import React, { useMemo, useState } from 'react';

// ============================================================
// TRIAL SANDBOX — RM Receiving (Longer Pipe / CTL Assignment)
// ============================================================
// Everything on this screen is fake, in-memory, and local to this
// component. There is no Firestore import here at all — not a
// conditional, an actual absence — so there is no code path by which
// anything typed on this screen can reach real inventory, real Tally
// data, or any other user's screen. Closing/refreshing the page throws
// all of it away; the "Reset Sample Data" button does the same on demand.
//
// Purpose: let Admin try the proposed longer-pipe receiving + CTL
// assignment + sibling-item stock-borrowing workflow against realistic
// sample data before any of it touches the live app, per Vipul's request
// (2-Sept-2026) for a trial before implementing this in production.
//
// Both "Longer Pipe" and "Finished Pieces" receipts are invoice-first:
// Supplier/Invoice/Date/Total Weight/Total Bill Value are entered once for
// the whole bill, and one or more "lines" sit underneath it — a bar length +
// bars received + item assignment for Longer Pipe, or one item + qty for
// Finished Pieces. This covers a single invoice covering several items (e.g.
// Upper Tube on one bar length, Rear+Lower Tube sharing a different length,
// all on one bill; or three different already-cut CTL parts on one bill)
// without re-entering the invoice totals per item.
//
// This is direct-from-manufacturer RM procurement, not the customer-supplied
// RM covered by RM Cross-Bill Check — so there is no customer/cross-invoice
// link anywhere on this screen, per Vipul's confirmation.
// ============================================================

interface TrialItem {
  id: string;
  name: string;
  sapCode: string;
  spec: string; // shared RM cross-section/spec label, e.g. "70x50x30x3.2 Butterfly"
  itemLengthMm: number;
  stock: number;
  siblingIds: string[]; // ids of items interchangeable with this one in RM/CTL form (empty = none)
}

interface ActivityEntry {
  id: string;
  timestamp: string;
  kind: 'receipt' | 'dispatch' | 'auto_transfer' | 'discrepancy';
  message: string;
}

// One bar-length group within a Longer Pipe invoice. Two ways to assign it to items:
//  - 'byBars': the normal case — dedicate whole bars to each item.
//  - 'byPieces': the misplanning/shortage case — only one (or very few) bars came in and
//    they must be shared across several non-sibling items, so pieces are entered per item
//    directly instead of whole bars, and whatever length is left over is logged as one
//    unattributed scrap figure (not credited to any single item).
type LineAssignMode = 'byBars' | 'byPieces';

interface Line {
  id: string;
  spec: string;
  lengthMm: string;
  barsReceived: string;
  assignMode: LineAssignMode;
  checkedItemIds: string[];
  barsPerItem: Record<string, string>;
  pcsPerItem: Record<string, string>;
  itemSearch: string;
  // true when this line's Spec/Material and Bar Length came from a picked RM Cross-Bill
  // invoice's material catalog — both are locked/non-editable in that case, exactly like
  // the real Add Manufacturer Invoice screen locks Piece Length once a material is chosen.
  lockedFromInvoice: boolean;
}

// RM Cross-Bill Check already ties each Material Code to a fixed Piece Length (locked on
// that screen once a material is chosen) — this mirrors that catalog so a picked invoice's
// Bar Length can be pulled in reliably, not just its Bars Received/Qty. `spec` here is the
// bridge to this screen's own RM-spec grouping (see distinctSpecs below).
const MATERIAL_CATALOG: Record<string, { materialName: string; lengthMm: number; spec: string }> = {
  'RMSS00000118': { materialName: 'STEELS TUBES-CDW-70.30x50x30x3.2x3600- UNANNEALED', lengthMm: 3600, spec: '70x50x30x3.2 Butterfly' },
  'RMSS00000205': { materialName: 'ERW STEEL TUBES-REC-SBR-25x25x2x4950- AS ROLLED', lengthMm: 4950, spec: '25x25x2 MS Tube' },
};

interface MfgInvoiceLine {
  materialCode: string;
  materialName: string;
  quantityPcs: number;
  ratePerPc: number;
}

// A sample RM Cross-Bill "Manufacturer Invoice" — booked on that screen first, per Vipul's
// description of A-POST's real flow (TI supplier → RM Cross-Bill linking → then Inventory's
// Material Entry). `usedForMaterialEntry` simulates the real app hiding an invoice here once
// its physical stock entry is done, so the same invoice can't be pulled in twice.
interface MfgInvoice {
  id: string;
  manufacturerName: string;
  customerName: string;
  invoiceNo: string;
  date: string;
  totalWeightKg: number;
  materials: MfgInvoiceLine[];
  usedForMaterialEntry: boolean;
}

const SEED_MFG_INVOICES: MfgInvoice[] = [
  {
    id: 'inv1', manufacturerName: 'Tube Investments of India Ltd', customerName: 'SIAC-SKH INDIA CABS Mfg. Pvt. Ltd. Palwal',
    invoiceNo: 'TI/2691', date: '2026-08-28', totalWeightKg: 10300,
    materials: [{ materialCode: 'RMSS00000118', materialName: MATERIAL_CATALOG['RMSS00000118'].materialName, quantityPcs: 200, ratePerPc: 850 }],
    usedForMaterialEntry: false,
  },
  {
    id: 'inv2', manufacturerName: 'Tube Investments of India Ltd', customerName: 'SIAC-SKH INDIA CABS Mfg. Pvt. Ltd. Palwal',
    invoiceNo: 'TI/2705', date: '2026-09-01', totalWeightKg: 8500,
    materials: [
      { materialCode: 'RMSS00000118', materialName: MATERIAL_CATALOG['RMSS00000118'].materialName, quantityPcs: 120, ratePerPc: 850 },
      { materialCode: 'RMSS00000205', materialName: MATERIAL_CATALOG['RMSS00000205'].materialName, quantityPcs: 80, ratePerPc: 310 },
    ],
    usedForMaterialEntry: false,
  },
];

