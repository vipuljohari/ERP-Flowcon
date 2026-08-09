import { Part, Sale } from "../types";

export const getInventoryInsights = async (parts: Part[], sales: Sale[]): Promise<string> => {
  try {
    const response = await fetch("/api/gemini/insights", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parts, sales }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error ${response.status}`);
    }

    const data = await response.json();
    return data.text || "Insights unavailable.";
  } catch (error: any) {
    console.error("Client getInventoryInsights Error:", error);
    return `Error processing report: ${error?.message || "Please make sure your AI key is set up in Secrets."}`;
  }
};

export const chatWithAI = async (
  message: string,
  parts: Part[],
  history: { role: 'user' | 'model'; content: string }[]
): Promise<string> => {
  try {
    const response = await fetch("/api/gemini/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, parts, history }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error ${response.status}`);
    }

    const data = await response.json();
    return data.text || "No response received.";
  } catch (error: any) {
    console.error("Client chatWithAI Error:", error);
    return `Error processing report: ${error?.message || "Please make sure your AI key is set up in Secrets."}`;
  }
};
