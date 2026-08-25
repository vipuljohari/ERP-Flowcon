// Shared request-handler logic for every server-side route this app needs
// (Gemini AI calls, and the two Admin-only user-management actions that
// must run with Firebase Admin privileges rather than the client SDK).
//
// Written once here and used from two different places:
//   - server.ts        — a local-dev Express server (`npm run dev`).
//   - api/**/*.ts       — Vercel Serverless Functions (production).
// Vercel's automatic Vite detection only builds and serves the static
// `dist` output; it never runs server.ts's Express app. Without files
// under /api, every fetch to /api/admin/createUser (etc.) 404s against
// Vercel's own router and the client gets Vercel's HTML "page not found"
// back instead of JSON — which is exactly the "Unexpected token 'T'"
// error this was built to fix. Keeping the actual logic here (instead of
// duplicated in server.ts and four separate api/*.ts files) means the
// local-dev server and the production functions can never drift apart.
import { GoogleGenAI, Type } from "@google/genai";
import admin from "firebase-admin";

// A minimal, structurally-compatible request/response shape that both
// Express's (Request, Response) and Vercel's (VercelRequest,
// VercelResponse) satisfy without needing either type imported here —
// keeps this file framework-agnostic.
export interface MinimalRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}
export interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: any): any;
}

// --- Firebase Admin (server-side only) ---
// Creating login accounts must happen server-side: the client Firebase SDK
// signs in as whichever user it just created, which would silently log the
// Admin out of their own session if done in the browser.
let adminApp: admin.app.App | null = null;
function getAdminApp(): admin.app.App {
  if (adminApp) return adminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not set.");
  const serviceAccount = JSON.parse(raw);
  adminApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return adminApp;
}

// Verifies the caller's ID token and confirms their Firestore profile has role: 'admin'.
async function requireAdmin(req: MinimalRequest, res: MinimalResponse): Promise<string | null> {
  const authHeader = (req.headers.authorization as string) || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing auth token." });
    return null;
  }
  const app = getAdminApp();
  const decoded = await admin.auth(app).verifyIdToken(token);
  const profile = await admin.firestore(app).collection("users").doc(decoded.uid).get();
  if (!profile.exists || profile.data()?.role !== "admin" || profile.data()?.active === false) {
    res.status(403).json({ error: "Admin access required." });
    return null;
  }
  return decoded.uid;
}

let genAI: GoogleGenAI | null | undefined;
function getGenAI(): GoogleGenAI | null {
  if (genAI !== undefined) return genAI;
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  genAI = apiKey
    ? new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } })
    : null;
  return genAI;
}

export async function handleInsights(req: MinimalRequest, res: MinimalResponse) {
  try {
    const ai = getGenAI();
    if (!ai) {
      res.status(503).json({ error: "Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets." });
      return;
    }

    const { parts, sales } = req.body || {};
    if (!parts || !sales) {
      res.status(400).json({ error: "Missing parts or sales payload." });
      return;
    }

    const summary = parts.map((p: any) => {
      const partDispatches = sales
        .filter((s: any) => s.partId === p.id)
        .reduce((sum: number, s: any) => sum + s.quantity, 0);

      const totalTarget = Object.values(p.schedules || {}).reduce((acc: number, val: any) => acc + (Number(val) || 0), 0) || 1;

      return {
        name: p.name,
        rate: p.rate,
        inward: p.inward,
        disp: partDispatches,
        achv: ((partDispatches / totalTarget) * 100).toFixed(1) + "%",
        bal: p.stock,
      };
    });

    const prompt = `
        Analyze this precise manufacturing report.
        Columns include Rate, Inward qty, Dispatch qty, and Total Stock (Balance).
        Parts Data: ${JSON.stringify(summary)}

        Provide:
        1. Financial impact: Identify high-value inventory bottlenecks (Rate * Balance).
        2. Logistics warning: Identify parts where Inward is high but Dispatch is low (potential overstock).
        3. Achievement gaps: Which parts are falling behind targets despite having inward stock available.

        Focus on specific part names and keep it business-ready.
      `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });

    res.json({ text: response.text || "Insights unavailable." });
  } catch (error: any) {
    console.error("API Insights Error:", error);
    res.status(500).json({ error: error?.message || "Failed to generate insights." });
  }
}

