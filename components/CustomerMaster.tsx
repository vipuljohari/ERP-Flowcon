import React, { useState, useMemo } from 'react';
import { Customer, Sale, Part, RawMaterial } from '../types';

const norm = (s?: string | null) => (s || '').toUpperCase().trim();

// 6-Oct-26, Vipul's ask: the Tally connector auto-creates a Customer record
// (autoCreated: true) for every consignee name it sees on an invoice it
// can't match to an existing one — it doesn't check for a near-duplicate of
// a name already sitting here, and it runs on every import, so the same
// unmapped name can pile up as several identical rows over time (see
// flowcon-erp-rm-master.md-adjacent project notes). A customer that's
// genuinely in use would already show up via mapped Parts/RM/dispatches —
// so "has this customer actually been assigned an Item or RM yet" is used
// below to decide whether it belongs in the main list at all, exactly per
// Vipul's ask: "these should only become active once i assign an item and
// RM to them." This is a display-only filter — nothing is deleted or
// changed until Admin acts on it from the Needs Review panel.
const isCustomerUsed = (c: Customer, parts: Part[], rawMaterials: RawMaterial[], sales: Sale[]): boolean => {
  const n = norm(c.name);
  if (parts.some(p => p.mappedCustomers?.some(m => norm(m) === n) || Object.keys(p.schedules || {}).some(k => norm(k) === n))) return true;
  if (rawMaterials.some(rm => norm(rm.customerName) === n || rm.customerNames?.some(cn => norm(cn) === n))) return true;
  if (sales.some(s => norm(s.customer) === n)) return true;
  return false;
};

interface CustomerMasterProps {
  customers: Customer[];
  sales: Sale[];
  parts: Part[];
  rawMaterials: RawMaterial[];
  onAdd: (name: string, keywords: string) => void;
  onEdit: (id: string, name: string, keywords: string) => void;
  onDelete: (id: string) => void;
  activeCustomerInSession?: string;
  setCustomers?: (update: Customer[] | ((prev: Customer[]) => Customer[])) => void;
}

