import React, { useEffect, useMemo, useState } from 'react';
import { Part, RawMaterial, RMManufacturerInvoice, RMMaterialLength, DimensionTolerance } from '../types';
import {
  pcsPerBar,
  MaterialEntryHeader,
  FinishedPieceLine,
  LongerPipeSubMode,
  LongerPipeLine,
  AllottedItem,
  validateLongerPipeLine,
  computeUnattributedScrapMm,
} from '../services/materialEntry';
import { getLocalDateStr, correctedNow } from '../services/time';
import { readAndCompressPhoto } from '../services/photo';
import { extractMaterialEntryPhoto } from '../services/gemini';
import { archivePhotoToDropbox, buildArchiveFileName } from '../services/dropboxArchive';
import { suggestMatchingRawMaterials } from '../services/dimensionTolerance';

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
//  - From a specific Raw Material's own "Material Entry" button on the RM
//    Inventory (RM-wise) ledger (seedPart is null, initialRMId is set) — a
//    direct-from-manufacturer buy with no RM Cross-Bill invoice behind it.
//
// A Manufacturer Invoice is no longer a way into this screen at all — per
// Vipul's sign-off, RM Cross-Bill Check's own Manufacturer Invoice wizard
// now does invoice entry AND bar allotment in one sitting (see
// RMCrossBillCheck.tsx and App.tsx's handleManufacturerInvoiceWithAllotment),
// so there is nothing left here to "pull" a manufacturer invoice into.
// ============================================================

const genId = () => Math.random().toString(36).substr(2, 9);

const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 px-1">{label}</label>
    {children}
  </div>
);

// Shown under Supplier/Invoice No. when "Camera Upload only" mode has
// locked them — Store/PPC can see what the photo read but can't change it;
// only Admin can, in the RM Approvals screen.
const LockedFieldNote: React.FC = () => (
  <p className="text-[9px] font-bold text-indigo-500 mt-1 px-1">🔒 Auto-filled from photo — locked. If this is wrong, Admin will correct it in RM Approvals.</p>
);

// Same visual pattern as RMCrossBillCheck.tsx's "Auto-fill from a photo
// (AI)" block, reused here for both Finished Pieces and Longer Pipe. A
// shared component (not copy-pasted twice) since the two Camera Upload
// entry points need to stay identical in behavior.
const CameraUploadBlock: React.FC<{
  inputIdPrefix: string;
  extracting: boolean;
  error: string | null;
  note: string | null;
  onFile: (file: File) => void;
}> = ({ inputIdPrefix, extracting, error, note, onFile }) => (
  <div className="border-2 border-dashed border-indigo-200 bg-indigo-50/40 rounded-2xl p-4 text-center">
    <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400 mb-2">Camera Upload — Auto-fill from a photo (AI)</p>
    <div className="flex items-center justify-center gap-3">
      <input
        type="file"
        accept="image/*"
        capture="environment"
        id={`${inputIdPrefix}-camera`}
        className="hidden"
        disabled={extracting}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
      <label htmlFor={`${inputIdPrefix}-camera`} className={`inline-flex items-center gap-2 px-4 py-2 bg-white border-2 border-indigo-200 rounded-xl text-xs font-black text-indigo-700 ${extracting ? 'cursor-wait opacity-70' : 'cursor-pointer hover:border-indigo-500'}`}>
        📷 Use Camera
      </label>
      <input
        type="file"
        accept="image/*"
        id={`${inputIdPrefix}-upload`}
        className="hidden"
        disabled={extracting}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
      <label htmlFor={`${inputIdPrefix}-upload`} className={`inline-flex items-center gap-2 px-4 py-2 bg-white border-2 border-indigo-200 rounded-xl text-xs font-black text-indigo-700 ${extracting ? 'cursor-wait opacity-70' : 'cursor-pointer hover:border-indigo-500'}`}>
        📁 Upload Photo
      </label>
    </div>
    {extracting && <p className="text-xs font-bold text-indigo-600 mt-3">⏳ Reading invoice photo…</p>}
    <p className="text-[10px] text-slate-400 mt-2">Reads the invoice and pre-fills the fields below — always review before saving. The photo is also saved to Dropbox for your records either way.</p>
    {error && <p className="text-[11px] font-bold text-rose-600 mt-2">{error}</p>}
    {note && <p className="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2 mt-2 text-left">{note}</p>}
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
  // Auto-Assign — one decision per RM size/spec (this line), not per item
  // within it and not shared across every line in the entry: an invoice
  // covering two different RM sizes can auto-assign one and allot the other
  // item-by-item. See services/materialEntry.ts's LongerPipeLine.autoAssign.
  autoAssign: boolean;
}

