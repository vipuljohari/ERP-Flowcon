import React, { useEffect, useMemo, useState } from 'react';
import { Part, RawMaterial, RMManufacturerInvoice, RMMaterialLength } from '../types';
import {
  pcsPerBar,
  MaterialEntryHeader,
  FinishedPieceLine,
  LongerPipeSubMode,
  LongerPipeLine,
  AllottedItem,
  validateLongerPipeLine,
  computeUnattributedScrapMm,
  getPullableInvoiceGroups,
  PullableInvoiceGroup,
} from '../services/materialEntry';
import { getLocalDateStr, correctedNow } from '../services/time';
import { MATERIAL_ENTRY_INVOICE_PULL_CUTOFF } from '../constants';

// ============================================================
// Material Entry — RM Receiving (Longer Pipe / Finished Pieces)
// ============================================================
// This replaces the old single-item/single-quantity Material Entry modal
// for tubular parts, per Vipul's sign-off after hand-testing every rule
// below in an Admin-only trial sandbox (components/TrialRMReceiving.tsx —
// kept in the repo as the validated reference this file was ported from,
// not part of the live app itself). Sheet-metal parts and plain RM-only
// inward entries are unaffected — see Inventory.tsx's openMaterialEntry().
//
// Two ways in:
//  - From a specific Part's "Material Entry" button (seedPart set) — the
//    normal case. Both modes are offered; Longer Pipe seeds its first line
//    from the RM that part is mapped to (RawMaterial.partId/partIds), and
//    pre-checks that part (+ its siblings) once a Spec/Material is chosen.
//  - From RM Cross-Bill Check's "Post to Inventory" shortcut (seedPart is
//    null, initialInvoiceKey is set) — skips straight to Longer Pipe step 2
//    with every line already pulled from that invoice; only the item
//    assignment still needs Store's input.
// ============================================================

const genId = () => Math.random().toString(36).substr(2, 9);

const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 px-1">{label}</label>
    {children}
  </div>
);

interface UIFinishedLine {
  key: string;
  partId: string;
  qty: string;
}

interface UILongerLine {
  key: string;
  rmId: string;
  barLengthMm: string;
  barsReceived: string;
  subMode: LongerPipeSubMode;
  checkedPartIds: string[];
  barsPerItem: Record<string, string>;
  pcsPerItem: Record<string, string>;
  itemSearch: string;
  // true when Spec/Bar Length/Bars Received were pulled from an RM Cross-Bill
  // invoice line — locked (non-editable), Remove hidden, can't be un-pulled.
  lockedFromInvoice: boolean;
  pulledFromInvoiceLineId?: string;
}

interface MaterialEntryProps {
  seedPart: Part | null;
  parts: Part[];
  rawMaterials: RawMaterial[];
  manufacturerInvoices: RMManufacturerInvoice[];
  materialLengths: RMMaterialLength[];
  initialInvoiceKey?: string | null;
  onInitialInvoiceConsumed?: () => void;
  // Third way in, alongside seedPart and initialInvoiceKey: opened directly
  // from a specific Raw Material's own "Material Entry" button on the RM
  // Inventory (RM-wise) ledger — a direct-from-manufacturer purchase that
  // was never booked through RM Cross-Bill Check at all. Skips straight to
  // Longer Pipe step 2 with one unlocked line seeded to this RM (no invoice
  // to pull details from, so Store types Supplier/Invoice/Date/Weight/Bill
  // Value in fresh, same as any manual line).
  initialRMId?: string | null;
  onInitialRMConsumed?: () => void;
  onSubmitFinishedPieces: (header: MaterialEntryHeader, lines: FinishedPieceLine[]) => void;
  onSubmitLongerPipe: (header: MaterialEntryHeader, lines: LongerPipeLine[]) => void;
  onClose: () => void;
}

