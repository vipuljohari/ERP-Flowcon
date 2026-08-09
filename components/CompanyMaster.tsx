import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Company } from '../types';

const emptyForm: Omit<Company, 'id'> = { name: '', address: '', gstNumber: '', plantCode: '' };

const CompanyMaster: React.FC = () => {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'companies'), (snap) => {
      setCompanies(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Company)));
    });
    return () => unsub();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = editingId || form.plantCode?.trim().toLowerCase().replace(/\s+/g, '-') || crypto.randomUUID();
    await setDoc(doc(db, 'companies', id), form);
    setForm(emptyForm);
    setEditingId(null);
  };

  const handleEdit = (c: Company) => {
    setEditingId(c.id);
    setForm({ name: c.name, address: c.address, gstNumber: c.gstNumber || '', plantCode: c.plantCode || '' });
  };

  const handleDelete = async (id: string) => {
    if (confirm('Remove this company/plant entry?')) await deleteDoc(doc(db, 'companies', id));
  };

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-xl font-black text-slate-900 mb-1">Company Master</h2>
      <p className="text-xs text-slate-500 font-medium mb-6">
        Manage your company/plant details. Add a new entry here if you open a second unit.
      </p>

      <form onSubmit={handleSave} className="bg-slate-50 rounded-2xl p-6 mb-6 space-y-3">
        <input required placeholder="Company / plant name" value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
        <textarea required placeholder="Address" value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" rows={2} />
        <div className="grid grid-cols-2 gap-3">
          <input placeholder="GST number (optional)" value={form.gstNumber}
            onChange={(e) => setForm({ ...form, gstNumber: e.target.value })}
            className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
          <input placeholder="Plant code (e.g. PALWAL)" value={form.plantCode}
            onChange={(e) => setForm({ ...form, plantCode: e.target.value })}
            className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </div>
        <button type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold">
          {editingId ? 'Update' : 'Add'} Company
        </button>
        {editingId && (
          <button type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }}
            className="ml-2 px-4 py-2 text-slate-500 text-sm font-bold">
            Cancel
          </button>
        )}
      </form>

      <div className="space-y-3">
        {companies.map((c) => (
          <div key={c.id} className="bg-white border border-slate-100 rounded-2xl p-4 flex justify-between items-start">
            <div>
              <p className="font-bold text-slate-900">{c.name} {c.plantCode && <span className="text-xs text-slate-400 font-normal">({c.plantCode})</span>}</p>
              <p className="text-xs text-slate-500 mt-1">{c.address}</p>
              {c.gstNumber && <p className="text-[10px] text-slate-400 mt-1">GST: {c.gstNumber}</p>}
            </div>
            <div className="flex gap-3 text-xs font-bold">
              <button onClick={() => handleEdit(c)} className="text-indigo-600">Edit</button>
              <button onClick={() => handleDelete(c.id)} className="text-rose-600">Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CompanyMaster;
