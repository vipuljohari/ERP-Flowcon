import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import admin from "firebase-admin";

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
async function requireAdmin(req: express.Request, res: express.Response): Promise<string | null> {
  const authHeader = req.headers.authorization || "";
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

async function startServer() {
  const logFile = path.join(process.cwd(), "server-status.log");
  fs.writeFileSync(logFile, `Starting server at ${new Date().toISOString()}\n`);

  try {
    const app = express();
    const PORT = 3000;

    // Body parser with 10mb limit to handle part context safely
    app.use(express.json({ limit: '10mb' }));

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    fs.appendFileSync(logFile, `API key checked: ${apiKey ? 'Found' : 'Missing'}\n`);

    const ai = apiKey ? new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    }) : null;

    // API Route: Insights
    app.post("/api/gemini/insights", async (req, res) => {
      try {
        fs.appendFileSync(logFile, `Received /api/gemini/insights request at ${new Date().toISOString()}\n`);
        if (!ai) {
          fs.appendFileSync(logFile, `Insights Error: AI not initialized\n`);
          return res.status(503).json({ error: "Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets." });
        }

        const { parts, sales } = req.body;
        if (!parts || !sales) {
          fs.appendFileSync(logFile, `Insights Error: Missing payload\n`);
          return res.status(400).json({ error: "Missing parts or sales payload." });
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
          achv: ((partDispatches / totalTarget) * 100).toFixed(1) + '%',
          bal: p.stock
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
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } }
      });

      res.json({ text: response.text || "Insights unavailable." });
    } catch (error: any) {
      console.error("API Insights Error:", error);
      res.status(500).json({ error: error?.message || "Failed to generate insights." });
    }
  });

  // API Route: Chat
  app.post("/api/gemini/chat", async (req, res) => {
    try {
      fs.appendFileSync(logFile, `Received /api/gemini/chat request at ${new Date().toISOString()}\n`);
      if (!ai) {
        fs.appendFileSync(logFile, `Chat Error: AI not initialized\n`);
        return res.status(503).json({ error: "Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets." });
      }

      const { message, parts, history } = req.body;
      if (!message || !parts) {
        fs.appendFileSync(logFile, `Chat Error: Missing payload\n`);
        return res.status(400).json({ error: "Missing message or parts context." });
      }

      const systemPrompt = `
        You are the Flowcon ERP AI Assistant, tracking SIAC-SKH manufacturing data.
        You have access to Rates, Dimensions (Size), Inward logs, and Dispatch targets.
        Data Context: ${JSON.stringify(parts)}
        Help the owner optimize inventory value and hit dispatch targets.
      `;

      const formattedHistory = (history || []).map((h: any) => ({
        role: h.role === 'model' ? 'model' : 'user',
        parts: [{ text: h.content }]
      }));

      const contents = [
        ...formattedHistory,
        {
          role: 'user',
          parts: [{ text: message }]
        }
      ];

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: contents,
        config: { systemInstruction: systemPrompt }
      });

      res.json({ text: response.text || "No response received." });
    } catch (error: any) {
      console.error("API Chat Error:", error);
      res.status(500).json({ error: error?.message || "Failed to process chat demand." });
    }
  });

  // API Route: Admin creates a new user (Store/Accounts/PPC/Admin)
  app.post("/api/admin/createUser", async (req, res) => {
    try {
      const callerUid = await requireAdmin(req, res);
      if (!callerUid) return; // requireAdmin already sent the response

      const { email, password, displayName, role, companyId } = req.body;
      if (!email || !password || !role) {
        return res.status(400).json({ error: "email, password, and role are required." });
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
  });

  // API Route: Admin activates/deactivates or changes a user's role
  app.post("/api/admin/updateUser", async (req, res) => {
    try {
      const callerUid = await requireAdmin(req, res);
      if (!callerUid) return;

      const { uid, role, active, displayName } = req.body;
      if (!uid) return res.status(400).json({ error: "uid is required." });
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
  });

  // Vite development middleware vs Static asset server
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
      fs.appendFileSync(logFile, `Server listening on port ${PORT} successfully\n`);
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err: any) {
    const errorLogFile = path.join(process.cwd(), "server-status.log");
    fs.appendFileSync(errorLogFile, `FATAL Server Start Error: ${err?.message}\n${err?.stack}\n`);
  }
}

startServer();