const CustomerMaster: React.FC<CustomerMasterProps> = ({
  customers,
  sales,
  parts,
  rawMaterials,
  onAdd,
  onEdit,
  onDelete,
  activeCustomerInSession,
  setCustomers
}) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [showNeedsReview, setShowNeedsReview] = useState(false);

  // Split: a manually-added customer, or an auto-created one that's already
  // mapped to at least one Item/RM/dispatch, shows in the main list as
  // before. An auto-created customer with nothing mapped to it yet — the
  // clutter Vipul's screenshot showed — moves into the collapsed Needs
  // Review panel below instead, grouped by name so exact duplicates (the
  // Tally connector doesn't dedupe against existing rows) are obvious and
  // easy to clean up in one place rather than scattered through the main
  // table.
  const { mainCustomers, reviewGroups } = useMemo(() => {
    const main: Customer[] = [];
    const unused: Customer[] = [];
    customers.forEach(c => {
      if (c.autoCreated && !isCustomerUsed(c, parts, rawMaterials, sales)) unused.push(c);
      else main.push(c);
    });
    const groups = new Map<string, Customer[]>();
    unused.forEach(c => {
      const key = norm(c.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    });
    const reviewGroups = Array.from(groups.values()).sort((a, b) => a[0].name.localeCompare(b[0].name));
    return { mainCustomers: main, reviewGroups };
  }, [customers, parts, rawMaterials, sales]);

  const needsReviewCount = reviewGroups.reduce((sum, g) => sum + g.length, 0);

  // Safe because these are, by construction, customers nothing is mapped
  // to yet — no Part, RawMaterial or Sale references them, so deleting the
  // extras has no cascading data to touch (unlike handleDelete's cascading-
  // sales warning below, which is for the main, in-use list).
  const keepOneDeleteRest = (group: Customer[]) => {
    if (group.length <= 1) return;
    const [, ...extras] = group;
    if (!window.confirm(`Delete ${extras.length} duplicate "${group[0].name}" record${extras.length === 1 ? '' : 's'}, keeping one? None of these are mapped to anything yet, so nothing else is affected.`)) return;
    extras.forEach(c => onDelete(c.id));
  };

  // --- Admin reorder mode ---
  const [reorderMode, setReorderMode] = useState(false);
  const [draftOrder, setDraftOrder] = useState<Customer[]>([]);

  const enterReorderMode = () => {
    setDraftOrder([...customers]); // `customers` prop already arrives pre-sorted from App.tsx
    setReorderMode(true);
  };

  const moveDraftItem = (index: number, direction: -1 | 1) => {
    setDraftOrder((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const saveOrder = () => {
    if (!setCustomers) return;
    const withOrder = draftOrder.map((c, i) => ({ ...c, sortOrder: i }));
    setCustomers((prev) => prev.map((c) => {
      const updated = withOrder.find((w) => w.id === c.id);
      return updated ? updated : c;
    }));
    setReorderMode(false);
  };

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
          <div className="flex items-center gap-3 mb-2">
            {!reorderMode && (
              <button
                onClick={enterReorderMode}
                title="Reorder customers"
                className="w-9 h-9 flex items-center justify-center rounded-xl border-2 border-slate-200 text-slate-500 hover:border-indigo-500 hover:text-indigo-600 transition-all"
              >
                ✏️
              </button>
            )}
            {reorderMode && (
              <div className="flex items-center gap-2">
                <button onClick={saveOrder} className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-black uppercase tracking-widest">
                  Save Order
                </button>
                <button onClick={() => setReorderMode(false)} className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-widest">
                  Cancel
                </button>
              </div>
            )}
            <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none">Customer Master</h2>
          </div>
          <p className="text-slate-500 font-medium">Manage consignees and smart-match routing keywords</p>
        </div>
        <button 
          onClick={handleOpenAdd}
          className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95"
        >
          Add New Consignee +
        </button>
      </header>

      {reorderMode && (
        <div className="bg-white rounded-[2rem] shadow-sm border border-indigo-200 p-6">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-4">
            Reorder customers — use the arrows, then click Save Order above. This order applies everywhere, including every customer dropdown in the app.
          </p>
          <div className="space-y-2">
            {draftOrder.map((c, i) => (
              <div key={c.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3">
                <p className="font-bold text-slate-900 text-sm">{c.name}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => moveDraftItem(i, -1)}
                    disabled={i === 0}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-indigo-500 hover:text-indigo-600"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveDraftItem(i, 1)}
                    disabled={i === draftOrder.length - 1}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-indigo-500 hover:text-indigo-600"
                  >
                    ↓
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!reorderMode && (
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
            {mainCustomers.map(c => {
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
      )}

      {!reorderMode && needsReviewCount > 0 && (
        <div className="bg-amber-50/40 rounded-[2rem] border-2 border-dashed border-amber-200 overflow-hidden">
          <button
            onClick={() => setShowNeedsReview(v => !v)}
            className="w-full flex items-center justify-between px-8 py-5 text-left"
          >
            <div>
              <p className="text-sm font-black text-amber-800 uppercase tracking-wide">
                Needs Review — Not Yet Used ({needsReviewCount})
              </p>
              <p className="text-xs text-amber-700/80 font-medium mt-0.5">
                Auto-created from Tally, nothing mapped to any of these yet — they'll move to the main list above on their own once you assign an Item or RM Master to one.
              </p>
            </div>
            <span className="shrink-0 text-amber-600 text-sm font-black ml-4">{showNeedsReview ? '▲' : '▼'}</span>
          </button>
          {showNeedsReview && (
            <div className="px-8 pb-6 space-y-3">
              {reviewGroups.map(group => (
                <div key={norm(group[0].name)} className="bg-white border border-amber-100 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-black text-slate-900 text-sm uppercase truncate">
                      {group[0].name}
                      {group.length > 1 && (
                        <span className="ml-2 bg-rose-100 text-rose-700 px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest align-middle">
                          {group.length}× duplicate
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-slate-400 font-medium mt-0.5">
                      {group.map(c => c.autoCreatedAt ? new Date(c.autoCreatedAt).toLocaleDateString() : null).filter(Boolean).join(' · ') || 'Auto-created'}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {group.length > 1 && (
                      <button
                        onClick={() => keepOneDeleteRest(group)}
                        className="px-3 py-2 bg-rose-50 text-rose-600 border-2 border-rose-200 hover:bg-rose-600 hover:text-white hover:border-rose-600 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all"
                      >
                        Keep 1, Delete {group.length - 1}
                      </button>
                    )}
                    <button
                      onClick={(e) => handleOpenEdit(e, group[0])}
                      className="w-10 h-10 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-100 transition-all flex items-center justify-center shadow-sm"
                      title="Edit Record"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, group[0])}
                      className="w-10 h-10 bg-rose-50 text-rose-600 rounded-xl hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center shadow-sm"
                      title="Delete Record"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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