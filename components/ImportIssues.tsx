import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, doc, deleteDoc, orderBy, query } from 'firebase/firestore';
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
}

const ImportIssues: React.FC<ImportIssuesProps> = ({ onAddToItemMaster, isAdmin }) => {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const dismiss = async (id: string) => {
    await deleteDoc(doc(db, 'importIssues', id));
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
      <h2 className="text-xl font-black text-slate-900 mb-1">Import Issues</h2>
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

      {issues.length === 0 && (
        <div className="bg-emerald-50 text-emerald-700 text-sm font-bold rounded-2xl px-6 py-8 text-center">
          Nothing waiting for review 🎉
        </div>
      )}

      <div className="space-y-3">
        {issues.map((issue) => (
          <div key={issue.id} className="bg-white border border-slate-100 rounded-2xl p-4 flex justify-between items-start">
            <div>
              <p className="font-bold text-slate-900 text-sm">{issue.rawText}</p>
              <p className="text-xs text-slate-500 mt-1">
                Invoice {issue.invoiceNumber} • {issue.customer} • Qty {issue.quantity} • {new Date(issue.date).toLocaleDateString()}
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