// One item + qty within a Finished Pieces invoice — e.g. 3 different CTL parts
// arriving pre-cut on the same bill, each its own line under one invoice header.
interface FinishedLine {
  id: string;
  itemId: string;
  qty: string;
}

const genId = () => Math.random().toString(36).substr(2, 9);
const nowStr = () => new Date().toLocaleString('en-GB');

const SEED_ITEMS: TrialItem[] = [
  { id: 'lh', name: 'A-POST LH (HT)', sapCode: 'BOCS00001242', spec: '70x50x30x3.2 Butterfly', itemLengthMm: 1650, stock: 127, siblingIds: ['rh'] },
  { id: 'rh', name: 'A-POST RH (HT)', sapCode: 'BOCS00001243', spec: '70x50x30x3.2 Butterfly', itemLengthMm: 1650, stock: 140, siblingIds: ['lh'] },
  { id: 'upper', name: 'Upper Tube', sapCode: 'TRIAL-UP-01', spec: '25x25x2 MS Tube', itemLengthMm: 1200, stock: 40, siblingIds: [] },
  { id: 'rear', name: 'Rear Tube', sapCode: 'TRIAL-RT-01', spec: '25x25x2 MS Tube', itemLengthMm: 1600, stock: 30, siblingIds: [] },
  { id: 'lower', name: 'Lower Tube', sapCode: 'TRIAL-LT-01', spec: '25x25x2 MS Tube', itemLengthMm: 1600, stock: 25, siblingIds: [] },
];

const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 px-1">{label}</label>
    {children}
  </div>
);

const inrFmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TrialRMReceiving: React.FC = () => {
  const [items, setItems] = useState<TrialItem[]>(SEED_ITEMS);
  const [log, setLog] = useState<ActivityEntry[]>([]);
  const [mfgInvoices, setMfgInvoices] = useState<MfgInvoice[]>(SEED_MFG_INVOICES);

  const addLog = (kind: ActivityEntry['kind'], message: string) => {
    setLog(prev => [{ id: genId(), timestamp: nowStr(), kind, message }, ...prev]);
  };

  const resetAll = () => {
    if (!window.confirm('Reset the trial back to its starting sample data? This clears the activity log too.')) return;
    setItems(SEED_ITEMS);
    setLog([]);
    setMfgInvoices(SEED_MFG_INVOICES);
    setEntryForItem(null);
  };

  // --- Material Entry modal state ---
  const [entryForItem, setEntryForItem] = useState<TrialItem | null>(null);
  const [entryMode, setEntryMode] = useState<'pieces' | 'longer' | null>(null);
  const [step, setStep] = useState<1 | 2>(1);

  // Invoice header fields — shared across the whole bill, entered once, for BOTH modes.
  const [supplier, setSupplier] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  // Some invoices are booked in Unit 1's Tally and the material sent on to this unit by
  // an internal challan — the invoice number typed above won't be found in this unit's
  // own Tally, so this flag tells Accounts to look it up in Unit 1's Tally instead.
  const [bookedInUnit1, setBookedInUnit1] = useState(false);
  const [date, setDate] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [billValue, setBillValue] = useState('');

  // Finished-pieces-only: one or more item+qty lines under the invoice header above —
  // e.g. 3 different CTL parts arriving already cut, on one bill.
  const [finishedLines, setFinishedLines] = useState<FinishedLine[]>([]);

  // Longer-pipe-only: one or more bar-length lines under the invoice header above.
  const [lines, setLines] = useState<Line[]>([]);
  // Set when the current Longer Pipe entry was pulled from an existing RM Cross-Bill
  // invoice below — used to mark that invoice "used" (hidden from the picker) on Save.
  const [linkedInvoiceId, setLinkedInvoiceId] = useState<string | null>(null);

  const makeLine = (seedItem?: TrialItem): Line => ({
    id: genId(),
    spec: seedItem?.spec || '',
    lengthMm: '',
    barsReceived: '',
    assignMode: 'byBars',
    checkedItemIds: seedItem ? [seedItem.id, ...seedItem.siblingIds] : [],
    barsPerItem: {},
    pcsPerItem: {},
    itemSearch: '',
    lockedFromInvoice: false,
  });

  const makeFinishedLine = (seedItem?: TrialItem): FinishedLine => ({
    id: genId(),
    itemId: seedItem?.id || '',
    qty: '',
  });

  const openEntry = (item: TrialItem) => {
    setEntryForItem(item);
    setEntryMode(null);
    setStep(1);
    setSupplier(''); setInvoiceNo(''); setBookedInUnit1(false); setDate(''); setWeightKg(''); setBillValue('');
    setLines([makeLine(item)]);
    setFinishedLines([makeFinishedLine(item)]);
    setLinkedInvoiceId(null);
  };

  // Only invoices that (a) have not yet had a Material Entry done against them, and (b)
  // contain at least one material matching the spec of the item this Material Entry was
  // opened for, are offered — an invoice with no relevant material has no business showing
  // up here at all, even if it does contain other, unrelated materials. In the real app this
  // would also exclude invoices booked before this feature went live.
  const availableMfgInvoices = mfgInvoices.filter(inv =>
    !inv.usedForMaterialEntry &&
    entryForItem &&
    inv.materials.some(m => MATERIAL_CATALOG[m.materialCode]?.spec === entryForItem.spec)
  );

  const pullFromInvoice = (inv: MfgInvoice) => {
    const hasExistingData = lines.some(l => l.lengthMm || l.barsReceived || l.checkedItemIds.length > 0);
    if (hasExistingData && !window.confirm(`Replace the current line(s) with Invoice ${inv.invoiceNo}'s materials?`)) return;

    setSupplier(inv.manufacturerName);
    setInvoiceNo(inv.invoiceNo);
    setDate(inv.date);
    setWeightKg(String(inv.totalWeightKg));
    setBillValue(String(inv.materials.reduce((s, m) => s + m.quantityPcs * m.ratePerPc, 0)));
    setLinkedInvoiceId(inv.id);
    setLines(inv.materials.map(m => {
      const cat = MATERIAL_CATALOG[m.materialCode];
      const spec = cat?.spec || '';
      const preCheck = entryForItem && spec === entryForItem.spec ? [entryForItem.id, ...entryForItem.siblingIds] : [];
      return {
        id: genId(),
        spec,
        lengthMm: cat ? String(cat.lengthMm) : '',
        lockedFromInvoice: !!cat,
        barsReceived: String(m.quantityPcs),
        assignMode: 'byBars',
        checkedItemIds: preCheck,
        barsPerItem: {},
        pcsPerItem: {},
        itemSearch: '',
      };
    }));
  };

  const closeEntry = () => {
    setEntryForItem(null);
    setEntryMode(null);
  };

  const patchLine = (lineId: string, updater: (l: Line) => Line) => {
    setLines(prev => prev.map(l => (l.id === lineId ? updater(l) : l)));
  };

  const addLine = () => setLines(prev => [...prev, makeLine()]);
  const removeLine = (lineId: string) => setLines(prev => (prev.length > 1 ? prev.filter(l => l.id !== lineId) : prev));

  // Every item has a parent RM spec (e.g. A-POST LH/RH share "70x50x30x3.2 Butterfly";
  // Upper/Rear/Lower Tube share "25x25x2 MS Tube"). Physically, a bar of one spec can
  // only ever be cut into items of that same spec — a 25x25 tube can never become an
  // A-POST. So a line's item picker only shows/allows items matching that line's chosen
  // spec, and changing the spec drops any already-checked items that no longer qualify.
  const distinctSpecs = useMemo(() => Array.from(new Set(items.map(it => it.spec))), [items]);

  const setLineSpec = (lineId: string, newSpec: string) => {
    patchLine(lineId, l => {
      const validIds = new Set(items.filter(it => it.spec === newSpec).map(it => it.id));
      return {
        ...l,
        spec: newSpec,
        checkedItemIds: l.checkedItemIds.filter(id => validIds.has(id)),
        barsPerItem: Object.fromEntries(Object.entries(l.barsPerItem).filter(([id]) => validIds.has(id))),
        pcsPerItem: Object.fromEntries(Object.entries(l.pcsPerItem).filter(([id]) => validIds.has(id))),
      };
    });
  };

  const patchFinishedLine = (lineId: string, updater: (l: FinishedLine) => FinishedLine) => {
    setFinishedLines(prev => prev.map(l => (l.id === lineId ? updater(l) : l)));
  };
  const addFinishedLine = () => setFinishedLines(prev => [...prev, makeFinishedLine()]);
  const removeFinishedLine = (lineId: string) => setFinishedLines(prev => (prev.length > 1 ? prev.filter(l => l.id !== lineId) : prev));

  // Live per-line computation: pcs/scrap for 'byBars', consumed-length/unattributed-scrap
  // for 'byPieces'. Recomputed from the lines array + items whenever either changes.
  const lineComputations = useMemo(() => {
    return lines.map(line => {
      const barsReceivedNum = parseFloat(line.barsReceived) || 0;
      const lengthMmNum = parseFloat(line.lengthMm) || 0;

      if (line.assignMode === 'byBars') {
        const byItem: Record<string, { bars: number; pcs: number; scrapMmPerBar: number }> = {};
        line.checkedItemIds.forEach(id => {
          const it = items.find(i => i.id === id);
          if (!it) return;
          const bars = parseFloat(line.barsPerItem[id] || '') || 0;
          const pcsPerBar = it.itemLengthMm > 0 ? Math.floor(lengthMmNum / it.itemLengthMm) : 0;
          const scrapMmPerBar = it.itemLengthMm > 0 ? Math.max(0, lengthMmNum - pcsPerBar * it.itemLengthMm) : 0;
          byItem[id] = { bars, pcs: pcsPerBar * bars, scrapMmPerBar };
        });
        const barsAllotted = Object.values(byItem).reduce((s, c) => s + c.bars, 0);
        const barsRemaining = barsReceivedNum - barsAllotted;
        // A negative bars-per-item entry (e.g. -5) can cancel out a positive over-allotment
        // elsewhere on the same line and land "Remaining to allot" at exactly 0, which would
        // otherwise slip past the full-allotment check above even though no such bars
        // physically exist — so it's tracked and blocked separately, regardless of the total.
        const hasNegativeEntry = Object.values(byItem).some(c => c.bars < 0);
        return {
          mode: 'byBars' as const,
          line, barsReceivedNum, lengthMmNum, byItem, barsAllotted, barsRemaining,
          overAllotted: barsRemaining < -0.0001,
          hasNegativeEntry,
        };
      }

      const totalAvailableMm = barsReceivedNum * lengthMmNum;
      const pcsByItem: Record<string, number> = {};
      let totalConsumedMm = 0;
      line.checkedItemIds.forEach(id => {
        const it = items.find(i => i.id === id);
        const pcs = parseFloat(line.pcsPerItem[id] || '') || 0;
        pcsByItem[id] = pcs;
        totalConsumedMm += it ? pcs * it.itemLengthMm : 0;
      });
      const unattributedScrapMm = totalAvailableMm - totalConsumedMm;
      const pcsAllottedTotal = Object.values(pcsByItem).reduce((s, p) => s + p, 0);
      const hasNegativeEntry = Object.values(pcsByItem).some(p => p < 0);
      return {
        mode: 'byPieces' as const,
        line, barsReceivedNum, lengthMmNum, pcsByItem, totalAvailableMm, totalConsumedMm,
        unattributedScrapMm, overAllottedPieces: unattributedScrapMm < -0.0001, pcsAllottedTotal,
        hasNegativeEntry,
      };
    });
  }, [lines, items]);

  const isLineValid = (lc: typeof lineComputations[number]) => {
    if (!lc.line.spec) return false;
    if (lc.lengthMmNum <= 0 || lc.barsReceivedNum <= 0) return false;
    // A negative bars/pcs entry against any single item is never physically real — even
    // when it happens to cancel out to a "clean" total (e.g. 205 to one sibling, -5 to the
    // other, netting to the 200 received) — so it's rejected regardless of what the line's
    // totals work out to.
    if (lc.hasNegativeEntry) return false;
    if (lc.mode === 'byBars') {
      if (lc.overAllotted || lc.barsAllotted <= 0) return false;
      // Every bar received on a "Whole Bars per Item" line must be allotted to some item
      // before Save is allowed — whether the line was pulled from an RM Cross-Bill invoice
      // (which gets marked "used" and can't be pulled again) or typed in manually. Either
      // way, an unallotted bar left behind at Save time has nowhere left to be accounted
      // for and becomes untrackable stock. (The "Split by Pieces (Shortage)" mode is
      // different on purpose — leftover length there is deliberately logged as one shared
      // unattributed scrap figure, not silently dropped.)
      if (lc.barsRemaining > 0.0001) return false;
      return true;
    }
    return !lc.overAllottedPieces && lc.pcsAllottedTotal > 0;
  };
  const allLinesValid = lineComputations.length > 0 && lineComputations.every(isLineValid);

  // Only items sharing this exact RM spec are selectable for a line — see distinctSpecs above.
  const searchItemsForSpec = (spec: string, search: string) => items.filter(it =>
    it.spec === spec && (it.name.toLowerCase().includes(search.toLowerCase()) || it.sapCode.toLowerCase().includes(search.toLowerCase()))
  );

  const finishedLinesValid = finishedLines.length > 0 && finishedLines.every(l => l.itemId && (parseFloat(l.qty) || 0) > 0);

  const saveFinishedPieces = () => {
    if (!finishedLinesValid) return;
    const stockDeltas: Record<string, number> = {};
    const parts: string[] = [];
    finishedLines.forEach(l => {
      const qty = parseFloat(l.qty) || 0;
      if (!l.itemId || qty <= 0) return;
      stockDeltas[l.itemId] = (stockDeltas[l.itemId] || 0) + qty;
      const it = items.find(i => i.id === l.itemId);
      if (it) parts.push(`${it.name} +${qty} Pcs`);
    });
    setItems(prev => prev.map(it => (stockDeltas[it.id] ? { ...it, stock: it.stock + stockDeltas[it.id] } : it)));
    addLog('receipt', `Finished Pieces Receipt — Invoice ${invoiceNo || 'n/a'}${bookedInUnit1 ? ' (booked in Unit 1 Tally)' : ''} from ${supplier || 'supplier'}${date ? `, ${date}` : ''}${weightKg ? `, Total Weight ${weightKg} Kg` : ''}${billValue ? `, Total Bill Value ₹${inrFmt(parseFloat(billValue) || 0)}` : ''}. Received: ${parts.join('; ')}.`);
    closeEntry();
  };

  const saveLongerPipe = () => {
    if (!allLinesValid) return;
    const stockDeltas: Record<string, number> = {};
    const lineSummaries: string[] = [];

    lineComputations.forEach(lc => {
      const parts: string[] = [];
      if (lc.mode === 'byBars') {
        Object.entries(lc.byItem).forEach(([id, c]) => {
          if (c.pcs <= 0) return;
          stockDeltas[id] = (stockDeltas[id] || 0) + c.pcs;
          const it = items.find(i => i.id === id)!;
          parts.push(`${it.name} +${c.pcs} Pcs (${c.bars} bar${c.bars === 1 ? '' : 's'} × floor(${lc.lengthMmNum}/${it.itemLengthMm}), scrap ${c.scrapMmPerBar}mm/bar)`);
        });
        lineSummaries.push(`${lc.line.spec || 'Line'} — ${lc.barsReceivedNum} bar${lc.barsReceivedNum === 1 ? '' : 's'} × ${lc.lengthMmNum}mm: ${parts.join('; ')}${lc.barsRemaining > 0.0001 ? ` (${lc.barsRemaining} bar(s) left unassigned)` : ''}`);
      } else {
        Object.entries(lc.pcsByItem).forEach(([id, pcs]) => {
          if (pcs <= 0) return;
          stockDeltas[id] = (stockDeltas[id] || 0) + pcs;
          const it = items.find(i => i.id === id)!;
          parts.push(`${it.name} +${pcs} Pcs`);
        });
        lineSummaries.push(`${lc.line.spec || 'Line'} (split by pieces — shortage) — ${lc.barsReceivedNum} bar${lc.barsReceivedNum === 1 ? '' : 's'} × ${lc.lengthMmNum}mm: ${parts.join('; ')}. Unattributed scrap: ${lc.unattributedScrapMm}mm (shared, not credited to any single item).`);
      }
    });

    setItems(prev => prev.map(it => (stockDeltas[it.id] ? { ...it, stock: it.stock + stockDeltas[it.id] } : it)));
    if (linkedInvoiceId) {
      setMfgInvoices(prev => prev.map(inv => (inv.id === linkedInvoiceId ? { ...inv, usedForMaterialEntry: true } : inv)));
    }
    addLog('receipt', `Longer Pipe Receipt — Invoice ${invoiceNo || 'n/a'}${bookedInUnit1 ? ' (booked in Unit 1 Tally)' : ''} from ${supplier || 'supplier'}${date ? `, ${date}` : ''}${weightKg ? `, Total Weight ${weightKg} Kg` : ''}${billValue ? `, Total Bill Value ₹${inrFmt(parseFloat(billValue) || 0)}` : ''}${linkedInvoiceId ? ' — linked to RM Cross-Bill Invoice' : ''}. ${lineSummaries.join(' | ')}`);
    closeEntry();
  };

  // --- Dispatch simulator ---
  const [dispatchItemId, setDispatchItemId] = useState(items[0]?.id || '');
  const [dispatchQty, setDispatchQty] = useState('');

  const runDispatch = () => {
    const qty = parseFloat(dispatchQty) || 0;
    if (qty <= 0) return;
    const item = items.find(i => i.id === dispatchItemId);
    if (!item) return;

    setItems(prev => {
      let working = prev.map(i => ({ ...i }));
      const target = working.find(i => i.id === dispatchItemId)!;
      let shortfall = qty - target.stock;
      target.stock -= qty;

      if (shortfall > 0.0001 && target.siblingIds.length > 0) {
        for (const sibId of target.siblingIds) {
          if (shortfall <= 0.0001) break;
          const sib = working.find(i => i.id === sibId);
          if (!sib || sib.stock <= 0) continue;
          const borrow = Math.min(shortfall, sib.stock);
          sib.stock -= borrow;
          target.stock += borrow;
          shortfall -= borrow;
          addLog('auto_transfer', `Auto-transferred ${borrow} Pcs from ${sib.name} to ${target.name} — shared RM, demand ran ahead of the original split.`);
        }
      }

      if (shortfall > 0.0001) {
        addLog('discrepancy', `⚠ ${target.name} still short by ${shortfall} Pcs after borrowing from any sibling(s) — this is a real shortage, needs a Discrepancy Control Entry, not an auto-fix.`);
      } else {
        addLog('dispatch', `Dispatched ${qty} Pcs of ${item.name}.`);
      }

      return working;
    });
    setDispatchQty('');
  };

  const kindMeta: Record<ActivityEntry['kind'], { icon: string; color: string }> = {
    receipt: { icon: '📥', color: 'text-indigo-700 bg-indigo-50 border-indigo-200' },
    dispatch: { icon: '🚚', color: 'text-slate-700 bg-slate-50 border-slate-200' },
    auto_transfer: { icon: '🔄', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    discrepancy: { icon: '⚠️', color: 'text-rose-700 bg-rose-50 border-rose-200' },
  };

  return (
    <div className="p-8 max-w-6xl">
      <div className="border-2 border-dashed border-amber-300 bg-amber-50/60 rounded-2xl px-6 py-4 mb-6">
        <p className="text-sm font-black text-amber-800">🧪 TRIAL SANDBOX — sample data only</p>
        <p className="text-xs text-amber-700 mt-1">Nothing on this screen touches your real inventory, Tally, or Firestore data — it only exists in this browser tab, right now. Use it to try the proposed Longer Pipe / CTL Assignment workflow before it's built into the real app. Refreshing the page or clicking Reset below throws everything here away.</p>
      </div>

      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">RM Receiving — Trial</h2>
          <p className="text-xs text-slate-500 font-medium mt-1 max-w-2xl">
            Sample items below: A-POST LH/RH are marked as siblings (interchangeable RM/CTL form); Upper/Rear/Lower Tube share one RM spec but different CTL lengths, so they stay independent. One invoice can cover several items at different bar lengths (e.g. Upper on one length, Rear+Lower on another) — Total Weight and Total Bill Value are entered once for the whole bill.
          </p>
        </div>
        <button onClick={resetAll} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-widest hover:border-rose-400 hover:text-rose-600 shrink-0">
          ↺ Reset Sample Data
        </button>
      </div>

      {/* Sample inventory table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-8">
        <table className="w-full text-left border-collapse text-sm">
          <thead className="bg-slate-900 text-slate-100 text-[10px] uppercase font-black tracking-widest">
            <tr>
              <th className="py-3 px-5">Item</th>
              <th className="py-3 px-5">Spec</th>
              <th className="py-3 px-5 text-right">Item Length</th>
              <th className="py-3 px-5 text-right">Stock</th>
              <th className="py-3 px-5">Siblings</th>
              <th className="py-3 px-5 text-center">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map(it => (
              <tr key={it.id} className="hover:bg-slate-50">
                <td className="py-3 px-5">
                  <p className="font-bold text-slate-800">{it.name}</p>
                  <p className="text-[10px] text-slate-400 font-mono">{it.sapCode}</p>
                </td>
                <td className="py-3 px-5 text-slate-500 text-xs">{it.spec}</td>
                <td className="py-3 px-5 text-right font-mono">{it.itemLengthMm} mm</td>
                <td className="py-3 px-5 text-right">
                  <span className={`font-black text-base ${it.stock < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{it.stock}</span>
                </td>
                <td className="py-3 px-5 text-xs text-slate-400">
                  {it.siblingIds.length > 0 ? it.siblingIds.map(sid => items.find(i => i.id === sid)?.name).join(', ') : '—'}
                </td>
                <td className="py-3 px-5 text-center">
                  <button onClick={() => openEntry(it)} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-xl font-black uppercase tracking-widest shadow-sm active:scale-95">
                    Material Entry
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Dispatch simulator */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-8">
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest mb-1">🚚 Simulate a Dispatch</h3>
        <p className="text-xs text-slate-400 mb-3">Type a quantity against an item to see the automatic sibling borrowing (LH ↔ RH) fire, with its log entry, when demand runs ahead of the original split.</p>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Item">
            <select value={dispatchItemId} onChange={(e) => setDispatchItemId(e.target.value)} className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
              {items.map(it => <option key={it.id} value={it.id}>{it.name} (stock {it.stock})</option>)}
            </select>
          </FormField>
          <FormField label="Dispatch Qty (Pcs)">
            <input type="number" value={dispatchQty} onChange={(e) => setDispatchQty(e.target.value)} className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm w-36" />
          </FormField>
          <button onClick={runDispatch} className="px-5 py-2.5 bg-slate-900 hover:bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest active:scale-95">
            Dispatch
          </button>
        </div>
      </div>

      {/* Activity log */}
      <div>
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest mb-3">Activity Log (this trial only)</h3>
        {log.length === 0 && (
          <div className="bg-slate-50 text-slate-400 text-sm font-bold rounded-2xl px-6 py-6 text-center">
            Nothing yet — try a Material Entry or a simulated dispatch above.
          </div>
        )}
        <div className="space-y-2">
          {log.map(entry => {
            const m = kindMeta[entry.kind];
            return (
              <div key={entry.id} className={`border rounded-xl px-4 py-3 text-xs ${m.color}`}>
                <div className="flex justify-between gap-3">
                  <span className="font-black">{m.icon} {entry.message}</span>
                  <span className="text-slate-400 shrink-0">{entry.timestamp}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Material Entry modal */}
      {entryForItem && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl max-w-lg w-full p-8 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-black text-slate-900">Material Entry — {entryForItem.name}</h3>
              <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">Trial</span>
            </div>

            {entryMode === null && (
              <div className="mt-4">
                <p className="text-xs text-slate-500 mb-3">How did this material arrive?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => setEntryMode('pieces')} className="border-2 border-slate-200 hover:border-emerald-500 rounded-2xl p-4 text-left">
                    <p className="text-sm font-black text-slate-800">Finished Pieces</p>
                    <p className="text-[11px] text-slate-400 mt-1">Received already cut to size — enter pieces directly.</p>
                  </button>
                  <button onClick={() => setEntryMode('longer')} className="border-2 border-slate-200 hover:border-indigo-500 rounded-2xl p-4 text-left">
                    <p className="text-sm font-black text-slate-800">Longer Pipe</p>
                    <p className="text-[11px] text-slate-400 mt-1">Needs cutting — enter the invoice, then one or more bar-length lines.</p>
                  </button>
                </div>
                <button onClick={closeEntry} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 mt-4">Cancel</button>
              </div>
            )}

            {entryMode === 'pieces' && step === 1 && (
              <div className="mt-4 space-y-3">
                <p className="text-[11px] text-slate-400">These invoice details apply to the whole bill — even if it covers several different finished parts, enter Total Weight and Total Bill Value once here.</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Supplier"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                  <FormField label="Invoice No."><input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                </div>
                <label className="flex items-start gap-2 text-xs font-bold text-slate-600 -mt-1 px-1">
                  <input type="checkbox" checked={bookedInUnit1} onChange={(e) => setBookedInUnit1(e.target.checked)} className="mt-0.5" />
                  <span>Invoice booked in Unit 1 — this invoice number won't be found in this unit's own Tally; Accounts should look it up in Unit 1's Tally instead.</span>
                </label>
                <FormField label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Total Weight (Kg)"><input type="number" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                  <FormField label="Total Bill Value (₹)"><input type="number" value={billValue} onChange={(e) => setBillValue(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={() => setEntryMode(null)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
                  <button onClick={() => setStep(2)} className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                    Next: Add Item Line(s) ›
                  </button>
                </div>
              </div>
            )}

            {entryMode === 'pieces' && step === 2 && (
              <div className="mt-4 space-y-4">
                {finishedLines.map((fl, idx) => (
                  <div key={fl.id} className="border-2 border-slate-100 rounded-2xl p-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Line {idx + 1}</p>
                      {finishedLines.length > 1 && (
                        <button onClick={() => removeFinishedLine(fl.id)} className="text-[10px] font-black uppercase tracking-widest text-rose-500 hover:text-rose-700">Remove</button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label="Item">
                        <select value={fl.itemId} onChange={(e) => patchFinishedLine(fl.id, l => ({ ...l, itemId: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
                          <option value="">Select item…</option>
                          {items.map(it => <option key={it.id} value={it.id}>{it.name} ({it.sapCode})</option>)}
                        </select>
                      </FormField>
                      <FormField label="Qty (Pcs)">
                        <input type="number" value={fl.qty} onChange={(e) => patchFinishedLine(fl.id, l => ({ ...l, qty: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                      </FormField>
                    </div>
                  </div>
                ))}

                <button onClick={addFinishedLine} className="w-full py-2.5 border-2 border-dashed border-slate-300 text-slate-500 hover:border-indigo-400 hover:text-indigo-600 rounded-xl text-xs font-black uppercase tracking-widest">
                  + Add Another Line (different item)
                </button>

                <div className="flex gap-2 pt-2">
                  <button onClick={() => setStep(1)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
                  <button onClick={saveFinishedPieces} disabled={!finishedLinesValid} className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                    Save (Trial only)
                  </button>
                </div>
              </div>
            )}

            {entryMode === 'longer' && step === 1 && (
              <div className="mt-4 space-y-3">
                {availableMfgInvoices.length > 0 && (
                  <div className="border-2 border-indigo-100 bg-indigo-50/50 rounded-2xl p-4 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-indigo-700">Pull from an existing RM Cross-Bill Invoice</p>
                    <p className="text-[11px] text-indigo-600/80">Fills in the invoice details and one line per material below — only Bars Received and the item assignment still need your input. In the real app, only invoices booked after this feature goes live would show up here.</p>
                    <div className="space-y-2">
                      {availableMfgInvoices.map(inv => (
                        <div key={inv.id} className="flex items-center justify-between gap-3 bg-white border border-indigo-100 rounded-xl px-3 py-2">
                          <div>
                            <p className="text-xs font-bold text-slate-800">{inv.manufacturerName} — {inv.invoiceNo}</p>
                            <p className="text-[10px] text-slate-400">{inv.materials.map(m => `${m.materialName} (${m.quantityPcs} Pcs)`).join(' · ')}</p>
                          </div>
                          <button onClick={() => pullFromInvoice(inv)} className="text-[10px] bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-black uppercase tracking-widest shrink-0">
                            Use This Invoice
                          </button>
                        </div>
                      ))}
                    </div>
                    {linkedInvoiceId && (
                      <p className="text-[11px] font-bold text-emerald-700">✓ Pulled Invoice {mfgInvoices.find(i => i.id === linkedInvoiceId)?.invoiceNo} — fields below are filled in; review and continue.</p>
                    )}
                  </div>
                )}
                <p className="text-[11px] text-slate-400">{availableMfgInvoices.length > 0 ? 'Or enter these details manually:' : 'These invoice details apply to the whole bill — even if it covers several items at different bar lengths, enter Total Weight and Total Bill Value once here.'}</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Supplier"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                  <FormField label="Invoice No."><input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                </div>
                <label className="flex items-start gap-2 text-xs font-bold text-slate-600 -mt-1 px-1">
                  <input type="checkbox" checked={bookedInUnit1} onChange={(e) => setBookedInUnit1(e.target.checked)} className="mt-0.5" />
                  <span>Invoice booked in Unit 1 — this invoice number won't be found in this unit's own Tally; Accounts should look it up in Unit 1's Tally instead.</span>
                </label>
                <FormField label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Total Weight (Kg)"><input type="number" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                  <FormField label="Total Bill Value (₹)"><input type="number" value={billValue} onChange={(e) => setBillValue(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={() => setEntryMode(null)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
                  <button onClick={() => setStep(2)} className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                    Next: Add Bar-Length Line(s) ›
                  </button>
                </div>
              </div>
            )}

            {entryMode === 'longer' && step === 2 && (
              <div className="mt-4 space-y-4">
                {lines.map((line, idx) => {
                  const lc = lineComputations[idx];
                  return (
                    <div key={line.id} className="border-2 border-slate-100 rounded-2xl p-4 space-y-3">
                      <div className="flex justify-between items-center">
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Line {idx + 1}</p>
                        {lines.length > 1 && (
                          <button onClick={() => removeLine(line.id)} className="text-[10px] font-black uppercase tracking-widest text-rose-500 hover:text-rose-700">Remove</button>
                        )}
                      </div>

                      <FormField label="Spec / Material (RM Group)">
                        {line.lockedFromInvoice ? (
                          <input disabled value={line.spec} className="w-full border-2 border-slate-100 bg-slate-50 rounded-xl px-3 py-2 text-sm text-slate-500 font-bold" />
                        ) : (
                          <select value={line.spec} onChange={(e) => setLineSpec(line.id, e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
                            <option value="">Select spec…</option>
                            {distinctSpecs.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        )}
                      </FormField>
                      <p className="text-[11px] text-slate-400 -mt-2">Only items that share this exact RM spec are shown below — a bar of one spec physically can't be cut into a different spec's item, so switching this drops any items you'd already checked that no longer belong.</p>
                      <div className="grid grid-cols-2 gap-3">
                        <FormField label="Bar Length (mm)">
                          {line.lockedFromInvoice ? (
                            <input disabled value={line.lengthMm} className="w-full border-2 border-slate-100 bg-slate-50 rounded-xl px-3 py-2 text-sm text-slate-500 font-bold" />
                          ) : (
                            <input type="number" value={line.lengthMm} onChange={(e) => patchLine(line.id, l => ({ ...l, lengthMm: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                          )}
                        </FormField>
                        <FormField label="Bars Received">
                          <input type="number" value={line.barsReceived} onChange={(e) => patchLine(line.id, l => ({ ...l, barsReceived: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                        </FormField>
                      </div>
                      {line.lockedFromInvoice && (
                        <p className="text-[11px] text-slate-400 -mt-2">Spec and Bar Length are locked — pulled from RM Cross-Bill's material catalog for this material code, same as that screen locks Piece Length.</p>
                      )}
                      <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-2 text-xs font-bold flex justify-between">
                        <span className="text-slate-500">Bars available: {lc.barsReceivedNum}</span>
                        {line.assignMode === 'byBars' ? (
                          <span className={lc.overAllotted ? 'text-rose-600' : 'text-slate-700'}>Remaining to allot: {lc.barsRemaining}</span>
                        ) : (
                          <span className={lc.overAllottedPieces ? 'text-rose-600' : 'text-slate-700'}>Length remaining: {lc.unattributedScrapMm}mm</span>
                        )}
                      </div>

                      <div className="flex gap-2 p-1 bg-slate-100 rounded-xl">
                        <button
                          onClick={() => patchLine(line.id, l => ({ ...l, assignMode: 'byBars' }))}
                          className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${line.assignMode === 'byBars' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}
                        >
                          Whole Bars per Item
                        </button>
                        <button
                          onClick={() => patchLine(line.id, l => ({ ...l, assignMode: 'byPieces' }))}
                          className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${line.assignMode === 'byPieces' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}
                        >
                          Split by Pieces (Shortage)
                        </button>
                      </div>
                      {line.assignMode === 'byPieces' && (
                        <p className="text-[11px] text-slate-400 -mt-1">Use this when very few bars came in and have to be shared across items due to a planning/RM shortage. Enter pieces directly per item — whatever length is left over is logged as one shared, unattributed scrap figure rather than credited to any single item.</p>
                      )}

                      {!line.spec && (
                        <p className="text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">Select a Spec / Material above to see which items can be cut from this RM group.</p>
                      )}

                      {line.spec && (
                        <>
                          <FormField label="Search items">
                            <input value={line.itemSearch} onChange={(e) => patchLine(line.id, l => ({ ...l, itemSearch: e.target.value }))} placeholder="Search by name or SAP code…" className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                          </FormField>

                          <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-xl divide-y divide-slate-100">
                            {searchItemsForSpec(line.spec, line.itemSearch).map(it => {
                          const checked = line.checkedItemIds.includes(it.id);
                          return (
                            <div key={it.id} className={`p-3 ${checked ? 'bg-indigo-50/40' : ''}`}>
                              <label className="flex items-center gap-2 text-sm font-bold text-slate-800">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => patchLine(line.id, l => ({
                                    ...l,
                                    checkedItemIds: l.checkedItemIds.includes(it.id) ? l.checkedItemIds.filter(x => x !== it.id) : [...l.checkedItemIds, it.id],
                                  }))}
                                />
                                {it.name} <span className="text-[10px] text-slate-400 font-mono">({it.itemLengthMm}mm)</span>
                                {idx === 0 && entryForItem.siblingIds.includes(it.id) && (
                                  <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 border border-sky-200">Sibling — pre-checked</span>
                                )}
                              </label>
                              {checked && line.assignMode === 'byBars' && (
                                <div className="mt-2 flex items-center gap-3 pl-6">
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="Bars"
                                    value={line.barsPerItem[it.id] || ''}
                                    onChange={(e) => patchLine(line.id, l => ({ ...l, barsPerItem: { ...l.barsPerItem, [it.id]: e.target.value } }))}
                                    className={`border-2 rounded-lg px-2 py-1 text-xs w-24 ${(lc.byItem?.[it.id]?.bars ?? 0) < 0 ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200'}`}
                                  />
                                  <span className="text-[11px] text-slate-500">
                                    = {lc.byItem?.[it.id]?.pcs ?? 0} Pcs (floor({lc.lengthMmNum || 0}÷{it.itemLengthMm})) · scrap {lc.byItem?.[it.id]?.scrapMmPerBar ?? 0}mm/bar
                                  </span>
                                </div>
                              )}
                              {checked && line.assignMode === 'byPieces' && (
                                <div className="mt-2 flex items-center gap-3 pl-6">
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="Pcs"
                                    value={line.pcsPerItem[it.id] || ''}
                                    onChange={(e) => patchLine(line.id, l => ({ ...l, pcsPerItem: { ...l.pcsPerItem, [it.id]: e.target.value } }))}
                                    className={`border-2 rounded-lg px-2 py-1 text-xs w-24 ${(lc.pcsByItem?.[it.id] ?? 0) < 0 ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200'}`}
                                  />
                                  <span className="text-[11px] text-slate-500">
                                    = {((parseFloat(line.pcsPerItem[it.id] || '') || 0) * it.itemLengthMm)}mm consumed
                                  </span>
                                </div>
                              )}
                            </div>
                              );
                            })}
                          </div>
                        </>
                      )}

                      {lc.hasNegativeEntry && (
                        <p className="text-[11px] font-bold text-rose-600">⚠ One of the items above has a negative value entered — that isn't physically possible, even if it happens to make the line's total add up. Fix it before saving.</p>
                      )}
                      {line.assignMode === 'byBars' && lc.overAllotted && (
                        <p className="text-[11px] font-bold text-rose-600">⚠ You've assigned more bars than were received on this line — reduce one of the entries above before saving.</p>
                      )}
                      {line.assignMode === 'byPieces' && lc.overAllottedPieces && (
                        <p className="text-[11px] font-bold text-rose-600">⚠ These pieces need more length than this line's bar(s) actually have — reduce one of the entries above before saving.</p>
                      )}
                      {lc.mode === 'byBars' && !lc.overAllotted && lc.barsRemaining > 0.0001 && (
                        <p className="text-[11px] font-bold text-rose-600">
                          ⚠ {lc.barsRemaining} bar(s) on this line are still unallotted — every bar received must be assigned to an item before Save is enabled (or reduce Bars Received to just what you're assigning now).
                          {line.lockedFromInvoice && ' This line was pulled from an RM Cross-Bill invoice, which gets marked "used" and won\'t be pullable again once saved, so leftover bars here would become untrackable.'}
                        </p>
                      )}
                    </div>
                  );
                })}

                <button onClick={addLine} className="w-full py-2.5 border-2 border-dashed border-slate-300 text-slate-500 hover:border-indigo-400 hover:text-indigo-600 rounded-xl text-xs font-black uppercase tracking-widest">
                  + Add Another Line (different bar length / items)
                </button>

                <div className="flex gap-2 pt-2">
                  <button onClick={() => setStep(1)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
                  <button onClick={saveLongerPipe} disabled={!allLinesValid} className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                    Save (Trial only)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TrialRMReceiving;
