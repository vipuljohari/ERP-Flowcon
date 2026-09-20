// Vercel Serverless Function — production entry point for POST
// /api/gate/upload. See services/apiHandlers.ts's handleGateUpload for the
// real logic (WhatsApp gate-photo capture from bot.js), and
// gemini/insights.ts's header comment for why this file needs to exist and
// why it's typed this way.
import { handleGateUpload } from "../../services/apiHandlers.js";
import type { MinimalRequest, MinimalResponse } from "../../services/apiHandlers.js";

export default async function handler(req: MinimalRequest, res: MinimalResponse) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed." });
      return;
    }
    await handleGateUpload(req, res);
  } catch (error: any) {
    console.error("gate/upload handler top-level error:", error);
    res.status(500).json({ error: error?.message || "Unexpected server error." });
  }
}
