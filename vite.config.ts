
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { GoogleGenAI, Type } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

// Bulletproof dev middleware for Gemini API endpoints when served directly via Vite dev server
const geminiApiPlugin = () => {
  return {
    name: 'gemini-api-plugin',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (!req.url) return next();
        
        if (req.url.startsWith('/api/gemini/')) {
          const logFile = path.join(process.cwd(), "server-status.log");
          const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
          
          if (!apiKey) {
            fs.appendFileSync(logFile, `[Vite Dev API] Error: API key missing\n`);
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: "Gemini API key is not configured. Please add GEMINI_API_KEY under Settings > Secrets." }));
            return;
          }
          
          const ai = new GoogleGenAI({
            apiKey: apiKey,
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
          });
          
          let body = '';
          req.on('data', (chunk: any) => {
            body += chunk;
          });
          
          req.on('end', async () => {
            try {
              const payload = JSON.parse(body || '{}');
              
              if (req.url === '/api/gemini/insights') {
                fs.appendFileSync(logFile, `[Vite Dev API] Received insights request at ${new Date().toISOString()}\n`);
                const { parts, sales } = payload;
                if (!parts || !sales) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "Missing parts or sales payload." }));
                  return;
                }
                
                const summary = parts.map((p: any) => {
                  const partDispatches = sales
                    .filter((s: any) => s.partId === p.id)
                    .reduce((sum: number, s: any) => sum + s.quantity, 0);
                  const totalTarget = Object.values(p.schedules || {}).reduce((acc: number, val: any) => acc + (Number(val) || 0), 0) || 1;
                  return {
                    name: p.name,
                    rate: p.rate,
                    inward: p.inward,
                    disp: partDispatches,
                    achv: ((partDispatches / totalTarget) * 100).toFixed(1) + '%',
                    bal: p.stock
                  };
                });
                
                const prompt = `
                  Analyze this precise manufacturing report.
                  Columns include Rate, Inward qty, Dispatch qty, and Total Stock (Balance).
                  Parts Data: ${JSON.stringify(summary)}
                  
                  Provide:
                  1. Financial impact: Identify high-value inventory bottlenecks (Rate * Balance).
                  2. Logistics warning: Identify parts where Inward is high but Dispatch is low (potential overstock).
                  3. Achievement gaps: Which parts are falling behind targets despite having inward stock available.
                  
                  Focus on specific part names and keep it business-ready.
                `;
                
                const response = await ai.models.generateContent({
                  model: 'gemini-3.5-flash',
                  contents: prompt,
                  config: { thinkingConfig: { thinkingBudget: 0 } }
                });
                
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ text: response.text || "Insights unavailable." }));
              } else if (req.url === '/api/gemini/chat') {
                fs.appendFileSync(logFile, `[Vite Dev API] Received chat request at ${new Date().toISOString()}\n`);
                const { message, parts, history } = payload;
                if (!message || !parts) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "Missing message or parts context." }));
                  return;
                }
                
                const systemPrompt = `
                  You are the Flowcon ERP AI Assistant, tracking SIAC-SKH manufacturing data.
                  You have access to Rates, Dimensions (Size), Inward logs, and Dispatch targets.
                  Data Context: ${JSON.stringify(parts)}
                  Help the owner optimize inventory value and hit dispatch targets.
                `;
                
                const formattedHistory = (history || []).map((h: any) => ({
                  role: h.role === 'model' ? 'model' : 'user',
                  parts: [{ text: h.content }]
                }));
                
                const contents = [
                  ...formattedHistory,
                  {
                    role: 'user',
                    parts: [{ text: message }]
                  }
                ];
                
                const response = await ai.models.generateContent({
                  model: 'gemini-3.5-flash',
                  contents: contents,
                  config: { systemInstruction: systemPrompt }
                });
                
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ text: response.text || "No response received." }));
              } else if (req.url === '/api/gemini/extractInvoice') {
                fs.appendFileSync(logFile, `[Vite Dev API] Received extractInvoice request at ${new Date().toISOString()}\n`);
                const { imageBase64, mimeType, docType } = payload;
                if (!imageBase64 || !mimeType) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "Missing imageBase64 or mimeType." }));
                  return;
                }
                const isCustomer = docType === 'customer';

                const extractPrompt = isCustomer ? `
                  This is a photo of a Customer Cross-Invoice: a GST tax invoice your
                  OWN customer (e.g. SIAC-SKH India Cabs Mfg Pvt Ltd) issued to you,
                  reselling raw material back to you at their own markup.

                  Read the invoice and extract these exact fields:
                  - customerName: the SELLER company's name, from the letterhead at the
                    top of the invoice — this is your own customer's name, NOT your
                    own company's name (do not extract "Flowcon" or similar here).
                  - invoiceNo: the Invoice No field.
                  - date: the Invoice Date, formatted as YYYY-MM-DD.
                  - quantityMtr: the invoiced quantity in meters, as a plain number.
                  - rate: the rate, as a plain number.
                  - itemValue: the item value BEFORE tax (Item Value / Total Item
                    Value), as a plain number.

                  If the invoice has more than one line item, extract only the FIRST
                  one. If a field genuinely can't be read, use "" for text fields or 0
                  for number fields — never guess a value that isn't legible.
                ` : `
                  This is a photo of a Raw Material manufacturer's GST tax invoice (e.g.
                  from Tube Investments of India Ltd or a similar steel tube/sheet
                  supplier), sent to a manufacturing customer.

                  Read the invoice and extract these exact fields:
                  - manufacturerName: the SELLER company's name, from the letterhead at
                    the top of the invoice — NOT the "Bill to" / "Ship to" customer.
                  - invoiceNo: the Invoice No field.
                  - date: the Invoice Date, formatted as YYYY-MM-DD.
                  - materialName: the material/item description line, exactly as
                    printed (e.g. "STEEL TUBES-ERW/SB-RECTANGLE-90.00 X 50.00 X 2.90 X
                    4950.00-AS ROLLED").
                  - materialCode: the CUSTOMER's own part code for this material —
                    usually printed as "Cust Part No" (or similar) near the item
                    description, often starting with letters like "BOCS" or "RMSS".
                    Prefer this over any separate internal vendor/item code. Report
                    just the code itself — drop any trailing period or other
                    punctuation from the source layout that isn't actually part of
                    the code (e.g. "RMSS00000119." -> "RMSS00000119").
                  - quantityPcs: the invoiced quantity, as a plain number (Qty column).
                  - ratePerPc: the rate per piece, as a plain number (Item Rate column).
                  - itemValue: the item value BEFORE tax (Item Value / Total Item
                    Value), as a plain number.

                  If the invoice has more than one line item, extract only the FIRST
                  one. If a field genuinely can't be read, use "" for text fields or 0
                  for number fields — never guess a value that isn't legible.
                `;

                const extractResponseSchema = isCustomer ? {
                  type: Type.OBJECT,
                  properties: {
                    customerName: { type: Type.STRING },
                    invoiceNo: { type: Type.STRING },
                    date: { type: Type.STRING },
                    quantityMtr: { type: Type.NUMBER },
                    rate: { type: Type.NUMBER },
                    itemValue: { type: Type.NUMBER },
                  },
                  required: ['customerName', 'invoiceNo', 'date', 'quantityMtr', 'rate', 'itemValue'],
                } : {
                  type: Type.OBJECT,
                  properties: {
                    manufacturerName: { type: Type.STRING },
                    invoiceNo: { type: Type.STRING },
                    date: { type: Type.STRING },
                    materialName: { type: Type.STRING },
                    materialCode: { type: Type.STRING },
                    quantityPcs: { type: Type.NUMBER },
                    ratePerPc: { type: Type.NUMBER },
                    itemValue: { type: Type.NUMBER },
                  },
                  required: ['manufacturerName', 'invoiceNo', 'date', 'materialName', 'materialCode', 'quantityPcs', 'ratePerPc', 'itemValue'],
                };

                const extractResponse = await ai.models.generateContent({
                  model: 'gemini-3.5-flash',
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        { text: extractPrompt },
                        { inlineData: { data: imageBase64, mimeType } },
                      ],
                    },
                  ],
                  config: {
                    responseMimeType: 'application/json',
                    responseSchema: extractResponseSchema,
                  },
                });

                let extractParsed: any;
                try {
                  extractParsed = JSON.parse(extractResponse.text || '{}');
                } catch {
                  res.statusCode = 502;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'Could not make sense of this photo. Try a clearer, better-lit shot.' }));
                  return;
                }

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                if (isCustomer) {
                  res.end(JSON.stringify({
                    customerName: String(extractParsed.customerName || '').trim(),
                    invoiceNo: String(extractParsed.invoiceNo || '').trim(),
                    date: String(extractParsed.date || '').trim(),
                    quantityMtr: Number(extractParsed.quantityMtr) || 0,
                    rate: Number(extractParsed.rate) || 0,
                    itemValue: Number(extractParsed.itemValue) || 0,
                  }));
                } else {
                  res.end(JSON.stringify({
                    manufacturerName: String(extractParsed.manufacturerName || '').trim(),
                    invoiceNo: String(extractParsed.invoiceNo || '').trim(),
                    date: String(extractParsed.date || '').trim(),
                    materialName: String(extractParsed.materialName || '').trim(),
                    materialCode: String(extractParsed.materialCode || '').trim().replace(/[.\s]+$/, ''),
                    quantityPcs: Number(extractParsed.quantityPcs) || 0,
                    ratePerPc: Number(extractParsed.ratePerPc) || 0,
                    itemValue: Number(extractParsed.itemValue) || 0,
                  }));
                }
              } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "Not found" }));
              }
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err?.message || "Internal server error" }));
            }
          });
        } else {
          next();
        }
      });
    }
  };
};

export default defineConfig({
  plugins: [react(), geminiApiPlugin()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: './index.html',
      },
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-utils': ['xlsx', 'recharts', 'dropbox'],
          'vendor-ai': ['@google/genai']
        }
      }
    },
  },
  define: {
    'process.env.API_KEY': JSON.stringify(process.env.API_KEY || '')
  }
});
