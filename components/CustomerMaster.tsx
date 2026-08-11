import React, { useState } from 'react';
import { Customer, Sale } from '../types';

interface CustomerMasterProps {
  customers: Customer[];
  sales: Sale[];
  onAdd: (name: string, keywords: string) => void;
  onEdit: (id: string, name: string, keywords: string) => void;
  onDelete: (id: string) => void;
  activeCustomerInSession?: string;
}

const CustomerMaster: React.FC<CustomerMasterProps> = ({ 
  customers, 
  sales, 
  onAdd, 
  onEdit, 
  onDelete,
  activeCustomerInSession
}) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');

  const handleOpenAdd = () => {
    setName('');
    setKeywords('');
    setEditingCustomer(null);
    setShowAddModal(true);
  };

  const handleOpenEdit = (e: React.MouseEvent, customer: Customer) => {
    e.stopPropagation();
    setName(customer.name);
    setKeywords(customer.matchKeywords);
    setEditingCustomer(customer);
    setShowAddModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    
    if (editingCustomer) {
      onEdit(editingCustomer.id, name.trim(), keywords.trim());
    } else {
      onAdd(name.trim(), keywords.trim());
    }
    setShowAddModal(false);
  };

  const handleDelete = (e: React.MouseEvent, customer: Customer) => {
    e.stopPropagation();
    const hasSales = sales.some(s => s.customer && s.customer.toUpperCase().trim() === customer.name.toUpperCase().trim());
    let confirmMsg = `Are you sure you want to delete customer "${customer.name}"?`;
    
    if (hasSales) {
      confirmMsg = `⚠️ WARNING: Customer "${customer.name}" has dispatch history.\n\nDeleting this customer will PERMANENTLY REMOVE all associated sales records and mappings.\n\nProceed with cascading deletion?`;
    }

    if (window.confirm(confirmMsg)) {
      onDelete(customer.id);
    }
  };

  return (
    <div className="space-y-8 text-left">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2">Customer Master</h2>
          <p className="text-slate-500 font-medium">Manage consignees and smart-match routing keywords</p>
        </div>
        <button 
          onClick={handleOpenAdd}
          className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95"
        >
          Add New Consignee +
        </button>
      </header>

      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
            <tr>
              <th className="px-8 py-6 border-r border-slate-200/40">Consignee Name</th>
              <th className="px-8 py-6 border-r border-slate-200/40">Tally Match Keywords</th>
              <th className="px-8 py-6 border-r border-slate-200/40 text-center">History</th>
              <th className="px-8 py-6 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {customers.map(c => {
              const salesCount = sales.filter(s => s.customer && s.customer.toUpperCase().trim() === c.name.toUpperCase().trim()).length;
              const isActive = activeCustomerInSession === c.name;
              return (
                <tr key={c.id} className={`hover:bg-slate-50 transition-colors ${isActive ? 'bg-indigo-50/20' : ''}`}>
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-3">
                      <p className="font-black text-slate-900 text-base uppercase">{c.name}</p>
                      {c.autoCreated && (
                        <span className="bg-amber-100 text-amber-700 border border-amber-200 px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest" title={`Auto-created from Tally on ${c.autoCreatedAt ? new Date(c.autoCreatedAt).toLocaleDateString() : ''} — review rate/keywords`}>
                          Needs Review
                        </span>
                      )}
                      {isActive && (
                        <span className="bg-indigo-600 text-white px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest animate-pulse shadow-sm">
                          Active
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    <div className="flex flex-wrap gap-2">
                      {(c.matchKeywords || "").split(',').map((k, i) => k.trim() && (
                        <span key={i} className="bg-slate-50 text-slate-600 px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-tight border border-slate-200">
                          {k.trim()}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-8 py-6 text-center">
                    <span className="text-xs font-bold text-slate-500">{salesCount} Dispatches</span>
                  </td>
                  <td className="px-8 py-6 text-center">
                    <div className="flex justify-center gap-3">
                      <button 
                        onClick={(e) => handleOpenEdit(e, c)}
                        className="w-10 h-10 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-100 transition-all flex items-center justify-center shadow-sm"
                        title="Edit Record"
                      >
                        ✏️
                      </button>
                      <button 
                        onClick={(e) => handleDelete(e, c)}
                        className="w-10 h-10 bg-rose-50 text-rose-600 rounded-xl hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center shadow-sm"
                        title="Delete Record"
                      >
                        🗑️
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-10 border border-white/20 animate-in zoom-in-95">
            <h3 className="text-2xl font-black text-slate-900 mb-2 leading-none">
              {editingCustomer ? 'Edit Consignee' : 'Register Consignee'}
            </h3>
            <p className="text-sm text-slate-500 mb-8 font-medium">Define customer name and smart-match filters for Tally.</p>
            
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Display Name (Exact)</label>
                <input 
                  autoFocus
                  type="text" 
                  required
                  placeholder="e.g. SKH-PRITHLA"
                  className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 focus:bg-white outline-none font-black text-slate-900 transition-all shadow-inner"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Tally Match Keywords</label>
                <textarea 
                  required
                  placeholder="e.g. PRITHLA, SKH-P"
                  className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 focus:bg-white outline-none font-bold text-slate-900 min-h-[120px] shadow-inner"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                />
              </div>

              <div className="flex gap-4 pt-4">
                <button type="button" onClick={() => setShowAddModal(false)} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest hover:bg-slate-50 transition-all">Cancel</button>
                <button type="submit" className="flex-[2] py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95">
                  Save Record
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerMaster;