// Matches a Gemini-extracted supplier name (from a WhatsApp gate photo —
// see services/apiHandlers.ts's handleGateUpload) against the known RM-
// supplier list, so only genuine RM-manufacturer photos ever reach the
// "Gate Documents for Approval" queue — everything else (BOP/consumable/
// irrelevant gate photos) is silently ignored instead of cluttering it.
//
// Deliberately simpler than services/customerMatch.ts's findMatchingCustomer:
// no matchKeywords field exists for RM suppliers/Tally vendors, so this is
// just exact match, then normalized (punctuation-stripped) containment
// either direction — the same idea as customerMatch.ts's tiers 1 and 3,
// without the keyword tiers that need a field this data doesn't have.
//
// Framework-free, no Firestore/React here — independently testable, same
// precedent as customerMatch.ts and services/materialEntry.ts.
export type SupplierMatchResult =
  | { result: 'no_match' }
  | { result: 'confident'; matchedSupplier: string }
  | { result: 'unmatched' };

const normalize = (s: string): string => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const matchKnownSupplier = (extractedName: string, knownNames: Iterable<string>): SupplierMatchResult => {
  const cleanExtracted = normalize(extractedName);

  // Nothing legible at all — most likely this photo wasn't an RM invoice to
  // begin with (BOP/consumable/irrelevant gate photo), not a genuine
  // supplier we simply don't recognize yet. Vipul's supplier-list decision
  // (18-Sep) doesn't change this branch either way.
  if (!cleanExtracted) return { result: 'no_match' };

  // Tier 1: exact match.
  for (const known of knownNames) {
    const cleanKnown = normalize(known);
    if (cleanKnown && cleanExtracted === cleanKnown) {
      return { result: 'confident', matchedSupplier: known };
    }
  }

  // Tier 2: normalized containment either direction (handles Gemini reading
  // "Tube Investments of India Limited" against a Tally ledger name of
  // "TUBE INVESTMENTS OF INDIA LTD", or a shorter one containing a longer
  // one). The 0.8-length guard on the reverse direction stops a short known
  // name from matching almost anything.
  for (const known of knownNames) {
    const cleanKnown = normalize(known);
    if (cleanKnown.length < 3) continue;
    if (
      cleanExtracted.includes(cleanKnown) ||
      (cleanKnown.includes(cleanExtracted) && cleanExtracted.length >= cleanKnown.length * 0.8)
    ) {
      return { result: 'confident', matchedSupplier: known };
    }
  }

  // Read a supplier name, just not one on file in rmPurchaseVouchers yet —
  // held for manual pickup rather than dropped (Vipul's 17-Sep decision),
  // so a new/renamed supplier doesn't just vanish.
  return { result: 'unmatched' };
};
