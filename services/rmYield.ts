// Shared RM <-> Part conversion math, used by every place in App.tsx that
// rolls RM stock forward against Part consumption (opening-balance
// simulation, the live Part.stock sync effect, the cDP stock-at-date calc,
// and the bidirectional Item-inward <-> RM-inward auto-conversion).
//
// Tube RM (category 'tube' or undefined, the app's original/only shape): a
// fixed-length bar. "Yield" = how many pieces of a part can be cut from one
// bar, by length (item fits N times along the bar) or, if no length is set,
// by weight (bar weight / item weight). This logic is UNCHANGED from what
// each call site already did inline before Sheet RM existed — moved here
// only so it's defined once instead of ~4 times.
//
// Sheet RM (category 'sheet'): there is no bar/length concept — sheet size
// varies every delivery, and stock is tracked directly in Kg (the admin
// types total Kg received at each inward, see Inventory.tsx). So "1 unit of
// RM stock" IS "1 Kg", and a part's RM cost is simply its Gross Weight
// (Kg/pc, entered in Item Master) — no floor/bar-fitting needed at the
// RM-unit level, only at the final whole-pieces-obtainable level.
import { Part, RawMaterial, Sale, RMInwardLog } from '../types';

export const isSheetRM = (rm: Pick<RawMaterial, 'category'>): boolean => rm.category === 'sheet';

// All customer names `rm` is used for — its primary `customerName` plus any
// additional `customerNames` (an RM deliberately shared across more than one
// customer/plant, one physical stock pool). Use this instead of reading
// `rm.customerName` alone wherever "which customers does this RM serve"
// matters — a shared RM must count as belonging to every one of them.
export const rmAllCustomers = (rm: Pick<RawMaterial, 'customerName' | 'customerNames'>): string[] =>
  [rm.customerName, ...(rm.customerNames || [])];

// True if `rm` is used for `customerName` — either as its primary
// `customerName` or as one of its additional `customerNames`. Case/
// whitespace-insensitive to match the comparison style already used
// throughout the app for customer names.
export const rmMatchesCustomer = (rm: Pick<RawMaterial, 'customerName' | 'customerNames'>, customerName: string): boolean => {
  const target = (customerName || '').toUpperCase().trim();
  return rmAllCustomers(rm).some(c => (c || '').toUpperCase().trim() === target);
};

// Kg of Sheet RM consumed to make one piece of `part`. 0 if the part has no
// Gross Weight set (e.g. not actually a Sheet Metal part, or not yet filled in).
export const rmKgPerPart = (part: Pick<Part, 'grossWeight'>): number => part.grossWeight || 0;

// How many pieces of `part` one unit of `rm`'s stock yields:
//   - Tube: pieces per bar (by length, or by weight if no length set).
//   - Sheet: pieces per Kg (1 / grossWeight) — `rm` isn't actually consulted
//     for Sheet since Sheet RM carries no per-unit dimension, but it's kept
//     in the signature so every call site can branch on rm.category alone
//     without needing a second helper.
export const partsPerRMUnit = (part: Pick<Part, 'itemLength' | 'itemWeight' | 'grossWeight'>, rm: Pick<RawMaterial, 'category' | 'length' | 'weightPer1000'>): number => {
  if (isSheetRM(rm)) {
    const kgPerPart = rmKgPerPart(part as Pick<Part, 'grossWeight'>);
    return kgPerPart > 0 ? 1 / kgPerPart : 0;
  }

  const rmLength = rm.length || 6000;
  const partLength = part.itemLength || 0;
  if (partLength > 0) {
    return Math.floor(rmLength / partLength);
  }
  const rmWeight = rmLength * ((rm.weightPer1000 || 0) / 1000);
  const partWeight = part.itemWeight || 0;
  if (partWeight > 0 && rmWeight > 0) {
    return Math.floor(rmWeight / partWeight);
  }
  return 0;
};

