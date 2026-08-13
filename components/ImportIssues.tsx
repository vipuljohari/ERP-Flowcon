import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, doc, deleteDoc, orderBy, query, writeBatch } from 'firebase/firestore';
import { db } from '../services/firebase';

interface Issue {
  id: string;
  type: string;
  invoiceNumber: string;
  date: string;
  customer: string | null;
  rawText: string;
  quantity: number;
  rate?: number;
  createdAt: string;
}

interface ImportIssuesProps {
  onAddToItemMaster?: (draft: { sapCode: string; name: string; customer?: string; rate?: number }) => void;
  isAdmin?: boolean;
  customers?: { id: string; name: string }[];
}

const ImportIssues: React.FC<ImportIssuesProps> = ({ onAddToItemMaster, isAdmin, customers = [] }) => {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [customerFilter, setCustomerFilter] = useState<string>('All');

  useEffect(() => {
    const q = query(collection(db, 'importIssues'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setError(null);
        setIssues(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Issue)));
      },
      (err) => {
        setError(err.message || 'Could not load Import Issues — likely a Firestore Rules permission problem.');
      }
    );
    return () => unsub();
  }, []);

  const filteredIssues = issues.filter((issue) => {
    if (customerFilter === 'All') return true;
    if (customerFilter === '__unknown__') return !issue.customer;
    return issue.customer === customerFilter;
  });

  const dismiss = async (id: string) => {
    await deleteDoc(doc(db, 'importIssues', id));
  };

  // Collapses exact duplicates only — same invoice number AND same raw item
  // text, the identical criteria the connector script itself uses for its
  // own dedup checks. Keeps the oldest copy of each, deletes the rest.
  // Never touches anything that isn't a true duplicate.
  const [dedupeStatus, setDedupeStatus] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

  const runDeduplication = async () => {
    const groups = new Map<string, Issue[]>();
    issues.forEach((issue) => {
      const key = `${issue.invoiceNumber}::${issue.rawText}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(issue);
    });

    const toDelete: string[] = [];
    groups.forEach((group) => {
      if (group.length <= 1) return;
      const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      sorted.slice(1).forEach((extra) => toDelete.push(extra.id)); // keep the oldest, delete the rest
    });

    if (toDelete.length === 0) {
      setDedupeStatus({ busy: false, message: 'No duplicates found — nothing to clean up.' });
      return;
    }

    if (!confirm(`Found ${toDelete.length} duplicate entr${toDelete.length === 1 ? 'y' : 'ies'} to remove, keeping one copy of each. Continue?`)) {
      return;
    }

    setDedupeStatus({ busy: true, message: null });
    try {
      // Firestore batches cap at 500 operations — chunk if there's ever more.
      for (let i = 0; i < toDelete.length; i += 450) {
        const batch = writeBatch(db);
        toDelete.slice(i, i + 450).forEach((id) => batch.delete(doc(db, 'importIssues', id)));
        await batch.commit();
      }
      setDedupeStatus({ busy: false, message: `Removed ${toDelete.length} duplicate entr${toDelete.length === 1 ? 'y' : 'ies'}.` });
    } catch (err: any) {
      setDedupeStatus({ busy: false, message: `Cleanup failed: ${err.message}` });
    }
  };

  // rawText looks like "007651155V91 Foot Step Pipe - 38x38" — same
  // convention used everywhere else in the app: first token is the SAP
  // code, the rest is the part name. This just gives Item Master's own
  // Create form a starting point — nothing is saved until the user reviews
  // and submits that form themselves.
  const addToItemMaster = (issue: Issue) => {
    const [sapCode, ...rest] = issue.rawText.trim().split(/\s+/);
    onAddToItemMaster?.({
      sapCode: sapCode || '',
      name: rest.join(' ') || issue.rawText,
      customer: issue.customer || undefined,
      rate: issue.rate || undefined,
    });
  };

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex justify-between items-start mb-1">
        <h2 className="text-xl font-black text-slate-900">Import Issues</h2>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <button
              onClick={runDeduplication}
              disabled={dedupeStatus.busy}
              className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 text-slate-600 hover:border-indigo-500 hover:text-indigo-600 disabled:opacity-50"
            >
              {dedupeStatus.busy ? 'Cleaning up…' : 'Remove duplicates'}
            </button>
          )}
          <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Customer</label>
          <select
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-bold text-slate-700"
          >
            <option value="All">All customers</option>
            <option value="__unknown__">Unassigned (no matched customer)</option>
            {customers.map((c) => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>
      {dedupeStatus.message && (
        <div className="mb-4 text-xs font-bold text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 inline-block">
          {dedupeStatus.message}
        </div>
      )}
      <p className="text-xs text-slate-500 font-medium mb-6">
        Invoice line items from the Tally connector that couldn't be matched to a part in Item Master.
        Click "Add to Item Master" to open a pre-filled creation form — review before saving — or fix the
        SAP code directly in Tally/Item Master and dismiss. This doesn't retry automatically.
      </p>

      {error && (
        <div className="bg-rose-50 text-rose-600 text-sm font-bold rounded-2xl px-6 py-4 mb-6">
          {error}
        </div>
      )}

      {filteredIssues.length === 0 && (
        <div className="bg-emerald-50 text-emerald-700 text-sm font-bold rounded-2xl px-6 py-8 text-center">
          {issues.length === 0 ? 'Nothing waiting for review 🎉' : 'Nothing for this customer right now.'}
        </div>
      )}

      <div className="space-y-3">
        {filteredIssues.map((issue) => (
          <div key={issue.id} className="bg-white border border-slate-100 rounded-2xl p-4 flex justify-between items-start">
            <div>
              <p className="font-bold text-slate-900 text-sm">{issue.rawText}</p>
              <p className="text-xs text-slate-500 mt-1">
                Invoice {issue.invoiceNumber} • {issue.customer || 'Unassigned'} • Qty {issue.quantity} • {new Date(issue.date).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-4 shrink-0 ml-4">
              {isAdmin && (
                <button onClick={() => addToItemMaster(issue)} className="text-xs font-bold text-indigo-600">
                  Add to Item Master
                </button>
              )}
              <button onClick={() => dismiss(issue.id)} className="text-xs font-bold text-rose-600">
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ImportIssues;
