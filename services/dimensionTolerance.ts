// Dimension-tolerance matching for Material Entry's Camera Upload —
// framework-free, same rmYield.ts/materialEntry.ts precedent as everything
// else in services/.
//
// The problem this solves: a manufacturer's invoice states the dimension it
// actually measured, which is normally a shade under the Raw Material's own
// nominal spec (real manufacturing tolerance) — e.g. a "45mm OD" tube's
// invoice reads "44.45". Camera Upload extracts whatever number is printed,
// so matching it to the right RawMaterial has to know these aren't
// mismatches, they're the same size. Per Vipul (11-Sep-26): real tolerance
// bands are NOT a uniform percentage/offset — OD tolerance and Thickness
// tolerance are different bands, and don't scale linearly with size — so
// this is deliberately an explicit, Admin-editable lookup table
// (DimensionTolerance[], seeded below) rather than a formula. New sizes
// Admin hasn't added yet simply require an exact match, which just means no
// suggestion is offered — never a wrong one.
import { DimensionTolerance, RawMaterial } from '../types';

// Seeded once into the `dimensionTolerances` collection on first load (see
// hooks/useFirestoreArray's seedIfEmpty) — Admin can add more rows later
// from Material Entry's "Dimension Tolerances" editor without needing a
// code change. These five are exactly what Vipul specified:
//   1. 45mm OD can be invoiced as 44.45.
//   2/3/4. Thickness 1.6 -> 1.5; 2 -> 1.8 or 1.9; 3 -> 2.8 or 2.9.
//   5. C-Post (57.15 OD x 2mm x 5910mm) — its 2mm thickness follows the
//      same 1.8/1.9 rule as #3, already covered by that row; no separate
//      OD tolerance was given for 57.15, so none is seeded for it.
export const SEED_DIMENSION_TOLERANCES: DimensionTolerance[] = [
  { id: 'od-45', field: 'OD', nominal: 45, acceptedValues: [44.45], updatedAt: '2026-09-11T00:00:00.000Z' },
  { id: 'thk-1.6', field: 'Thickness', nominal: 1.6, acceptedValues: [1.5], updatedAt: '2026-09-11T00:00:00.000Z' },
  { id: 'thk-2', field: 'Thickness', nominal: 2, acceptedValues: [1.8, 1.9], updatedAt: '2026-09-11T00:00:00.000Z' },
  { id: 'thk-3', field: 'Thickness', nominal: 3, acceptedValues: [2.8, 2.9], updatedAt: '2026-09-11T00:00:00.000Z' },
];

// Floating-point-safe equality for dimension numbers (OCR/AI output and
// RM Master entries are both plain decimals, but "45" vs "45.0" style
// drift shouldn't break an exact match).
const numsEqual = (a: number, b: number) => Math.abs(a - b) < 0.005;

export const matchesNominal = (
  measured: number,
  nominal: number,
  table: DimensionTolerance[],
  field: 'OD' | 'Thickness'
): boolean => {
  if (numsEqual(measured, nominal)) return true;
  return table.some(
    t => t.field === field && numsEqual(t.nominal, nominal) && t.acceptedValues.some(v => numsEqual(v, measured))
  );
};

// Splits a Raw Material's free-text `size` (e.g. "40X1.6X5710 mm",
// "70.30X50X30X3.2X3600", "38x38x3") into its numeric tokens. Thickness is
// reliably the SECOND-TO-LAST number in every size format this app uses —
// square/rectangular tube just has more leading width/height numbers before
// it. OD only has a clean meaning for a round tube, i.e. exactly 3 tokens
// (OD, Thickness, Length) or 2 (OD, Thickness — length tracked separately
// in rm.length instead); anything with 4+ tokens is square/rectangular, and
// only Thickness is compared for those.
const parseSizeTokens = (size: string): number[] =>
  (size || '')
    .replace(/mm/gi, '')
    .split(/[xX×]/)
    .map(s => parseFloat(s.trim()))
    .filter(n => Number.isFinite(n));

export interface ExtractedRMDimensions {
  odMm?: number;
  thicknessMm?: number;
  lengthMm?: number;
}

// Ranks every RawMaterial against a photo/invoice's extracted dimensions,
// best match first. Returns [] when nothing was actually extracted (no
// odMm/thicknessMm at all) — Camera Upload should never pre-select
// anything on a photo it couldn't read. This is ALWAYS a suggestion for a
// human to confirm in the Spec/Material dropdown, never an auto-lock — see
// components/MaterialEntry.tsx.
export const suggestMatchingRawMaterials = (
  extracted: ExtractedRMDimensions,
  rawMaterials: RawMaterial[],
  table: DimensionTolerance[]
): RawMaterial[] => {
  const hasThickness = typeof extracted.thicknessMm === 'number' && extracted.thicknessMm > 0;
  const hasOD = typeof extracted.odMm === 'number' && (extracted.odMm as number) > 0;
  if (!hasThickness && !hasOD) return [];

  const scored = rawMaterials
    .filter(rm => rm.category !== 'sheet')
    .map(rm => {
      const tokens = parseSizeTokens(rm.size);
      if (tokens.length < 2) return null;
      const thicknessToken = tokens[tokens.length - 2];
      const isRound = tokens.length <= 3; // OD, Thickness[, Length]
      const odToken = isRound ? tokens[0] : undefined;

      let score = 0;
      if (hasThickness) {
        if (!matchesNominal(extracted.thicknessMm as number, thicknessToken, table, 'Thickness')) return null;
        score += 1;
      }
      if (hasOD && isRound && odToken !== undefined) {
        if (!matchesNominal(extracted.odMm as number, odToken, table, 'OD')) return null;
        score += 1;
      }
      // Length is the one dimension this app already tracks as a real,
      // structured field (rm.length) — use it as a tie-breaker, not a hard
      // filter, since a bar can legitimately be re-measured a few mm off
      // its nominal cut length without being a different Raw Material.
      if (typeof extracted.lengthMm === 'number' && extracted.lengthMm > 0 && rm.length) {
        if (Math.abs(rm.length - extracted.lengthMm) <= 5) score += 1;
      }
      return { rm, score };
    })
    .filter((x): x is { rm: RawMaterial; score: number } => x !== null && x.score > 0);

  return scored.sort((a, b) => b.score - a.score).map(x => x.rm);
};
