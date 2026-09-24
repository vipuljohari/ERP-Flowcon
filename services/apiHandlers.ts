// Shared request-handler logic for every server-side route this app needs
// (Gemini AI calls, the two Admin-only user-management actions that must
// run with Firebase Admin privileges rather than the client SDK, and the
// WhatsApp gate-photo capture endpoint added 18-Sep-26).
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
import { Jimp } from "jimp";
import { matchKnownSupplier } from "./rmSupplierMatch.js";
import { buildArchiveFileName, buildArchiveMonthFolder } from "./dropboxArchive.js";

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

export interface ExtractedMaterialEntryFields {
  supplierName: string;
  invoiceNo: string;
  date: string;
  totalWeightKg: number;
  totalBillValue: number;
  materialDescription: string;
  odMm: number;
  thicknessMm: number;
  lengthMm: number;
  quantityPcs: number;
  vehicleNo: string;
}

// Core extraction logic for a Raw Material supplier invoice photo — shared
// by handleExtractMaterialEntryPhoto (Store's own Camera Upload, browser-
// triggered) and handleGateUpload (WhatsApp gate-photo capture, bot.js-
// triggered) below, added 18-Sep-26 so the gate-photo pipeline reuses the
// EXACT SAME prompt/schema instead of a second copy that could silently
// drift out of sync with it — same reasoning as services/customerMatch.ts's
// extraction from services/tally.ts. Throws on a missing/unconfigured
// Gemini key or an unparsable response; each caller decides how to surface
// that (a 503/502 straight to the browser for the direct-upload path, a
// 500-so-bot.js-retries for the gate path — see handleGateUpload).
async function extractMaterialEntryFields(imageBase64: string, mimeType: string): Promise<ExtractedMaterialEntryFields> {
  const ai = getGenAI();
  if (!ai) {
    throw new Error("Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets.");
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
      - vehicleNo: the transport/truck vehicle registration number, ONLY if
        it is actually printed somewhere on this invoice (some suppliers
        print it near the transport/dispatch details, many don't). Read it
        exactly as printed, keeping any letters/digits but stripping spaces
        and hyphens (e.g. "PB11CB9547" not "PB-11-CB-9547" or "PB 11 CB
        9547"). Use "" if no vehicle number is printed anywhere — never
        guess or invent one.

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
      vehicleNo: { type: Type.STRING },
    },
    required: ["supplierName", "invoiceNo", "date", "totalWeightKg", "totalBillValue", "materialDescription", "odMm", "thicknessMm", "lengthMm", "quantityPcs", "vehicleNo"],
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
    throw new Error("Could not make sense of this photo. Try a clearer, better-lit shot.");
  }

  return {
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
    vehicleNo: normalizeVehicleNo(String(parsed.vehicleNo || "")),
  };
}

// Uppercase + strip everything except letters/digits, so "PB11CB9547",
// "PB-11-CB-9547" and "pb 11 cb 9547" all normalize to the same join key —
// the invoice and the dharamkanta slip are two completely different
// documents/OCR passes and will never print a vehicle number identically.
function normalizeVehicleNo(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64 || !mimeType) {
      res.status(400).json({ error: "Missing imageBase64 or mimeType." });
      return;
    }
    const fields = await extractMaterialEntryFields(imageBase64, mimeType);
    res.json(fields);
  } catch (error: any) {
    console.error("API Extract Material Entry Photo Error:", error);
    const msg = error?.message || "Failed to read this invoice photo.";
    const status = /Gemini API key/.test(msg) ? 503 : /Could not make sense/.test(msg) ? 502 : 500;
    res.status(status).json({ error: msg });
  }
}

