
import { Part, Customer } from '../types';
import * as XLSX from 'xlsx';

export interface TallyMatchedItem {
  partId: string;
  partName: string;
  quantity: number;
  tallyName: string;
  customer: string; 
}

export interface TallyImportResult {
  matchedItems: TallyMatchedItem[];
  unmatchedNames: string[];
  detectedDate?: string; 
  detectedConsignee?: string; 
  detectedInvoice?: string; 
}

export class TallyService {
  private static findMatchingPart(tallyText: string, inventory: Part[]): Part | undefined {
    const cleanTallyText = tallyText.trim().toLowerCase();
    if (!cleanTallyText) return undefined;

    // 1. Try exact matches first
    let part = inventory.find(p => 
      p.name.trim().toLowerCase() === cleanTallyText || 
      p.sapCode.trim().toLowerCase() === cleanTallyText ||
      p.sku.trim().toLowerCase() === cleanTallyText
    );
    if (part) return part;

    // 2. Try SAP code containment (most reliable for partial strings)
    part = inventory.find(p => {
      const sap = p.sapCode.trim().toLowerCase();
      return sap.length >= 2 && cleanTallyText.includes(sap);
    });
    if (part) return part;

    // 3. Try Name containment (Reverse: does inventory name exist in the Tally string)
    part = inventory.find(p => {
      const invName = p.name.trim().toLowerCase();
      return invName.length >= 3 && cleanTallyText.includes(invName);
    });
    
    return part;
  }

  private static getAutomaticKeywords(name: string): string[] {
    const commonWords = new Set([
      'SIAC', 'SKH', 'INDIA', 'CABS', 'MFG', 'PVT', 'LTD', 'LIMITED', 'AND', 'THE', 
      'FOR', 'OF', 'CO', 'CORP', 'CORPORATION', 'PRIVATE', 'MANUFACTURING', 'PLANT',
      'DIVISION', 'GROUP', 'INDUSTRIES', 'INDUSTRY', 'ENTERPRISES', 'PVT.', 'LTD.', 'MFG.'
    ]);
    const words = name.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
    return words.filter(w => w.length > 2 && !commonWords.has(w));
  }

  private static findMatchingCustomer(tallyText: string, customers: Customer[]): string | null {
    if (!tallyText) return null;
    const text = tallyText.toUpperCase().trim();
    if (!text) return null;
    
    // Sort customers descending by name length to ensure most specific match wins first
    const sortedCustomers = [...customers].sort((a, b) => b.name.length - a.name.length);

    // 1. Exact or direct match
    for (const customer of sortedCustomers) {
      const custName = customer.name.toUpperCase();
      if (text === custName) return customer.name;
    }

    // 2. Contains entire customer name as substring
    for (const customer of sortedCustomers) {
      const custName = customer.name.toUpperCase();
      if (text.includes(custName)) return customer.name;
    }

    // 3. High-robustness normalized comparison (ignores punctuation, dots, dashes, spaces)
    const cleanTally = text.replace(/[^A-Z0-9]/g, '');
    for (const customer of sortedCustomers) {
      const cleanCust = customer.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleanCust.length >= 3) {
        // Safe: Excel consignee contains the database customer name
        if (cleanTally.includes(cleanCust)) {
          return customer.name;
        }
        // Safe: If database customer name includes the Excel text, but ONLY if clean tally is almost the entire name (>= 80% coverage)
        if (cleanCust.includes(cleanTally) && (cleanTally.length >= cleanCust.length * 0.8)) {
          return customer.name;
        }
      }
    }

