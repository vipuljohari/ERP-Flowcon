import React, { useState } from 'react';
import { GateDocumentForApproval, PendingRMEntryType } from '../types';

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
// Picking a mode here doesn't create anything yet — it just opens the
// matching existing entry screen (Material Entry for Finished Parts/Longer
// Pipe, RM Cross-Bill Check's Manufacturer Invoice wizard for RM Cross-Bill)
// pre-seeded with what the photo already read, via App.tsx's gateSeed
// wiring. The card stays visible (now 'in_progress') the WHOLE time that
// screen is open — it's only removed, and the photo archived to Dropbox,
// once Post for Approval / Save is actually clicked there. Per Vipul's
// explicit 18-Sep confirmation, closing/cancelling that screen puts this
// card back to 'pending' rather than losing it.
// ============================================================

interface GateDocumentsQueueProps {
  gateDocuments: GateDocumentForApproval[];
  isAdmin: boolean;
  onProcess: (doc: GateDocumentForApproval, mode: PendingRMEntryType) => void;
  // Admin-only "unstick" action — puts an 'in_progress' card back to
  // 'pending' without touching anything else, for when whoever picked it
  // closed their browser/tab instead of Cancel/Post for Approval.
  onResetInProgress?: (doc: GateDocumentForApproval) => void;
}

const MODE_LABEL: Record<PendingRMEntryType, string> = {
  manufacturer_invoice: 'RM Cross-Bill',
  finished_pieces: 'Finished Parts',
  longer_pipe: 'Longer Pipes',
};

const fmtWhen = (iso?: string | null) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

const GateDocumentCard: React.FC<{
  doc: GateDocumentForApproval;
  isAdmin: boolean;
  onProcess: (mode: PendingRMEntryType) => void;
  onResetInProgress?: () => void;
  onViewPhoto: () => void;
}> = ({ doc, isAdmin, onProcess, onResetInProgress, onViewPhoto }) => {
  const ex = doc.extracted;
  return (
    <div className={`border-2 rounded-2xl p-4 ${doc.status === 'in_progress' ? 'border-amber-300 bg-amber-50/40' : 'border-slate-100 bg-white'}`}>
      <div className="flex gap-4">
        <button onClick={onViewPhoto} className="shrink-0 w-20 h-20 rounded-xl overflow-hidden border-2 border-slate-200 hover:border-indigo-400" title="View full photo">
          {doc.imageBase64 ? (
            <img src={`data:${doc.mimeType};base64,${doc.imageBase64}`} alt="Gate photo" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-2xl bg-slate-100">📷</div>
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
          <p className="text-[10px] text-slate-400 mt-1">
            Captured {fmtWhen(doc.capturedAt)}{doc.pushName ? ` by ${doc.pushName}` : ''}
            {doc.pickedBy ? ` · picked by ${doc.pickedBy} at ${fmtWhen(doc.pickedAt)}` : ''}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        <button onClick={() => onProcess('manufacturer_invoice')} className="px-3 py-1.5 border-2 border-indigo-200 hover:border-indigo-500 text-indigo-700 rounded-lg text-[11px] font-black uppercase tracking-widest">
          RM Cross-Bill
        </button>
        <button onClick={() => onProcess('finished_pieces')} className="px-3 py-1.5 border-2 border-emerald-200 hover:border-emerald-500 text-emerald-700 rounded-lg text-[11px] font-black uppercase tracking-widest">
          Finished Parts
        </button>
        <button onClick={() => onProcess('longer_pipe')} className="px-3 py-1.5 border-2 border-slate-200 hover:border-slate-500 text-slate-700 rounded-lg text-[11px] font-black uppercase tracking-widest">
          Longer Pipes
        </button>
        {isAdmin && doc.status === 'in_progress' && onResetInProgress && (
          <button onClick={onResetInProgress} className="ml-auto px-3 py-1.5 text-rose-500 hover:text-rose-700 rounded-lg text-[11px] font-black uppercase tracking-widest">
            Reset to Pending
          </button>
        )}
      </div>
    </div>
  );
};

const GateDocumentsQueue: React.FC<GateDocumentsQueueProps> = ({ gateDocuments, isAdmin, onProcess, onResetInProgress }) => {
  const [viewingPhoto, setViewingPhoto] = useState<GateDocumentForApproval | null>(null);

  const active = gateDocuments
    .filter(d => d.status === 'pending' || d.status === 'in_progress')
    .sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-slate-900">Gate Documents for Approval</h2>
        <p className="text-sm text-slate-500 mt-1">
          Photos the gate guard posted on WhatsApp that matched an approved RM supplier. Pick how each one arrived, complete
          the entry as usual, then Post for Approval / Save — the photo is archived to Dropbox automatically once you do, and
          this card disappears.
        </p>
        {isAdmin && (
          <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-3">
            You're signed in as Admin — completing an entry from here also approves and posts it to inventory immediately
            (no separate RM Approvals step), for when no Store person is available.
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
              onViewPhoto={() => setViewingPhoto(doc)}
            />
          ))}
        </div>
      )}

      {viewingPhoto && (
        <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-md flex items-center justify-center z-[110] p-4" onClick={() => setViewingPhoto(null)}>
          <div className="max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
            {viewingPhoto.imageBase64 ? (
              <img src={`data:${viewingPhoto.mimeType};base64,${viewingPhoto.imageBase64}`} alt="Gate photo" className="w-full h-auto rounded-2xl shadow-2xl" />
            ) : (
              <p className="text-white text-center">Photo no longer available — it may already be archived.</p>
            )}
            <button onClick={() => setViewingPhoto(null)} className="mt-3 w-full py-2.5 bg-white/10 hover:bg-white/20 text-white rounded-xl font-black uppercase text-[10px] tracking-widest">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GateDocumentsQueue;
