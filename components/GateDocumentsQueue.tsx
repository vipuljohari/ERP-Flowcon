import React, { useState, useMemo } from 'react';
import { GateDocumentForApproval, PendingRMEntryType, PendingRMEntry, UnmatchedDharamkantaSlip, DharamkantaSlipExtractedFields } from '../types';
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
  // 30-Sep-26 — read-only, for the Admin-only History tab below: once a
  // gate document is 'consumed' its own imageBase64/slipImageBase64 are
  // cleared and the final approve/reject decision happens on the
  // PendingRMEntry it was turned into (linkedPendingRMEntryId), not on the
  // gate document itself — so History needs both collections to render the
  // full received → picked → approved/rejected timeline for a 'consumed'
  // entry. Not needed by the existing Active queue below.
  pendingRMEntries: PendingRMEntry[];
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
  // Admin-only, 25-Sep-26 — permanently removes an unmatched slip's
  // Firestore doc (see UnmatchedSlipsModal below). Undefined for a
  // non-Admin, same convention as onReject/onResetInProgress above.
  onDeleteUnmatchedSlip?: (slip: UnmatchedDharamkantaSlip) => void;
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

// Same as fmtWhen above but with the year included — the Active queue only
// ever shows entries from the last few hours/days so the year is obvious,
// but History can span back months or into a prior year, so leaving it out
// there would be ambiguous.
const fmtWhenFull = (iso?: string | null) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

// ============================================================
// Gate Documents — History (Admin-only, 30-Sep-26)
// ============================================================
// The Active queue above only ever shows 'pending'/'in_progress' cards —
// the instant an entry is completed ('consumed') or rejected, it vanishes
// from there with no record left in this screen. This is the read-only
// audit trail Vipul asked for: every 'consumed'/'rejected' gate document,
// filterable by month and by manufacturer, each showing the full
// received → slip attached → picked up → approved/rejected workflow with
// who did each step and when. Nothing here is editable — it's reporting.
// ============================================================

type HistoryStep = {
  icon: string;
  label: string;
  when?: string | null;
  by?: string | null;
  extra?: string | null;
  tone: 'default' | 'emerald' | 'rose' | 'amber';
};

type HistoryOutcome = {
  badgeLabel: string;
  badgeTone: 'emerald' | 'rose' | 'amber' | 'slate';
};

const SLIP_VIA_LABEL: Record<NonNullable<GateDocumentForApproval['slipAttachedVia']>, string> = {
  auto_whatsapp: 'auto-matched by vehicle number',
  manual_pick: 'picked from WhatsApp unmatched photos',
  manual_upload: 'uploaded directly',
};