// Reads a dharamkanta (weighbridge) slip photo uploaded directly in-app —
// the manual-attach "upload" path on Gate Documents for Approval, for when
// Store/Admin has the slip in hand but vehicle-number auto-match (from the
// WhatsApp path) either failed or hasn't run yet. Same no-auth pattern as
// handleExtractMaterialEntryPhoto above (a logged-in browser session, not
// bot.js's shared-secret path) and reuses extractDharamkantaSlipFields —
// the exact same extraction handleDharamkantaSlipUpload uses server-side —
// so both attach paths read a slip identically.
export async function handleExtractDharamkantaSlipPhoto(req: MinimalRequest, res: MinimalResponse) {
  try {
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64 || !mimeType) {
      res.status(400).json({ error: "Missing imageBase64 or mimeType." });
      return;
    }
    const fields = await extractDharamkantaSlipFields(imageBase64, mimeType);
    res.json(fields);
  } catch (error: any) {
    console.error("API Extract Dharamkanta Slip Photo Error:", error);
    const msg = error?.message || "Failed to read this slip photo.";
    const status = /Gemini API key/.test(msg) ? 503 : /Could not make sense/.test(msg) ? 502 : 500;
    res.status(status).json({ error: msg });
  }
}

// --- Gate-photo capture (WhatsApp "Unit 2 Inward" group -> ERP) ---
// Called by bot.js's gate-queue worker (see whatsapp-inward-tally-
// automation design) for every photo the gate guard posts that survives
// bot.js's own capture step. Auth is a static shared secret
// (ERP_GATE_API_KEY), NOT a Firebase ID token — bot.js has no logged-in
// user session, so this can't go through requireAdmin above.
//
// Field names in the request body deliberately match exactly what bot.js's
// processOneGateQueueItem already sends (image/mimetype, not imageBase64/
// mimeType like this file's other Gemini endpoints) — converted once here
// rather than changing already-shipped, tested bot.js code to match this
// file's naming instead.
let rmSupplierNameCache: { names: string[]; expiresAt: number } | null = null;
async function getKnownRMSupplierNames(app: admin.app.App): Promise<string[]> {
  const now = Date.now();
  if (rmSupplierNameCache && rmSupplierNameCache.expiresAt > now) {
    return rmSupplierNameCache.names;
  }
  // Full Tally-synced Purchase party list — rmPurchaseVouchers is mirrored
  // hourly by import-tally.js, never written by this app itself. Used to
  // CANONICALIZE whatever Gemini read off the photo (handles vision/OCR
  // fuzziness against the real ledger name) — NOT, by itself, permission
  // to reach the Gate Documents for Approval tab; see
  // getApprovedSupplierNames below for that gate. Projection query
  // (.select) so this only reads the one field this needs, not every
  // voucher's full line-item detail — same Firestore-quota-consciousness
  // as import-tally.js's own targeted `where in` queries.
  const snap = await admin.firestore(app).collection("rmPurchaseVouchers").select("supplierName").get();
  const names = new Set<string>();
  snap.docs.forEach((d) => {
    const n = (d.data() as any)?.supplierName;
    if (n) names.add(String(n));
  });
  const list = Array.from(names);
  // 10 min cache — this collection only changes on the hourly Tally sync,
  // so re-reading it on every single gate photo would be pure waste.
  rmSupplierNameCache = { names: list, expiresAt: now + 10 * 60 * 1000 };
  return list;
}

// Admin's checkbox selection (18-Sep-26 refinement) over the full Tally
// Purchase party list above — only a party Admin has actually ticked here
// counts as an RM supplier for this feature. Maintained from the Party
// Name Master screen (components/PartyNameMaster.tsx, Admin-only), via
// App.tsx's `useFirestoreDoc<GateApprovedSuppliersSettings>('settings',
// 'gateApprovedSuppliers', ...)` — same collection/doc path this reads
// directly with firebase-admin. Missing doc or empty selectedNames =
// nothing approved yet = every gate photo goes to Unprocessed until Admin
// makes a first selection — a safe default (never silently promotes an
// unreviewed vendor into the live queue).
//
// 24-Sep-26: also carries manualNames — supplier names Admin typed in by
// hand for a manufacturer that never gets a direct Tally Purchase voucher
// (billed to us as a cross-bill against a customer instead, e.g. Tube
// Investments / Avon Tubes via SKH — see GateApprovedSuppliersSettings in
// types.ts). A manual name is approved the moment it's added (folded
// straight into approvedNames below), AND returned separately so
// handleGateUpload can also fold it into the known-supplier pool used to
// canonicalize OCR'd names — these names would otherwise never appear in
// rmPurchaseVouchers for that canonicalization to find them.
let approvedSupplierCache: { approvedNames: Set<string>; manualNames: string[]; expiresAt: number } | null = null;
async function getGateApprovedSettings(app: admin.app.App): Promise<{ approvedNames: Set<string>; manualNames: string[] }> {
  const now = Date.now();
  if (approvedSupplierCache && approvedSupplierCache.expiresAt > now) {
    return { approvedNames: approvedSupplierCache.approvedNames, manualNames: approvedSupplierCache.manualNames };
  }
  const doc = await admin.firestore(app).collection("settings").doc("gateApprovedSuppliers").get();
  const data = (doc.exists && (doc.data() as any)) || {};
  const selected: string[] = data.selectedNames || [];
  const manual: string[] = data.manualNames || [];
  const manualNames = manual.map((s) => String(s));
  const approvedNames = new Set([...selected.map((s) => String(s)), ...manualNames]);
  // Shorter TTL than the Tally-list cache — Admin changing this selection
  // should take effect reasonably soon, not up to 10 minutes later.
  approvedSupplierCache = { approvedNames, manualNames, expiresAt: now + 5 * 60 * 1000 };
  return { approvedNames, manualNames };
}

