// Sibling Stock Borrow — the rule Vipul described as "if LH/RH goes
// negative they will borrow" from each other. Restricted to TRUE, mutually-
// declared sibling parts only (Part.siblingIds, kept symmetric by
// ItemMaster/App.tsx's add/edit/delete handlers) — never a general
// "anything sharing an RM" pool, and never something that can push a
// lending sibling negative itself.
//
// This only moves each part's own `stock` field around between siblings —
// it does not touch RM stock, InwardLogs, or Sales records. It runs once,
// right after a dispatch batch's own -quantity deductions are computed, so
// a shortfall created by THIS batch (not a pre-existing one) is what gets
// covered.
import { Part } from '../types';

export interface SiblingBorrowEvent {
  borrowerPartId: string;
  borrowerPartName: string;
  lenderPartId: string;
  lenderPartName: string;
  quantity: number;
}

export interface SiblingBorrowResult {
  updatedStock: Map<string, number>; // partId -> final stock after borrowing
  borrowEvents: SiblingBorrowEvent[];
}

// `stockAfterDispatch` must already reflect the dispatch batch's own
// -quantity deductions (one entry per Part in `parts`, keyed by id). Any
// part left negative there tries to borrow the shortfall from a sibling's
// positive stock, capped so the sibling never goes negative from lending.
// Order of `p.siblingIds` decides borrow order when a part has more than
// one sibling. Any shortfall siblings can't fully cover is left negative on
// the original part — same as today's uncovered behaviour, just smaller.
export const applySiblingBorrow = (
  parts: Part[],
  stockAfterDispatch: Map<string, number>
): SiblingBorrowResult => {
  const working = new Map(stockAfterDispatch);
  const borrowEvents: SiblingBorrowEvent[] = [];
  const byId = new Map(parts.map(p => [p.id, p]));

  parts.forEach(p => {
    let shortfall = -(working.get(p.id) ?? 0);
    if (shortfall <= 0) return;

    for (const siblingId of p.siblingIds || []) {
      if (shortfall <= 0) break;
      const sibling = byId.get(siblingId);
      if (!sibling) continue;
      // Reciprocal check — only a sibling link BOTH parts declare counts,
      // matching the "true sibling" definition already used for the RM
      // opening-balance/plant-balance display split.
      if (!(sibling.siblingIds || []).includes(p.id)) continue;

      const lenderStock = working.get(siblingId) ?? sibling.stock;
      if (lenderStock <= 0) continue;

      const borrowed = Math.min(shortfall, lenderStock);
      working.set(siblingId, lenderStock - borrowed);
      working.set(p.id, (working.get(p.id) ?? 0) + borrowed);
      shortfall -= borrowed;

      borrowEvents.push({
        borrowerPartId: p.id,
        borrowerPartName: p.name,
        lenderPartId: siblingId,
        lenderPartName: sibling.name,
        quantity: borrowed,
      });
    }
  });

  return { updatedStock: working, borrowEvents };
};