// Builds the 4-step workflow timeline for one History card, and the
// overall outcome badge shown on the collapsed header. `entry` is the
// linked PendingRMEntry (via linkedPendingRMEntryId) when doc.status is
// 'consumed' — undefined for a doc rejected before ever becoming one.
function buildHistorySteps(doc: GateDocumentForApproval, entry: PendingRMEntry | undefined): { steps: HistoryStep[]; outcome: HistoryOutcome } {
  const steps: HistoryStep[] = [
    {
      icon: '📱',
      label: 'Sent on WhatsApp',
      when: doc.capturedAt,
      by: doc.pushName || 'Gate guard',
      extra: doc.caption ? `"${doc.caption}"` : undefined,
      tone: 'default',
    },
  ];

  if (doc.slipAttachedAt) {
    steps.push({
      icon: '⚖️',
      label: 'Dharamkanta slip attached',
      when: doc.slipAttachedAt,
      by: doc.slipAttachedBy || '—',
      extra: doc.slipAttachedVia ? SLIP_VIA_LABEL[doc.slipAttachedVia] : undefined,
      tone: 'default',
    });
  }

  if (doc.pickedAt) {
    steps.push({
      icon: '🧾',
      label: 'Picked up & processed',
      when: doc.pickedAt,
      by: doc.pickedBy,
      extra: doc.pickedEntryType ? MODE_LABEL[doc.pickedEntryType] : undefined,
      tone: 'default',
    });
  }

  let outcome: HistoryOutcome;

  if (doc.status === 'rejected') {
    steps.push({
      icon: '❌',
      label: 'Rejected (before posting)',
      when: doc.rejectedAt,
      by: doc.rejectedBy,
      extra: doc.rejectReason || 'No reason given',
      tone: 'rose',
    });
    outcome = { badgeLabel: 'Rejected', badgeTone: 'rose' };
  } else if (entry) {
    if (entry.status === 'approved') {
      steps.push({ icon: '✅', label: 'Approved & posted to inventory', when: entry.reviewedAt, by: entry.reviewedBy, tone: 'emerald' });
      outcome = { badgeLabel: 'Approved & Posted', badgeTone: 'emerald' };
    } else if (entry.status === 'rejected') {
      steps.push({ icon: '❌', label: 'Rejected by Admin (after review)', when: entry.reviewedAt, by: entry.reviewedBy, extra: entry.rejectionReason || 'No reason given', tone: 'rose' });
      outcome = { badgeLabel: 'Rejected by Admin', badgeTone: 'rose' };
    } else {
      steps.push({
        icon: '⏳',
        label: entry.status === 'not_matched' ? 'Submitted — Raw Material not matched yet' : 'Submitted — awaiting Admin approval',
        when: entry.submittedAt,
        by: entry.submittedBy,
        tone: 'amber',
      });
      outcome = { badgeLabel: 'Awaiting Approval', badgeTone: 'amber' };
    }
  } else {
    // Defensive fallback — consumed with no findable PendingRMEntry (e.g.
    // very old data). Shouldn't happen in normal operation.
    outcome = { badgeLabel: 'Posted', badgeTone: 'slate' };
  }

  return { steps, outcome };
}

const OUTCOME_BADGE_CLASSES: Record<HistoryOutcome['badgeTone'], string> = {
  emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  rose: 'bg-rose-100 text-rose-700 border-rose-200',
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
};

const STEP_TONE_CLASSES: Record<HistoryStep['tone'], string> = {
  default: 'bg-slate-100 text-slate-600',
  emerald: 'bg-emerald-100 text-emerald-700',
  rose: 'bg-rose-100 text-rose-700',
  amber: 'bg-amber-100 text-amber-700',
};

