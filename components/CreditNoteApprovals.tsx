import React, { useMemo, useState } from 'react';
import { CreditNoteApproval, CREDIT_NOTE_CLASSIFICATION_LABELS } from '../types';

// ============================================================
// Credit Note Approvals (30-Oct-26) — Admin's review queue for every
// Credit Note cx412's import-tally.js has found in Tally and staged into
// Firestore's `creditNoteApprovals` collection (same "script writes,
// app reads/acts" pattern as the RM Purchase Voucher mirror). Sits on
// the same RM Approvals tab as RMApprovalQueue, as its own section —
// deliberately a separate component rather than folded into
// RMApprovalQueue's PendingRMEntry machinery, since these entries
// originate from Tally (not from an in-app staging flow) and carry a
// completely different shape (one line item each, a Narration-derived
// classification, no photos/material-entry fields at all).
//
// REJECTION / RATE_DIFF (goods genuinely dispatched, no inventory
// impact — same convention as the cx412 scripts' own MTD netting) show
// up marked "No action needed" and are never actionable here.
// CANCELLED / SHORT_QTY / unclassified (classification === null) get an
// Approve button. Approving (see App.tsx's approveCreditNote) posts ONE
// negative Sale entry (this is what actually un-counts the double
// dispatch — and, since RM "Stock as on date" is itself derived from
// Dispatches, restores the RM stock too, in the same move) plus a
// visible-but-excluded-from-totals note on the RM Inward Log, so the
// ledger shows why the number moved without moving it twice.
// ============================================================

interface CreditNoteApprovalsProps {
  entries: CreditNoteApproval[];
  isAdmin?: boolean;
  onApprove: (entry: CreditNoteApproval, againstInvoiceNumber?: string) => void;
  onReject: (entry: CreditNoteApproval) => void;
  // 30-Oct-26 — coarse sanity check (see App.tsx's comment on the memo
  // that builds this map): total of every real dispatch ever recorded for
  // `${customer}::${partId}`. Not a precise check against the specific
  // invoice this CN credits (Tally gives us no structured link for that —
  // only free-text Narration) — just a circuit breaker for the
  // catastrophic case of a quantity that's obviously wrong.
  dispatchedQtyByCustomerPart?: Map<string, number>;
}

const classificationStyle: Record<string, string> = {
  CANCELLED: 'bg-rose-50 text-rose-700 border-rose-200',
  SHORT_QTY: 'bg-rose-50 text-rose-700 border-rose-200',
  REJECTION: 'bg-slate-100 text-slate-500 border-slate-200',
  RATE_DIFF: 'bg-slate-100 text-slate-500 border-slate-200',
  UNCLASSIFIED: 'bg-amber-50 text-amber-700 border-amber-200',
};

