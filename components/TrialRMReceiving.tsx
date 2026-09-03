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
}

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

  const addLog = (kind: ActivityEntry['kind'], message: string) => {
    setLog(prev => [{ id: genId(), timestamp: nowStr(), kind, message }, ...prev]);
  };

  const resetAll = () => {
    if (!window.confirm('Reset the trial back to its starting sample data? This clears the activity log too.')) return;
    setItems(SEED_ITEMS);
    setLog([]);
    setEntryForItem(null);
  };

  // --- Material Entry modal state ---
  const [entryForItem, setEntryForItem] = useState<TrialItem | null>(null);
  const [entryMode, setEntryMode] = useState<'pieces' | 'longer' | null>(null);
  const [step, setStep] = useState<1 | 2>(1);

  // Invoice header fields — shared across the whole bill, entered once, for BOTH modes.
  const [supplier, setSupplier] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [date, setDate] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [billValue, setBillValue] = useState('');

  // Finished-pieces-only: one or more item+qty lines under the invoice header above —
  // e.g. 3 different CTL parts arriving already cut, on one bill.
  const [finishedLines, setFinishedLines] = useState<FinishedLine[]>([]);

  // Longer-pipe-only: one or more bar-length lines under the invoice header above.
  const [lines, setLines] = useState<Line[]>([]);

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
    setSupplier(''); setInvoiceNo(''); setDate(''); setWeightKg(''); setBillValue('');
    setLines([makeLine(item)]);
    setFinishedLines([makeFinishedLine(item)]);
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
        return {
          mode: 'byBars' as const,
          line, barsReceivedNum, lengthMmNum, byItem, barsAllotted, barsRemaining,
          overAllotted: barsRemaining < -0.0001,
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
      return {
        mode: 'byPieces' as const,
        line, barsReceivedNum, lengthMmNum, pcsByItem, totalAvailableMm, totalConsumedMm,
        unattributedScrapMm, overAllottedPieces: unattributedScrapMm < -0.0001, pcsAllottedTotal,
      };
    });
  }, [lines, items]);

  const isLineValid = (lc: typeof lineComputations[number]) => {
    if (lc.lengthMmNum <= 0 || lc.barsReceivedNum <= 0) return false;
    if (lc.mode === 'byBars') return !lc.overAllotted && lc.barsAllotted > 0;
    return !lc.overAllottedPieces && lc.pcsAllottedTotal > 0;
  };
  const allLinesValid = lineComputations.length > 0 && lineComputations.every(isLineValid);

  const searchItems = (search: string) => items.filter(it =>
    it.name.toLowerCase().includes(search.toLowerCase()) || it.sapCode.toLowerCase().includes(search.toLowerCase())
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
    addLog('receipt', `Finished Pieces Receipt — Invoice ${invoiceNo || 'n/a'} from ${supplier || 'supplier'}${date ? `, ${date}` : ''}${weightKg ? `, Total Weight ${weightKg} Kg` : ''}${billValue ? `, Total Bill Value ₹${inrFmt(parseFloat(billValue) || 0)}` : ''}. Received: ${parts.join('; ')}.`);
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
    addLog('receipt', `Longer Pipe Receipt — Invoice ${invoiceNo || 'n/a'} from ${supplier || 'supplier'}${date ? `, ${date}` : ''}${weightKg ? `, Total Weight ${weightKg} Kg` : ''}${billValue ? `, Total Bill Value ₹${inrFmt(parseFloat(billValue) || 0)}` : ''}. ${lineSummaries.join(' | ')}`);
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
                <p className="text-[11px] text-slate-400">These invoice details apply to the whole bill — even if it covers several items at different bar lengths, enter Total Weight and Total Bill Value once here.</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Supplier"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                  <FormField label="Invoice No."><input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
                </div>
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

                      <FormField label="Spec / Material">
                        <input value={line.spec} onChange={(e) => patchLine(line.id, l => ({ ...l, spec: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                      </FormField>
                      <div className="grid grid-cols-2 gap-3">
                        <FormField label="Bar Length (mm)">
                          <input type="number" value={line.lengthMm} onChange={(e) => patchLine(line.id, l => ({ ...l, lengthMm: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                        </FormField>
                        <FormField label="Bars Received">
                          <input type="number" value={line.barsReceived} onChange={(e) => patchLine(line.id, l => ({ ...l, barsReceived: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                        </FormField>
                      </div>
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

                      <FormField label="Search items">
                        <input value={line.itemSearch} onChange={(e) => patchLine(line.id, l => ({ ...l, itemSearch: e.target.value }))} placeholder="Search by name or SAP code…" className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                      </FormField>

                      <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-xl divide-y divide-slate-100">
                        {searchItems(line.itemSearch).map(it => {
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
                                    placeholder="Bars"
                                    value={line.barsPerItem[it.id] || ''}
                                    onChange={(e) => patchLine(line.id, l => ({ ...l, barsPerItem: { ...l.barsPerItem, [it.id]: e.target.value } }))}
                                    className="border-2 border-slate-200 rounded-lg px-2 py-1 text-xs w-24"
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
                                    placeholder="Pcs"
                                    value={line.pcsPerItem[it.id] || ''}
                                    onChange={(e) => patchLine(line.id, l => ({ ...l, pcsPerItem: { ...l.pcsPerItem, [it.id]: e.target.value } }))}
                                    className="border-2 border-slate-200 rounded-lg px-2 py-1 text-xs w-24"
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

                      {line.assignMode === 'byBars' && lc.overAllotted && (
                        <p className="text-[11px] font-bold text-rose-600">⚠ You've assigned more bars than were received on this line — reduce one of the entries above before saving.</p>
                      )}
                      {line.assignMode === 'byPieces' && lc.overAllottedPieces && (
                        <p className="text-[11px] font-bold text-rose-600">⚠ These pieces need more length than this line's bar(s) actually have — reduce one of the entries above before saving.</p>
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
