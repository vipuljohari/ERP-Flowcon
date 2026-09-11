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

// Reads a photo of a Raw Material supplier's invoice for Material Entry's
// Camera Upload (Finished Pieces / Longer Pipe) — a different shape from
// handleExtractInvoice above, which feeds RM Cross-Bill Check's own
// Manufacturer Invoice form. This one additionally pulls the OD/Thickness/
// Length actually printed in the material description line (e.g. "STEEL
// TUBES-ERW/SB-ROUND-44.45 X 1.8 X 5710-AS ROLLED"), so the client can
// suggest the matching Raw Material via services/dimensionTolerance.ts —
// always a suggestion the Spec/Material dropdown shows for review, never
// something this endpoint or the client applies on its own. Also extracts
// Total Weight (Kg) and Total Bill Value, which the RM Cross-Bill Check
// extractor doesn't need to. Dharamkanta (weighbridge) Weight is
// deliberately never part of this — it's a physical slip generated at
// receipt, never printed on the supplier's invoice, so it stays a manual
// field exactly like it already is on every other invoice form in this
// app.
export async function handleExtractMaterialEntryPhoto(req: MinimalRequest, res: MinimalResponse) {
  try {
    const ai = getGenAI();
    if (!ai) {
      res.status(503).json({ error: "Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets." });
      return;
    }

    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64 || !mimeType) {
      res.status(400).json({ error: "Missing imageBase64 or mimeType." });
      return;
    }

    const prompt = `
      This is a photo of a Raw Material supplier's GST tax invoice (e.g. a
      steel tube/pipe manufacturer like Tube Investments of India Ltd),
      being read for goods-receipt entry.

      Read the invoice and extract these exact fields:
      - supplierName: the SELLER company's name from the letterhead — NOT
        the "Bill to"/"Ship to" customer.
      - invoiceNo: the Invoice No field.
      - date: the Invoice Date, formatted as YYYY-MM-DD.
      - totalWeightKg: the invoice's own stated total weight in Kg, as a
        plain number (this is the SUPPLIER's stated weight, not a
        weighbridge reading — if the invoice states no weight, use 0).
      - totalBillValue: the total item value BEFORE tax, as a plain number.
      - materialDescription: the material/item description line, exactly as
        printed (e.g. "STEEL TUBES-ERW/SB-ROUND-44.45 X 1.8 X 5710-AS
        ROLLED").
      - odMm: for a ROUND tube/pipe only, the Outer Diameter actually
        printed in the material description (the FIRST dimension number),
        as a plain number in mm. This is the invoice's own measured value —
        report it exactly as printed even if it looks slightly under a
        "round" size (e.g. report 44.45, don't round it to 45). Use 0 if
        the material is square/rectangular or the description doesn't show
        a clean OD.
      - thicknessMm: the wall Thickness printed in the material description
        (the number immediately BEFORE the length, for both round and
        square/rectangular tube), as a plain number in mm, exactly as
        printed. Use 0 if not legible.
      - lengthMm: the piece/bar Length printed in the material description
        (the LAST dimension number), as a plain number in mm. Use 0 if not
        legible.
      - quantityPcs: the invoiced quantity of bars/pieces, as a plain
        number (Qty column).

      If the invoice has more than one line item, extract only the FIRST
      one. If a field genuinely can't be read, use "" for text fields or 0
      for number fields — never guess a value that isn't legible.
    `;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        supplierName: { type: Type.STRING },
        invoiceNo: { type: Type.STRING },
        date: { type: Type.STRING },
        totalWeightKg: { type: Type.NUMBER },
        totalBillValue: { type: Type.NUMBER },
        materialDescription: { type: Type.STRING },
        odMm: { type: Type.NUMBER },
        thicknessMm: { type: Type.NUMBER },
        lengthMm: { type: Type.NUMBER },
        quantityPcs: { type: Type.NUMBER },
      },
      required: ["supplierName", "invoiceNo", "date", "totalWeightKg", "totalBillValue", "materialDescription", "odMm", "thicknessMm", "lengthMm", "quantityPcs"],
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

    res.json({
      supplierName: String(parsed.supplierName || "").trim(),
      invoiceNo: String(parsed.invoiceNo || "").trim(),
      date: String(parsed.date || "").trim(),
      totalWeightKg: Number(parsed.totalWeightKg) || 0,
      totalBillValue: Number(parsed.totalBillValue) || 0,
      materialDescription: String(parsed.materialDescription || "").trim(),
      odMm: Number(parsed.odMm) || 0,
      thicknessMm: Number(parsed.thicknessMm) || 0,
      lengthMm: Number(parsed.lengthMm) || 0,
      quantityPcs: Number(parsed.quantityPcs) || 0,
    });
  } catch (error: any) {
    console.error("API Extract Material Entry Photo Error:", error);
    res.status(500).json({ error: error?.message || "Failed to read this invoice photo." });
  }
}