// Sibling to handleArchivePhoto's ARCHIVE_PHOTO_FOLDER, for gate photos
// that did NOT resolve to an Admin-approved supplier — Vipul's 18-Sep
// decision: never dropped, just filed here instead of reaching the Gate
// Documents for Approval tab. ASSUMPTION flagged for Vipul to confirm: he
// asked for "same file name structure" under a folder named "Unprocessed";
// this mirrors ARCHIVE_PHOTO_FOLDER's own "<MMM YY>/<Supplier>_<InvoiceNo>_
// <Date>" layout under a sibling "/Unit 2/Unprocessed" folder. If he meant
// a different location, only this one constant needs to change.
const UNPROCESSED_GATE_FOLDER = "/Unit 2/Unprocessed";

async function archiveUnprocessedGatePhoto(
  imageBase64: string,
  mimeType: string,
  supplierNameGuess: string,
  invoiceNoGuess: string,
  dateGuess: string
): Promise<void> {
  try {
    const accessToken = await getDropboxAccessToken();
    const buffer = Buffer.from(imageBase64, "base64");
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const fileName = buildArchiveFileName(supplierNameGuess || "Unknown Supplier", invoiceNoGuess || "Pending", dateGuess);
    const monthFolder = buildArchiveMonthFolder(dateGuess);
    const path = `${UNPROCESSED_GATE_FOLDER}/${monthFolder}/${fileName}.${ext}`;
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
  } catch (e: any) {
    // This archive is a safety net for a photo the app decided NOT to act
    // on — it must never be the reason bot.js's queue worker thinks
    // delivery failed and retries a photo that was already correctly
    // triaged. Log and swallow, same "audit-trail, never blocking" rule
    // handleArchivePhoto/dropboxArchive.ts already follow for the
    // matched-and-processed path.
    console.error("Unprocessed gate photo archive failed (non-fatal):", e);
  }
}

// 20-Sep-26: server-side safety net for the Firestore 1MB document limit —
// was flagged (below, where handleGateUpload calls this) as unresolved;
// closed here on the App side per Vipul's steer to keep bot.js changes in
// its own thread. WhatsApp photos arrive at whatever resolution WhatsApp
// itself sent, unlike every browser Camera Upload photo, which the browser
// already downsizes to 1600px/JPEG-85 (services/photo.ts, MAX_PHOTO_DIMENSION)
// before it ever reaches a server. This mirrors those exact numbers so a
// gate photo and a browser-uploaded photo end up compressed the same way —
// and only touches a photo that's actually large enough to need it, so a
// normal WhatsApp-compressed photo (the common case Vipul pointed out —
// "whatsapp photos are not more than 1 mb" — is about the SENT photo; a
// Document-mode send or a particularly large Photo-mode one can still
// exceed this) passes through untouched.
// A matching fix on bot.js's own capture step, if Vipul wants one, is
// tracked separately in that thread — this is a second, independent line
// of defense here in the App, not a replacement for that.
// Never blocks the upload: if Jimp can't decode the image for any reason
// (an unsupported format, corrupt bytes), this logs and falls back to the
// original bytes untouched, same "audit-trail, never blocking" rule
// archiveUnprocessedGatePhoto/handleArchivePhoto already follow.
const GATE_PHOTO_MAX_DIMENSION = 1600;
const GATE_PHOTO_JPEG_QUALITY = 85;
// Budget in RAW bytes (pre-base64) for the stored image. Base64 adds ~33%,
// and the rest of the gateDocumentsForApproval doc (extracted fields,
// supplier name, timestamps, etc.) is only a few KB, so this leaves
// comfortable headroom under Firestore's 1 MiB per-document limit.
const GATE_PHOTO_MAX_RAW_BYTES = 650 * 1024;