export async function handleChat(req: MinimalRequest, res: MinimalResponse) {
  try {
    const ai = getGenAI();
    if (!ai) {
      res.status(503).json({ error: "Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets." });
      return;
    }

    const { message, parts, history } = req.body || {};
    if (!message || !parts) {
      res.status(400).json({ error: "Missing message or parts context." });
      return;
    }

    const systemPrompt = `
        You are the Flowcon ERP AI Assistant, tracking SIAC-SKH manufacturing data.
        You have access to Rates, Dimensions (Size), Inward logs, and Dispatch targets.
        Data Context: ${JSON.stringify(parts)}
        Help the owner optimize inventory value and hit dispatch targets.
      `;

    const formattedHistory = (history || []).map((h: any) => ({
      role: h.role === "model" ? "model" : "user",
      parts: [{ text: h.content }],
    }));

    const contents = [
      ...formattedHistory,
      {
        role: "user",
        parts: [{ text: message }],
      },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: contents,
      config: { systemInstruction: systemPrompt },
    });

    res.json({ text: response.text || "No response received." });
  } catch (error: any) {
    console.error("API Chat Error:", error);
    res.status(500).json({ error: error?.message || "Failed to process chat demand." });
  }
}

// Reads a photo of an RM invoice and extracts the fields the RM Cross-Bill
// Check form for that invoice type needs, so Admin can review/correct
// instead of re-typing every field by hand. docType selects which of the
// two invoice types (and which form) this is for:
//   - "manufacturer": the RM manufacturer's invoice (e.g. Tube Investments)
//     -> feeds the "+ Manufacturer Invoice" form.
//   - "customer": the customer's own cross-invoice reselling that RM back
//     (e.g. SIAC-SKH) -> feeds the "+ Customer Invoice" form. This
//     deliberately does NOT try to guess which outstanding manufacturer
//     invoice it matches — that's the actual judgment this whole screen
//     exists to support, so it always stays a manual pick in the form.
// Deliberately returns only the FIRST line item either way — these
// invoices are one-line-item-per-invoice in practice, and extracting a
// whole table reliably is a materially harder problem than this needs to
// solve yet. The client always shows the extracted values in the normal
// form fields for review before Save — this never writes anything on its
// own.
export async function handleExtractInvoice(req: MinimalRequest, res: MinimalResponse) {
  try {
    const ai = getGenAI();
    if (!ai) {
      res.status(503).json({ error: "Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets." });
      return;
    }

    const { imageBase64, mimeType, docType } = req.body || {};
    if (!imageBase64 || !mimeType) {
      res.status(400).json({ error: "Missing imageBase64 or mimeType." });
      return;
    }
    const isCustomer = docType === "customer";

    const prompt = isCustomer ? `
      This is a photo of a Customer Cross-Invoice: a GST tax invoice your
      OWN customer (e.g. SIAC-SKH India Cabs Mfg Pvt Ltd) issued to you,
      reselling raw material back to you at their own markup.

      Read the invoice and extract these exact fields:
      - customerName: the SELLER company's name, from the letterhead at the
        top of the invoice — this is your own customer's name, NOT your
        own company's name (do not extract "Flowcon" or similar here).
      - invoiceNo: the Invoice No field.
      - date: the Invoice Date, formatted as YYYY-MM-DD.
      - quantityMtr: the invoiced quantity in meters, as a plain number.
      - rate: the rate, as a plain number.
      - itemValue: the item value BEFORE tax (Item Value / Total Item
        Value), as a plain number.

      If the invoice has more than one line item, extract only the FIRST
      one. If a field genuinely can't be read, use "" for text fields or 0
      for number fields — never guess a value that isn't legible.
    ` : `
      This is a photo of a Raw Material manufacturer's GST tax invoice (e.g.
      from Tube Investments of India Ltd or a similar steel tube/sheet
      supplier), sent to a manufacturing customer.

      Read the invoice and extract these exact fields:
      - manufacturerName: the SELLER company's name, from the letterhead at
        the top of the invoice — NOT the "Bill to" / "Ship to" customer.
      - invoiceNo: the Invoice No field.
      - date: the Invoice Date, formatted as YYYY-MM-DD.
      - materialName: the material/item description line, exactly as
        printed (e.g. "STEEL TUBES-ERW/SB-RECTANGLE-90.00 X 50.00 X 2.90 X
        4950.00-AS ROLLED").
      - materialCode: the CUSTOMER's own part code for this material —
        usually printed as "Cust Part No" (or similar) near the item
        description, often starting with letters like "BOCS" or "RMSS".
        Prefer this over any separate internal vendor/item code. Report
        just the code itself — drop any trailing period or other
        punctuation from the source layout that isn't actually part of
        the code (e.g. "RMSS00000119." -> "RMSS00000119").
      - quantityPcs: the invoiced quantity, as a plain number (Qty column).
      - ratePerPc: the rate per piece, as a plain number (Item Rate column).
      - itemValue: the item value BEFORE tax (Item Value / Total Item
        Value), as a plain number.

      If the invoice has more than one line item, extract only the FIRST
      one. If a field genuinely can't be read, use "" for text fields or 0
      for number fields — never guess a value that isn't legible.
    `;

    const responseSchema = isCustomer ? {
      type: Type.OBJECT,
      properties: {
        customerName: { type: Type.STRING },
        invoiceNo: { type: Type.STRING },
        date: { type: Type.STRING },
        quantityMtr: { type: Type.NUMBER },
        rate: { type: Type.NUMBER },
        itemValue: { type: Type.NUMBER },
      },
      required: ["customerName", "invoiceNo", "date", "quantityMtr", "rate", "itemValue"],
    } : {
      type: Type.OBJECT,
      properties: {
        manufacturerName: { type: Type.STRING },
        invoiceNo: { type: Type.STRING },
        date: { type: Type.STRING },
        materialName: { type: Type.STRING },
        materialCode: { type: Type.STRING },
        quantityPcs: { type: Type.NUMBER },
        ratePerPc: { type: Type.NUMBER },
        itemValue: { type: Type.NUMBER },
      },
      required: ["manufacturerName", "invoiceNo", "date", "materialName", "materialCode", "quantityPcs", "ratePerPc", "itemValue"],
    };

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { data: imageBase64, mimeType } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema,
      },
    });

    let parsed: any;
    try {
      parsed = JSON.parse(response.text || "{}");
    } catch {
      res.status(502).json({ error: "Could not make sense of this photo. Try a clearer, better-lit shot." });
      return;
    }

    if (isCustomer) {
      res.json({
        customerName: String(parsed.customerName || "").trim(),
        invoiceNo: String(parsed.invoiceNo || "").trim(),
        date: String(parsed.date || "").trim(),
        quantityMtr: Number(parsed.quantityMtr) || 0,
        rate: Number(parsed.rate) || 0,
        itemValue: Number(parsed.itemValue) || 0,
      });
    } else {
      res.json({
        manufacturerName: String(parsed.manufacturerName || "").trim(),
        invoiceNo: String(parsed.invoiceNo || "").trim(),
        date: String(parsed.date || "").trim(),
        materialName: String(parsed.materialName || "").trim(),
        materialCode: String(parsed.materialCode || "").trim().replace(/[.\s]+$/, ""),
        quantityPcs: Number(parsed.quantityPcs) || 0,
        ratePerPc: Number(parsed.ratePerPc) || 0,
        itemValue: Number(parsed.itemValue) || 0,
      });
    }
  } catch (error: any) {
    console.error("API Extract Invoice Error:", error);
    res.status(500).json({ error: error?.message || "Failed to read this invoice photo." });
  }
}

