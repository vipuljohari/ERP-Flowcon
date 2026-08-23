// Vercel Serverless Function — production entry point for POST /api/gemini/chat.
// See services/apiHandlers.ts for the real logic, and insights.ts's header
// comment for why this file needs to exist and why it's typed this way.
import { handleChat, MinimalRequest, MinimalResponse } from "../../services/apiHandlers";

export default async function handler(req: MinimalRequest, res: MinimalResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  await handleChat(req, res);
}