const CreditNoteApprovals: React.FC<CreditNoteApprovalsProps> = ({ entries, isAdmin = false, onApprove, onReject, dispatchedQtyByCustomerPart }) => {
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  // Keyed by entry.id — the original/cancelled invoice number Admin types
  // in right before Approve (Tally only has this in free-text Narration,
  // confirmed 30-Oct-26, so it's typed, not parsed — see App.tsx's
  // approveCreditNote). Purely local/ephemeral until Approve is clicked.
  const [againstInvoiceInputs, setAgainstInvoiceInputs] = useState<Record<string, string>>({});

  const sorted = useMemo(
    () => [...entries].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [entries]
  );

  const visible = filter === 'open' ? sorted.filter(e => e.status === 'pending') : sorted;
  const openCount = sorted.filter(e => e.status === 'pending').length;

  if (entries.length === 0) return null;

  const handleApprove = async (entry: CreditNoteApproval) => {
    setApprovingId(entry.id);
    try {
      await onApprove(entry, againstInvoiceInputs[entry.id]);
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async (entry: CreditNoteApproval) => {
    if (!window.confirm(`Reject Credit Note ${entry.voucherNumber}? No Sale or RM Inward entry will be posted — this just dismisses it from the queue.`)) return;
    setRejectingId(entry.id);
    try {
      await onReject(entry);
    } finally {
      setRejectingId(null);
    }
  };

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-black text-slate-800">Credit Notes from Tally</h3>
          <p className="text-xs font-medium text-slate-400 mt-0.5">
            Auto-staged from Tally's hourly sync — Narration decides what each one needs.
          </p>
        </div>
        <div className="flex items-center gap-2 bg-slate-100 rounded-xl p-1">
          <button
            onClick={() => setFilter('open')}
            className={`px-3 py-1.5 rounded-lg text-xs font-black transition-colors ${filter === 'open' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
          >
            Needs Approval ({openCount})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-black transition-colors ${filter === 'all' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
          >
            All ({sorted.length})
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm font-medium text-slate-400">
          Nothing needs approval right now.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(entry => {
            const badgeKey = entry.classification || 'UNCLASSIFIED';
            const badgeLabel = entry.classification ? CREDIT_NOTE_CLASSIFICATION_LABELS[entry.classification] : 'Unclassified';
            const totalDispatched = entry.partId ? (dispatchedQtyByCustomerPart?.get(`${entry.customer}::${entry.partId}`) || 0) : 0;
            const qtyLooksOff = entry.partId && entry.quantity > totalDispatched;
            return (
              <div
                key={entry.id}
                className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col sm:flex-row sm:items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className="font-black text-slate-800 text-sm">{entry.voucherNumber}</span>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                      {new Date(entry.date).toLocaleDateString('en-GB')}
                    </span>
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border uppercase tracking-wide ${classificationStyle[badgeKey]}`}>
                      {badgeLabel}
                    </span>
                    {!entry.actionNeeded && (
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 uppercase tracking-wide">
                        No action needed
                      </span>
                    )}
                    {entry.status === 'approved' && (
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200 uppercase tracking-wide">
                        Approved
                      </span>
                    )}
                    {entry.status === 'rejected' && (
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200 uppercase tracking-wide">
                        Rejected
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-bold text-slate-700 truncate">
                    {entry.customer} — {entry.partId ? `${entry.partName} (${entry.sapCode})` : entry.rawStockItemName}
                    {!entry.partId && (
                      <span className="ml-2 text-[10px] font-black text-rose-500 uppercase">Unmatched item</span>
                    )}
                  </div>
                  <div className="text-xs font-medium text-slate-400 mt-0.5">
                    Qty {entry.quantity.toLocaleString()}
                    {entry.narration && <span className="italic"> — "{entry.narration}"</span>}
                  </div>
                  {qtyLooksOff && entry.status === 'pending' && (
                    <div className="text-[10px] font-bold text-amber-600 mt-1">
                      ⚠ Qty exceeds total ever dispatched to {entry.customer} for this part ({totalDispatched.toLocaleString()}) — verify before approving.
                    </div>
                  )}
                  {isAdmin && entry.actionNeeded && entry.status === 'pending' && (
                    <input
                      type="text"
                      value={againstInvoiceInputs[entry.id] ?? ''}
                      onChange={e => setAgainstInvoiceInputs(prev => ({ ...prev, [entry.id]: e.target.value }))}
                      placeholder="Original/cancelled invoice # (optional) — e.g. IMT/26-27/1030"
                      className="mt-2 w-full max-w-sm px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-indigo-300"
                    />
                  )}
                  {entry.status === 'approved' && entry.againstInvoiceNumber && (
                    <div className="text-[10px] font-medium text-slate-400 mt-1">
                      Against invoice {entry.againstInvoiceNumber}
                    </div>
                  )}
                  {entry.status === 'approved' && entry.approvedBy && (
                    <div className="text-[10px] font-medium text-slate-400 mt-1">
                      Approved by {entry.approvedBy}{entry.approvedAt ? ` on ${new Date(entry.approvedAt).toLocaleDateString('en-GB')}` : ''}
                    </div>
                  )}
                  {entry.status === 'rejected' && entry.rejectedBy && (
                    <div className="text-[10px] font-medium text-slate-400 mt-1">
                      Rejected by {entry.rejectedBy}{entry.rejectedAt ? ` on ${new Date(entry.rejectedAt).toLocaleDateString('en-GB')}` : ''}
                    </div>
                  )}
                </div>
                {isAdmin && entry.actionNeeded && entry.status === 'pending' && (
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      disabled={approvingId === entry.id || rejectingId === entry.id}
                      onClick={() => handleReject(entry)}
                      className="px-5 py-2.5 rounded-xl bg-white border border-slate-300 text-slate-500 text-xs font-black uppercase tracking-wide shadow-sm hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {rejectingId === entry.id ? 'Rejecting…' : 'Reject'}
                    </button>
                    <button
                      disabled={!entry.partId || approvingId === entry.id || rejectingId === entry.id}
                      onClick={() => handleApprove(entry)}
                      title={!entry.partId ? 'Map this Tally item to a Part in Item Master before approving' : undefined}
                      className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-black uppercase tracking-wide shadow-sm hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {approvingId === entry.id ? 'Approving…' : 'Approve'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CreditNoteApprovals;
