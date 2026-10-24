// 24-Oct-26, Vipul's ask — SIAC-SKH's two plants have near-identical full
// legal names ("SIAC-SKH INDIA CABS Mfg. Pvt. Ltd. Palwal" vs "...MFG Pvt.
// Ltd. Jaipur" — casing of "Mfg"/"MFG" even differs between the two real
// Customer Master records) that are too long for dropdowns and table
// cells, and once truncated by the UI both just read "SIAC-SKH INDIA
// CABS..." — visually indistinguishable, including in the Dashboard's
// Global Dispatch Feed. This maps them to short labels for ON-SCREEN
// DISPLAY ONLY.
//
// NEVER use this for filtering, matching, comparisons, or anything written
// to Firestore — the real Customer Master name (`customer.name`) is still
// what's compared/stored, and every <option value={...}> in the app keeps
// using the full real name unchanged; only the rendered label text calls
// this. Matching below is a loose regex (not exact-equality) so it keeps
// working even if Customer Master's own casing/punctuation drifts further.
//
// Add more rules here if other customers' names turn out to be too long —
// everywhere in the app that renders a customer name for display should
// route through this one function.
const SHORT_NAME_RULES: { test: RegExp; label: string }[] = [
  { test: /SIAC-SKH.*PALWAL/i, label: 'SKH - Palwal' },
  { test: /SIAC-SKH.*JAIPUR/i, label: 'SKH - Jaipur' },
];

/**
 * Returns the short display label for a customer name if one is defined,
 * otherwise the name unchanged (or, with terseFallback, just its first
 * word — used by the Dashboard's Global Dispatch Feed, which already
 * abbreviated every customer to one word before this existed, and should
 * keep doing that for any customer not explicitly mapped above).
 */
export const getCustomerDisplayName = (
  fullName: string | undefined | null,
  terseFallback: boolean = false
): string => {
  if (!fullName) return fullName || '';
  const rule = SHORT_NAME_RULES.find(r => r.test.test(fullName));
  if (rule) return rule.label;
  return terseFallback ? fullName.split(' ')[0] : fullName;
};