interface MaterialEntryProps {
  seedPart: Part | null;
  parts: Part[];
  rawMaterials: RawMaterial[];
  // No longer read by this component — the "Pull from Invoice" bridge that
  // used to read these was removed along with the rest of the two-stage
  // Manufacturer Invoice design (see the file header comment above). Kept
  // as accepted-but-unused props purely so Inventory.tsx's existing
  // `<MaterialEntry manufacturerInvoices={...} materialLengths={...}>`
  // call site doesn't need to change.
  manufacturerInvoices: RMManufacturerInvoice[];
  materialLengths: RMMaterialLength[];
  // Second way in, alongside seedPart: opened directly from a specific Raw
  // Material's own "Material Entry" button on the RM Inventory (RM-wise)
  // ledger — a direct-from-manufacturer purchase that was never booked
  // through RM Cross-Bill Check at all. Skips straight to Longer Pipe step 2
  // with one unlocked line seeded to this RM (no invoice to pull details
  // from, so Store types Supplier/Invoice/Date/Weight/Bill Value in fresh,
  // same as any manual line).
  initialRMId?: string | null;
  onInitialRMConsumed?: () => void;
  onSubmitFinishedPieces: (header: MaterialEntryHeader, lines: FinishedPieceLine[]) => void;
  onSubmitLongerPipe: (header: MaterialEntryHeader, lines: LongerPipeLine[]) => void;
  onClose: () => void;
  isAdmin?: boolean;
  // Camera Upload's dimension-tolerance table — see
  // services/dimensionTolerance.ts. Only used for the Longer Pipe RM
  // suggestion and the Admin-only editor below; harmless if omitted.
  dimensionTolerances?: DimensionTolerance[];
  setDimensionTolerances?: (update: DimensionTolerance[] | ((prev: DimensionTolerance[]) => DimensionTolerance[])) => void;
  // Universal RM Receiving entry-mode switch — Admin sets this once, from
  // the top of the RM Approvals screen, and it applies here AND to RM
  // Cross-Bill Check's Manufacturer Invoice wizard at the same time (not a
  // per-screen control anymore). Both default true so existing behavior is
  // preserved on deploy. When cameraEnabled is true and manualEnabled is
  // false ("Camera Upload only"), Supplier and Invoice No. lock to whatever
  // the photo read — Store/PPC can't hand-edit them; only Admin can correct
  // them afterwards, in the RM Approvals screen, before approving.
  cameraEnabled?: boolean;
  manualEnabled?: boolean;
}

