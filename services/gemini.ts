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

export interface ExtractedInvoiceFields {
  manufacturerName: string;
  invoiceNo: string;
  date: string;
  materialName: string;
  materialCode: string;
  quantityPcs: number;
  ratePerPc: number;
  itemValue: number;
}

export interface ExtractedCustomerInvoiceFields {
  customerName: string;
  invoiceNo: string;
  date: string;
  quantityMtr: number;
  rate: number;
  itemValue: number;
}

const callExtractInvoice = async (imageBase64: string, mimeType: string, docType: 'manufacturer' | 'customer'): Promise<any> => {
  const response = await fetch("/api/gemini/extractInvoice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageBase64, mimeType, docType }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP error ${response.status}`);
  }

  return response.json();
};

// Reads a photo of a manufacturer's RM invoice and returns the fields the
// RM Cross-Bill Check "+ Manufacturer Invoice" form needs. Always
// review/correct the result in the form before saving — this never writes
// anything on its own.
export const extractInvoiceFromPhoto = (imageBase64: string, mimeType: string): Promise<ExtractedInvoiceFields> =>
  callExtractInvoice(imageBase64, mimeType, 'manufacturer');

// Reads a photo of your customer's cross-invoice (them reselling the RM
// back to you) and returns the fields the "+ Customer Invoice" form needs.
// Deliberately does NOT try to guess which outstanding manufacturer
// invoice this matches — that stays a manual pick in the form, since it's
// the actual judgment this whole screen exists to support.
export const extractCustomerInvoiceFromPhoto = (imageBase64: string, mimeType: string): Promise<ExtractedCustomerInvoiceFields> =>
  callExtractInvoice(imageBase64, mimeType, 'customer');

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
