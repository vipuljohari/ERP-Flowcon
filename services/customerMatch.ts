// Shared customer-name matching, extracted from services/tally.ts so Bulk
// Item Master import (services/bulkItemImport.ts) and Bulk Schedule import
// (components/BulkScheduleImport.tsx) use the exact same tiered logic the
// Tally importer has always used — instead of a second copy that could
// silently drift out of sync with it.
//
// Tiers, most confident first: exact name match -> text contains the full
// customer name -> normalized (punctuation-stripped) containment either
// direction -> admin-entered `matchKeywords` -> auto-derived keywords from
// the customer's own name (common corporate words like "PVT"/"LTD" filtered
// out so they can't false-match everything).
import { Customer } from '../types';

const getAutomaticKeywords = (name: string): string[] => {
  const commonWords = new Set([
    'SIAC', 'SKH', 'INDIA', 'CABS', 'MFG', 'PVT', 'LTD', 'LIMITED', 'AND', 'THE',
    'FOR', 'OF', 'CO', 'CORP', 'CORPORATION', 'PRIVATE', 'MANUFACTURING', 'PLANT',
    'DIVISION', 'GROUP', 'INDUSTRIES', 'INDUSTRY', 'ENTERPRISES', 'PVT.', 'LTD.', 'MFG.'
  ]);
  const words = name.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
  return words.filter(w => w.length > 2 && !commonWords.has(w));
};

export const findMatchingCustomer = (rawText: string, customers: Customer[]): string | null => {
  if (!rawText) return null;
  const text = rawText.toUpperCase().trim();
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
      if (cleanTally.includes(cleanCust)) {
        return customer.name;
      }
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
    const autoKeywords = getAutomaticKeywords(customer.name);
    for (const k of autoKeywords) {
      if (k.length >= 4) {
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
};

// Same 3-tier logic TallyService.findMatchingPart uses (exact -> SAP-code
// containment -> name containment), exposed here so bulk-schedule column
// detection (services/bulkScheduleImport logic in BulkScheduleImport.tsx)
// can score "does this column look like SAP codes" without re-deriving it.
export const findMatchingPartBySapOrName = <T extends { name: string; sapCode: string; sku: string }>(
  text: string,
  inventory: T[]
): T | undefined => {
  const cleanText = text.trim().toLowerCase();
  if (!cleanText) return undefined;

  let part = inventory.find(p =>
    p.name.trim().toLowerCase() === cleanText ||
    p.sapCode.trim().toLowerCase() === cleanText ||
    p.sku.trim().toLowerCase() === cleanText
  );
  if (part) return part;

  part = inventory.find(p => {
    const sap = p.sapCode.trim().toLowerCase();
    return sap.length >= 2 && cleanText.includes(sap);
  });
  if (part) return part;

  part = inventory.find(p => {
    const invName = p.name.trim().toLowerCase();
    return invName.length >= 3 && cleanText.includes(invName);
  });

  return part;
};