async function shrinkGatePhotoIfNeeded(
  imageBase64: string,
  mimeType: string
): Promise<{ imageBase64: string; mimeType: string }> {
  try {
    const original = Buffer.from(imageBase64, "base64");
    if (original.length <= GATE_PHOTO_MAX_RAW_BYTES) {
      return { imageBase64, mimeType };
    }
    const image = await Jimp.read(original);
    if (Math.max(image.bitmap.width, image.bitmap.height) > GATE_PHOTO_MAX_DIMENSION) {
      image.scaleToFit({ w: GATE_PHOTO_MAX_DIMENSION, h: GATE_PHOTO_MAX_DIMENSION });
    }
    // Step quality down further only on the rare photo that's still over
    // budget after the resize above (very high-detail/busy image) — most
    // gate photos will be done after that single resize.
    let quality = GATE_PHOTO_JPEG_QUALITY;
    let out = await image.getBuffer("image/jpeg", { quality });
    while (out.length > GATE_PHOTO_MAX_RAW_BYTES && quality > 50) {
      quality -= 15;
      out = await image.getBuffer("image/jpeg", { quality });
    }
    console.log(`[Gate photo] Resized ${original.length} -> ${out.length} bytes (quality ${quality}) before storing.`);
    return { imageBase64: out.toString("base64"), mimeType: "image/jpeg" };
  } catch (e: any) {
    console.error("Gate photo resize failed (non-fatal, using original):", e);
    return { imageBase64, mimeType };
  }
}

