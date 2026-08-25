import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { handleInsights, handleChat, handleExtractInvoice, handleCreateUser, handleUpdateUser } from "./services/apiHandlers";

// The actual route logic (Gemini calls, Admin-only user management) lives
// in services/apiHandlers.ts, shared with the Vercel Serverless Functions
// under /api/**. This file is the LOCAL DEV server only (`npm run dev` /
// `npm start`) — Vercel in production never runs this file at all, it
// just builds+serves `dist` and deploys /api/**/*.ts as functions. Keeping
// one copy of the logic means the two can't silently drift apart again.

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
    fs.appendFileSync(logFile, `Firebase service account checked: ${process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? 'Found' : 'Missing'}\n`);

    // All routes below just hand off to services/apiHandlers.ts — the
    // same functions the Vercel Serverless Functions under /api/** call in
    // production. See the header comment at the top of this file.
    app.post("/api/gemini/insights", (req, res) => handleInsights(req, res));
    app.post("/api/gemini/chat", (req, res) => handleChat(req, res));
    app.post("/api/gemini/extractInvoice", (req, res) => handleExtractInvoice(req, res));
    app.post("/api/admin/createUser", (req, res) => handleCreateUser(req, res));
    app.post("/api/admin/updateUser", (req, res) => handleUpdateUser(req, res));

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
