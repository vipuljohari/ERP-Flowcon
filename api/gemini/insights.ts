// Vercel Serverless Function — production entry point for POST /api/gemini/insights.
// Vercel's Vite auto-detection only builds/serves the static `dist` output;
// this file (and its siblings under /api) is what actually makes the path
// exist in production. See services/apiHandlers.ts for the real logic.
//
// Typed against MinimalRequest/MinimalResponse rather than @vercel/node's
// VercelRequest/VercelResponse on purpose — it's structurally compatible
// (Vercel's real req/res objects satisfy this shape at runtime regardless
// of the type annotation here) and avoids adding a new dependency just for
// type-only imports.
import { handleInsights } from "../../services/apiHandlers";
import type { MinimalRequest, MinimalResponse } from "../../services/apiHandlers";

export default async function handler(req: MinimalRequest, res: MinimalResponse) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed." });
      return;
    }
    await handleInsights(req, res);
  } catch (error: any) {
    console.error("insights handler top-level error:", error);
    res.status(500).json({ error: error?.message || "Unexpected server error." });
  }
}