// Every Part currently cut from `rm` — i.e. every item that would draw down
// the SAME physical stock pool. Mirrors the RM-wise ledger's own "mapped
// items" definition (Inventory.tsx) — RM-side partId/partIds only, not the
// Part-side customerRMMappings — since that's what that trusted screen's
// numbers are actually built from. Used to know how many ways one shared
// RM's derived piece-count has to be split.
export const partsSharingRM = (rm: Pick<RawMaterial, 'id' | 'partId' | 'partIds'>, allParts: Part[]): Part[] =>
  allParts.filter(p => p.id === rm.partId || (rm.partIds && rm.partIds.includes(p.id)));

// "Stock as on date" for a Tube RM, in bars/pipes and metres — the same
// figure the RM Inventory (RM-wise) ledger shows (Inventory.tsx): opening
// balance + this month's RM Inward, minus this month's dispatches (summed
// across every customer the RM is shared with) and end-piece scrap, all
// converted through the RM's own bar length. Deliberately kept a line-by-
// line match of that screen's own inline calculation (not a refactor of it)
// so as not to risk the screen Vipul checks daily — any change here should
// be mirrored there, and vice versa.
//
// `monthRmInwardLogs` and `monthSales` are expected already scoped to the
// relevant month/date (as App.tsx's contextRmInwardLogs/contextSales
// already are) — this function does no date filtering of its own.
export const computeRMStockAsOnDate = (
  rm: RawMaterial,
  mappedItems: Part[],
  monthRmInwardLogs: RMInwardLog[],
  monthSales: Sale[],
  openingBalancePipesStr: string
): { closingBalancePipes: number; closingBalanceMeters: number } => {
  const rmLength = rm.length || 6000;
  const rmStandardMeters = rmLength / 1000;

  const monthRMInwardPipes = monthRmInwardLogs
    .filter(l => l.rmId === rm.id)
    .reduce((sum, l) => sum + l.quantity, 0);
  const monthRMInwardMeters = monthRMInwardPipes * rmStandardMeters;

  let totalConsumedMeters = 0;
  let totalScrapMeters = 0;

  mappedItems.forEach(item => {
    let lengthFactorMeters = 0;
    if (item.itemLength && item.itemLength > 0) {
      lengthFactorMeters = item.itemLength / 1000;
    } else if (item.itemWeight && item.itemWeight > 0 && rm.weightPer1000 > 0) {
      lengthFactorMeters = (item.itemWeight / (rm.weightPer1000 / 1000)) / 1000;
    }

    const salesQty = monthSales
      .filter(s => s.partId === item.id && rmMatchesCustomer(rm, s.customer))
      .reduce((sum, s) => sum + s.quantity, 0);

    const itemMeters = salesQty * lengthFactorMeters;
    totalConsumedMeters += itemMeters;

    const itemLengthMm = item.itemLength || (lengthFactorMeters * 1000);
    let scrapMmPerPipe = 0;
    let yieldFactor = 0;
    if (item.hasCustomScrap) {
      scrapMmPerPipe = item.customScrapMm || 0;
      if (itemLengthMm > 0) yieldFactor = Math.floor(Math.max(0, rmLength - scrapMmPerPipe) / itemLengthMm);
    } else if (itemLengthMm > 0) {
      yieldFactor = Math.floor(rmLength / itemLengthMm);
      scrapMmPerPipe = rmLength % itemLengthMm;
    }

    let pipesUsed = 0;
    if (yieldFactor > 0) pipesUsed = Math.ceil(salesQty / yieldFactor);
    else if (rmStandardMeters > 0 && salesQty > 0) pipesUsed = Math.ceil(itemMeters / rmStandardMeters);

    totalScrapMeters += pipesUsed * (scrapMmPerPipe / 1000);
  });

  const openingBalancePipes = parseFloat(openingBalancePipesStr || '0');
  const openingBalanceMeters = openingBalancePipes * rmStandardMeters;
  const closingBalanceMeters = openingBalanceMeters + monthRMInwardMeters - totalConsumedMeters - totalScrapMeters;
  const closingBalancePipes = rmStandardMeters > 0 ? closingBalanceMeters / rmStandardMeters : 0;

  return { closingBalancePipes, closingBalanceMeters };
};
