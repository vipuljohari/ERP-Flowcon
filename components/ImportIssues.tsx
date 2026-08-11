import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, doc, deleteDoc, orderBy, query } from 'firebase/firestore';
import { db } from '../services/firebase';

interface Issue {
  id: string;
  type: string;
  invoiceNumber: string;
  date: string;
  customer: string;
  rawText: string;
  quantity: number;
  createdAt: string;
}

const ImportIssues: React.FC = () => {
  const [issues, setIssues] = useState<Issue[]>([]);

  useEffect(() => {
    const q = query(collection(db, 'importIssues'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setIssues(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Issue)));
    });
    return () => unsub();
  }, []);

  const dismiss = async (id: string) => {
    await deleteDoc(doc(db, 'importIssues', id));
  };

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-xl font-black text-slate-900 mb-1">Import Issues</h2>
      <p className="text-xs text-slate-500 font-medium mb-6">
        Invoice line items from the Tally connector that couldn't be matched to a part in Item Master.
        Add the item to Item Master (or fix its SAP code) then dismiss — this doesn't retry automatically.
      </p>

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
            <button onClick={() => dismiss(issue.id)} className="text-xs font-bold text-rose-600 shrink-0 ml-4">
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ImportIssues;