    // 4. Match using user-supplied check keywords
    const keywordMatches: { keyword: string; customerName: string }[] = [];
    for (const customer of sortedCustomers) {
      if (!customer.matchKeywords) continue;
      const userKeywords = customer.matchKeywords.split(',')
        .map(k => k.trim().toUpperCase())
        .filter(k => k.length >= 3);
        
      for (const k of userKeywords) {
        // Check for full word boundary or exact containment
        const regex = new RegExp(`\\b${k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
        if (regex.test(text) || text.includes(k)) {
          keywordMatches.push({ keyword: k, customerName: customer.name });
        }
      }
    }

    if (keywordMatches.length > 0) {
      keywordMatches.sort((a, b) => b.keyword.length - a.keyword.length);
      return keywordMatches[0].customerName;
    }

    // 5. Automatic keyword match (safeguarded)
    const autoKeywordMatches: { keyword: string; customerName: string }[] = [];
    for (const customer of sortedCustomers) {
      const autoKeywords = this.getAutomaticKeywords(customer.name);
      for (const k of autoKeywords) {
        if (k.length >= 4) { // Only match on automatic keywords of length >= 4 to avoid false positives
          const regex = new RegExp(`\\b${k}\\b`, 'i');
          if (regex.test(text)) {
            autoKeywordMatches.push({ keyword: k, customerName: customer.name });
          }
        }
      }
    }

    if (autoKeywordMatches.length > 0) {
      autoKeywordMatches.sort((a, b) => b.keyword.length - a.keyword.length);
      return autoKeywordMatches[0].customerName;
    }

    return null;
  }

  private static parseExcelDate(val: any): Date | null {
    if (!val) return null;
    
    // First, support native Date objects
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return null;
      const y = val.getFullYear();
      if (y >= 2020 && y <= 2035) return val;
      return null;
    }

    // Support numbers representing Excel date serials
    if (typeof val === 'number') {
      if (val < 40000 || val > 50000) return null;
      return new Date(Math.round((val - 25569) * 86400 * 1000));
    }
    
    const str = String(val).trim();
    if (!str) return null;

    // Check if it's a numeric string representing serial date
    if (/^\d{5}(\.\d+)?$/.test(str)) {
      const num = parseFloat(str);
      if (num >= 40000 && num <= 50000) {
        return new Date(Math.round((num - 25569) * 86400 * 1000));
      }
    }

    // Match DD.MM.YYYY or DD.MM.YY
    const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
    if (dotMatch) {
      const d = parseInt(dotMatch[1]);
      const m = parseInt(dotMatch[2]) - 1;
      let y = parseInt(dotMatch[3]);
      if (y < 100) y += 2000;
      if (y >= 2020 && y <= 2035) return new Date(y, m, d);
      return null;
    }

    // Match DD/MM/YYYY or DD-MM-YYYY
    const slashMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (slashMatch) {
      const d = parseInt(slashMatch[1]);
      const m = parseInt(slashMatch[2]) - 1;
      let y = parseInt(slashMatch[3]);
      if (y < 100) y += 2000;
      if (y >= 2020 && y <= 2035) return new Date(y, m, d);
      return null;
    }

    // Try standard Date parsing for string representations like "6-Jun-26", "2026-06-06"
    // Only parse if it looks like it might contain year and month info, to avoid parsing random numbers as years
    const hasMonthWord = /[a-zA-Z]/.test(str);
    const hasYearWord = /\b(202\d|203\d)\b/.test(str);
    if (hasMonthWord || hasYearWord || str.includes('-') || str.includes('/') || str.includes('.')) {
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        if (y >= 2020 && y <= 2035) return d;
      }
    }

    return null;
  }

  static async parseTallyXml(xmlString: string, inventory: Part[], customers: Customer[], currentActiveCustomer: string): Promise<TallyImportResult> {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    const inventoryEntries = Array.from(xmlDoc.getElementsByTagName("INVENTORYENTRIES.LIST"));
    const voucherNo = xmlDoc.getElementsByTagName("VOUCHERNUMBER")[0]?.textContent || undefined;
    
    // Try to parse DATE tag (standard Tally format is YYYYMMDD)
    const rawDate = xmlDoc.getElementsByTagName("DATE")[0]?.textContent || "";
    let detectedDateStr: string | undefined = undefined;
    if (rawDate && rawDate.length === 8 && /^\d{8}$/.test(rawDate)) {
      const year = rawDate.substr(0, 4);
      const month = rawDate.substr(4, 2);
      const day = rawDate.substr(6, 2);
      detectedDateStr = `${year}-${month}-${day}T12:00:00.000`;
    }

    // Try to auto-detect Consignee/Buyer from XML tags
    const partyName = xmlDoc.getElementsByTagName("PARTYNAME")[0]?.textContent || 
                      xmlDoc.getElementsByTagName("PARTYLEDGERNAME")[0]?.textContent || 
                      xmlDoc.getElementsByTagName("BASICBUYERNAME")[0]?.textContent || 
                      xmlDoc.getElementsByTagName("CONSIGNEEMAILINGNAME")[0]?.textContent || 
                      "";
    
    const detectedCust = this.findMatchingCustomer(partyName.trim(), customers);
    const finalCustomer = detectedCust || currentActiveCustomer;

    const matchedItems: TallyMatchedItem[] = [];
    const unmatchedNames: string[] = [];
    
    for (const entry of inventoryEntries) {
      const stockItemName = entry.getElementsByTagName("STOCKITEMNAME")[0]?.textContent || "";
      const billedQtyStr = entry.getElementsByTagName("BILLEDQTY")[0]?.textContent || "0";
      const quantity = Math.abs(parseFloat(billedQtyStr.replace(/[^\d.-]/g, ''))) || 0;
      if (quantity === 0) continue;
      const part = this.findMatchingPart(stockItemName, inventory);
      if (part) {
        matchedItems.push({ partId: part.id, partName: part.name, quantity, tallyName: stockItemName, customer: finalCustomer });
      } else {
        unmatchedNames.push(stockItemName.trim());
      }
    }
    return { 
      matchedItems, 
      unmatchedNames: Array.from(new Set(unmatchedNames)), 
      detectedDate: detectedDateStr,
      detectedInvoice: voucherNo,
      detectedConsignee: detectedCust || undefined
    };
  }

  static async parseTallyExcel(buffer: ArrayBuffer, inventory: Part[], customers: Customer[], currentActiveCustomer: string): Promise<TallyImportResult> {
    const workbook = XLSX.read(buffer, { type: 'array' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
    if (jsonData.length < 1) return { matchedItems: [], unmatchedNames: [] };

    let detectedDateStr: string | undefined;
    let detectedInvoiceNo: string | undefined;
    let sheetMasterCustomer: string | null = null;

    // 1. Precise/Targeted Invoice Date and Invoice Number Seeks
    for (let r = 0; r < Math.min(30, jsonData.length); r++) {
      const row = jsonData[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const valStr = String(row[c] || "").trim();
        if (!valStr) continue;
        const lowerVal = valStr.toLowerCase();

        // Target Invoice Number
        if (!detectedInvoiceNo && (lowerVal.includes("invoice no") || lowerVal.includes("inv no") || lowerVal.includes("voucher no") || lowerVal.includes("bill no") || lowerVal.includes("invoice number") || lowerVal.includes("bill number") || lowerVal.includes("inv. no"))) {
          // Check if same cell contains both label and number e.g., "Invoice No: SL-42/26"
          if (valStr.includes(':')) {
            const afterColon = valStr.split(':').pop()?.trim() || "";
            if (afterColon && afterColon !== "0") {
              detectedInvoiceNo = afterColon.replace(/^[:#\s\/.-]+|[:#\s\/.-]+$/g, '');
            }
          }
          
          // Check right neighbor
          if (!detectedInvoiceNo && c + 1 < row.length && row[c + 1]) {
            const neighborVal = String(row[c + 1]).trim();
            if (neighborVal && neighborVal !== "0") {
              detectedInvoiceNo = neighborVal.replace(/^[:#\s\/.-]+|[:#\s\/.-]+$/g, '');
            }
          }

          // Check below neighbor
          if (!detectedInvoiceNo && r + 1 < jsonData.length && jsonData[r + 1] && jsonData[r + 1][c]) {
            const neighborBelow = String(jsonData[r + 1][c]).trim();
            if (neighborBelow && neighborBelow !== "0" && !neighborBelow.toLowerCase().includes("date")) {
              detectedInvoiceNo = neighborBelow.replace(/^[:#\s\/.-]+|[:#\s\/.-]+$/g, '');
            }
          }

          // Check below-right neighbor
          if (!detectedInvoiceNo && r + 1 < jsonData.length && jsonData[r + 1] && c + 1 < jsonData[r + 1].length && jsonData[r + 1][c + 1]) {
            const neighborBelowRight = String(jsonData[r + 1][c + 1]).trim();
            if (neighborBelowRight && neighborBelowRight !== "0" && !neighborBelowRight.toLowerCase().includes("date")) {
              detectedInvoiceNo = neighborBelowRight.replace(/^[:#\s\/.-]+|[:#\s\/.-]+$/g, '');
            }
          }
        }

        // Target Date / Dated
        if (!detectedDateStr && (lowerVal.includes("dated") || lowerVal.includes("invoice date") || lowerVal.includes("voucher date") || lowerVal.includes("inv date") || lowerVal.includes("bill date") || lowerVal === "date" || lowerVal.startsWith("date:"))) {
          // Parse standard date inside the same cell if it contains value after colon or text
          const cleanCellVal = valStr.replace(/^[A-Za-z.\s:]+/, '').trim();
          let d = cleanCellVal ? this.parseExcelDate(cleanCellVal) : null;
          if (d) {
            const pad = (num: number) => String(num).padStart(2, '0');
            detectedDateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00:00.000`;
          }

          // Check right neighbor
          if (!detectedDateStr && c + 1 < row.length && row[c + 1]) {
            d = this.parseExcelDate(row[c + 1]);
            if (d) {
              const pad = (num: number) => String(num).padStart(2, '0');
              detectedDateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00:00.000`;
            }
          }

          // Check cell below
          if (!detectedDateStr && r + 1 < jsonData.length && jsonData[r + 1] && jsonData[r + 1][c]) {
            d = this.parseExcelDate(jsonData[r + 1][c]);
            if (d) {
              const pad = (num: number) => String(num).padStart(2, '0');
              detectedDateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00:00.000`;
            }
          }

          // Check cell below-right
          if (!detectedDateStr && r + 1 < jsonData.length && jsonData[r + 1] && c + 1 < jsonData[r + 1].length && jsonData[r + 1][c + 1]) {
            d = this.parseExcelDate(jsonData[r + 1][c + 1]);
            if (d) {
              const pad = (num: number) => String(num).padStart(2, '0');
              detectedDateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00:00.000`;
            }
          }
        }
      }
    }

    // 2. Fallback Invoice Date Scan (if not yet found near labels)
    if (!detectedDateStr) {
      for (let r = 0; r < Math.min(15, jsonData.length); r++) {
        const row = jsonData[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
          const d = this.parseExcelDate(row[c]);
          if (d) {
            const pad = (num: number) => String(num).padStart(2, '0');
            detectedDateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00:00.000`;
            break;
          }
        }
        if (detectedDateStr) break;
      }
    }

