
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { GoogleGenAI } from '@google/genai';
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
