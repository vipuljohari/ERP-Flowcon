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
import { GoogleGenAI } from "@google/genai";
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
