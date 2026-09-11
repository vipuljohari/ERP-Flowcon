import React, { useMemo, useState } from 'react';
import {
  PendingRMEntry, PendingLongerPipeLine, PendingMfgInvoiceLine, PendingFinishedPieceLine,
  PendingAllottedItem, PendingMaterialEntryHeader, PendingMfgInvoiceSubmission, Part, RawMaterial,
} from '../types';
import { pcsPerBar, computeUnattributedScrapMm } from '../services/materialEntry';

// ============================================================
// RM Approvals — Admin's review queue for every RM receiving entry
// Store/PPC has submitted (RM Cross-Bill Manufacturer Invoice, Material
// Entry Longer Pipe, Material Entry Finished Pieces). Nothing here has
// touched real stock yet — Approve is the only action that actually posts,
// by replaying the (possibly edited-here) payload through the exact same
// handler in App.tsx that used to run the moment Store clicked Save.
//
// Photo review: this phase of the feature doesn't yet have camera upload on
// Material Entry, and RM Cross-Bill's own camera upload doesn't archive to
// Dropbox yet either — so there is no photo attached to any entry here
// today. That's the next piece of this build, not a bug in this screen.
// ============================================================

interface RMApprovalQueueProps {
  entries: PendingRMEntry[];
  parts: Part[];
  rawMaterials: RawMaterial[];
  isAdmin?: boolean;
  onApprove: (entry: PendingRMEntry) => void;
  onUpdate: (id: string, updater: (e: PendingRMEntry) => PendingRMEntry) => void;
  onReject: (id: string, reason: string) => void;
  // Universal RM Receiving entry-mode switch — set from here, applies to RM
  // Cross-Bill Check's Manufacturer Invoice wizard AND Material Entry's
  // Finished Pieces / Longer Pipe all at once, not per-screen. When
  // cameraEnabled is true and manualEnabled is false ("Camera Upload only"),
  // Store/PPC can no longer hand-edit Invoice No. / Supplier/Manufacturer
  // Name on those 3 screens — this screen becomes the only place to fix a
  // wrong auto-read, via the editable fields below.
  cameraEnabled: boolean;
  manualEnabled: boolean;
  onSetCameraEnabled: (v: boolean) => void;
  onSetManualEnabled: (v: boolean) => void;
}

const isPartMappedToRM = (p: Part, rm: RawMaterial): boolean =>
  p.customerRMMappings?.[rm.customerName] === rm.id || rm.partId === p.id || !!rm.partIds?.includes(p.id);