const HistoryCard: React.FC<{ doc: GateDocumentForApproval; entry: PendingRMEntry | undefined; onViewPhoto: (base64: string, mimeType: string, label: string) => void }> = ({ doc, entry, onViewPhoto }) => {
  const [isOpen, setIsOpen] = useState(false);
  const { steps, outcome } = buildHistorySteps(doc, entry);
  const ex = doc.extracted;

  // Photos: the gate document's own copies are cleared the instant it's
  // consumed/rejected (see types.ts). An approved entry's copies are also
  // cleared (archived to Dropbox instead — photoDropboxPath/
  // slipPhotoDropboxPath). A REJECTED entry's copies are never archived or
  // cleared (rejectPendingRMEntry only touches status/reviewedAt/
  // reviewedBy/rejectionReason), so those are still viewable here.
  const invoicePhoto = entry?.photoImageBase64 && entry.photoMimeType ? { base64: entry.photoImageBase64, mimeType: entry.photoMimeType } : null;
  const slipPhoto = entry?.slipPhotoImageBase64 && entry.slipPhotoMimeType ? { base64: entry.slipPhotoImageBase64, mimeType: entry.slipPhotoMimeType } : null;

  return (
    <div className="border-2 border-slate-100 rounded-2xl p-4 bg-white">
      <button onClick={() => setIsOpen(v => !v)} className="w-full flex items-start justify-between gap-3 text-left">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-black text-slate-900 truncate">{doc.matchedSupplier}</p>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border whitespace-nowrap ${OUTCOME_BADGE_CLASSES[outcome.badgeTone]}`}>
              {outcome.badgeLabel}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Invoice {ex.invoiceNo || '—'} · {ex.date || '—'} · {ex.totalWeightKg ? `${ex.totalWeightKg} Kg` : '—'} · {ex.totalBillValue ? `₹${ex.totalBillValue.toLocaleString('en-IN')}` : '—'}
          </p>
          {entry?.summary && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{entry.summary}</p>}
        </div>
        <span className="shrink-0 text-slate-400 text-xs font-black">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
          {(invoicePhoto || slipPhoto || entry?.photoDropboxPath || entry?.slipPhotoDropboxPath) && (
            <div className="flex flex-wrap gap-2 mb-1">
              {invoicePhoto ? (
                <button onClick={() => onViewPhoto(invoicePhoto.base64, invoicePhoto.mimeType, 'Invoice Photo')} className="shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 border-slate-200 hover:border-indigo-400" title="View invoice photo">
                  <img src={`data:${invoicePhoto.mimeType};base64,${invoicePhoto.base64}`} alt="Invoice" className="w-full h-full object-cover" />
                </button>
              ) : entry?.photoDropboxPath ? (
                <div className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5 max-w-[14rem] truncate" title={entry.photoDropboxPath}>
                  📷 Archived — {entry.photoDropboxPath}
                </div>
              ) : null}
              {slipPhoto ? (
                <button onClick={() => onViewPhoto(slipPhoto.base64, slipPhoto.mimeType, 'Dharamkanta Slip')} className="shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 border-slate-200 hover:border-indigo-400" title="View dharamkanta slip">
                  <img src={`data:${slipPhoto.mimeType};base64,${slipPhoto.base64}`} alt="Dharamkanta slip" className="w-full h-full object-cover" />
                </button>
              ) : entry?.slipPhotoDropboxPath ? (
                <div className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5 max-w-[14rem] truncate" title={entry.slipPhotoDropboxPath}>
                  ⚖️ Archived — {entry.slipPhotoDropboxPath}
                </div>
              ) : null}
            </div>
          )}

          {steps.map((step, idx) => (
            <div key={idx} className="flex gap-3">
              <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs ${STEP_TONE_CLASSES[step.tone]}`}>{step.icon}</div>
              <div className="min-w-0 pb-1">
                <p className="text-[12px] font-black text-slate-800">{step.label}</p>
                <p className="text-[11px] text-slate-500">{fmtWhenFull(step.when)}{step.by ? ` — ${step.by}` : ''}</p>
                {step.extra && <p className="text-[11px] text-slate-400 mt-0.5">{step.extra}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const GateDocumentHistoryPanel: React.FC<{ gateDocuments: GateDocumentForApproval[]; pendingRMEntries: PendingRMEntry[] }> = ({ gateDocuments, pendingRMEntries }) => {
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [viewingPhoto, setViewingPhoto] = useState<{ base64: string; mimeType: string; label: string } | null>(null);

  const closed = useMemo(
    () => gateDocuments.filter(d => d.status === 'consumed' || d.status === 'rejected'),
    [gateDocuments]
  );

  const entryById = useMemo(() => {
    const map = new Map<string, PendingRMEntry>();
    for (const e of pendingRMEntries) map.set(e.id, e);
    return map;
  }, [pendingRMEntries]);

  const monthOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const d of closed) {
      if (!d.capturedAt) continue;
      const dt = new Date(d.capturedAt);
      if (isNaN(dt.getTime())) continue;
      keys.add(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
    }
    return Array.from(keys).sort((a, b) => b.localeCompare(a)).map(key => {
      const [y, m] = key.split('-').map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      return { key, label };
    });
  }, [closed]);

  const supplierOptions = useMemo(() => {
    const names = new Set<string>();
    for (const d of closed) if (d.matchedSupplier) names.add(d.matchedSupplier);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [closed]);

  const filtered = useMemo(() => {
    return closed
      .filter(d => {
        if (monthFilter !== 'all') {
          if (!d.capturedAt) return false;
          const dt = new Date(d.capturedAt);
          if (isNaN(dt.getTime())) return false;
          const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
          if (key !== monthFilter) return false;
        }
        if (supplierFilter !== 'all' && d.matchedSupplier !== supplierFilter) return false;
        return true;
      })
      .sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''));
  }, [closed, monthFilter, supplierFilter]);

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="px-3 py-2 border-2 border-slate-200 rounded-xl text-[12px] font-bold text-slate-700 bg-white">
          <option value="all">All Months</option>
          {monthOptions.map(opt => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
        </select>
        <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} className="px-3 py-2 border-2 border-slate-200 rounded-xl text-[12px] font-bold text-slate-700 bg-white">
          <option value="all">All Manufacturers</option>
          {supplierOptions.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <span className="self-center text-[11px] text-slate-400 font-bold">{filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="border-2 border-dashed border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-400">
          {closed.length === 0 ? 'No completed or rejected gate documents yet.' : 'Nothing matches these filters.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(doc => (
            <HistoryCard
              key={doc.id}
              doc={doc}
              entry={doc.linkedPendingRMEntryId ? entryById.get(doc.linkedPendingRMEntryId) : undefined}
              onViewPhoto={(base64, mimeType, label) => setViewingPhoto({ base64, mimeType, label })}
            />
          ))}
        </div>
      )}

      {viewingPhoto && (
        <PhotoViewerModal
          base64={viewingPhoto.base64}
          mimeType={viewingPhoto.mimeType}
          label={viewingPhoto.label}
          onClose={() => setViewingPhoto(null)}
        />
      )}
    </div>
  );
};

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
// Unmatched slip photos — Admin-only, 25-Sep-26. Every dharamkanta slip
// bot.js relayed that couldn't be auto-matched (or hasn't been manually
// picked yet — see AttachSlipModal above) lands in unmatchedDharamkantaSlips
// and just sits there: there's no expiry, no cleanup job, nothing. This is
// the manual prune Vipul asked for — a plain list of every 'unmatched' slip
// still holding its image, with its own preview (reuses PhotoViewerModal,
// same zoom/rotate/close as everywhere else photos are viewed in this app)
// and a Delete. Deliberately excludes 'attached' slips — those have already
// had imageBase64 cleared (see handleAttachSlipFromUnmatched in App.tsx) so
// there's no photo left to preview or reclaim space by deleting anyway;
// this list is specifically about photos still taking up room.
// ------------------------------------------------------------
const UnmatchedSlipsModal: React.FC<{
  slips: UnmatchedDharamkantaSlip[];
  onDelete: (slip: UnmatchedDharamkantaSlip) => void;
  onClose: () => void;
}> = ({ slips, onDelete, onClose }) => {
  const [previewing, setPreviewing] = useState<UnmatchedDharamkantaSlip | null>(null);

  const pending = slips.filter(s => s.status === 'unmatched').sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''));

  const handleDelete = (slip: UnmatchedDharamkantaSlip) => {
    const label = slip.extracted.vehicleNo || 'this photo';
    if (!window.confirm(`Delete this unmatched dharamkanta slip (${label}, captured ${fmtWhen(slip.capturedAt)})?\n\nThis can't be undone — it isn't archived anywhere else.`)) return;
    onDelete(slip);
  };

  return (
    <>
      {/* z-[105]: below PhotoViewerModal's z-[110]/[111] so the preview
          opens on top of this list, but still above the page itself. */}
      <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center z-[105] p-4" onClick={onClose}>
        <div className="max-w-lg w-full bg-white rounded-2xl shadow-2xl p-6 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-black text-slate-900">Unmatched Dharamkanta Slip Photos</h3>
          <p className="text-[11px] text-slate-500 mt-1">
            Slip photos from WhatsApp that never got picked up or attached to a gate entry — nothing deletes these
            automatically, so they sit here indefinitely otherwise. Tap a thumbnail to preview full-screen; delete
            whichever you don't need.
          </p>

          <div className="mt-4 space-y-2 overflow-y-auto">
            {pending.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-6">No unmatched slip photos right now.</p>
            ) : (
              pending.map(slip => (
                <div key={slip.id} className="flex gap-3 items-center border-2 border-slate-100 rounded-xl p-2">
                  <button onClick={() => setPreviewing(slip)} className="shrink-0 w-14 h-14 rounded-lg overflow-hidden border border-slate-200 hover:border-indigo-400" title="Preview photo">
                    {slip.imageBase64 ? (
                      <img src={`data:${slip.mimeType};base64,${slip.imageBase64}`} alt="Slip" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xl bg-slate-100">⚖️</div>
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-black text-slate-800 truncate">
                      {slip.extracted.vehicleNo || 'Vehicle no. not read'} {slip.extracted.netWeightKg ? `— ${slip.extracted.netWeightKg} Kg` : ''}
                    </p>
                    <p className="text-[10px] text-slate-400">Captured {fmtWhen(slip.capturedAt)}{slip.pushName ? ` by ${slip.pushName}` : ''}</p>
                  </div>
                  <button onClick={() => handleDelete(slip)} className="shrink-0 px-3 py-1.5 text-rose-600 hover:text-white hover:bg-rose-600 border-2 border-rose-200 hover:border-rose-600 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all">
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>

          <button onClick={onClose} className="mt-4 w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-black uppercase text-[10px] tracking-widest">
            Close
          </button>
        </div>
      </div>

      {previewing && previewing.imageBase64 && (
        <PhotoViewerModal
          base64={previewing.imageBase64}
          mimeType={previewing.mimeType}
          label={previewing.extracted.vehicleNo ? `Dharamkanta Slip — ${previewing.extracted.vehicleNo}` : 'Dharamkanta Slip'}
          onClose={() => setPreviewing(null)}
        />
      )}
    </>
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

const GateDocumentsQueue: React.FC<GateDocumentsQueueProps> = ({ gateDocuments, isAdmin, pendingRMEntries, onProcess, onResetInProgress, onReject, unmatchedSlips, onAttachSlipUpload, onAttachSlipFromUnmatched, onDeleteUnmatchedSlip }) => {
  const [viewingPhoto, setViewingPhoto] = useState<{ doc: GateDocumentForApproval; which: 'invoice' | 'slip' } | null>(null);
  const [attachingSlipFor, setAttachingSlipFor] = useState<GateDocumentForApproval | null>(null);
  const [rejectingDoc, setRejectingDoc] = useState<GateDocumentForApproval | null>(null);
  const [showUnmatchedSlips, setShowUnmatchedSlips] = useState(false);
  // Admin-only tab — see GateDocumentHistoryPanel's own comment above for
  // why this needs pendingRMEntries as well as gateDocuments.
  const [tab, setTab] = useState<'active' | 'history'>('active');

  const active = gateDocuments
    .filter(d => d.status === 'pending' || d.status === 'in_progress')
    .sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));

  const awaitingSlipCount = active.filter(d => !isSlipAttached(d)).length;
  const unmatchedSlipCount = unmatchedSlips.filter(s => s.status === 'unmatched').length;

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
        {isAdmin && onDeleteUnmatchedSlip && (
          <button
            onClick={() => setShowUnmatchedSlips(true)}
            className="mt-2 px-3 py-1.5 border-2 border-slate-200 hover:border-indigo-400 text-slate-600 hover:text-indigo-700 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all"
          >
            View Unmatched Photos {unmatchedSlipCount > 0 ? `(${unmatchedSlipCount})` : ''}
          </button>
        )}
        {awaitingSlipCount > 0 && (
          <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-2">
            {awaitingSlipCount} {awaitingSlipCount === 1 ? 'entry is' : 'entries are'} waiting on a dharamkanta slip photo.
          </p>
        )}

        {isAdmin && (
          <div className="flex gap-2 mt-4 border-b-2 border-slate-100">
            <button
              onClick={() => setTab('active')}
              className={`px-4 py-2 text-[11px] font-black uppercase tracking-widest border-b-2 -mb-0.5 transition-colors ${tab === 'active' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              Active{active.length > 0 ? ` (${active.length})` : ''}
            </button>
            <button
              onClick={() => setTab('history')}
              className={`px-4 py-2 text-[11px] font-black uppercase tracking-widest border-b-2 -mb-0.5 transition-colors ${tab === 'history' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              History
            </button>
          </div>
        )}
      </div>

      {tab === 'history' && isAdmin ? (
        <GateDocumentHistoryPanel gateDocuments={gateDocuments} pendingRMEntries={pendingRMEntries} />
      ) : (
      <>
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

      {showUnmatchedSlips && onDeleteUnmatchedSlip && (
        <UnmatchedSlipsModal
          slips={unmatchedSlips}
          onDelete={onDeleteUnmatchedSlip}
          onClose={() => setShowUnmatchedSlips(false)}
        />
      )}
      </>
      )}
    </div>
  );
};

export default GateDocumentsQueue;
