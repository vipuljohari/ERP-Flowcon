import React, { useState } from 'react';
import { GateDocumentForApproval, PendingRMEntryType, UnmatchedDharamkantaSlip, DharamkantaSlipExtractedFields } from '../types';
import { readAndCompressPhoto } from '../services/photo';
import { extractDharamkantaSlipPhoto } from '../services/gemini';
import PhotoViewerModal from './PhotoViewerModal';

// ============================================================
// Gate Documents for Approval
// ============================================================
// The WhatsApp gate-photo intake queue — every photo the gate guard posted
// to the "Unit 2 Inward" WhatsApp group that bot.js relayed and
// services/apiHandlers.ts's handleGateUpload resolved to an Admin-approved
// RM supplier (see Party Name Master) lands here as a GateDocumentForApproval
// doc, status 'pending'. Visible to Store AND Admin (see ROLE_PERMISSIONS)
// so Admin can process one directly whenever no Store person is around —
// see the isAdmin fast-path note below and App.tsx's finalizeGateDocument.
//
// Each entry now needs TWO photos before it can move forward — the
// supplier invoice (clicked as soon as the vehicle arrives) and a
// dharamkanta (weighbridge) slip, which can land minutes to several hours
// later. Per Vipul's explicit decision: the entry stays visibly "pending"
// to both Store and Admin until both photos are in. The slip usually
// arrives and auto-matches by vehicle number on its own (see
// services/apiHandlers.ts's handleDharamkantaSlipUpload /
// tryAttachWaitingSlipToNewGateDoc) — the "Attach Dharamkanta Slip" action
// here is the manual fallback for when that match doesn't happen: either
// upload the slip photo directly, or pick it from the list of
// WhatsApp-ingested slips that arrived but couldn't be auto-matched.
//
// Picking a mode doesn't create anything yet — it just opens the matching
// existing entry screen (Material Entry for Finished Parts/Longer Pipe,
// RM Cross-Bill Check's Manufacturer Invoice wizard for RM Cross-Bill)
// pre-seeded with what the photo already read, via App.tsx's gateSeed
// wiring. The card stays visible (now 'in_progress') the WHOLE time that
// screen is open — it's only removed, and both photos archived to
// Dropbox, once Post for Approval / Save is actually clicked there. Per
// Vipul's explicit 18-Sep confirmation, closing/cancelling that screen
// puts this card back to 'pending' rather than losing it.
// ============================================================

interface GateDocumentsQueueProps {
  gateDocuments: GateDocumentForApproval[];
  isAdmin: boolean;
  onProcess: (doc: GateDocumentForApproval, mode: PendingRMEntryType) => void;
  // Admin-only "unstick" action — puts an 'in_progress' card back to
  // 'pending' without touching anything else, for when whoever picked it
  // closed their browser/tab instead of Cancel/Post for Approval.
  onResetInProgress?: (doc: GateDocumentForApproval) => void;
  // Admin-only — permanently removes this card from the queue (e.g. a
  // duplicate resend of an invoice already sitting here). Both photos are
  // archived to Dropbox's "Unit 2/Rejected" folder first — see App.tsx's
  // handleRejectGateDocument.
  onReject?: (doc: GateDocumentForApproval, reason: string) => void | Promise<void>;
  // WhatsApp-ingested slip photos that arrived but couldn't be
  // auto-matched by vehicle number — the "pick from unmatched" fallback
  // reads this list.
  unmatchedSlips: UnmatchedDharamkantaSlip[];
  onAttachSlipUpload: (doc: GateDocumentForApproval, imageBase64: string, mimeType: string, extracted: DharamkantaSlipExtractedFields) => void;
  onAttachSlipFromUnmatched: (doc: GateDocumentForApproval, slip: UnmatchedDharamkantaSlip) => void;
}

const MODE_LABEL: Record<PendingRMEntryType, string> = {
  manufacturer_invoice: 'RM Cross-Bill',
  finished_pieces: 'Finished Parts',
  longer_pipe: 'Longer Pipes',
  // Not a real gate-photo processing mode — Inventory Correction has no
  // camera-upload intake — included only so this Record stays exhaustive
  // over PendingRMEntryType.
  inventory_correction: 'Inventory Correction',
};