// --- Dropbox photo archival (Material Entry's Camera Upload) ---
// Server-side only, by design — this uses a long-lived refresh token to
// mint short-lived access tokens on demand, which is the standard
// permanent/unattended Dropbox integration pattern (same relay idea as
// Vipul's other Dropbox automations), and must never be done with the App
// Secret or Refresh Token exposed to the browser. Needs three env vars set
// in Vercel: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
// (from the existing "Flowcon-Schedule-Export" Dropbox App — see Vipul's
// 11-Sep-26 message). This is purely an audit-trail archive: a failure
// here must never block a real Material Entry save, so the client
// (services/dropboxArchive.ts) always swallows errors from this endpoint.
let dropboxAccessTokenCache: { token: string; expiresAt: number } | null = null;
async function getDropboxAccessToken(): Promise<string> {
  const now = Date.now();
  if (dropboxAccessTokenCache && dropboxAccessTokenCache.expiresAt > now) {
    return dropboxAccessTokenCache.token;
  }
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  if (!appKey || !appSecret || !refreshToken) {
    throw new Error("Dropbox photo archival is not configured — DROPBOX_APP_KEY/DROPBOX_APP_SECRET/DROPBOX_REFRESH_TOKEN must be set under Settings > Secrets.");
  }
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Dropbox token refresh failed (${resp.status}): ${errText.slice(0, 200)}`);
  }
  const json: any = await resp.json();
  // Refresh a little early (60s margin) rather than exactly at expiry.
  dropboxAccessTokenCache = { token: json.access_token, expiresAt: now + (Number(json.expires_in) - 60) * 1000 };
  return json.access_token;
}

// Fixed destination — the same Dropbox App's "Unit 2/Inwards" folder,
// which syncs down to Vipul's local D:\...\Inwards via the Dropbox desktop
// client on his machine, same relay pattern as his other automations. A
// Dropbox "App folder" app's root IS this folder already (no leading
// /Apps/<name> segment needed — the API scopes every path to the app's own
// folder automatically), so this is relative to that root.
const ARCHIVE_PHOTO_FOLDER = "/Unit 2/Inwards";

export async function handleArchivePhoto(req: MinimalRequest, res: MinimalResponse) {
  try {
    const { imageBase64, mimeType, fileName } = req.body || {};
    if (!imageBase64 || !fileName) {
      res.status(400).json({ error: "Missing imageBase64 or fileName." });
      return;
    }
    const accessToken = await getDropboxAccessToken();
    const buffer = Buffer.from(imageBase64, "base64");
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const safeName = String(fileName).replace(/[^A-Za-z0-9_.-]/g, "_");
    const path = `${ARCHIVE_PHOTO_FOLDER}/${safeName}.${ext}`;

    const uploadResp = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path, mode: "add", autorename: true, mute: true }),
        "Content-Type": "application/octet-stream",
      },
      body: buffer,
    });
    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => "");
      throw new Error(`Dropbox upload failed (${uploadResp.status}): ${errText.slice(0, 200)}`);
    }
    const result: any = await uploadResp.json();
    res.json({ ok: true, path: result.path_display || path });
  } catch (error: any) {
    console.error("Archive photo error:", error);
    res.status(500).json({ error: error?.message || "Failed to archive photo to Dropbox." });
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
