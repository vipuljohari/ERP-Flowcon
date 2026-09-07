// Pure logic for the "Material Entry — RM Receiving" workflow (Finished
// Pieces / Longer Pipe), shared by components/MaterialEntry.tsx and the two
// save handlers in App.tsx. Mirrors the services/rmYield.ts precedent:
// framework-free, no Firestore/React here, so it's independently testable
// and reviewable.
//
// Longer Pipe is the case rmYield.ts's partsPerRMUnit can't represent: one
// RM bar being cut across SEVERAL different Part sizes at once (siblings,
// or genuinely different items sharing one RM spec), rather than one RM
// yielding one Part at a fixed factor. Everything here was validated by
// hand in an Admin-only trial sandbox before being built for real — the
// three hard rules below (full allotment, no negatives, no removing a
// pulled line) each come from a real mistake found during that testing.
import { RMManufacturerInvoice, RMMaterialLength } from '../types';

export const pcsPerBar = (barLengthMm: number, itemLengthMm: number): number =>
  itemLengthMm > 0 ? Math.floor(barLengthMm / itemLengthMm) : 0;

export const scrapPerBarMm = (barLengthMm: number, itemLengthMm: number): number => {
  const pcs = pcsPerBar(barLengthMm, itemLengthMm);
  return Math.max(0, barLengthMm - pcs * itemLengthMm);
};

export interface MaterialEntryHeader {
  supplierName: string;
  invoiceNo: string;
  date: string; // yyyy-mm-dd
  totalWeightKg?: number;
  totalBillValue?: number;
  // Actual weighbridge (Dharamkanta) reading for this receipt — a physical
  // check against the invoice's own stated Total Weight, entered separately
  // since it comes from the weighbridge slip, not the supplier's paperwork.
  dharamkantaWeightKg?: number;
  invoiceBookedInUnit1: boolean;
}

export interface FinishedPieceLine {
  key: string;
  partId: string;
  quantity: number;
}

export type LongerPipeSubMode = 'whole_bars' | 'split_pieces';

export interface AllottedItem {
  partId: string;
  barsAllotted?: number;    // whole_bars sub-mode
  piecesAllotted?: number;  // split_pieces sub-mode
}

export interface LongerPipeLine {
  key: string;
  rmId: string;
  barLengthMm: number;
  barsReceived: number;
  subMode: LongerPipeSubMode;
  allotments: AllottedItem[];
  // Set only when this line's Spec/Bar Length/Bars Received were pulled
  // from an RM Cross-Bill invoice line (that line's RMManufacturerInvoice.id)
  // — such a line is locked (non-editable) and cannot be removed, since the
  // source invoice gets irreversibly marked "used" on save.
  pulledFromInvoiceLineId?: string;
  // Restores the pre-Material-Entry-feature behaviour on request: Bars
  // Received just goes straight into the RM's own shared stock pool (no
  // per-item split at receiving time). Dispatches keep subtracting per-item
  // consumption automatically the same way they already do today (see
  // Inventory.tsx's RM-wise "Dispatches" column) — this only skips the
  // itemised allotment step for RMs mapped to many items where that detail
  // isn't wanted for a given receipt. When true, `allotments` is ignored
  // (treated as empty) regardless of what it contains.
  autoAssign?: boolean;
}

// Rule: a "Whole Bars per Item" line may not save with a negative entry
// against any item, and may not save unless every bar received is allotted
// to some item (remaining === 0) — true for BOTH manually-typed lines and
// invoice-pulled lines. Found the hard way: partial allotment silently
// leaves bars untracked forever once the source invoice is marked used, but
// the same untracked-bar problem turned out to be just as real for manual
// lines, so the rule applies universally to this sub-mode.
export const validateWholeBarsLine = (line: LongerPipeLine): string | null => {
  if (line.allotments.some(a => (a.barsAllotted ?? 0) < 0)) {
    return 'No item on this line may receive a negative number of bars.';
  }
  const allotted = line.allotments.reduce((s, a) => s + (a.barsAllotted ?? 0), 0);
  const remaining = line.barsReceived - allotted;
  if (remaining > 0.0001) {
    return `${remaining} bar(s) on this line are still unallotted — every bar received must be assigned to an item before saving.`;
  }
  if (remaining < -0.0001) {
    return `You've assigned more bars (${allotted}) than were received (${line.barsReceived}) on this line — reduce one of the entries.`;
  }
  return null;
};

