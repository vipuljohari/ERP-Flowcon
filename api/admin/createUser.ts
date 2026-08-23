// Vercel Serverless Function — production entry point for POST /api/admin/createUser.
// See services/apiHandlers.ts for the real logic, and gemini/insights.ts's
// header comment for why this file needs to exist and why it's typed this way.
import { handleCreateUser, MinimalRequest, MinimalResponse } from "../../services/apiHandlers";

export default async function handler(req: MinimalRequest, res: MinimalResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  await handleCreateUser(req, res);
}