const STATUS_META: Record<PendingRMEntry['status'], { label: string; badge: string; border: string }> = {
  pending: { label: 'Pending Approval', badge: 'bg-amber-100 text-amber-700 border-amber-200', border: 'border-l-amber-500' },
  not_matched: { label: 'Not Matched', badge: 'bg-rose-100 text-rose-700 border-rose-200', border: 'border-l-rose-500' },
  approved: { label: 'Approved & Posted', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', border: 'border-l-emerald-500' },
  rejected: { label: 'Rejected', badge: 'bg-slate-200 text-slate-500 border-slate-300', border: 'border-l-slate-300' },
};

const TYPE_LABEL: Record<PendingRMEntry['entryType'], string> = {
  finished_pieces: 'Material Entry — Finished Pieces',
  longer_pipe: 'Material Entry — Longer Pipe',
  manufacturer_invoice: 'RM Cross-Bill — Manufacturer Invoice',
};

const RMApprovalQueue: React.FC<RMApprovalQueueProps> = ({
  entries, parts, rawMaterials, isAdmin, onApprove, onUpdate, onReject,
  cameraEnabled, manualEnabled, onSetCameraEnabled, onSetManualEnabled,
}) => {
  const [filterStatus, setFilterStatus] = useState<'open' | 'all' | PendingRMEntry['status']>('open');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const sorted = useMemo(
    () => [...entries].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [entries]
  );
  const filtered = useMemo(() => sorted.filter(e => {
    if (filterStatus === 'all') return true;
    if (filterStatus === 'open') return e.status === 'pending' || e.status === 'not_matched';
    return e.status === filterStatus;
  }), [sorted, filterStatus]);

  const openCount = entries.filter(e => e.status === 'pending' || e.status === 'not_matched').length;
  const notMatchedCount = entries.filter(e => e.status === 'not_matched').length;

  const eligiblePartsForRM = (rmId: string): Part[] => {
    const rm = rawMaterials.find(r => r.id === rmId);
    if (!rm) return [];
    return parts.filter(p => isPartMappedToRM(p, rm));
  };

  // --- Header editing (Supplier/Manufacturer Name, Invoice No., etc.) ---
  // Always editable here, whatever the universal entry-mode setting says —
  // this screen is the one place that can fix a wrong or locked auto-read
  // from a photo before approving. Finished Pieces / Longer Pipe share one
  // header shape; Manufacturer Invoice carries its own fields at the top
  // level instead of a nested header.
  const patchHeader = (entry: PendingRMEntry, patch: Partial<PendingMaterialEntryHeader>) => {
    onUpdate(entry.id, e => {
      if (e.finishedPiecesPayload) return { ...e, finishedPiecesPayload: { ...e.finishedPiecesPayload, header: { ...e.finishedPiecesPayload.header, ...patch } } };
      if (e.longerPipePayload) return { ...e, longerPipePayload: { ...e.longerPipePayload, header: { ...e.longerPipePayload.header, ...patch } } };
      return e;
    });
  };
  const patchMfgHeader = (entry: PendingRMEntry, patch: Partial<PendingMfgInvoiceSubmission>) => {
    onUpdate(entry.id, e => e.manufacturerInvoicePayload ? { ...e, manufacturerInvoicePayload: { ...e.manufacturerInvoicePayload, ...patch } } : e);
  };

  // --- Finished Pieces editing ---
  const patchFinishedLine = (entry: PendingRMEntry, key: string, patch: Partial<PendingFinishedPieceLine>) => {
    onUpdate(entry.id, e => {
      if (!e.finishedPiecesPayload) return e;
      return {
        ...e,
        finishedPiecesPayload: {
          ...e.finishedPiecesPayload,
          lines: e.finishedPiecesPayload.lines.map(l => l.key === key ? { ...l, ...patch } : l),
        },
      };
    });
  };

  // --- Longer Pipe / Manufacturer Invoice line editing (shared shape) ---
  // Both PendingLongerPipeLine and PendingMfgInvoiceLine carry rmId,
  // barLengthMm, subMode, allotments, autoAssign — only the "how many bars
  // came in" field name differs (barsReceived vs quantityPcs), handled by
  // the caller passing it in already normalized.
  type EditableLine = { rmId: string; barLengthMm: number; barsReceived: number; subMode: 'whole_bars' | 'split_pieces'; allotments: PendingAllottedItem[]; autoAssign?: boolean };

  const renderLineEditor = (
    line: EditableLine,
    onPatch: (patch: Partial<EditableLine>) => void,
  ) => {
    const rm = rawMaterials.find(r => r.id === line.rmId);
    const itemLengthById: Record<string, number> = {};
    line.allotments.forEach(a => {
      const p = parts.find(x => x.id === a.partId);
      itemLengthById[a.partId] = p?.itemLength || 0;
    });
    const barsAllotted = line.allotments.reduce((s, a) => s + (a.barsAllotted ?? 0), 0);
    const barsRemaining = line.barsReceived - barsAllotted;
    const unattributedScrapMm = computeUnattributedScrapMm(
      { key: '', rmId: line.rmId, barLengthMm: line.barLengthMm, barsReceived: line.barsReceived, subMode: line.subMode, allotments: line.allotments },
      itemLengthById
    );

    return (
      <div className="border-2 border-slate-100 rounded-2xl p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Raw Material</label>
            {!line.rmId ? (
              <select
                value=""
                onChange={(e) => {
                  const newRmId = e.target.value;
                  const newRm = rawMaterials.find(r => r.id === newRmId);
                  onPatch({ rmId: newRmId, barLengthMm: newRm ? newRm.length : line.barLengthMm, allotments: [] });
                }}
                className="w-full border-2 border-rose-300 bg-rose-50 rounded-xl px-3 py-2 text-sm font-bold text-rose-700"
              >
                <option value="">— Not Matched: select the correct Raw Material —</option>
                {rawMaterials.filter(r => r.category !== 'sheet').map(r => (
                  <option key={r.id} value={r.id}>{r.size} — {r.partName} ({r.length}mm)</option>
                ))}
              </select>
            ) : (
              <select
                value={line.rmId}
                onChange={(e) => {
                  const newRmId = e.target.value;
                  const newRm = rawMaterials.find(r => r.id === newRmId);
                  const validIds = new Set(eligiblePartsForRM(newRmId).map(p => p.id));
                  onPatch({
                    rmId: newRmId,
                    barLengthMm: newRm ? newRm.length : line.barLengthMm,
                    allotments: line.allotments.filter(a => validIds.has(a.partId)),
                  });
                }}
                className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm font-bold"
              >
                {rawMaterials.filter(r => r.category !== 'sheet').map(r => (
                  <option key={r.id} value={r.id}>{r.size} — {r.partName} ({r.length}mm)</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Bar Length (mm)</label>
            <input type="number" value={line.barLengthMm} onChange={(e) => onPatch({ barLengthMm: parseFloat(e.target.value) || 0 })} className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
          </div>
        </div>

        {!line.rmId && (
          <p className="text-[11px] font-bold text-rose-600">Pick the Raw Material this material/photo actually is before it can be approved.</p>
        )}

        {line.rmId && (
          <>
            <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-2 text-xs font-bold flex justify-between">
              <span className="text-slate-500">Bars: {line.barsReceived}</span>
              {line.subMode === 'whole_bars' ? (
                <span className={barsRemaining < -0.0001 || barsRemaining > 0.0001 ? 'text-rose-600' : 'text-slate-700'}>Remaining to allot: {barsRemaining}</span>
              ) : (
                <span className={unattributedScrapMm < -0.0001 ? 'text-rose-600' : 'text-slate-700'}>Length remaining: {unattributedScrapMm}mm</span>
              )}
            </div>

            <div className="flex gap-2 p-1 bg-slate-100 rounded-xl">
              <button onClick={() => onPatch({ subMode: 'whole_bars' })} className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${line.subMode === 'whole_bars' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}>Whole Bars per Item</button>
              <button onClick={() => onPatch({ subMode: 'split_pieces' })} className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${line.subMode === 'split_pieces' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}>Split by Pieces</button>
            </div>

            <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-xl divide-y divide-slate-100">
              {eligiblePartsForRM(line.rmId).map(p => {
                const existing = line.allotments.find(a => a.partId === p.id);
                const checked = !!existing;
                const barsVal = existing?.barsAllotted ?? 0;
                const pcsVal = existing?.piecesAllotted ?? 0;
                const barLenNum = line.barLengthMm;
                return (
                  <div key={p.id} className={`p-3 ${checked ? 'bg-indigo-50/40' : ''}`}>
                    <label className="flex items-center gap-2 text-sm font-bold text-slate-800">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          if (checked) {
                            onPatch({ allotments: line.allotments.filter(a => a.partId !== p.id) });
                          } else {
                            onPatch({ allotments: [...line.allotments, { partId: p.id, barsAllotted: 0, piecesAllotted: 0 }] });
                          }
                        }}
                      />
                      {p.name} <span className="text-[10px] text-slate-400 font-mono">({p.itemLength || 0}mm)</span>
                    </label>
                    {checked && line.subMode === 'whole_bars' && (
                      <div className="mt-2 flex items-center gap-3 pl-6">
                        <input
                          type="number"
                          value={barsVal}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            onPatch({ allotments: line.allotments.map(a => a.partId === p.id ? { ...a, barsAllotted: v } : a) });
                          }}
                          className="border-2 border-slate-200 rounded-lg px-2 py-1 text-xs w-24"
                        />
                        <span className="text-[11px] text-slate-500">= {barsVal * pcsPerBar(barLenNum, p.itemLength || 0)} Pcs</span>
                      </div>
                    )}
                    {checked && line.subMode === 'split_pieces' && (
                      <div className="mt-2 flex items-center gap-3 pl-6">
                        <input
                          type="number"
                          value={pcsVal}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            onPatch({ allotments: line.allotments.map(a => a.partId === p.id ? { ...a, piecesAllotted: v } : a) });
                          }}
                          className="border-2 border-slate-200 rounded-lg px-2 py-1 text-xs w-24"
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
      </div>
    );
  };

  const startRejecting = (id: string) => { setRejectingId(id); setRejectReason(''); };
  const submitReject = (id: string) => {
    if (!rejectReason.trim()) return;
    onReject(id, rejectReason.trim());
    setRejectingId(null);
    setRejectReason('');
  };

  const canApprove = (e: PendingRMEntry): boolean => {
    if (e.status === 'approved' || e.status === 'rejected') return false;
    if (e.entryType === 'finished_pieces') return !!e.finishedPiecesPayload && e.finishedPiecesPayload.lines.every(l => l.partId && l.quantity > 0);
    if (e.entryType === 'longer_pipe') return !!e.longerPipePayload && e.longerPipePayload.lines.every(l => !!l.rmId);
    if (e.entryType === 'manufacturer_invoice') return !!e.manufacturerInvoicePayload && e.manufacturerInvoicePayload.lines.every(l => !!l.rmId);
    return false;
  };

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none">RM Approvals</h2>
            {openCount > 0 && (
              <span className="bg-amber-600 text-white px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm">
                {openCount} Awaiting You
              </span>
            )}
            {notMatchedCount > 0 && (
              <span className="bg-rose-600 text-white px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm animate-pulse">
                {notMatchedCount} Not Matched
              </span>
            )}
          </div>
          <p className="text-slate-500 font-medium">
            Every RM Cross-Bill Manufacturer Invoice and Material Entry (Longer Pipe / Finished Pieces) Store or PPC submits lands here first — nothing posts to inventory until you approve it.
          </p>
        </div>
        <select
          className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm font-bold bg-white text-slate-900 shadow-sm"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as any)}
        >
          <option value="open">Open (Pending + Not Matched)</option>
          <option value="pending">Pending Approval</option>
          <option value="not_matched">Not Matched</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </header>

      {isAdmin && (
        <div className="bg-white rounded-[1.75rem] shadow-sm border border-slate-100 p-6 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Entry Settings — applies to RM Cross-Bill, Finished Pieces and Longer Pipe together</p>
          <div className="flex flex-col md:flex-row gap-3">
            <label className="flex items-start gap-2 text-xs font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 flex-1">
              <input type="checkbox" checked={cameraEnabled} onChange={(ev) => onSetCameraEnabled(ev.target.checked)} className="mt-0.5" />
              <span>Camera Upload enabled for Store/PPC — offers the photo auto-fill shortcut on all 3 screens.</span>
            </label>
            <label className="flex items-start gap-2 text-xs font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 flex-1">
              <input type="checkbox" checked={manualEnabled} onChange={(ev) => onSetManualEnabled(ev.target.checked)} className="mt-0.5" />
              <span>Manual Entry enabled for Store/PPC — lets them type/edit Invoice No. and Supplier/Manufacturer Name by hand.</span>
            </label>
          </div>
          {cameraEnabled && !manualEnabled && (
            <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              Camera Upload only: Invoice No. and Supplier/Manufacturer Name will lock to whatever the photo reads on Store/PPC's screen — they won't be able to edit them. If a read comes out wrong, fix it here on the entry below before approving.
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(e => {
          const meta = STATUS_META[e.status];
          const isOpen = expandedId === e.id;
          const editable = e.status === 'pending' || e.status === 'not_matched';
          return (
            <div key={e.id} className={`bg-white rounded-[1.75rem] shadow-sm border border-l-4 ${meta.border} border-slate-100 p-6 space-y-4`}>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${meta.badge}`}>{meta.label}</span>
                    <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border bg-slate-100 text-slate-600 border-slate-200">{TYPE_LABEL[e.entryType]}</span>
                    <span className="text-[10px] font-bold text-slate-400">{new Date(e.submittedAt).toLocaleString('en-GB')} — {e.submittedBy}</span>
                  </div>
                  <p className="text-sm font-bold text-slate-800">{e.summary}</p>
                  {e.notMatchedReason && <p className="text-xs font-bold text-rose-600">{e.notMatchedReason}</p>}
                  {e.status === 'rejected' && e.rejectionReason && (
                    <p className="text-xs font-bold text-slate-500 italic">Rejected by {e.reviewedBy}: "{e.rejectionReason}"</p>
                  )}
                  {e.status === 'approved' && (
                    <p className="text-xs font-bold text-emerald-600">Approved & posted by {e.reviewedBy} on {e.reviewedAt ? new Date(e.reviewedAt).toLocaleString('en-GB') : ''}</p>
                  )}
                </div>
                <div className="shrink-0 flex gap-2">
                  <button onClick={() => setExpandedId(isOpen ? null : e.id)} className="px-5 py-2.5 border-2 border-slate-200 text-slate-600 rounded-xl font-black uppercase text-[10px] tracking-widest">
                    {isOpen ? 'Collapse' : 'Review'}
                  </button>
                  {editable && isAdmin && (
                    <>
                      <button onClick={() => startRejecting(e.id)} className="px-5 py-2.5 border-2 border-slate-300 text-slate-500 hover:bg-slate-50 rounded-xl font-black uppercase text-[10px] tracking-widest">Reject</button>
                      <button
                        onClick={() => onApprove(e)}
                        disabled={!canApprove(e)}
                        className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-md active:scale-95 transition-all"
                      >
                        ✓ Approve & Post
                      </button>
                    </>
                  )}
                </div>
              </div>

              {rejectingId === e.id && (
                <div className="space-y-2 bg-slate-50 border border-slate-100 rounded-xl p-4">
                  <textarea autoFocus placeholder="Why is this being rejected?" value={rejectReason} onChange={(ev) => setRejectReason(ev.target.value)} className="w-full px-4 py-3 bg-white border-2 border-slate-200 rounded-xl outline-none text-xs font-bold min-h-[60px]" />
                  <div className="flex gap-2">
                    <button onClick={() => setRejectingId(null)} className="flex-1 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest">Cancel</button>
                    <button onClick={() => submitReject(e.id)} disabled={!rejectReason.trim()} className="flex-1 py-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">Confirm Reject</button>
                  </div>
                </div>
              )}

              {isOpen && (
                <div className="space-y-4 pt-2 border-t border-slate-100">
                  <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-2 text-[11px] font-bold text-amber-700">
                    No photo attached yet — camera upload for this entry type, and Dropbox archival, are a follow-up to this build. Verify against the physical invoice/paper bill for now.
                  </div>

                  {e.entryType === 'finished_pieces' && e.finishedPiecesPayload && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase">Supplier</p>
                          {editable ? (
                            <input value={e.finishedPiecesPayload.header.supplierName} onChange={(ev) => patchHeader(e, { supplierName: ev.target.value })} className="w-full border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
                          ) : (
                            <p className="font-bold">{e.finishedPiecesPayload.header.supplierName}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase">Invoice No.</p>
                          {editable ? (
                            <input value={e.finishedPiecesPayload.header.invoiceNo} onChange={(ev) => patchHeader(e, { invoiceNo: ev.target.value })} className="w-full border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
                          ) : (
                            <p className="font-bold">{e.finishedPiecesPayload.header.invoiceNo}</p>
                          )}
                        </div>
                        <div><p className="text-[9px] font-black text-slate-400 uppercase">Weight (Dharamkanta)</p><p className="font-bold">{e.finishedPiecesPayload.header.totalWeightKg ?? '—'} Kg ({e.finishedPiecesPayload.header.dharamkantaWeightKg ?? '—'} Kg)</p></div>
                        <div><p className="text-[9px] font-black text-slate-400 uppercase">Bill Value</p><p className="font-bold">₹{e.finishedPiecesPayload.header.totalBillValue ?? '—'}</p></div>
                      </div>
                      {e.finishedPiecesPayload.lines.map(l => (
                        <div key={l.key} className="flex items-center gap-3 border-2 border-slate-100 rounded-xl p-3">
                          {editable ? (
                            <>
                              <select value={l.partId} onChange={(ev) => patchFinishedLine(e, l.key, { partId: ev.target.value })} className="flex-1 border-2 border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold">
                                <option value="">Select item…</option>
                                {parts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sapCode})</option>)}
                              </select>
                              <input type="number" value={l.quantity} onChange={(ev) => patchFinishedLine(e, l.key, { quantity: parseFloat(ev.target.value) || 0 })} className="w-24 border-2 border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold" />
                              <span className="text-[10px] text-slate-400 font-bold">Pcs</span>
                            </>
                          ) : (
                            <p className="text-sm font-bold">{parts.find(p => p.id === l.partId)?.name || l.partId} — {l.quantity} Pcs</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {e.entryType === 'longer_pipe' && e.longerPipePayload && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase">Supplier</p>
                          {editable ? (
                            <input value={e.longerPipePayload.header.supplierName} onChange={(ev) => patchHeader(e, { supplierName: ev.target.value })} className="w-full border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
                          ) : (
                            <p className="font-bold">{e.longerPipePayload.header.supplierName}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase">Invoice No.</p>
                          {editable ? (
                            <input value={e.longerPipePayload.header.invoiceNo} onChange={(ev) => patchHeader(e, { invoiceNo: ev.target.value })} className="w-full border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
                          ) : (
                            <p className="font-bold">{e.longerPipePayload.header.invoiceNo}</p>
                          )}
                        </div>
                        <div><p className="text-[9px] font-black text-slate-400 uppercase">Weight (Dharamkanta)</p><p className="font-bold">{e.longerPipePayload.header.totalWeightKg ?? '—'} Kg ({e.longerPipePayload.header.dharamkantaWeightKg ?? '—'} Kg)</p></div>
                        <div><p className="text-[9px] font-black text-slate-400 uppercase">Bill Value</p><p className="font-bold">₹{e.longerPipePayload.header.totalBillValue ?? '—'}</p></div>
                      </div>
                      {e.longerPipePayload.lines.map((l, idx) => editable ? (
                        <div key={l.key}>
                          {renderLineEditor(
                            { rmId: l.rmId, barLengthMm: l.barLengthMm, barsReceived: l.barsReceived, subMode: l.subMode, allotments: l.allotments, autoAssign: l.autoAssign },
                            (patch) => onUpdate(e.id, ent => {
                              if (!ent.longerPipePayload) return ent;
                              const nextLines = ent.longerPipePayload.lines.map((ll, i) => i === idx ? { ...ll, ...(patch as Partial<PendingLongerPipeLine>) } : ll);
                              const stillUnresolved = nextLines.some(ll => !ll.rmId);
                              return {
                                ...ent,
                                longerPipePayload: { ...ent.longerPipePayload, lines: nextLines },
                                status: stillUnresolved ? 'not_matched' : 'pending',
                                notMatchedReason: stillUnresolved ? ent.notMatchedReason : undefined,
                              };
                            })
                          )}
                        </div>
                      ) : (
                        <p key={l.key} className="text-sm font-bold">{rawMaterials.find(r => r.id === l.rmId)?.size || 'RM'} — {l.barsReceived} bars</p>
                      ))}
                    </div>
                  )}

                  {e.entryType === 'manufacturer_invoice' && e.manufacturerInvoicePayload && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase">Manufacturer</p>
                          {editable ? (
                            <input value={e.manufacturerInvoicePayload.manufacturerName} onChange={(ev) => patchMfgHeader(e, { manufacturerName: ev.target.value })} className="w-full border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
                          ) : (
                            <p className="font-bold">{e.manufacturerInvoicePayload.manufacturerName}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase">Invoice No.</p>
                          {editable ? (
                            <input value={e.manufacturerInvoicePayload.invoiceNo} onChange={(ev) => patchMfgHeader(e, { invoiceNo: ev.target.value })} className="w-full border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
                          ) : (
                            <p className="font-bold">{e.manufacturerInvoicePayload.invoiceNo}</p>
                          )}
                        </div>
                        <div><p className="text-[9px] font-black text-slate-400 uppercase">Weight (Billed / Dharam Kanta)</p><p className="font-bold">{e.manufacturerInvoicePayload.totalWeightKg} / {e.manufacturerInvoicePayload.actualWeightKg} Kg{e.manufacturerInvoicePayload.weightFlagged ? ' ⚠' : ''}</p></div>
                        <div><p className="text-[9px] font-black text-slate-400 uppercase">Customer</p><p className="font-bold">{e.manufacturerInvoicePayload.customerName}</p></div>
                      </div>
                      {e.manufacturerInvoicePayload.lines.map((l, idx) => editable ? (
                        <div key={idx} className="space-y-2">
                          <p className="text-xs font-black text-slate-500">{l.materialName} ({l.materialCode}) — ₹{l.itemValue}</p>
                          {renderLineEditor(
                            { rmId: l.rmId, barLengthMm: l.barLengthMm, barsReceived: l.quantityPcs, subMode: l.subMode, allotments: l.allotments, autoAssign: l.autoAssign },
                            (patch) => onUpdate(e.id, ent => {
                              if (!ent.manufacturerInvoicePayload) return ent;
                              const nextLines = ent.manufacturerInvoicePayload.lines.map((ll, i) => {
                                if (i !== idx) return ll;
                                const { barsReceived, ...rest } = patch as any;
                                return { ...ll, ...rest, ...(barsReceived !== undefined ? { quantityPcs: barsReceived } : {}) };
                              });
                              const stillUnresolved = nextLines.some(ll => !ll.rmId);
                              return {
                                ...ent,
                                manufacturerInvoicePayload: { ...ent.manufacturerInvoicePayload, lines: nextLines },
                                status: stillUnresolved ? 'not_matched' : 'pending',
                                notMatchedReason: stillUnresolved ? ent.notMatchedReason : undefined,
                              };
                            })
                          )}
                        </div>
                      ) : (
                        <p key={idx} className="text-sm font-bold">{l.materialCode} — {rawMaterials.find(r => r.id === l.rmId)?.size || 'unmatched'} — {l.quantityPcs} bars</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="p-16 text-center text-slate-400 font-bold uppercase text-xs tracking-wide bg-white rounded-[2rem] border border-slate-100">
            Nothing here.
          </div>
        )}
      </div>
    </div>
  );
};

export default RMApprovalQueue;
