
import React, { useMemo, useState } from 'react';
import { AdminAlert, AdminAlertType } from '../types';

interface NotificationsProps {
  alerts: AdminAlert[];
  onVerify: (id: string) => void;
  onFlag: (id: string, remark: string) => void;
}

const TYPE_META: Record<AdminAlertType, { label: string; icon: string; color: string }> = {
  discrepancy: { label: 'Discrepancy Control Entry (Negative Value)', icon: '⚠️', color: 'rose' },
  rm_inward: { label: 'RM Inward Entry', icon: '📥', color: 'indigo' },
  item_inward: { label: 'Item Material Entry', icon: '📦', color: 'teal' },
  dispatch_manual: { label: 'Manual Dispatch Slip', icon: '📝', color: 'amber' },
  tally_import: { label: 'Tally Excel/XML Import', icon: '📊', color: 'emerald' },
  schedule_bulk_import: { label: 'Bulk Customer Schedule Import', icon: '📋', color: 'violet' },
  rm_cross_bill: { label: 'RM Cross-Bill Invoice Entry', icon: '🧾', color: 'sky' },
};

const colorClasses: Record<string, { badge: string; border: string }> = {
  rose: { badge: 'bg-rose-100 text-rose-700 border-rose-200', border: 'border-l-rose-500' },
  indigo: { badge: 'bg-indigo-100 text-indigo-700 border-indigo-200', border: 'border-l-indigo-500' },
  amber: { badge: 'bg-amber-100 text-amber-700 border-amber-200', border: 'border-l-amber-500' },
  emerald: { badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', border: 'border-l-emerald-500' },
  violet: { badge: 'bg-violet-100 text-violet-700 border-violet-200', border: 'border-l-violet-500' },
  sky: { badge: 'bg-sky-100 text-sky-700 border-sky-200', border: 'border-l-sky-500' },
  teal: { badge: 'bg-teal-100 text-teal-700 border-teal-200', border: 'border-l-teal-500' },
};

const Notifications: React.FC<NotificationsProps> = ({ alerts, onVerify, onFlag }) => {
  const [filterType, setFilterType] = useState<'all' | AdminAlertType>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'verified' | 'flagged'>('all');
  // Which alert's remark box is currently open, and what's typed into it —
  // one at a time, keyed by alert id so multiple cards never fight over it.
  const [flaggingId, setFlaggingId] = useState<string | null>(null);
  const [flagRemarkInput, setFlagRemarkInput] = useState('');

  const sorted = useMemo(
    () => [...alerts].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [alerts]
  );

  const filtered = useMemo(() => {
    return sorted.filter(a => {
      if (filterType !== 'all' && a.type !== filterType) return false;
      if (filterStatus === 'pending' && (a.verified || a.flagged)) return false;
      if (filterStatus === 'verified' && !a.verified) return false;
      if (filterStatus === 'flagged' && !a.flagged) return false;
      return true;
    });
  }, [sorted, filterType, filterStatus]);

  // Flagged counts as handled, same as Verified — it just means Admin
  // decided this needs no further action, not that it was confirmed correct.
  const pendingCount = alerts.filter(a => !a.verified && !a.flagged).length;

  const startFlagging = (id: string) => { setFlaggingId(id); setFlagRemarkInput(''); };
  const cancelFlagging = () => { setFlaggingId(null); setFlagRemarkInput(''); };
  const submitFlag = (id: string) => {
    if (!flagRemarkInput.trim()) return;
    onFlag(id, flagRemarkInput.trim());
    setFlaggingId(null);
    setFlagRemarkInput('');
  };

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none">Notifications</h2>
            {pendingCount > 0 && (
              <span className="bg-rose-600 text-white px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm animate-pulse">
                {pendingCount} Pending Review
              </span>
            )}
          </div>
          <p className="text-slate-500 font-medium">
            Every negative Discrepancy Control Entry, RM Inward entry, manual Dispatch Slip, Tally import, and RM Cross-Bill invoice entry — so you can cross-check or cross-question any of them.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col">
            <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Entry Type</label>
            <select
              className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm font-bold bg-white text-slate-900 shadow-sm"
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as any)}
            >
              <option value="all">All Types</option>
              {(Object.keys(TYPE_META) as AdminAlertType[]).map(t => (
                <option key={t} value={t}>{TYPE_META[t].label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Status</label>
            <select
              className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm font-bold bg-white text-slate-900 shadow-sm"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
            >
              <option value="all">All</option>
              <option value="pending">Pending Review</option>
              <option value="verified">Verified</option>
              <option value="flagged">Flagged</option>
            </select>
          </div>
        </div>
      </header>

      <div className="space-y-3">
        {filtered.map(a => {
          const meta = TYPE_META[a.type];
          const c = colorClasses[meta.color];
          return (
            <div key={a.id} className={`bg-white rounded-[1.75rem] shadow-sm border border-l-4 ${c.border} border-slate-100 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 ${(a.verified || a.flagged) ? 'opacity-70' : ''}`}>
              <div className="flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${c.badge}`}>
                    {meta.icon} {meta.label}
                  </span>
                  {a.verified && (
                    <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border bg-emerald-100 text-emerald-700 border-emerald-200">
                      ✓ Verified
                    </span>
                  )}
                  {a.flagged && (
                    <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border bg-orange-100 text-orange-700 border-orange-200">
                      🚩 Flagged
                    </span>
                  )}
                  <span className="text-[10px] font-bold text-slate-400">
                    {new Date(a.timestamp).toLocaleString('en-GB')}
                  </span>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-sm">
                  <div>
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Entered By</p>
                    <p className="font-bold text-slate-800">{a.createdBy} <span className="text-[10px] text-slate-400 uppercase">({a.role})</span></p>
                  </div>
                  {(a.partName || a.rmSize) && (
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Part / RM</p>
                      <p className="font-bold text-slate-800">{a.partName || a.rmSize} {a.sapCode ? `(${a.sapCode})` : ''}</p>
                    </div>
                  )}
                  {typeof a.quantity === 'number' && (
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Quantity</p>
                      <p className={`font-black ${a.quantity < 0 ? 'text-rose-600' : 'text-slate-800'}`}>{a.quantity}</p>
                    </div>
                  )}
                  {a.customer && (
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Customer</p>
                      <p className="font-bold text-slate-800">{a.customer}</p>
                    </div>
                  )}
                  {a.invoiceNumber && (
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Invoice No.</p>
                      <p className="font-bold text-slate-800">{a.invoiceNumber}</p>
                    </div>
                  )}
                  {a.supplier && (
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Supplier</p>
                      <p className="font-bold text-slate-800">{a.supplier}</p>
                    </div>
                  )}
                  {a.responsibleName && (
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Responsible Name</p>
                      <p className="font-bold text-slate-800">{a.responsibleName}</p>
                    </div>
                  )}
                  {typeof a.itemCount === 'number' && (
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Items</p>
                      <p className="font-bold text-slate-800">{a.itemCount}</p>
                    </div>
                  )}
                </div>

                {a.remarks && (
                  <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-2 mt-1">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Remarks</p>
                    <p className="text-xs font-bold text-slate-700 italic">"{a.remarks}"</p>
                  </div>
                )}

                {a.details && (
                  <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-2">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Details</p>
                    <p className="text-xs font-bold text-slate-700 whitespace-pre-line">{a.details}</p>
                  </div>
                )}

                {a.verified && (
                  <p className="text-[10px] font-bold text-emerald-600">
                    Verified by {a.verifiedBy} on {a.verifiedAt ? new Date(a.verifiedAt).toLocaleString('en-GB') : ''}
                  </p>
                )}

                {a.flagged && (
                  <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-2 mt-1">
                    <p className="text-[9px] font-black text-orange-400 uppercase tracking-widest mb-0.5">Flag Remark</p>
                    <p className="text-xs font-bold text-orange-800 italic">"{a.flagRemark}"</p>
                    <p className="text-[10px] font-bold text-orange-500 mt-1">
                      Flagged by {a.flaggedBy} on {a.flaggedAt ? new Date(a.flaggedAt).toLocaleString('en-GB') : ''}
                    </p>
                  </div>
                )}
              </div>

              {!a.verified && !a.flagged && (
                flaggingId === a.id ? (
                  <div className="shrink-0 w-full md:w-72 space-y-2">
                    <textarea
                      autoFocus
                      required
                      placeholder="Why are you setting this aside? e.g. duplicate of an entry already saved"
                      className="w-full px-4 py-3 bg-orange-50/40 border-2 border-orange-200 rounded-xl outline-none text-xs font-bold text-slate-800 min-h-[70px] shadow-inner"
                      value={flagRemarkInput}
                      onChange={(e) => setFlagRemarkInput(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={cancelFlagging}
                        className="flex-1 px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl font-black uppercase text-[10px] tracking-widest"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => submitFlag(a.id)}
                        disabled={!flagRemarkInput.trim()}
                        className="flex-1 px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-md active:scale-95 transition-all"
                      >
                        🚩 Save Flag
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="shrink-0 flex gap-2">
                    <button
                      onClick={() => startFlagging(a.id)}
                      className="px-6 py-3 border-2 border-orange-200 text-orange-600 hover:bg-orange-50 rounded-xl font-black uppercase text-[11px] tracking-widest active:scale-95 transition-all"
                    >
                      🚩 Flag
                    </button>
                    <button
                      onClick={() => onVerify(a.id)}
                      className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black uppercase text-[11px] tracking-widest shadow-md active:scale-95 transition-all"
                    >
                      ✓ Verify
                    </button>
                  </div>
                )
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="p-16 text-center text-slate-400 font-bold uppercase text-xs tracking-wide bg-white rounded-[2rem] border border-slate-100">
            No entries match the selected filters.
          </div>
        )}
      </div>
    </div>
  );
};

export default Notifications;