export async function handleCreateUser(req: MinimalRequest, res: MinimalResponse) {
  try {
    const callerUid = await requireAdmin(req, res);
    if (!callerUid) return; // requireAdmin already sent the response

    const { email, password, displayName, role, companyId } = req.body || {};
    if (!email || !password || !role) {
      res.status(400).json({ error: "email, password, and role are required." });
      return;
    }
    const app = getAdminApp();
    const userRecord = await admin.auth(app).createUser({ email, password, displayName });
    await admin.firestore(app).collection("users").doc(userRecord.uid).set({
      email, displayName: displayName || email, role, companyId: companyId || "default",
      active: true, createdAt: new Date().toISOString(),
    });
    res.json({ uid: userRecord.uid });
  } catch (error: any) {
    console.error("Create user error:", error);
    res.status(500).json({ error: error?.message || "Failed to create user." });
  }
}

export async function handleUpdateUser(req: MinimalRequest, res: MinimalResponse) {
  try {
    const callerUid = await requireAdmin(req, res);
    if (!callerUid) return;

    const { uid, role, active, displayName } = req.body || {};
    if (!uid) {
      res.status(400).json({ error: "uid is required." });
      return;
    }
    const app = getAdminApp();
    const updates: Record<string, any> = {};
    if (role !== undefined) updates.role = role;
    if (active !== undefined) updates.active = active;
    if (displayName !== undefined) updates.displayName = displayName;
    await admin.firestore(app).collection("users").doc(uid).update(updates);
    if (active === false) {
      await admin.auth(app).updateUser(uid, { disabled: true });
    } else if (active === true) {
      await admin.auth(app).updateUser(uid, { disabled: false });
    }
    res.json({ ok: true });
  } catch (error: any) {
    console.error("Update user error:", error);
    res.status(500).json({ error: error?.message || "Failed to update user." });
  }
}