const MaterialEntry: React.FC<MaterialEntryProps> = ({
  seedPart,
  parts,
  rawMaterials,
  manufacturerInvoices,
  materialLengths,
  initialInvoiceKey,
  onInitialInvoiceConsumed,
  initialRMId,
  onInitialRMConsumed,
  onSubmitFinishedPieces,
  onSubmitLongerPipe,
  onClose,
}) => {
  // Same "current calendar month only, no back-dating or future-dating"
  // rule already enforced elsewhere in Inventory.tsx — copied verbatim.
  const todayDateStr = useMemo(() => getLocalDateStr(), []);
  const minEntryDateStr = useMemo(() => {
    const now = correctedNow();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }, []);
  const isDateValid = (d: string) => !!d && d >= minEntryDateStr && d <= todayDateStr;

  const [entryMode, setEntryMode] = useState<'pieces' | 'longer' | null>(null);
  const [step, setStep] = useState<1 | 2>(1);

  const [supplier, setSupplier] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [bookedInUnit1, setBookedInUnit1] = useState(false);
  const [date, setDate] = useState(todayDateStr);
  const [weightKg, setWeightKg] = useState('');
  const [billValue, setBillValue] = useState('');

  const [finishedLines, setFinishedLines] = useState<UIFinishedLine[]>([]);
  const [lines, setLines] = useState<UILongerLine[]>([]);
  // Set once a Longer Pipe entry is pulled from (or pre-loaded from) an RM
  // Cross-Bill invoice — used to mark that invoice's lines "used" on Save.
  const [linkedInvoiceKey, setLinkedInvoiceKey] = useState<string | null>(null);

  // A part counts as mapped to an RM via EITHER mechanism this app
  // supports — a per-customer link set on the Part itself
  // (customerRMMappings) or the RM-side mapping set in RM Master
  // (RawMaterial.partId/partIds). This must match the exact predicate used
  // everywhere else in App.tsx (the RM Weight & Stock Reconciliation panel,
  // RM Master's own item list, etc.) — using only partId/partIds here would
  // wrongly show "no RM available" for any part that's actually mapped the
  // other way, even though the rest of the app already treats it as linked.
  const isPartMappedToRM = (p: Part, rm: RawMaterial): boolean =>
    p.customerRMMappings?.[rm.customerName] === rm.id || rm.partId === p.id || !!rm.partIds?.includes(p.id);

  const eligiblePartsForRM = (rmId: string): Part[] => {
    const rm = rawMaterials.find(r => r.id === rmId);
    if (!rm) return [];
    return parts.filter(p => isPartMappedToRM(p, rm));
  };

  // The RM this Material Entry's part is actually mapped to (normal case,
  // seedPart set) — seeds the first Longer Pipe line and filters which
  // invoices "Pull from Invoice" offers to just this spec, exactly like
  // RM Master's existing partId/partIds mapping already drives elsewhere.
  const impliedRM = useMemo(() => {
    if (!seedPart) return null;
    return rawMaterials.find(rm => isPartMappedToRM(seedPart, rm)) || null;
  }, [seedPart, rawMaterials]);

  const makeFinishedLine = (partId?: string): UIFinishedLine => ({ key: genId(), partId: partId || '', qty: '' });

  const makeLongerLine = (rmId?: string, preCheckPartIds: string[] = []): UILongerLine => {
    const rm = rmId ? rawMaterials.find(r => r.id === rmId) : undefined;
    return {
      key: genId(),
      rmId: rmId || '',
      // Auto-filled from the RM's own Length for convenience, but left
      // editable (not locked) as a safety margin for real-world bar-length
      // variance — unlike an invoice-pulled line, which IS hard-locked.
      barLengthMm: rm ? String(rm.length) : '',
      barsReceived: '',
      subMode: 'whole_bars',
      checkedPartIds: preCheckPartIds,
      barsPerItem: {},
      pcsPerItem: {},
      itemSearch: '',
      lockedFromInvoice: false,
    };
  };

  // Fresh entry every time this modal opens for a (possibly different)
  // seedPart — mirrors the trial's openEntry().
  useEffect(() => {
    setEntryMode(null);
    setStep(1);
    setSupplier('');
    setInvoiceNo('');
    setBookedInUnit1(false);
    setDate(todayDateStr);
    setWeightKg('');
    setBillValue('');
    setLinkedInvoiceKey(null);
    setFinishedLines([makeFinishedLine(seedPart?.id)]);
    if (seedPart && impliedRM) {
      const eligible = eligiblePartsForRM(impliedRM.id);
      const preCheck = eligible
        .filter(p => p.id === seedPart.id || seedPart.siblingIds?.includes(p.id) || p.siblingIds?.includes(seedPart.id))
        .map(p => p.id);
      setLines([makeLongerLine(impliedRM.id, preCheck)]);
    } else {
      setLines([makeLongerLine()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPart]);

  // --- Pull from RM Cross-Bill Invoice (searched from within this modal) ---
  const availableInvoiceGroups: PullableInvoiceGroup[] = useMemo(() => {
    if (!impliedRM) return [];
    return getPullableInvoiceGroups(manufacturerInvoices, materialLengths, impliedRM.id, MATERIAL_ENTRY_INVOICE_PULL_CUTOFF);
  }, [manufacturerInvoices, materialLengths, impliedRM]);

  const buildLinesFromInvoiceGroup = (group: PullableInvoiceGroup): UILongerLine[] =>
    group.lines.map(line => {
      const ml = materialLengths.find(m => m.materialCode === line.materialCode);
      const rmId = ml?.linkedRMId || '';
      const eligible = rmId ? eligiblePartsForRM(rmId) : [];
      const preCheck = seedPart
        ? eligible
            .filter(p => p.id === seedPart.id || seedPart.siblingIds?.includes(p.id) || p.siblingIds?.includes(seedPart.id))
            .map(p => p.id)
        : [];
      return {
        key: genId(),
        rmId,
        barLengthMm: ml ? String(ml.lengthMm) : '',
        barsReceived: String(line.quantityPcs),
        subMode: 'whole_bars' as LongerPipeSubMode,
        checkedPartIds: preCheck,
        barsPerItem: {},
        pcsPerItem: {},
        itemSearch: '',
        lockedFromInvoice: true,
        pulledFromInvoiceLineId: line.id,
      };
    });

  const pullFromInvoiceGroup = (group: PullableInvoiceGroup) => {
    const hasExistingData = lines.some(l => l.barLengthMm || l.barsReceived || l.checkedPartIds.length > 0);
    if (hasExistingData && !window.confirm(`Replace the current line(s) with Invoice ${group.invoiceNo}'s materials?`)) return;
    setSupplier(group.manufacturerName);
    setInvoiceNo(group.invoiceNo);
    setDate(group.date);
    const firstWeight = group.lines.find(l => l.totalWeightKg != null)?.totalWeightKg;
    setWeightKg(firstWeight != null ? String(firstWeight) : '');
    setBillValue(String(group.lines.reduce((s, l) => s + (l.itemValue || 0), 0)));
    setLinkedInvoiceKey(`${group.invoiceNo}__${group.manufacturerName}`);
    setLines(buildLinesFromInvoiceGroup(group));
  };

  // --- Jump straight in from RM Cross-Bill Check's "Post to Inventory" ---
  // Here seedPart is null (no single implied RM to filter by), so this
  // resolves the invoice group directly by its invoiceNo__manufacturerName
  // key across ALL manufacturerInvoices, then goes straight to step 2.
  useEffect(() => {
    if (!initialInvoiceKey) return;
    const linesForKey = manufacturerInvoices.filter(inv => `${inv.invoiceNo}__${inv.manufacturerName}` === initialInvoiceKey);
    if (linesForKey.length === 0) {
      onInitialInvoiceConsumed?.();
      return;
    }
    const first = linesForKey[0];
    const group: PullableInvoiceGroup = { invoiceNo: first.invoiceNo, manufacturerName: first.manufacturerName, date: first.date, lines: linesForKey };
    setEntryMode('longer');
    setStep(2);
    setSupplier(group.manufacturerName);
    setInvoiceNo(group.invoiceNo);
    setDate(group.date);
    const firstWeight = group.lines.find(l => l.totalWeightKg != null)?.totalWeightKg;
    setWeightKg(firstWeight != null ? String(firstWeight) : '');
    setBillValue(String(group.lines.reduce((s, l) => s + (l.itemValue || 0), 0)));
    setLinkedInvoiceKey(initialInvoiceKey);
    setLines(buildLinesFromInvoiceGroup(group));
    onInitialInvoiceConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInvoiceKey]);

  // --- Jump straight in from a specific RM's own "Material Entry" button
  // on the RM Inventory (RM-wise) ledger — a direct-from-manufacturer buy
  // that has no RM Cross-Bill invoice behind it at all. Unlike the invoice
  // pull above, nothing is locked here and no header fields are pre-filled
  // (there's no invoice to pull them from) — this only seeds which RM the
  // single starting line is for, exactly as if Store had picked it manually.
  useEffect(() => {
    if (!initialRMId) return;
    setEntryMode('longer');
    setStep(2);
    setLines([makeLongerLine(initialRMId, [])]);
    onInitialRMConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRMId]);

  const closeEntry = () => onClose();

  const patchLine = (key: string, updater: (l: UILongerLine) => UILongerLine) => {
    setLines(prev => prev.map(l => (l.key === key ? updater(l) : l)));
  };
  const addLine = () => setLines(prev => [...prev, makeLongerLine()]);
  const removeLine = (key: string) => setLines(prev => (prev.length > 1 ? prev.filter(l => l.key !== key) : prev));

  // Changing a (non-locked) line's RM drops any already-checked parts that
  // no longer belong, and re-fills Bar Length from the new RM — a bar of
  // one RM physically can't be cut into a different RM's parts.
  const setLineRM = (key: string, newRmId: string) => {
    const rm = rawMaterials.find(r => r.id === newRmId);
    const validIds = new Set(eligiblePartsForRM(newRmId).map(p => p.id));
    patchLine(key, l => ({
      ...l,
      rmId: newRmId,
      barLengthMm: rm ? String(rm.length) : l.barLengthMm,
      checkedPartIds: l.checkedPartIds.filter(id => validIds.has(id)),
      barsPerItem: Object.fromEntries(Object.entries(l.barsPerItem).filter(([id]) => validIds.has(id))),
      pcsPerItem: Object.fromEntries(Object.entries(l.pcsPerItem).filter(([id]) => validIds.has(id))),
    }));
  };

  const patchFinishedLine = (key: string, updater: (l: UIFinishedLine) => UIFinishedLine) => {
    setFinishedLines(prev => prev.map(l => (l.key === key ? updater(l) : l)));
  };
  const addFinishedLine = () => setFinishedLines(prev => [...prev, makeFinishedLine()]);
  const removeFinishedLine = (key: string) => setFinishedLines(prev => (prev.length > 1 ? prev.filter(l => l.key !== key) : prev));

  const tubeRawMaterials = useMemo(() => rawMaterials.filter(rm => rm.category !== 'sheet'), [rawMaterials]);

  // Convert every UI line's string inputs into the typed LongerPipeLine
  // shape services/materialEntry.ts's validators expect, and run those same
  // validators here — so the Save button's gating and (defensively)
  // App.tsx's save handlers are always checking the exact same rules.
  const lineComputations = useMemo(() => {
    return lines.map(l => {
      const allotments: AllottedItem[] = l.checkedPartIds.map(partId => ({
        partId,
        barsAllotted: l.subMode === 'whole_bars' ? parseFloat(l.barsPerItem[partId] || '') || 0 : undefined,
        piecesAllotted: l.subMode === 'split_pieces' ? parseFloat(l.pcsPerItem[partId] || '') || 0 : undefined,
      }));
      const typed: LongerPipeLine = {
        key: l.key,
        rmId: l.rmId,
        barLengthMm: parseFloat(l.barLengthMm) || 0,
        barsReceived: parseFloat(l.barsReceived) || 0,
        subMode: l.subMode,
        allotments,
        pulledFromInvoiceLineId: l.pulledFromInvoiceLineId,
      };
      const itemLengthById: Record<string, number> = {};
      l.checkedPartIds.forEach(id => {
        const p = parts.find(x => x.id === id);
        itemLengthById[id] = p?.itemLength || 0;
      });
      const error = validateLongerPipeLine(typed, itemLengthById);
      const barsAllotted = allotments.reduce((s, a) => s + (a.barsAllotted ?? 0), 0);
      const barsRemaining = typed.barsReceived - barsAllotted;
      const pcsAllottedTotal = allotments.reduce((s, a) => s + (a.piecesAllotted ?? 0), 0);
      const unattributedScrapMm = computeUnattributedScrapMm(typed, itemLengthById);
      return { ui: l, typed, itemLengthById, error, barsAllotted, barsRemaining, pcsAllottedTotal, unattributedScrapMm };
    });
  }, [lines, parts]);

  const allLinesValid = lineComputations.length > 0 && lineComputations.every(lc => lc.error === null) && isDateValid(date);

  const finishedLinesValid =
    finishedLines.length > 0 &&
    finishedLines.every(l => l.partId && (parseFloat(l.qty) || 0) > 0) &&
    isDateValid(date);

  const buildHeader = (): MaterialEntryHeader => ({
    supplierName: supplier,
    invoiceNo,
    date,
    totalWeightKg: weightKg ? parseFloat(weightKg) || undefined : undefined,
    totalBillValue: billValue ? parseFloat(billValue) || undefined : undefined,
    invoiceBookedInUnit1: bookedInUnit1,
  });

  const saveFinishedPieces = () => {
    if (!finishedLinesValid) return;
    const outLines: FinishedPieceLine[] = finishedLines
      .filter(l => l.partId && (parseFloat(l.qty) || 0) > 0)
      .map(l => ({ key: l.key, partId: l.partId, quantity: parseFloat(l.qty) || 0 }));
    if (outLines.length === 0) return;
    onSubmitFinishedPieces(buildHeader(), outLines);
  };

  const saveLongerPipe = () => {
    if (!allLinesValid) return;
    onSubmitLongerPipe(buildHeader(), lineComputations.map(lc => lc.typed));
  };

  const searchPartsFor = (rmId: string, search: string) =>
    eligiblePartsForRM(rmId).filter(
      p => p.name.toLowerCase().includes(search.toLowerCase()) || p.sapCode.toLowerCase().includes(search.toLowerCase())
    );

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-[2rem] shadow-2xl max-w-lg w-full p-8 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-black text-slate-900 mb-1">Material Entry{seedPart ? ` — ${seedPart.name}` : ''}</h3>

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
            <FormField label="Date">
              <input type="date" min={minEntryDateStr} max={todayDateStr} value={date} onChange={(e) => setDate(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
            </FormField>
            <p className="text-[11px] text-slate-400 -mt-2">Current month only ({minEntryDateStr} to {todayDateStr}) — previous months are locked.</p>
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
              <div key={fl.key} className="border-2 border-slate-100 rounded-2xl p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Line {idx + 1}</p>
                  {finishedLines.length > 1 && (
                    <button onClick={() => removeFinishedLine(fl.key)} className="text-[10px] font-black uppercase tracking-widest text-rose-500 hover:text-rose-700">Remove</button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Item">
                    <select value={fl.partId} onChange={(e) => patchFinishedLine(fl.key, l => ({ ...l, partId: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
                      <option value="">Select item…</option>
                      {parts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sapCode})</option>)}
                    </select>
                  </FormField>
                  <FormField label="Qty (Pcs)">
                    <input type="number" value={fl.qty} onChange={(e) => patchFinishedLine(fl.key, l => ({ ...l, qty: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                  </FormField>
                </div>
              </div>
            ))}

            <button onClick={addFinishedLine} className="w-full py-2.5 border-2 border-dashed border-slate-300 text-slate-500 hover:border-indigo-400 hover:text-indigo-600 rounded-xl text-xs font-black uppercase tracking-widest">
              + Add Another Line (different item)
            </button>

            {!isDateValid(date) && (
              <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">Entry Date must be within the current month ({minEntryDateStr} to {todayDateStr}).</p>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={() => setStep(1)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
              <button onClick={saveFinishedPieces} disabled={!finishedLinesValid} className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                Save
              </button>
            </div>
          </div>
        )}

        {entryMode === 'longer' && step === 1 && (
          <div className="mt-4 space-y-3">
            {availableInvoiceGroups.length > 0 && (
              <div className="border-2 border-indigo-100 bg-indigo-50/50 rounded-2xl p-4 space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-indigo-700">Pull from an existing RM Cross-Bill Invoice</p>
                <p className="text-[11px] text-indigo-600/80">Fills in the invoice details and one line per material below — only Bars Received and the item assignment still need your input.</p>
                <div className="space-y-2">
                  {availableInvoiceGroups.map(group => (
                    <div key={`${group.invoiceNo}__${group.manufacturerName}`} className="flex items-center justify-between gap-3 bg-white border border-indigo-100 rounded-xl px-3 py-2">
                      <div>
                        <p className="text-xs font-bold text-slate-800">{group.manufacturerName} — {group.invoiceNo}</p>
                        <p className="text-[10px] text-slate-400">{group.lines.map(l => `${l.materialName} (${l.quantityPcs} Pcs)`).join(' · ')}</p>
                      </div>
                      <button onClick={() => pullFromInvoiceGroup(group)} className="text-[10px] bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-black uppercase tracking-widest shrink-0">
                        Use This Invoice
                      </button>
                    </div>
                  ))}
                </div>
                {linkedInvoiceKey && (
                  <p className="text-[11px] font-bold text-emerald-700">✓ Pulled Invoice {invoiceNo} — fields below are filled in; review and continue.</p>
                )}
              </div>
            )}
            <p className="text-[11px] text-slate-400">{availableInvoiceGroups.length > 0 ? 'Or enter these details manually:' : 'These invoice details apply to the whole bill — even if it covers several items at different bar lengths, enter Total Weight and Total Bill Value once here.'}</p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Supplier"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
              <FormField label="Invoice No."><input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
            </div>
            <label className="flex items-start gap-2 text-xs font-bold text-slate-600 -mt-1 px-1">
              <input type="checkbox" checked={bookedInUnit1} onChange={(e) => setBookedInUnit1(e.target.checked)} className="mt-0.5" />
              <span>Invoice booked in Unit 1 — this invoice number won't be found in this unit's own Tally; Accounts should look it up in Unit 1's Tally instead.</span>
            </label>
            <FormField label="Date">
              <input type="date" min={minEntryDateStr} max={todayDateStr} value={date} onChange={(e) => setDate(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
            </FormField>
            <p className="text-[11px] text-slate-400 -mt-2">Current month only ({minEntryDateStr} to {todayDateStr}) — previous months are locked.</p>
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
              const rm = rawMaterials.find(r => r.id === line.rmId);
              return (
                <div key={line.key} className="border-2 border-slate-100 rounded-2xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Line {idx + 1}</p>
                    {lines.length > 1 && !line.lockedFromInvoice && (
                      <button onClick={() => removeLine(line.key)} className="text-[10px] font-black uppercase tracking-widest text-rose-500 hover:text-rose-700">Remove</button>
                    )}
                  </div>

                  <FormField label="Spec / Material (Raw Material)">
                    {line.lockedFromInvoice ? (
                      <input disabled value={rm ? `${rm.size} — ${rm.partName}` : '(no RM linked to this invoice material code yet — ask Admin to link it in RM Cross-Bill Check\'s Material Lengths)'} className="w-full border-2 border-slate-100 bg-slate-50 rounded-xl px-3 py-2 text-sm text-slate-500 font-bold" />
                    ) : (
                      <select value={line.rmId} onChange={(e) => setLineRM(line.key, e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
                        <option value="">Select Raw Material…</option>
                        {tubeRawMaterials.map(r => <option key={r.id} value={r.id}>{r.size} — {r.partName} ({r.length}mm)</option>)}
                      </select>
                    )}
                  </FormField>
                  <p className="text-[11px] text-slate-400 -mt-2">Only items this Raw Material is mapped to (RM Master's item mapping) are shown below — a bar physically can't be cut into an unrelated item, so switching this drops any items you'd already checked that no longer belong.</p>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField label="Bar Length (mm)">
                      {line.lockedFromInvoice ? (
                        <input disabled value={line.barLengthMm} className="w-full border-2 border-slate-100 bg-slate-50 rounded-xl px-3 py-2 text-sm text-slate-500 font-bold" />
                      ) : (
                        <input type="number" value={line.barLengthMm} onChange={(e) => patchLine(line.key, l => ({ ...l, barLengthMm: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                      )}
                    </FormField>
                    <FormField label="Bars Received">
                      {line.lockedFromInvoice ? (
                        <input disabled value={line.barsReceived} className="w-full border-2 border-slate-100 bg-slate-50 rounded-xl px-3 py-2 text-sm text-slate-500 font-bold" />
                      ) : (
                        <input type="number" value={line.barsReceived} onChange={(e) => patchLine(line.key, l => ({ ...l, barsReceived: e.target.value }))} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                      )}
                    </FormField>
                  </div>
                  {line.lockedFromInvoice && (
                    <p className="text-[11px] text-slate-400 -mt-2">Spec, Bar Length and Bars Received are all locked — pulled directly from this RM Cross-Bill invoice, so the physical quantity on the ground always matches what Accounts booked. This line also can't be removed — every material on this invoice must get a Material Entry; if the invoice was booked wrongly, Admin should delete and re-enter it in RM Cross-Bill Check rather than dropping a line here.</p>
                  )}

                  <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-2 text-xs font-bold flex justify-between">
                    <span className="text-slate-500">Bars available: {parseFloat(line.barsReceived) || 0}</span>
                    {line.subMode === 'whole_bars' ? (
                      <span className={lc.barsRemaining < -0.0001 ? 'text-rose-600' : 'text-slate-700'}>Remaining to allot: {lc.barsRemaining}</span>
                    ) : (
                      <span className={lc.unattributedScrapMm < -0.0001 ? 'text-rose-600' : 'text-slate-700'}>Length remaining: {lc.unattributedScrapMm}mm</span>
                    )}
                  </div>

                  <div className="flex gap-2 p-1 bg-slate-100 rounded-xl">
                    <button
                      onClick={() => patchLine(line.key, l => ({ ...l, subMode: 'whole_bars' }))}
                      className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${line.subMode === 'whole_bars' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}
                    >
                      Whole Bars per Item
                    </button>
                    <button
                      onClick={() => patchLine(line.key, l => ({ ...l, subMode: 'split_pieces' }))}
                      className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${line.subMode === 'split_pieces' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}
                    >
                      Split by Pieces (Shortage)
                    </button>
                  </div>
                  {line.subMode === 'split_pieces' && (
                    <p className="text-[11px] text-slate-400 -mt-1">Use this when very few bars came in and have to be shared across items due to a planning/RM shortage. Enter pieces directly per item — whatever length is left over is logged as one shared, unattributed scrap figure rather than credited to any single item.</p>
                  )}

                  {!line.rmId && (
                    <p className="text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">Select a Spec / Material above to see which items can be cut from this RM.</p>
                  )}

                  {line.rmId && (
                    <>
                      <FormField label="Search items">
                        <input value={line.itemSearch} onChange={(e) => patchLine(line.key, l => ({ ...l, itemSearch: e.target.value }))} placeholder="Search by name or SAP code…" className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                      </FormField>

                      <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-xl divide-y divide-slate-100">
                        {searchPartsFor(line.rmId, line.itemSearch).map(p => {
                          const checked = line.checkedPartIds.includes(p.id);
                          const isSibling = !!(seedPart && idx === 0 && (seedPart.siblingIds?.includes(p.id) || p.siblingIds?.includes(seedPart.id)));
                          const barsVal = parseFloat(line.barsPerItem[p.id] || '') || 0;
                          const pcsVal = parseFloat(line.pcsPerItem[p.id] || '') || 0;
                          const barLenNum = parseFloat(line.barLengthMm) || 0;
                          return (
                            <div key={p.id} className={`p-3 ${checked ? 'bg-indigo-50/40' : ''}`}>
                              <label className="flex items-center gap-2 text-sm font-bold text-slate-800">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => patchLine(line.key, l => ({
                                    ...l,
                                    checkedPartIds: l.checkedPartIds.includes(p.id) ? l.checkedPartIds.filter(x => x !== p.id) : [...l.checkedPartIds, p.id],
                                  }))}
                                />
                                {p.name} <span className="text-[10px] text-slate-400 font-mono">({p.itemLength || 0}mm)</span>
                                {isSibling && (
                                  <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 border border-sky-200">Sibling — pre-checked</span>
                                )}
                              </label>
                              {checked && line.subMode === 'whole_bars' && (
                                <div className="mt-2 flex items-center gap-3 pl-6">
                                  <input
                                    type="number"
                                    placeholder="Bars"
                                    value={line.barsPerItem[p.id] || ''}
                                    onChange={(e) => patchLine(line.key, l => ({ ...l, barsPerItem: { ...l.barsPerItem, [p.id]: e.target.value } }))}
                                    className={`border-2 rounded-lg px-2 py-1 text-xs w-24 ${barsVal < 0 ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200'}`}
                                  />
                                  <span className="text-[11px] text-slate-500">
                                    = {barsVal * pcsPerBar(barLenNum, p.itemLength || 0)} Pcs (floor({barLenNum || 0}÷{p.itemLength || 0}))
                                  </span>
                                </div>
                              )}
                              {checked && line.subMode === 'split_pieces' && (
                                <div className="mt-2 flex items-center gap-3 pl-6">
                                  <input
                                    type="number"
                                    placeholder="Pcs"
                                    value={line.pcsPerItem[p.id] || ''}
                                    onChange={(e) => patchLine(line.key, l => ({ ...l, pcsPerItem: { ...l.pcsPerItem, [p.id]: e.target.value } }))}
                                    className={`border-2 rounded-lg px-2 py-1 text-xs w-24 ${pcsVal < 0 ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200'}`}
                                  />
                                  <span className="text-[11px] text-slate-500">= {pcsVal * (p.itemLength || 0)}mm consumed</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {lc.error && (
                    <p className="text-[11px] font-bold text-rose-600">⚠ {lc.error}</p>
                  )}
                </div>
              );
            })}

            <button onClick={addLine} className="w-full py-2.5 border-2 border-dashed border-slate-300 text-slate-500 hover:border-indigo-400 hover:text-indigo-600 rounded-xl text-xs font-black uppercase tracking-widest">
              + Add Another Line (different bar length / items)
            </button>

            {!isDateValid(date) && (
              <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">Entry Date must be within the current month ({minEntryDateStr} to {todayDateStr}).</p>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={() => setStep(1)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
              <button onClick={saveLongerPipe} disabled={!allLinesValid} className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                Save
              </button>
            </div>
          </div>
        )}

        {entryMode !== null && (
          <button onClick={closeEntry} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 mt-4 block">Close</button>
        )}
      </div>
    </div>
  );
};

export default MaterialEntry;
