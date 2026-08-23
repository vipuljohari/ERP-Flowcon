// Vercel Serverless Function — production entry point for POST /api/admin/updateUser.
// See services/apiHandlers.ts for the real logic, and gemini/insights.ts's
// header comment for why this file needs to exist and why it's typed this way.
import { handleUpdateUser } from "../../services/apiHandlers.js";
import type { MinimalRequest, MinimalResponse } from "../../services/apiHandlers.js";

export default async function handler(req: MinimalRequest, res: MinimalResponse) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed." });
      return;
    }
    await handleUpdateUser(req, res);
  } catch (error: any) {
    console.error("updateUser handler top-level error:", error);
    res.status(500).json({ error: error?.message || "Unexpected server error." });
  }
}
