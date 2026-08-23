// Bulk Customer Schedule upload (.xlsx, multi-sheet) — Admin only. The
// admin copies a customer's schedule table straight out of an email and
// pastes it into an Excel sheet (one sheet per customer); this parses every
// sheet, matches the sheet name to a real Customer, auto-detects which
// column holds SAP codes and which holds the quantity, and overwrites
// Part.schedules[customerName] for every matched row.
//
// This is inherently a best-effort heuristic — pasted-email tables have no
// fixed layout — so every detected sheet/customer/column is admin
// -overridable in the review screen (components/BulkScheduleImport.tsx)
// before anything is written. Nothing here writes to Firestore.
import * as XLSX from 'xlsx';
import { Part, Customer } from '../types';
import { findMatchingCustomer, findMatchingPartBySapOrName } from './customerMatch';

export interface ScheduleUpdateRow {
  rowIndex: number; // 0-based index into the sheet's raw rows
  sapCodeText: string;
  partId: string;
  partName: string;
  sapCode: string;
  qty: number;
  oldValue: number;
}

export interface ScheduleUnmatchedRow {
  rowIndex: number;
  sapCodeText: string;
  qtyText: string;
}

export interface ParsedScheduleSheet {
  sheetName: string;
  customerName: string | null; // best-guess match; null = admin must pick
  rows: any[][]; // raw rows, exposed so the review UI can re-derive on column override
  columnCount: number;
  sapColIndex: number; // -1 = not detected
  qtyColIndex: number; // -1 = not detected
  updates: ScheduleUpdateRow[];
  unmatched: ScheduleUnmatchedRow[];
}

const norm = (v: any): string => (v === undefined || v === null ? '' : String(v).trim());

const looksNumeric = (text: string): boolean => {
  const t = text.replace(/,/g, '').trim();
  if (!t) return false;
  return /^-?\d+(\.\d+)?$/.test(t);
};

const toNum = (v: any): number => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? NaN : n;
};

// Scores each column by how many of its non-empty cells match a real SAP
// code — exact match first, then "cell contains a real SAP code" (handles
// pasted cells like "BOCS00001242 - A Post LH"). The column with the most
// matches wins; ties go to the earliest column.
const detectSapColumn = (rows: any[][], sapCodes: string[]): number => {
  const sapSet = new Set(sapCodes.map(s => s.toUpperCase()));
  const sapList = sapCodes.filter(s => s.length >= 4).map(s => s.toUpperCase());
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

  let bestCol = -1;
  let bestScore = 0;
  for (let c = 0; c < maxCols; c++) {
    let score = 0;
    for (const row of rows) {
      const text = norm(row[c]).toUpperCase();
      if (!text) continue;
      if (sapSet.has(text)) { score++; continue; }
      if (sapList.some(sap => text.includes(sap))) score++;
    }
    if (score > bestScore) { bestScore = score; bestCol = c; }
  }
  return bestScore > 0 ? bestCol : -1;
};

// Among all columns except the SAP column, scores by the fraction of
// non-empty cells that parse as a plain number, then picks the highest-
// scoring column closest to the SAP column (schedule quantities are almost
// always the immediate neighbor in a pasted table).
const detectQtyColumn = (rows: any[][], sapColIndex: number): number => {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const candidates: { col: number; ratio: number }[] = [];

  for (let c = 0; c < maxCols; c++) {
    if (c === sapColIndex) continue;
    let numeric = 0, nonEmpty = 0;
    for (const row of rows) {
      const text = norm(row[c]);
      if (!text) continue;
      nonEmpty++;
      if (looksNumeric(text)) numeric++;
    }
    const ratio = nonEmpty > 0 ? numeric / nonEmpty : 0;
    if (nonEmpty >= 1 && ratio >= 0.5) candidates.push({ col: c, ratio });
  }

  if (candidates.length === 0) return -1;
  candidates.sort((a, b) => {
    const distA = sapColIndex === -1 ? 0 : Math.abs(a.col - sapColIndex);
    const distB = sapColIndex === -1 ? 0 : Math.abs(b.col - sapColIndex);
    if (distA !== distB) return distA - distB;
    return b.ratio - a.ratio;
  });
  return candidates[0].col;
};

// Builds the matched/unmatched row lists for one sheet given a chosen
// (sapCol, qtyCol, customerName) — re-run this whenever the admin overrides
// a dropdown in the review screen, without re-parsing the whole workbook.
export const buildScheduleRows = (
  rows: any[][],
  sapColIndex: number,
  qtyColIndex: number,
  customerName: string | null,
  inventory: Part[]
): { updates: ScheduleUpdateRow[]; unmatched: ScheduleUnmatchedRow[] } => {
  const updates: ScheduleUpdateRow[] = [];
  const unmatched: ScheduleUnmatchedRow[] = [];
  if (sapColIndex === -1) return { updates, unmatched };

  rows.forEach((row, rowIndex) => {
    const sapCodeText = norm(row[sapColIndex]);
    if (!sapCodeText) return; // blank row, skip silently

    const qtyText = qtyColIndex !== -1 ? norm(row[qtyColIndex]) : '';
    const qty = toNum(qtyText);

    const part = findMatchingPartBySapOrName(sapCodeText, inventory);
    if (!part || isNaN(qty)) {
      unmatched.push({ rowIndex, sapCodeText, qtyText });
      return;
    }

    const oldValue = (customerName && part.schedules?.[customerName]) || 0;
    updates.push({
      rowIndex, sapCodeText, partId: part.id, partName: part.name, sapCode: part.sapCode,
      qty, oldValue,
    });
  });

  return { updates, unmatched };
};

export const parseScheduleWorkbook = (
  buffer: ArrayBuffer,
  inventory: Part[],
  customers: Customer[]
): ParsedScheduleSheet[] => {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sapCodes = inventory.map(p => p.sapCode).filter(Boolean);

  return workbook.SheetNames.map(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    const customerName = findMatchingCustomer(sheetName, customers);
    const sapColIndex = detectSapColumn(rows, sapCodes);
    const qtyColIndex = detectQtyColumn(rows, sapColIndex);
    const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0);

    const { updates, unmatched } = buildScheduleRows(rows, sapColIndex, qtyColIndex, customerName, inventory);

    return { sheetName, customerName, rows, columnCount, sapColIndex, qtyColIndex, updates, unmatched };
  });
};