export async function handleGateUpload(req: MinimalRequest, res: MinimalResponse) {
  try {
    const apiKey = process.env.ERP_GATE_API_KEY;
    const authHeader = (req.headers.authorization as string) || "";
    if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }

    let { image, mimetype, filename, sender, pushName, caption, waTimestamp, capturedAt } = req.body || {};
    if (!image || !mimetype || !filename) {
      res.status(400).json({ error: "Missing image, mimetype, or filename." });
      return;
    }

    // Shrink first (see shrinkGatePhotoIfNeeded above) — everything
    // downstream (Gemini extraction, the Unprocessed-folder archive, and
    // the Firestore doc itself) uses these bytes from here on.
    ({ imageBase64: image, mimeType: mimetype } = await shrinkGatePhotoIfNeeded(image, mimetype));

    const extracted = await extractMaterialEntryFields(image, mimetype);

    const app = getAdminApp();
    const [allTallySuppliers, gateApproved] = await Promise.all([
      getKnownRMSupplierNames(app),
      getGateApprovedSettings(app),
    ]);
    // Canonicalize first against the FULL Tally Purchase party list PLUS
    // any manually-added names (a cross-bill manufacturer with no Tally
    // Purchase voucher of its own — see GateApprovedSuppliersSettings in
    // types.ts), THEN check Admin's approval against that canonical name —
    // not the raw Gemini-read text — so a slightly-misread name for an
    // already-approved supplier still gets picked up correctly.
    const knownNames = gateApproved.manualNames.length
      ? [...allTallySuppliers, ...gateApproved.manualNames]
      : allTallySuppliers;
    const match = matchKnownSupplier(extracted.supplierName, knownNames);
    const isApproved = match.result === "confident" && gateApproved.approvedNames.has(match.matchedSupplier);

    if (!isApproved) {
      // Nothing legible, matched no Tally party at all, OR matched a real
      // party Admin simply hasn't ticked yet — all three land here per
      // Vipul's 18-Sep decision: archived to Unprocessed for manual
      // review, never lost, never cluttering the in-app queue for a
      // party that isn't meant to be there.
      await archiveUnprocessedGatePhoto(
        image,
        mimetype,
        match.result === "confident" ? match.matchedSupplier : extracted.supplierName,
        extracted.invoiceNo,
        extracted.date
      );
      res.json({ matched: false, approved: false });
      return;
    }

    const docRef = admin.firestore(app).collection("gateDocumentsForApproval").doc();
    const resolvedCapturedAt = capturedAt ? String(capturedAt) : new Date().toISOString();
    await docRef.set({
      id: docRef.id,
      imageBase64: String(image),
      mimeType: String(mimetype),
      status: "pending",
      matchedSupplier: match.matchedSupplier,
      extracted,
      originalFileName: String(filename),
      sender: sender ? String(sender) : "",
      pushName: pushName ?? null,
      caption: caption ? String(caption) : "",
      waTimestamp: waTimestamp ?? null,
      capturedAt: resolvedCapturedAt,
      createdAt: new Date().toISOString(),
      source: "whatsapp-gate",
      // Awaiting Weighment Slip (23-Sep-26) — this entry can't be worked
      // (mode picked) until the dharamkanta slip lands too. See
      // handleDharamkantaSlipUpload below for the normal arrival order
      // (invoice first, slip hours later); the lookup right after this is
      // only for the rarer out-of-order case (slip somehow processed
      // before this invoice's own doc existed to match against).
      slipStatus: "awaiting",
    });

    if (extracted.vehicleNo) {
      await tryAttachWaitingSlipToNewGateDoc(app, docRef.id, extracted.vehicleNo, resolvedCapturedAt);
    }

    res.json({ matched: true, status: "pending", docId: docRef.id });
  } catch (error: any) {
    console.error("Gate upload error:", error);
    // Any non-2xx makes bot.js's queue worker retry (30s backoff) instead
    // of losing the photo — safe, and correct, to fail loudly here rather
    // than swallow the error.
    res.status(500).json({ error: error?.message || "Failed to process gate photo." });
  }
}

// --- Dharamkanta (weighbridge) slip capture (added 23-Sep-26) ---
// Companion to the invoice photo above — Vipul's 22/23-Sep decision: a gate
// entry can't be worked until BOTH photos have landed, since the slip can
// take 5+ hours after the invoice (it depends on when the truck actually
// gets weighed). See GateDocumentForApproval.slipStatus in types.ts for the
// full design note.

// True when both ISO timestamps fall on the same calendar day — deliberately
// simple (no timezone library): both strings come from bot.js's own
// capturedAt, which is already local IST time the same way every other
// timestamp in this pipeline is, so a plain date-prefix compare is enough.
function sameCalendarDay(isoA: string, isoB: string): boolean {
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

// Reads a photo of a weighbridge (dharamkanta) slip — a completely
// different document from the supplier invoice above, so its own prompt/
// schema rather than trying to stretch extractMaterialEntryFields to cover
// both. Only 3 fields matter here: the vehicle number (the join key back to
// the invoice), the net weight (what actually gets auto-filled into the
// entry), and the slip's own date (for the same-day matching window).
async function extractDharamkantaSlipFields(imageBase64: string, mimeType: string): Promise<{ vehicleNo: string; netWeightKg: number; slipDate: string }> {
  const ai = getGenAI();
  if (!ai) {
    throw new Error("Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets.");
  }

  const prompt = `
      This is a photo of a weighbridge (dharamkanta) weighment slip — a
      receipt from a public weighbridge showing a truck's gross, tare and
      net weight, printed on the weighbridge operator's own letterhead (NOT
      a supplier's GST invoice).

      Read the slip and extract these exact fields:
      - vehicleNo: the truck/vehicle registration number (labelled
        "Vehicle No." or similar). Read it exactly as printed, keeping only
        letters and digits — strip spaces and hyphens (e.g. "PB11CB9547"
        not "PB-11-CB-9547" or "PB 11 CB 9547"). Use "" if not legible.
      - netWeightKg: the Net Weight value, as a plain number in Kg (the
        slip states this directly — do not compute it yourself from gross
        minus tare unless there is no separate Net Weight line). Use 0 if
        not legible.
      - slipDate: the date printed on the slip (the weighment date, not a
        signature date if they differ), formatted as YYYY-MM-DD. Use "" if
        not legible.

      Never guess a value that isn't actually legible on the slip.
    `;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      vehicleNo: { type: Type.STRING },
      netWeightKg: { type: Type.NUMBER },
      slipDate: { type: Type.STRING },
    },
    required: ["vehicleNo", "netWeightKg", "slipDate"],
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
    throw new Error("Could not make sense of this photo. Try a clearer, better-lit shot.");
  }

  return {
    vehicleNo: normalizeVehicleNo(String(parsed.vehicleNo || "")),
    netWeightKg: Number(parsed.netWeightKg) || 0,
    slipDate: String(parsed.slipDate || "").trim(),
  };
}

