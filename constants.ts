import { Part, Customer } from './types';

export const INITIAL_CUSTOMERS: Customer[] = [
  { id: 'c1', name: 'SIAC-SKH INDIA CABS Mfg. Pvt. Ltd. Palwal', matchKeywords: 'PRITHLA, SKH-P, FARIDABAD, PALWAL, SIAC-PALWAL' },
  { id: 'c2', name: 'SIAC-SKH INDIA CABS MFG Pvt. Ltd. Jaipur', matchKeywords: 'JAIPUR, RAJASTHAN, SKH-J, SIAC-JAIPUR' }
];

const N1 = 'SIAC-SKH INDIA CABS Mfg. Pvt. Ltd. Palwal';
const N2 = 'SIAC-SKH INDIA CABS MFG Pvt. Ltd. Jaipur';

export const INITIAL_PARTS: Part[] = [
  { id: '1', sapCode: 'BOCS00001242', sku: '334/Y5847', name: 'A- POST LH (HT)', category: 'Structural', rate: 1215.72, customerRates: { [N1]: 1215.72, [N2]: 1215.72 }, size: 'Butterfly 70x50x30x3.2', stock: 1217, inward: 602, schedules: { [N1]: 400, [N2]: 376 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 200, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '2', sapCode: 'BOCS00001243', sku: '334/Y5495', name: 'A- POST RH (HT)', category: 'Structural', rate: 1215.82, customerRates: { [N1]: 1215.82, [N2]: 1215.82 }, size: 'Butterfly 70x50x30x3.2', stock: 1209, inward: 604, schedules: { [N1]: 300, [N2]: 280 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 200, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '3', sapCode: 'BOCS00006483', sku: '333/Y9864', name: 'BULKHEAD RAIL (HT)', category: 'Rail Systems', rate: 545.11, customerRates: { [N1]: 545.11, [N2]: 545.11 }, size: '60x30x3', stock: 3256, inward: 1026, schedules: { [N1]: 300, [N2]: 284 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 100, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '4', sapCode: 'BOCS00006549', sku: '332/G6974', name: 'SIDE RAIL LH (HT)', category: 'Rail Systems', rate: 755.33, customerRates: { [N1]: 755.33, [N2]: 755.33 }, size: '90x50x3', stock: 260, inward: 0, schedules: { [N1]: 330, [N2]: 337 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 300, status: 'Low Stock', lastUpdated: new Date().toISOString() },
  { id: '5', sapCode: 'BOCS00006550', sku: '332/G6975', name: 'SIDE RAIL RH (HT)', category: 'Rail Systems', rate: 755.33, customerRates: { [N1]: 755.33, [N2]: 755.33 }, size: '90x50x3', stock: 226, inward: 0, schedules: { [N1]: 330, [N2]: 329 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 300, status: 'Low Stock', lastUpdated: new Date().toISOString() },
  { id: '6', sapCode: 'BOCS00001249', sku: '332/G5382', name: 'BOTTOM RAIL (HT)', category: 'Rail Systems', rate: 853.74, customerRates: { [N1]: 853.74, [N2]: 853.74 }, size: '60x40x4', stock: 2000, inward: 900, schedules: { [N1]: 334, [N2]: 334 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 200, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '7', sapCode: 'BOCS00001245', sku: '332/G5408', name: 'LH FLOOR RAIL (HT)', category: 'Rail Systems', rate: 533.86, customerRates: { [N1]: 533.86, [N2]: 533.86 }, size: '60x40x4', stock: 1942, inward: 765, schedules: { [N1]: 170, [N2]: 177 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 150, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '8', sapCode: 'BOCS00001244', sku: '332/G5407', name: 'RH FLOOR RAIL (HT)', category: 'Rail Systems', rate: 533.86, customerRates: { [N1]: 533.86, [N2]: 533.86 }, size: '60x40x4', stock: 1488, inward: 765, schedules: { [N1]: 221, [N2]: 221 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 150, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '9', sapCode: 'BOCS00000057', sku: '332/Y8707', name: 'LH C POST', category: 'Body Posts', rate: 263.55, customerRates: { [N1]: 263.55, [N2]: 263.55 }, size: 'C Post', stock: 715, inward: 1595, schedules: { [N1]: 260, [N2]: 255 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 100, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '10', sapCode: 'BOCS00000061', sku: '332/Y5303', name: 'RH C POST', category: 'Body Posts', rate: 263.55, customerRates: { [N1]: 263.55, [N2]: 263.55 }, size: 'C Post', stock: 897, inward: 1595, schedules: { [N1]: 233, [N2]: 230 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 100, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '11', sapCode: 'BOCS00000053', sku: '332/F9815', name: 'LH GRAB HANDLE', category: 'Interior Trim', rate: 162.24, customerRates: { [N1]: 162.24, [N2]: 162.24 }, size: '31.75x2x1384', stock: 1090, inward: 1600, schedules: { [N1]: 349, [N2]: 349 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 200, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '12', sapCode: 'BOCS00000054', sku: '332/F9908', name: 'RH GRAB HANDLE', category: 'Interior Trim', rate: 162.24, customerRates: { [N1]: 162.24, [N2]: 162.24 }, size: '31.75x2x1384', stock: 799, inward: 1599, schedules: { [N1]: 370, [N2]: 373 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 200, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '13', sapCode: 'BOCS00000065', sku: '332/F5434', name: 'DOOR GRAB HANDLE', category: 'Interior Trim', rate: 111.34, customerRates: { [N1]: 111.34, [N2]: 111.34 }, size: '31.75x2.5x763', stock: 2060, inward: 0, schedules: { [N1]: 822, [N2]: 822 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 300, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '14', sapCode: 'BOCS00000064', sku: '333/C5780', name: 'TUBE DOOR FRAME LOWER', category: 'Frame Tubing', rate: 259.24, customerRates: { [N1]: 259.24, [N2]: 259.24 }, size: '25x25x2x 2121mm', stock: 497, inward: 0, schedules: { [N1]: 877, [N2]: 878 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 600, status: 'Low Stock', lastUpdated: new Date().toISOString() },
  { id: '15', sapCode: 'BOCS00000063', sku: '333/C5809', name: 'TUBE DOOR FRAME UPPER', category: 'Frame Tubing', rate: 194.87, customerRates: { [N1]: 194.87, [N2]: 194.87 }, size: '25x25x2x 1475mm', stock: 1556, inward: 1856, schedules: { [N1]: 825, [N2]: 825 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 400, status: 'In Stock', lastUpdated: new Date().toISOString() },
  { id: '16', sapCode: 'BOCS00000081', sku: '333/C5859', name: 'TUBE WINDOW FRAME REAR', category: 'Frame Tubing', rate: 225.22, customerRates: { [N1]: 225.22, [N2]: 225.22 }, size: '25x25x2x 1882mm', stock: 142, inward: 0, schedules: { [N1]: 806, [N2]: 806 }, mappedCustomers: [N1, N2], revisionCount: 0, minThreshold: 300, status: 'Low Stock', lastUpdated: new Date().toISOString() },
];

export const CATEGORIES = [
  'Structural', 'Rail Systems', 'Body Posts', 'Interior Trim', 'Frame Tubing'
];

// The date the new Material Entry ("Longer Pipe" / "Finished Pieces")
// feature went live. Any RM Cross-Bill Manufacturer Invoice dated before
// this can never be pulled into Material Entry — it was already reconciled
// under the old, simpler Material Entry rules, and silently re-consuming it
// under the new invoice-line rules would risk double-counting stock. See
// services/materialEntry.ts's getPullableInvoiceGroups.
export const MATERIAL_ENTRY_INVOICE_PULL_CUTOFF = '2026-09-04';