// Bulk Item Master (.xlsx) upload — Admin only. Lets an admin type/paste a
// spreadsheet of item details and have the app auto-create the matching
// Parts, instead of adding them one at a time through the Item Master form.
//
// Decisions confirmed with the user before building this:
//   - If an uploaded SAP code already exists in the app, that ROW IS
//     SKIPPED — never overwrite an existing item via this path.
//   - Customer names in the "Mapped Customers" column are matched against
//     Customer Master the same tiered way Tally-import already does
//     (services/customerMatch.ts) — exact / substring / keyword.
import * as XLSX from 'xlsx';
import { Part, PartType } from '../types';
import { findMatchingCustomer } from './customerMatch';

export const ITEM_MASTER_TEMPLATE_COLUMNS = [
  'SAP Code',
  'Item Name',
  'SKU',
  'Category',
  'Part Type (Tubular / Sheet Metal)',
  'Size/Spec',
  'Base Rate',
  'Min Threshold',
  'Item Length mm (Tubular only)',
  'Item Weight Kg (Tubular, optional)',
  'Net Weight Kg (Sheet Metal only)',
  'Gross Weight Kg (Sheet Metal only)',
  'Mapped Customers (comma-separated, as per Customer Master)',
] as const;

export const downloadItemMasterTemplate = (customers: { name: string }[]) => {
  const sampleRows = [
    {
      'SAP Code': 'BOCS00099999',
      'Item Name': 'SAMPLE TUBULAR PART',
      'SKU': '999/X0001',
      'Category': 'Structural',
      'Part Type (Tubular / Sheet Metal)': 'Tubular',
      'Size/Spec': '60x40x4',
      'Base Rate': 500,
      'Min Threshold': 100,
      'Item Length mm (Tubular only)': 1200,
      'Item Weight Kg (Tubular, optional)': '',
      'Net Weight Kg (Sheet Metal only)': '',
      'Gross Weight Kg (Sheet Metal only)': '',
      'Mapped Customers (comma-separated, as per Customer Master)': customers[0]?.name || '',
    },
    {
      'SAP Code': 'BOCS00099998',
      'Item Name': 'SAMPLE SHEET METAL PART',
      'SKU': '999/X0002',
      'Category': 'Structural',
      'Part Type (Tubular / Sheet Metal)': 'Sheet Metal',
      'Size/Spec': 'Bracket 120x80',
      'Base Rate': 350,
      'Min Threshold': 100,
      'Item Length mm (Tubular only)': '',
      'Item Weight Kg (Tubular, optional)': '',
      'Net Weight Kg (Sheet Metal only)': 0.85,
      'Gross Weight Kg (Sheet Metal only)': 1.05,
      'Mapped Customers (comma-separated, as per Customer Master)': customers[0]?.name || '',
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleRows, { header: ITEM_MASTER_TEMPLATE_COLUMNS as unknown as string[] });
  worksheet['!cols'] = ITEM_MASTER_TEMPLATE_COLUMNS.map(c => ({ wch: Math.max(18, c.length * 0.9) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Item Master Template');
  XLSX.writeFile(workbook, 'Item_Master_Bulk_Upload_Template.xlsx');
};

export interface ParsedNewPart {
  data: Partial<Part>;
  rowNum: number; // 1-based, matching the Excel row (header = row 1)
  unmatchedCustomers: string[]; // entered in the sheet but not found in Customer Master
}

export interface InvalidRow {
  rowNum: number;
  reason: string;
  raw: Record<string, any>;
}

export interface SkippedRow {
  rowNum: number;
  sapCode: string;
  reason: string; // "SAP code already exists"
}

export interface BulkItemImportResult {
  newParts: ParsedNewPart[];
  skippedRows: SkippedRow[];
  invalidRows: InvalidRow[];
}

const norm = (v: any): string => (v === undefined || v === null ? '' : String(v).trim());
const toNum = (v: any): number => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
};

export const parseItemMasterExcel = (
  buffer: ArrayBuffer,
  existingParts: Part[],
  customers: { name: string }[]
): BulkItemImportResult => {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as Record<string, any>[];

  const existingSapCodes = new Set(existingParts.map(p => p.sapCode.trim().toUpperCase()));
  // Guard against duplicate SAP codes WITHIN the same upload too — first
  // occurrence wins, later ones are treated the same as "already exists".
  const seenInThisUpload = new Set<string>();

  const newParts: ParsedNewPart[] = [];
  const skippedRows: SkippedRow[] = [];
  const invalidRows: InvalidRow[] = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // header is row 1
    const getCell = (...keys: string[]): any => {
      for (const k of keys) {
        const foundKey = Object.keys(row).find(rk => rk.trim().toLowerCase().startsWith(k.toLowerCase()));
        if (foundKey && norm(row[foundKey])) return row[foundKey];
      }
      return '';
    };

    const sapCode = norm(getCell('SAP Code'));
    const name = norm(getCell('Item Name'));
    if (!sapCode && !name) return; // fully blank row, skip silently

    if (!sapCode || !name) {
      invalidRows.push({ rowNum, reason: !sapCode ? 'Missing SAP Code' : 'Missing Item Name', raw: row });
      return;
    }

    const sapUpper = sapCode.toUpperCase();
    if (existingSapCodes.has(sapUpper) || seenInThisUpload.has(sapUpper)) {
      skippedRows.push({
        rowNum,
        sapCode,
        reason: existingSapCodes.has(sapUpper) ? 'SAP code already exists in Item Master' : 'Duplicate SAP code within this upload',
      });
      return;
    }

    const partTypeRaw = norm(getCell('Part Type')).toLowerCase();
    const partType: PartType = partTypeRaw.startsWith('sheet') ? 'sheet_metal' : 'tubular';

    const netWeight = toNum(getCell('Net Weight'));
    const grossWeight = toNum(getCell('Gross Weight'));
    const itemLength = toNum(getCell('Item Length'));
    const itemWeight = toNum(getCell('Item Weight'));

    if (partType === 'sheet_metal') {
      if (grossWeight <= 0 || netWeight <= 0) {
        invalidRows.push({ rowNum, reason: 'Sheet Metal rows require both Net Weight and Gross Weight > 0', raw: row });
        return;
      }
      if (grossWeight < netWeight) {
        invalidRows.push({ rowNum, reason: 'Gross Weight must be >= Net Weight', raw: row });
        return;
      }
    } else {
      if (itemLength <= 0) {
        invalidRows.push({ rowNum, reason: 'Tubular rows require a numeric Item Length (mm) > 0', raw: row });
        return;
      }
    }

    const rate = toNum(getCell('Base Rate', 'Rate'));
    const minThreshold = toNum(getCell('Min Threshold')) || 100;
    const category = norm(getCell('Category')) || 'Structural';
    const sku = norm(getCell('SKU'));
    const size = norm(getCell('Size'));

    const customerNamesRaw = norm(getCell('Mapped Customers', 'Customers'));
    const mappedCustomers: string[] = [];
    const unmatchedCustomers: string[] = [];
    customerNamesRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
      const matched = findMatchingCustomer(entry, customers as any);
      if (matched && !mappedCustomers.includes(matched)) mappedCustomers.push(matched);
      else if (!matched) unmatchedCustomers.push(entry);
    });

    const customerRates: Record<string, number> = {};
    mappedCustomers.forEach(c => { customerRates[c] = rate; });

    seenInThisUpload.add(sapUpper);

    const data: Partial<Part> = {
      sapCode, name, sku, category, size, rate, minThreshold,
      mappedCustomers, customerRates, customerModels: {},
      partType,
      customerRMMappings: {},
    };
    if (partType === 'sheet_metal') {
      data.netWeight = netWeight;
      data.grossWeight = grossWeight;
    } else {
      data.itemLength = itemLength;
      if (itemWeight > 0) data.itemWeight = itemWeight;
    }

    newParts.push({ data, rowNum, unmatchedCustomers });
  });

  return { newParts, skippedRows, invalidRows };
};