// Fires the moment a slip can't be confidently auto-matched (zero or
// multiple same-day vehicle-number candidates) — per Vipul's explicit ask,
// so Admin is alerted to keenly verify whichever manual attach eventually
// resolves it, not just relying on whoever happens to open Gate Documents
// for Approval and notice. Written directly via the Admin SDK, mirroring
// the shape App.tsx's own client-side pushAdminAlert produces — this is the
// one AdminAlert type in the whole app that a server function creates
// rather than the client, since nobody's logged-in browser session is
// involved in this match attempt at all.
async function pushGateSlipNotMatchedAlert(app: admin.app.App, vehicleNo: string, candidateCount: number, sender: string): Promise<void> {
  try {
    const alertRef = admin.firestore(app).collection("adminAlerts").doc();
    await alertRef.set({
      id: alertRef.id,
      type: "gate_slip_not_matched",
      timestamp: new Date().toISOString(),
      createdBy: "WhatsApp Gate Bot",
      role: "store",
      remarks: vehicleNo
        ? `Dharamkanta slip for vehicle ${vehicleNo} could not be auto-matched — ${candidateCount === 0 ? "no open gate entry from today has that vehicle number" : `${candidateCount} open gate entries from today share that vehicle number`}. Sent by ${sender || "unknown"}. Attach it manually from Gate Documents for Approval.`
        : `A dharamkanta slip arrived with no legible vehicle number and could not be auto-matched. Sent by ${sender || "unknown"}. Attach it manually from Gate Documents for Approval.`,
      verified: false,
    });
  } catch (e) {
    // Same "audit-trail, never blocking" rule as every other alert/archive
    // helper in this file — a failure here must never make bot.js retry a
    // slip photo that was otherwise handled correctly.
    console.error("gate_slip_not_matched alert failed (non-fatal):", e);
  }
}

// Out-of-order safety net for handleGateUpload above: if a slip photo
// somehow got processed (and landed in unmatchedDharamkantaSlips) BEFORE
// its invoice's own gate doc existed to match against, this catches it the
// moment that gate doc IS created, instead of leaving both stuck waiting on
// each other forever.
async function tryAttachWaitingSlipToNewGateDoc(app: admin.app.App, gateDocId: string, vehicleNo: string, capturedAt: string): Promise<void> {
  const snap = await admin.firestore(app).collection("unmatchedDharamkantaSlips").where("status", "==", "unmatched").get();
  const candidates = snap.docs.filter(d => {
    const data = d.data() as any;
    return data.extracted?.vehicleNo === vehicleNo && sameCalendarDay(data.capturedAt || "", capturedAt);
  });
  if (candidates.length !== 1) return; // 0 = nothing waiting; 2+ = still ambiguous, leave for manual attach either way
  const slipDoc = candidates[0];
  const slip = slipDoc.data() as any;
  const now = new Date().toISOString();
  const batch = admin.firestore(app).batch();
  batch.update(admin.firestore(app).collection("gateDocumentsForApproval").doc(gateDocId), {
    slipStatus: "attached",
    slipImageBase64: slip.imageBase64,
    slipMimeType: slip.mimeType,
    slipExtracted: slip.extracted,
    slipAttachedVia: "auto_whatsapp",
    slipAttachedBy: "bot.js (auto-matched)",
    slipAttachedAt: now,
  });
  batch.update(slipDoc.ref, { status: "attached", attachedToGateDocId: gateDocId, attachedBy: "bot.js (auto-matched)", attachedAt: now, imageBase64: "" });
  await batch.commit();
}