    // 3. Search specifically for labeled fields of consignee, buyer, or bill/ship to
    // to target the correct box and avoid false-matching of our own seller info
    let consigneeLabelRow = -1;
    let consigneeLabelCol = -1;
    for (let r = 0; r < Math.min(30, jsonData.length); r++) {
      const row = jsonData[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const val = String(row[c] || "").toLowerCase();
        if (val.includes("consignee") || val.includes("buyer") || val.includes("bill to") || val.includes("billed to") || val.includes("party's name")) {
          consigneeLabelRow = r;
          consigneeLabelCol = c;
          break;
        }
      }
      if (consigneeLabelRow !== -1) break;
    }

    if (consigneeLabelRow !== -1) {
      const candidates: string[] = [];
      const colStart = consigneeLabelCol;
      const colEnd = Math.min(colStart + 3, jsonData[consigneeLabelRow].length);
      const rowStart = consigneeLabelRow;
      const rowEnd = Math.min(rowStart + 4, jsonData.length);
      
      for (let r = rowStart; r < rowEnd; r++) {
        const row = jsonData[r];
        if (!row) continue;
        for (let c = colStart; c < colEnd; c++) {
          const val = String(row[c] || "").trim();
          if (val) {
            candidates.push(val);
          }
        }
      }

      // Try matching candidates
      for (const cand of candidates) {
        const matched = this.findMatchingCustomer(cand, customers);
        if (matched) {
          sheetMasterCustomer = matched;
          break;
        }
      }
    }

