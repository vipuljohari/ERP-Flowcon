// Vercel Serverless Function — production entry point for POST
// /api/dropbox/archivePhoto. See services/apiHandlers.ts for the real
// logic (Dropbox refresh-token exchange + upload), and gemini/insights.ts's
// header comment for why this file needs to exist and why it's typed this
// way.
import { handleArchivePhoto } from "../../services/apiHandlers.js";
import type { MinimalRequest, MinimalResponse } from "../../services/apiHandlers.js";

export default async function handler(req: MinimalRequest, res: MinimalResponse) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed." });
      return;
    }
    await handleArchivePhoto(req, res);
  } catch (error: any) {
    console.error("archivePhoto handler top-level error:", error);
    res.status(500).json({ error: error?.message || "Unexpected server error." });
  }
}