export async function handleDharamkantaSlipUpload(req: MinimalRequest, res: MinimalResponse) {
  try {
    const apiKey = process.env.ERP_GATE_API_KEY;
    const authHeader = (req.headers.authorization as string) || "";
    if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }

    let { image, mimetype, filename, sender, pushName, waTimestamp, capturedAt } = req.body || {};
    if (!image || !mimetype) {
      res.status(400).json({ error: "Missing image or mimetype." });
      return;
    }

    ({ imageBase64: image, mimeType: mimetype } = await shrinkGatePhotoIfNeeded(image, mimetype));

    const extracted = await extractDharamkantaSlipFields(image, mimetype);
    const app = getAdminApp();
    const resolvedCapturedAt = capturedAt ? String(capturedAt) : new Date().toISOString();

    let candidates: admin.firestore.QueryDocumentSnapshot[] = [];
    if (extracted.vehicleNo) {
      const snap = await admin.firestore(app).collection("gateDocumentsForApproval").where("status", "==", "pending").get();
      candidates = snap.docs.filter(d => {
        const data = d.data() as any;
        return (data.slipStatus || "awaiting") !== "attached"
          && (data.extracted?.vehicleNo || "") === extracted.vehicleNo
          && sameCalendarDay(data.capturedAt || "", resolvedCapturedAt);
      });
    }

    if (candidates.length === 1) {
      const now = new Date().toISOString();
      await candidates[0].ref.update({
        slipStatus: "attached",
        slipImageBase64: String(image),
        slipMimeType: String(mimetype),
        slipExtracted: extracted,
        slipAttachedVia: "auto_whatsapp",
        slipAttachedBy: "bot.js (auto-matched)",
        slipAttachedAt: now,
      });
      res.json({ matched: true, docId: candidates[0].id });
      return;
    }

    // No confident single match — file it for manual attach and alert
    // Admin, per Vipul's explicit ask, rather than guessing.
    const slipRef = admin.firestore(app).collection("unmatchedDharamkantaSlips").doc();
    await slipRef.set({
      id: slipRef.id,
      imageBase64: String(image),
      mimeType: String(mimetype),
      extracted,
      sender: sender ? String(sender) : "",
      pushName: pushName ?? null,
      capturedAt: resolvedCapturedAt,
      createdAt: new Date().toISOString(),
      status: "unmatched",
    });
    await pushGateSlipNotMatchedAlert(app, extracted.vehicleNo, candidates.length, sender ? String(sender) : "");
    res.json({ matched: false, docId: slipRef.id });
  } catch (error: any) {
    console.error("Dharamkanta slip upload error:", error);
    res.status(500).json({ error: error?.message || "Failed to process dharamkanta slip photo." });
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
    const { imageBase64, mimeType, fileName, folder } = req.body || {};
    if (!imageBase64 || !fileName) {
      res.status(400).json({ error: "Missing imageBase64 or fileName." });
      return;
    }
    const accessToken = await getDropboxAccessToken();
    const buffer = Buffer.from(imageBase64, "base64");
    const ext = mimeType === "image/png" ? "png" : "jpg";
    // Keep the same readable characters the filename builder allows
    // client-side (letters, digits, spaces, dots, hyphens) — only strip
    // what Dropbox/Windows genuinely can't store in a path segment.
    const safeName = String(fileName).replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
    // Month-bucket subfolder (e.g. "Sep 26"), passed from the client via
    // buildArchiveMonthFolder — Dropbox creates it automatically on first
    // upload, no separate "create folder" call needed. Falls back to the
    // flat root for any older caller that doesn't send one.
    const safeFolder = folder ? String(folder).replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim() : "";
    const path = safeFolder
      ? `${ARCHIVE_PHOTO_FOLDER}/${safeFolder}/${safeName}.${ext}`
      : `${ARCHIVE_PHOTO_FOLDER}/${safeName}.${ext}`;

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