const fmtWhen = (iso?: string | null) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

// Absent slipStatus (docs created before this feature shipped) is treated
// exactly like 'awaiting' everywhere — see types.ts's design-note comment
// on GateDocumentForApproval.
const isSlipAttached = (doc: GateDocumentForApproval) => (doc.slipStatus || 'awaiting') === 'attached';

// ------------------------------------------------------------
// Attach Dharamkanta Slip modal — upload-in-app or pick-from-unmatched.
// ------------------------------------------------------------
const AttachSlipModal: React.FC<{
  doc: GateDocumentForApproval;
  unmatchedSlips: UnmatchedDharamkantaSlip[];
  onAttachSlipUpload: (doc: GateDocumentForApproval, imageBase64: string, mimeType: string, extracted: DharamkantaSlipExtractedFields) => void;
  onAttachSlipFromUnmatched: (doc: GateDocumentForApproval, slip: UnmatchedDharamkantaSlip) => void;
  onClose: () => void;
}> = ({ doc, unmatchedSlips, onAttachSlipUpload, onAttachSlipFromUnmatched, onClose }) => {
  const [tab, setTab] = useState<'upload' | 'pick'>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = unmatchedSlips.filter(s => s.status === 'unmatched').sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''));

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { base64, mimeType } = await readAndCompressPhoto(file);
      const extracted = await extractDharamkantaSlipPhoto(base64, mimeType);
      onAttachSlipUpload(doc, base64, mimeType, extracted);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not read this photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center z-[120] p-4" onClick={onClose}>
      <div className="max-w-lg w-full bg-white rounded-2xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-black text-slate-900">Attach Dharamkanta Slip</h3>
        <p className="text-[11px] text-slate-500 mt-1">{doc.matchedSupplier} — Invoice {doc.extracted.invoiceNo || '—'}</p>

        <div className="flex gap-2 mt-4">
          <button onClick={() => setTab('upload')} className={`flex-1 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest ${tab === 'upload' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
            Upload Photo
          </button>
          <button onClick={() => setTab('pick')} className={`flex-1 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest ${tab === 'pick' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
            Pick From WhatsApp ({candidates.length})
          </button>
        </div>

        {tab === 'upload' ? (
          <div className="mt-4">
            <label className="block border-2 border-dashed border-slate-300 hover:border-indigo-400 rounded-xl p-6 text-center cursor-pointer">
              <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy}
                onChange={(e) => handleFile(e.target.files?.[0])} />
              <span className="text-sm font-bold text-slate-600">{busy ? 'Reading photo…' : 'Tap to take or choose a photo of the slip'}</span>
            </label>
            {error && <p className="text-[11px] text-rose-600 mt-2">{error}</p>}
          </div>
        ) : (
          <div className="mt-4 max-h-80 overflow-y-auto space-y-2">
            {candidates.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-6">No unmatched slip photos waiting right now.</p>
            ) : (
              candidates.map(slip => (
                <button key={slip.id} onClick={() => { onAttachSlipFromUnmatched(doc, slip); onClose(); }}
                  className="w-full flex gap-3 items-center border-2 border-slate-100 hover:border-indigo-400 rounded-xl p-2 text-left">
                  <div className="shrink-0 w-14 h-14 rounded-lg overflow-hidden border border-slate-200">
                    {slip.imageBase64 ? (
                      <img src={`data:${slip.mimeType};base64,${slip.imageBase64}`} alt="Slip" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xl bg-slate-100">⚖️</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12px] font-black text-slate-800 truncate">
                      {slip.extracted.vehicleNo || 'Vehicle no. not read'} {slip.extracted.netWeightKg ? `— ${slip.extracted.netWeightKg} Kg` : ''}
                    </p>
                    <p className="text-[10px] text-slate-400">Captured {fmtWhen(slip.capturedAt)}{slip.pushName ? ` by ${slip.pushName}` : ''}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        )}

        <button onClick={onClose} className="mt-4 w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-black uppercase text-[10px] tracking-widest">
          Cancel
        </button>
      </div>
    </div>
  );
};

// ------------------------------------------------------------
// Reject entry modal — Admin-only, 24-Sep-26. A short reason is optional
// but encouraged (shows up in the doc's own record and helps whoever
// reviews the Dropbox "Unit 2/Rejected" archive later understand why).
// ------------------------------------------------------------
const RejectModal: React.FC<{
  doc: GateDocumentForApproval;
  onReject: (doc: GateDocumentForApproval, reason: string) => void | Promise<void>;
  onClose: () => void;
}> = ({ doc, onReject, onClose }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onReject(doc, reason.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center z-[120] p-4" onClick={onClose}>
      <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-black text-slate-900">Reject This Entry</h3>
        <p className="text-[11px] text-slate-500 mt-1">{doc.matchedSupplier} — Invoice {doc.extracted.invoiceNo || '—'}</p>
        <p className="text-[11px] text-rose-600 font-bold mt-3">
          This removes it from the queue for good — it will never be posted to inventory. Both photos stay archived to
          Dropbox ("Unit 2/Rejected") for the record, they're just no longer editable here.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional) — e.g. duplicate of an already-posted invoice"
          rows={2}
          className="mt-3 w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm"
        />
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} disabled={busy} className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-black uppercase text-[10px] tracking-widest disabled:opacity-50">
            Cancel
          </button>
          <button onClick={confirm} disabled={busy} className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
            {busy ? 'Rejecting…' : 'Reject Entry'}
          </button>
        </div>
      </div>
    </div>
  );
};

const GateDocumentCard: React.FC<{
  doc: GateDocumentForApproval;
  isAdmin: boolean;
  onProcess: (mode: PendingRMEntryType) => void;
  onResetInProgress?: () => void;
  onReject?: () => void;
  onViewPhoto: (which: 'invoice' | 'slip') => void;
  onAttachSlip: () => void;
}> = ({ doc, isAdmin, onProcess, onResetInProgress, onReject, onViewPhoto, onAttachSlip }) => {
  const ex = doc.extracted;
  const slipAttached = isSlipAttached(doc);
  return (
    <div className={`border-2 rounded-2xl p-4 ${doc.status === 'in_progress' ? 'border-amber-300 bg-amber-50/40' : 'border-slate-100 bg-white'}`}>
      <div className="flex gap-4">
        <button onClick={() => onViewPhoto('invoice')} className="shrink-0 w-20 h-20 rounded-xl overflow-hidden border-2 border-slate-200 hover:border-indigo-400" title="View invoice photo">
          {doc.imageBase64 ? (
            <img src={`data:${doc.mimeType};base64,${doc.imageBase64}`} alt="Gate photo" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-2xl bg-slate-100">📷</div>
          )}
        </button>
        <button onClick={() => slipAttached && onViewPhoto('slip')} className="shrink-0 w-20 h-20 rounded-xl overflow-hidden border-2 relative" title={slipAttached ? 'View dharamkanta slip' : 'Awaiting dharamkanta slip'}
          style={{ cursor: slipAttached ? 'pointer' : 'default' }}>
          {slipAttached && doc.slipImageBase64 ? (
            <img src={`data:${doc.slipMimeType};base64,${doc.slipImageBase64}`} alt="Dharamkanta slip" className="w-full h-full object-cover border-2 border-emerald-300 rounded-xl" />
          ) : (
            <div className={`w-full h-full flex flex-col items-center justify-center text-[9px] font-black uppercase tracking-tight rounded-xl border-2 ${slipAttached ? 'border-emerald-300 bg-emerald-50 text-emerald-600' : 'border-amber-300 bg-amber-50 text-amber-600'}`}>
              <span className="text-xl">⚖️</span>
              {slipAttached ? 'Attached' : 'Awaiting Slip'}
            </div>
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-black text-slate-900 truncate">{doc.matchedSupplier}</p>
            {doc.status === 'in_progress' && (
              <span className="text-[9px] font-black uppercase tracking-widest text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full whitespace-nowrap">
                In Progress{doc.pickedEntryType ? ` — ${MODE_LABEL[doc.pickedEntryType]}` : ''}
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Invoice {ex.invoiceNo || '—'} · {ex.date || '—'} · {ex.totalWeightKg ? `${ex.totalWeightKg} Kg` : '—'} · {ex.totalBillValue ? `₹${ex.totalBillValue.toLocaleString('en-IN')}` : '—'}
          </p>
          {ex.materialDescription && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{ex.materialDescription} — OD {ex.odMm || '?'}mm × Th {ex.thicknessMm || '?'}mm × L {ex.lengthMm || '?'}mm, Qty {ex.quantityPcs || '?'}</p>}
          {slipAttached && doc.slipExtracted && (
            <p className="text-[11px] text-emerald-600 font-bold mt-0.5">
              Dharam Kanta {doc.slipExtracted.netWeightKg ? `${doc.slipExtracted.netWeightKg} Kg` : '—'} · {doc.slipExtracted.slipDate || '—'}
              {doc.slipAttachedVia === 'auto_whatsapp' ? '' : ` · attached ${doc.slipAttachedVia === 'manual_upload' ? 'manually' : 'from WhatsApp'} by ${doc.slipAttachedBy || '—'}`}
            </p>
          )}
          <p className="text-[10px] text-slate-400 mt-1">
            Captured {fmtWhen(doc.capturedAt)}{doc.pushName ? ` by ${doc.pushName}` : ''}
            {doc.pickedBy ? ` · picked by ${doc.pickedBy} at ${fmtWhen(doc.pickedAt)}` : ''}
          </p>
        </div>
      </div>

      {!slipAttached && (
        <div className="mt-3 border-2 border-dashed border-amber-200 bg-amber-50/60 rounded-xl px-3 py-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-amber-700 font-bold">Waiting on the dharamkanta (weighbridge) slip photo before this entry can be posted.</p>
          <button onClick={onAttachSlip} className="shrink-0 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-[10px] font-black uppercase tracking-widest whitespace-nowrap">
            Attach Slip
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-3">
        <button onClick={() => onProcess('manufacturer_invoice')} disabled={!slipAttached} title={!slipAttached ? 'Attach the dharamkanta slip first' : undefined}
          className="px-3 py-1.5 border-2 border-indigo-200 hover:border-indigo-500 text-indigo-700 rounded-lg text-[11px] font-black uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-indigo-200">
          RM Cross-Bill
        </button>
        <button onClick={() => onProcess('finished_pieces')} disabled={!slipAttached} title={!slipAttached ? 'Attach the dharamkanta slip first' : undefined}
          className="px-3 py-1.5 border-2 border-emerald-200 hover:border-emerald-500 text-emerald-700 rounded-lg text-[11px] font-black uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-emerald-200">
          Finished Parts
        </button>
        <button onClick={() => onProcess('longer_pipe')} disabled={!slipAttached} title={!slipAttached ? 'Attach the dharamkanta slip first' : undefined}
          className="px-3 py-1.5 border-2 border-slate-200 hover:border-slate-500 text-slate-700 rounded-lg text-[11px] font-black uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-200">
          Longer Pipes
        </button>
        {isAdmin && (
          <div className="ml-auto flex gap-2">
            {doc.status === 'in_progress' && onResetInProgress && (
              <button onClick={onResetInProgress} className="px-3 py-1.5 text-amber-600 hover:text-amber-800 rounded-lg text-[11px] font-black uppercase tracking-widest">
                Reset to Pending
              </button>
            )}
            {onReject && (
              <button onClick={onReject} className="px-3 py-1.5 text-rose-600 hover:text-rose-800 border-2 border-rose-200 hover:border-rose-400 rounded-lg text-[11px] font-black uppercase tracking-widest">
                Reject
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const GateDocumentsQueue: React.FC<GateDocumentsQueueProps> = ({ gateDocuments, isAdmin, onProcess, onResetInProgress, onReject, unmatchedSlips, onAttachSlipUpload, onAttachSlipFromUnmatched }) => {
  const [viewingPhoto, setViewingPhoto] = useState<{ doc: GateDocumentForApproval; which: 'invoice' | 'slip' } | null>(null);
  const [attachingSlipFor, setAttachingSlipFor] = useState<GateDocumentForApproval | null>(null);
  const [rejectingDoc, setRejectingDoc] = useState<GateDocumentForApproval | null>(null);

  const active = gateDocuments
    .filter(d => d.status === 'pending' || d.status === 'in_progress')
    .sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));

  const awaitingSlipCount = active.filter(d => !isSlipAttached(d)).length;

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-slate-900">Gate Documents for Approval</h2>
        <p className="text-sm text-slate-500 mt-1">
          Photos the gate guard posted on WhatsApp that matched an approved RM supplier. Each entry needs both the invoice
          photo AND the dharamkanta (weighbridge) slip photo before it can be posted — the slip usually arrives later and
          matches automatically by vehicle number; use "Attach Slip" if it doesn't. Pick how each one arrived, complete the
          entry as usual, then Post for Approval / Save — both photos are archived to Dropbox automatically once you do, and
          this card disappears.
        </p>
        {isAdmin && (
          <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-3">
            You're signed in as Admin — completing an entry from here also approves and posts it to inventory immediately
            (no separate RM Approvals step), for when no Store person is available.
          </p>
        )}
        {awaitingSlipCount > 0 && (
          <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-2">
            {awaitingSlipCount} {awaitingSlipCount === 1 ? 'entry is' : 'entries are'} waiting on a dharamkanta slip photo.
          </p>
        )}
      </div>

      {active.length === 0 ? (
        <div className="border-2 border-dashed border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-400">
          No gate photos waiting right now.
        </div>
      ) : (
        <div className="space-y-3">
          {active.map(doc => (
            <GateDocumentCard
              key={doc.id}
              doc={doc}
              isAdmin={isAdmin}
              onProcess={(mode) => onProcess(doc, mode)}
              onResetInProgress={onResetInProgress ? () => onResetInProgress(doc) : undefined}
              onReject={onReject ? () => setRejectingDoc(doc) : undefined}
              onViewPhoto={(which) => setViewingPhoto({ doc, which })}
              onAttachSlip={() => setAttachingSlipFor(doc)}
            />
          ))}
        </div>
      )}

      {viewingPhoto && (() => {
        const base64 = viewingPhoto.which === 'invoice' ? viewingPhoto.doc.imageBase64 : viewingPhoto.doc.slipImageBase64;
        const mimeType = viewingPhoto.which === 'invoice' ? viewingPhoto.doc.mimeType : (viewingPhoto.doc.slipMimeType || 'image/jpeg');
        if (!base64) {
          return (
            <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-md flex items-center justify-center z-[110] p-4" onClick={() => setViewingPhoto(null)}>
              <div className="max-w-md w-full text-center" onClick={(e) => e.stopPropagation()}>
                <p className="text-white mb-3">Photo no longer available — it may already be archived.</p>
                <button onClick={() => setViewingPhoto(null)} className="px-6 py-2.5 bg-white/10 hover:bg-white/20 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
                  Close
                </button>
              </div>
            </div>
          );
        }
        return (
          <PhotoViewerModal
            base64={base64}
            mimeType={mimeType}
            label={viewingPhoto.which === 'invoice' ? 'Invoice Photo' : 'Dharamkanta Slip'}
            onClose={() => setViewingPhoto(null)}
          />
        );
      })()}

      {attachingSlipFor && (
        <AttachSlipModal
          doc={attachingSlipFor}
          unmatchedSlips={unmatchedSlips}
          onAttachSlipUpload={onAttachSlipUpload}
          onAttachSlipFromUnmatched={onAttachSlipFromUnmatched}
          onClose={() => setAttachingSlipFor(null)}
        />
      )}

      {rejectingDoc && onReject && (
        <RejectModal
          doc={rejectingDoc}
          onReject={onReject}
          onClose={() => setRejectingDoc(null)}
        />
      )}
    </div>
  );
};

export default GateDocumentsQueue;