const MaterialEntry: React.FC<MaterialEntryProps> = ({
  seedPart,
  parts,
  rawMaterials,
  initialRMId,
  onInitialRMConsumed,
  onSubmitFinishedPieces,
  onSubmitLongerPipe,
  onClose,
  isAdmin = false,
  dimensionTolerances = [],
  setDimensionTolerances,
  cameraEnabled = true,
  manualEnabled = true,
}) => {
  // "Camera Upload only" — Manual Entry is switched off, so Store/PPC have
  // no way to type Supplier/Invoice No. themselves; those two fields lock to
  // whatever the photo read (or stay blank/wrong until Admin fixes them in
  // the RM Approvals screen). Every other field here stays freely editable
  // either way — this lock is deliberately narrow, per Vipul's ask.
  const cameraOnlyMode = cameraEnabled && !manualEnabled;
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
  const [dharamkantaWeightKg, setDharamkantaWeightKg] = useState('');

  // --- Camera Upload (both modes) ---
  // Reads a photo of the supplier's invoice and pre-fills the header above
  // — Supplier/Invoice No./Date/Total Weight/Total Bill Value — same
  // "always review before Save" convention as RM Cross-Bill Check's own
  // photo auto-fill. Dharamkanta Weight is never touched by this — it's a
  // physical weighbridge slip, always typed in by hand. Every captured
  // photo is also archived to Dropbox (fire-and-forget, never blocks this
  // form) regardless of whether the AI could read it.
  const [extractingPhoto, setExtractingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [rmMatchNote, setRmMatchNote] = useState<string | null>(null);

  const handleMaterialPhotoUpload = async (file: File, mode: 'pieces' | 'longer') => {
    setPhotoError(null);
    setRmMatchNote(null);
    setExtractingPhoto(true);
    try {
      const { base64, mimeType } = await readAndCompressPhoto(file);
      // Fire-and-forget — never awaited into the extraction's own
      // success/failure path, and archivePhotoToDropbox itself swallows
      // its own errors (see that file). A photo the AI can't read is still
      // worth keeping in the archive.
      archivePhotoToDropbox(base64, mimeType, buildArchiveFileName(supplier || 'unknown', invoiceNo || 'pending'));

      const extracted = await extractMaterialEntryPhoto(base64, mimeType);
      setSupplier(prev => extracted.supplierName || prev);
      setInvoiceNo(prev => extracted.invoiceNo || prev);
      if (extracted.date) setDate(extracted.date);
      if (extracted.totalWeightKg > 0) setWeightKg(String(extracted.totalWeightKg));
      if (extracted.totalBillValue > 0) setBillValue(String(extracted.totalBillValue));

      if (mode === 'longer') {
        const matches = suggestMatchingRawMaterials(
          { odMm: extracted.odMm, thicknessMm: extracted.thicknessMm, lengthMm: extracted.lengthMm },
          rawMaterials,
          dimensionTolerances
        );
        if (matches.length > 0 && lines[0]) {
          const best = matches[0];
          const firstLineKey = lines[0].key;
          setLineRM(firstLineKey, best.id);
          if (extracted.quantityPcs > 0) {
            patchLine(firstLineKey, l => ({ ...l, barsReceived: String(extracted.quantityPcs) }));
          }
          setRmMatchNote(`Matched to ${best.size} — ${best.partName} from the photo (${extracted.materialDescription || 'no description read'}). Verify before saving — you can change it above.`);
        } else if (extracted.materialDescription) {
          setRmMatchNote(`Couldn't confidently match "${extracted.materialDescription}" to a Raw Material — pick it by hand below. If this size recurs, ask Admin to add its tolerance under "Dimension Tolerances".`);
        }
      }
    } catch (err: any) {
      setPhotoError(err?.message || 'Could not read this photo — enter the details manually below.');
    } finally {
      setExtractingPhoto(false);
    }
  };

  // --- Admin-only Dimension Tolerances editor ---
  const [showToleranceEditor, setShowToleranceEditor] = useState(false);
  const [newTolerance, setNewTolerance] = useState<{ field: 'OD' | 'Thickness'; nominal: string; acceptedValues: string }>({ field: 'Thickness', nominal: '', acceptedValues: '' });
  const addTolerance = () => {
    const nominal = parseFloat(newTolerance.nominal);
    const acceptedValues = newTolerance.acceptedValues.split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n));
    if (!Number.isFinite(nominal) || acceptedValues.length === 0 || !setDimensionTolerances) return;
    setDimensionTolerances(prev => [
      ...prev.filter(t => !(t.field === newTolerance.field && t.nominal === nominal)),
      { id: `${newTolerance.field.toLowerCase()}-${nominal}`, field: newTolerance.field, nominal, acceptedValues, updatedAt: new Date().toISOString() },
    ]);
    setNewTolerance({ field: 'Thickness', nominal: '', acceptedValues: '' });
  };
  const removeTolerance = (id: string) => setDimensionTolerances?.(prev => prev.filter(t => t.id !== id));

  const [finishedLines, setFinishedLines] = useState<UIFinishedLine[]>([]);
  const [lines, setLines] = useState<UILongerLine[]>([]);

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
  // seedPart set) — seeds the first Longer Pipe line, exactly like RM
  // Master's existing partId/partIds mapping already drives elsewhere.
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
      autoAssign: false,
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

  // --- Jump straight in from a specific RM's own "Material Entry" button
  // on the RM Inventory (RM-wise) ledger — a direct-from-manufacturer buy
  // that has no RM Cross-Bill invoice behind it at all. Unlike the invoice
  // pull above, nothing is locked here and no header fields are pre-filled
  // (there's no invoice to pull them from), so this stops at step 1 — the
  // invoice header still needs Supplier/Invoice No./Date/Weight/Bill Value
  // typed in fresh — with the Longer Pipe line already seeded to this RM so
  // Store lands straight on it after filling in the header (previously this
  // jumped straight to step 2, skipping the header entirely and forcing a
  // confusing "Back" just to reach it).
  useEffect(() => {
    if (!initialRMId) return;
    setEntryMode('longer');
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
      // Auto-Assign is a per-line decision (this line's own RM size/spec) —
      // when it's on for this line, that line ignores whatever is checked,
      // no per-item split at all; the full Bars Received amount goes
      // straight into this line's RM's shared stock pool (see
      // services/materialEntry.ts's autoAssign comment). A different line
      // in the same entry (a different RM size on the same invoice) can
      // make the opposite choice independently.
      const allotments: AllottedItem[] = l.autoAssign ? [] : l.checkedPartIds.map(partId => ({
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
        autoAssign: l.autoAssign,
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

  // The invoice header is mandatory in full — Supplier, Invoice No., Total
  // Weight, Total Bill Value and the Dharamkanta (weighbridge) Weight all
  // have to be filled in before moving past step 1, and are re-checked here
  // (not just on the "Next" button) so Save can never go through with any of
  // them blank even if a Next-button check is ever bypassed.
  const headerValid =
    supplier.trim().length > 0 &&
    invoiceNo.trim().length > 0 &&
    (parseFloat(weightKg) || 0) > 0 &&
    (parseFloat(billValue) || 0) > 0 &&
    (parseFloat(dharamkantaWeightKg) || 0) > 0 &&
    isDateValid(date);

  const allLinesValid = headerValid && lineComputations.length > 0 && lineComputations.every(lc => lc.error === null);

  const finishedLinesValid =
    headerValid &&
    finishedLines.length > 0 &&
    finishedLines.every(l => l.partId && (parseFloat(l.qty) || 0) > 0);

  const buildHeader = (): MaterialEntryHeader => ({
    supplierName: supplier,
    invoiceNo,
    date,
    totalWeightKg: weightKg ? parseFloat(weightKg) || undefined : undefined,
    totalBillValue: billValue ? parseFloat(billValue) || undefined : undefined,
    dharamkantaWeightKg: dharamkantaWeightKg ? parseFloat(dharamkantaWeightKg) || undefined : undefined,
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
            {cameraEnabled && (
              <CameraUploadBlock
                inputIdPrefix="me-pieces"
                extracting={extractingPhoto}
                error={photoError}
                note={null}
                onFile={(f) => handleMaterialPhotoUpload(f, 'pieces')}
              />
            )}
            <p className="text-[11px] text-slate-400">These invoice details apply to the whole bill — even if it covers several different finished parts, enter Total Weight and Total Bill Value once here. Fields marked * are required.</p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Supplier *">
                <input value={supplier} disabled={cameraOnlyMode} onChange={(e) => setSupplier(e.target.value)} className={`w-full border-2 rounded-xl px-3 py-2 text-sm ${cameraOnlyMode ? 'border-slate-100 bg-slate-50 text-slate-500 cursor-not-allowed' : 'border-slate-200'}`} />
                {cameraOnlyMode && <LockedFieldNote />}
              </FormField>
              <FormField label="Invoice No. *">
                <input value={invoiceNo} disabled={cameraOnlyMode} onChange={(e) => setInvoiceNo(e.target.value)} className={`w-full border-2 rounded-xl px-3 py-2 text-sm ${cameraOnlyMode ? 'border-slate-100 bg-slate-50 text-slate-500 cursor-not-allowed' : 'border-slate-200'}`} />
                {cameraOnlyMode && <LockedFieldNote />}
              </FormField>
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
              <FormField label="Total Weight (Kg) *"><input type="number" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
              <FormField label="Total Bill Value (₹) *"><input type="number" value={billValue} onChange={(e) => setBillValue(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
            </div>
            <FormField label="Dharamkanta Weight (Kg) *">
              <input type="number" value={dharamkantaWeightKg} onChange={(e) => setDharamkantaWeightKg(e.target.value)} placeholder="Actual weighbridge slip weight" className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
            </FormField>
            {!headerValid && (
              <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">Supplier, Invoice No., a valid Date, Total Weight, Total Bill Value and Dharamkanta Weight are all required before you can continue.</p>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={() => setEntryMode(null)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
              <button onClick={() => setStep(2)} disabled={!headerValid} className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
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
              <button onClick={saveFinishedPieces} disabled={!finishedLinesValid} className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                Post for Approval
              </button>
            </div>
          </div>
        )}

        {entryMode === 'longer' && step === 1 && (
          <div className="mt-4 space-y-3">
            {cameraEnabled && (
              <CameraUploadBlock
                inputIdPrefix="me-longer"
                extracting={extractingPhoto}
                error={photoError}
                note={rmMatchNote}
                onFile={(f) => handleMaterialPhotoUpload(f, 'longer')}
              />
            )}
            {isAdmin && (
              <div className="border border-slate-200 rounded-xl">
                <button type="button" onClick={() => setShowToleranceEditor(v => !v)} className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500">
                  <span>Dimension Tolerances ({dimensionTolerances.length})</span>
                  <span>{showToleranceEditor ? '▲' : '▼'}</span>
                </button>
                {showToleranceEditor && (
                  <div className="border-t border-slate-200 p-3 space-y-2">
                    <p className="text-[11px] text-slate-400">What a measured OD/Thickness can be invoiced as for a given nominal size, so Camera Upload still recognises it as the right Raw Material. e.g. nominal Thickness 2 accepting 1.8, 1.9.</p>
                    {dimensionTolerances.map(t => (
                      <div key={t.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-1.5 text-xs font-bold text-slate-700">
                        <span>{t.field} {t.nominal} → accepts {t.acceptedValues.join(', ')}</span>
                        <button type="button" onClick={() => removeTolerance(t.id)} className="text-rose-500 hover:text-rose-700 text-[10px] font-black uppercase">Remove</button>
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-1">
                      <select value={newTolerance.field} onChange={(e) => setNewTolerance({ ...newTolerance, field: e.target.value as 'OD' | 'Thickness' })} className="border-2 border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold">
                        <option value="Thickness">Thickness</option>
                        <option value="OD">OD</option>
                      </select>
                      <input type="number" placeholder="Nominal" value={newTolerance.nominal} onChange={(e) => setNewTolerance({ ...newTolerance, nominal: e.target.value })} className="w-20 border-2 border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
                      <input placeholder="Accepts (e.g. 1.8, 1.9)" value={newTolerance.acceptedValues} onChange={(e) => setNewTolerance({ ...newTolerance, acceptedValues: e.target.value })} className="flex-1 border-2 border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
                      <button type="button" onClick={addTolerance} className="px-3 py-1.5 bg-slate-900 text-white rounded-lg text-[10px] font-black uppercase">Add</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <p className="text-[11px] text-slate-400">These invoice details apply to the whole bill — even if it covers several items at different bar lengths, enter Total Weight and Total Bill Value once here. Fields marked * are required.</p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Supplier *">
                <input value={supplier} disabled={cameraOnlyMode} onChange={(e) => setSupplier(e.target.value)} className={`w-full border-2 rounded-xl px-3 py-2 text-sm ${cameraOnlyMode ? 'border-slate-100 bg-slate-50 text-slate-500 cursor-not-allowed' : 'border-slate-200'}`} />
                {cameraOnlyMode && <LockedFieldNote />}
              </FormField>
              <FormField label="Invoice No. *">
                <input value={invoiceNo} disabled={cameraOnlyMode} onChange={(e) => setInvoiceNo(e.target.value)} className={`w-full border-2 rounded-xl px-3 py-2 text-sm ${cameraOnlyMode ? 'border-slate-100 bg-slate-50 text-slate-500 cursor-not-allowed' : 'border-slate-200'}`} />
                {cameraOnlyMode && <LockedFieldNote />}
              </FormField>
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
              <FormField label="Total Weight (Kg) *"><input type="number" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
              <FormField label="Total Bill Value (₹) *"><input type="number" value={billValue} onChange={(e) => setBillValue(e.target.value)} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" /></FormField>
            </div>
            <FormField label="Dharamkanta Weight (Kg) *">
              <input type="number" value={dharamkantaWeightKg} onChange={(e) => setDharamkantaWeightKg(e.target.value)} placeholder="Actual weighbridge slip weight" className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
            </FormField>
            {!headerValid && (
              <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">Supplier, Invoice No., a valid Date, Total Weight, Total Bill Value and Dharamkanta Weight are all required before you can continue — even when pulling from an invoice, the Dharamkanta Weight still has to be entered by hand since it comes from the weighbridge slip, not the invoice.</p>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={() => setEntryMode(null)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
              <button onClick={() => setStep(2)} disabled={!headerValid} className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                Next: Add Bar-Length Line(s) ›
              </button>
            </div>
          </div>
        )}

        {entryMode === 'longer' && step === 2 && (
          <div className="mt-4 space-y-4">
            {rmMatchNote && (
              <p className="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2 text-left">{rmMatchNote}</p>
            )}
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
                      {line.lockedFromInvoice || line.subMode === 'whole_bars' || line.autoAssign ? (
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
                  {!line.lockedFromInvoice && !line.autoAssign && line.subMode === 'whole_bars' && (
                    <p className="text-[11px] text-slate-400 -mt-2">Bar Length is fixed to this Raw Material's own spec ({rm ? rm.length : '—'}mm) — it shouldn't change bar to bar. If a real shortage means bars have to be split unevenly across items, switch to "Split by Pieces (Shortage)" below, where Bar Length can be adjusted.</p>
                  )}

                  <label className="flex items-start gap-2 text-xs font-bold text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                    <input
                      type="checkbox"
                      checked={line.autoAssign}
                      onChange={(e) => patchLine(line.key, l => ({ ...l, autoAssign: e.target.checked }))}
                      className="mt-0.5"
                    />
                    <span>
                      Auto-Assign this size — skip item-wise allotment for this line only. Bars Received goes straight into this Raw Material's shared stock pool (in metres/pipes), same as before this per-item screen existed; dispatches keep subtracting consumption automatically per item, just like they already do today. If this invoice has another size/line, that one can make its own choice independently.
                    </span>
                  </label>

                  {line.autoAssign ? (
                    <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-2 text-xs font-bold text-slate-500">
                      No item split for this line — {parseFloat(line.barsReceived) || 0} bar(s) will be added to the RM's total stock only.
                    </div>
                  ) : (
                    <>
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
                      onClick={() => patchLine(line.key, l => ({ ...l, subMode: 'whole_bars', barLengthMm: l.lockedFromInvoice ? l.barLengthMm : (rm ? String(rm.length) : l.barLengthMm) }))}
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

            {/* Belt-and-suspenders: Step 2 is normally only reachable via
                Step 1's own "Next" button, which already gates on
                headerValid, so this shouldn't be visible in practice — kept
                as a defensive message rather than an unexplained dead grey
                Save button, same reasoning as the header-fields check on
                Step 1 itself. */}
            {isDateValid(date) && !headerValid && (
              <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
                Can't save yet — click "‹ Back" below to open Invoice Details. Supplier, Invoice No., Total Weight, Total Bill Value and Dharamkanta Weight are all required.
              </p>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={() => setStep(1)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">‹ Back</button>
              <button onClick={saveLongerPipe} disabled={!allLinesValid} className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                Post for Approval
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