    // Default fallback to cell A11 check if not yet matched (extremely common in standard Tally reports)
    if (!sheetMasterCustomer && jsonData[10] && jsonData[10][0]) {
      const a11Value = String(jsonData[10][0]).trim();
      sheetMasterCustomer = this.findMatchingCustomer(a11Value, customers);
    }

    // Secondary fallback cel-by-cell scan (restricted to row >= 8 where buyer info typically lies)
    if (!sheetMasterCustomer) {
      for (let r = 8; r < Math.min(20, jsonData.length); r++) {
        const row = jsonData[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
          const val = String(row[c] || "").trim();
          if (!val) continue;
          const matched = this.findMatchingCustomer(val, customers);
          if (matched) {
            sheetMasterCustomer = matched;
            break;
          }
        }
        if (sheetMasterCustomer) break;
      }
    }

    let itemColIdx = -1, qtyColIdx = -1;
    for (let r = 0; r < Math.min(40, jsonData.length); r++) {
      const row = jsonData[r]; if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const val = String(row[c] || "").toLowerCase();
        if (val.includes("particulars") || val.includes("item") || val.includes("description") || val.includes("part name") || val.includes("stock item")) itemColIdx = c;
        if (val.includes("qty") || val.includes("quantity") || val.includes("billed") || val.includes("pcs") || val.includes("nos")) qtyColIdx = c;
      }
      if (itemColIdx !== -1 && qtyColIdx !== -1) break;
    }
    if (itemColIdx === -1) itemColIdx = 1;

    const matchedItems: TallyMatchedItem[] = [];
    const unmatchedNames: string[] = [];
    for (let r = 0; r < jsonData.length; r++) {
      const row = jsonData[r]; if (!row || row.length < 2) continue;
      const stockItemName = String(row[itemColIdx] || "").trim();
      const billedQtyStr = qtyColIdx !== -1 ? String(row[qtyColIdx] || "0") : "0";
      const quantity = Math.abs(parseFloat(billedQtyStr.replace(/[^\d.-]/g, ''))) || 0;
      if (!stockItemName || quantity === 0 || stockItemName.toLowerCase().includes("total")) continue;

      const part = this.findMatchingPart(stockItemName, inventory);
      if (part) {
        const finalCustomer = sheetMasterCustomer || currentActiveCustomer;
        matchedItems.push({ partId: part.id, partName: part.name, quantity, tallyName: stockItemName, customer: finalCustomer });
      } else if (stockItemName.length > 3) {
        unmatchedNames.push(stockItemName);
      }
    }

    return { 
      matchedItems, 
      unmatchedNames: Array.from(new Set(unmatchedNames)), 
      detectedDate: detectedDateStr, 
      detectedConsignee: sheetMasterCustomer || undefined, 
      detectedInvoice: detectedInvoiceNo 
    };
  }
}