// Rule: "Split by Pieces (Shortage)" is the deliberate misplanning/shortage
// mode — leftover length is EXPECTED and gets logged as one shared,
// unattributed scrap figure rather than credited to any single item, so
// (unlike Whole Bars) there is no full-consumption requirement here. Still
// rejects a negative per-item entry, and rejects claiming more pieces than
// the bars physically contain (that's a typo, not a valid shortage).
export const validateSplitPiecesLine = (line: LongerPipeLine, itemLengthById: Record<string, number>): string | null => {
  if (line.allotments.some(a => (a.piecesAllotted ?? 0) < 0)) {
    return 'No item on this line may receive a negative quantity.';
  }
  const leftover = computeUnattributedScrapMm(line, itemLengthById);
  if (leftover < -0.0001) {
    return 'These pieces need more length than this line\'s bar(s) actually have — reduce one of the entries.';
  }
  return null;
};

export const computeUnattributedScrapMm = (line: LongerPipeLine, itemLengthById: Record<string, number>): number => {
  const totalAvailableMm = line.barsReceived * line.barLengthMm;
  const consumedMm = line.allotments.reduce(
    (s, a) => s + (a.piecesAllotted ?? 0) * (itemLengthById[a.partId] || 0),
    0
  );
  return totalAvailableMm - consumedMm;
};

export const validateLongerPipeLine = (line: LongerPipeLine, itemLengthById: Record<string, number>): string | null => {
  if (!line.rmId) return 'Select a Spec / Material for this line.';
  if (line.barLengthMm <= 0 || line.barsReceived <= 0) return 'Bar Length and Bars Received must both be greater than zero.';
  // Auto-Assign: nothing to allot, so the per-item allotment rules below
  // don't apply — Bars Received alone is enough to save this line.
  if (line.autoAssign) return null;
  return line.subMode === 'whole_bars'
    ? validateWholeBarsLine(line)
    : validateSplitPiecesLine(line, itemLengthById);
};

// One "invoice" as Material Entry's picker shows it: RMManufacturerInvoice
// is stored one Firestore doc per material line (correlated only by shared
// invoiceNo/manufacturerName/date), so every group here is a same-invoiceNo
// cluster of those docs, not a single document.
export interface PullableInvoiceGroup {
  invoiceNo: string;
  manufacturerName: string;
  date: string;
  lines: RMManufacturerInvoice[];
}

// Material codes are sometimes typed by hand (RM Cross-Bill Check's "+ Add
// New Material" flow) or read off a photographed invoice, and either way
// can carry case differences or trailing print artifacts (e.g.
// "RMSS00000119." with a stray period from the source document's column
// layout, or "rmss00000119" typed in lowercase) that aren't part of the
// actual code. Every place that matches one material code against another
// — recognizing a re-typed material as the same one already on file,
// deciding whether an invoice is eligible to post/pull — MUST go through
// this, not a raw `===`, or a real match gets silently missed (confirmed
// bug: RMCrossBillCheck.tsx's own "Post to Inventory" eligibility check
// used to compare codes with `===` directly while the rest of that same
// file already normalized this way, so a manually-typed code that differed
// only in case from what's on file — matching materialLengths's own
// case-insensitive dedupe, so no duplicate record was even created — still
// silently failed the *eligibility* check alone).
export const normalizeMaterialCode = (code: string): string => (code || '').trim().replace(/[.\s]+$/, '').toUpperCase();

// Spec-relevance + deployment-cutoff filter for "Pull from Invoice": only
// show invoices where (a) every line is still unused, (b) the invoice date
// is on/after this feature's go-live (an invoice older than that was
// already reconciled under the old rules and must never be silently
// re-consumed), and (c) at least one line's material code is linked
// (via RMMaterialLength.linkedRMId) to the RM this particular line is for —
// an invoice with no matching material must never even appear.
export const getPullableInvoiceGroups = (
  invoices: RMManufacturerInvoice[],
  materialLengths: RMMaterialLength[],
  targetRMId: string,
  cutoffDateStr: string
): PullableInvoiceGroup[] => {
  const linkedRMIdByCode: Record<string, string | undefined> = {};
  materialLengths.forEach(ml => { linkedRMIdByCode[normalizeMaterialCode(ml.materialCode)] = ml.linkedRMId; });

  const groups = new Map<string, RMManufacturerInvoice[]>();
  invoices.forEach(inv => {
    const key = `${inv.invoiceNo}__${inv.manufacturerName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(inv);
  });

  const result: PullableInvoiceGroup[] = [];
  groups.forEach((lines, key) => {
    if (lines.some(l => l.usedForMaterialEntry)) return; // any line already used -> whole invoice is done
    const first = lines[0];
    if (first.date < cutoffDateStr) return;
    const hasMatch = lines.some(l => linkedRMIdByCode[normalizeMaterialCode(l.materialCode)] === targetRMId);
    if (!hasMatch) return;
    result.push({ invoiceNo: first.invoiceNo, manufacturerName: first.manufacturerName, date: first.date, lines });
  });
  return result.sort((a, b) => (a.date < b.date ? 1 : -1));
};
