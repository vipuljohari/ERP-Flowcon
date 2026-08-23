// Vercel Serverless Function — production entry point for POST /api/admin/createUser.
// See services/apiHandlers.ts for the real logic, and gemini/insights.ts's
// header comment for why this file needs to exist and why it's typed this way.
import { handleCreateUser } from "../../services/apiHandlers.js";
import type { MinimalRequest, MinimalResponse } from "../../services/apiHandlers.js";

export default async function handler(req: MinimalRequest, res: MinimalResponse) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed." });
      return;
    }
    await handleCreateUser(req, res);
  } catch (error: any) {
    // Last line of defense: handleCreateUser already catches everything it
    // can, but if something outside that (module load, a rejected promise
    // slipping past) throws, this still returns real JSON instead of
    // Vercel's generic HTML crash page — which is what made the earlier
    // "Unexpected token 'A', 'A server e'..." error so hard to diagnose.
    console.error("createUser handler top-level error:", error);
    res.status(500).json({ error: error?.message || "Unexpected server error." });
  }
}
