import React, { useState, useMemo } from 'react';
import { RawMaterial, Customer, Part, RMCategory } from '../types';
import { rmAllCustomers, rmMatchesCustomer } from '../services/rmYield';

// A Part with no partType set is a pre-existing Tubular part (see
// types.ts's PartType comment) — treat undefined the same as 'tubular'
// everywhere so old data doesn't need a migration.
const partMatchesRMCategory = (p: Part, category: RMCategory): boolean =>
  category === 'sheet' ? p.partType === 'sheet_metal' : (p.partType || 'tubular') === 'tubular';

interface RMMasterProps {
  rawMaterials: RawMaterial[];
  parts: Part[];
  customers: Customer[];
  onAdd: (rmData: Partial<RawMaterial>) => void;
  onEdit: (id: string, rmData: Partial<RawMaterial>) => void;
  onDelete: (id: string) => void;
}

const RMMaster: React.FC<RMMasterProps> = ({ rawMaterials, parts, customers, onAdd, onEdit, onDelete }) => {
  // Models scoped per customer — mirrors Item Master's approach, so the
  // dropdown only shows models actually used by RM for that customer.
  const modelsByCustomer = useMemo(() => {
    const map: Record<string, string[]> = {};
    rawMaterials.forEach(rm => {
      if (!rm.model) return;
      if (!map[rm.customerName]) map[rm.customerName] = [];
      if (!map[rm.customerName].includes(rm.model)) map[rm.customerName].push(rm.model);
    });
    Object.keys(map).forEach(k => map[k].sort());
    return map;
  }, [rawMaterials]);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCustFilter, setSelectedCustFilter] = useState('All');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<'All' | RMCategory>('All');
  // Filters the "Map to Finished Goods Items" checklist inside the modal —
  // separate from the page-level `searchTerm` above, which filters the RM
  // list itself. Reset whenever the modal is (re)opened (see handleOpenAdd/
  // handleOpenEdit) so it never carries over stale text between RMs.
  const [partSearchTerm, setPartSearchTerm] = useState('');

  const [formData, setFormData] = useState({
    category: 'tube' as RMCategory,
    size: '',
    length: 6000,
    weightPer1000: 0,
    thickness: '',
    grade: '',
    customerName: '',
    // Additional customers this RM's stock is ALSO shared with, besides
    // `customerName` above — see types.ts's RawMaterial.customerNames.
    customerNames: [] as string[],
    model: '',
    partId: '',
    partIds: [] as string[],
  });

  const handleOpenAdd = () => {
    setEditingId(null);
    const initialCustomer = customers[0]?.name || '';
    const initialPartId = parts[0]?.id || '';
    setFormData({
      category: 'tube',
      size: '',
      length: 6000,
      weightPer1000: 0,
      thickness: '',
      grade: '',
      customerName: initialCustomer,
      customerNames: [],
      model: '',
      partId: initialPartId,
      partIds: initialPartId ? [initialPartId] : [],
    });
    setPartSearchTerm('');
    setShowModal(true);
  };

  const handleOpenEdit = (e: React.MouseEvent, rm: RawMaterial) => {
    e.stopPropagation();
    setEditingId(rm.id);
    setPartSearchTerm('');
    setFormData({
      category: rm.category || 'tube',
      size: rm.size,
      length: rm.length,
      weightPer1000: rm.weightPer1000,
      thickness: rm.thickness || '',
      grade: rm.grade || '',
      customerName: rm.customerName,
      customerNames: rm.customerNames || [],
      model: rm.model || '',
      partId: rm.partId || '',
      partIds: rm.partIds || (rm.partId ? [rm.partId] : []),
    });
    setShowModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let finalPartIds = formData.partIds;
    if (finalPartIds.length === 0 && formData.partId) {
      finalPartIds = [formData.partId];
    }

    const selectedParts = parts.filter(p => finalPartIds.includes(p.id));
    const finalPartNames = selectedParts.map(p => p.name).join(', ') || 'Unmapped';
    const finalPartId = finalPartIds[0] || '';

    // Never let the primary customer also sit in the "additional" list —
    // switching "Map to Customer" can otherwise leave a stale duplicate.
    const finalCustomerNames = formData.customerNames.filter(
      c => c.toUpperCase().trim() !== formData.customerName.toUpperCase().trim()
    );

    const submitData = {
      ...formData,
      customerNames: finalCustomerNames,
      partId: finalPartId,
      partIds: finalPartIds,
      partName: finalPartNames,
    };

    if (editingId) {
      onEdit(editingId, submitData);
    } else {
      onAdd(submitData);
    }
    setShowModal(false);
  };

  const handleDelete = (e: React.MouseEvent, rm: RawMaterial) => {
    e.stopPropagation();
    if (window.confirm(`Delete Raw Material spec "${rm.size}" mapped to "${rm.partName}"?`)) {
      onDelete(rm.id);
    }
  };

  // Only offer parts whose type matches this RM's category — the key
  // guardrail against linking a Tubular part to a Sheet RM (or vice versa),
  // which would silently feed the wrong numbers into the stock/shortage
  // math in App.tsx (see services/rmYield.ts).
  // Includes items mapped to ANY customer on this RM (primary + additional
  // "Also Used By" ones) so a shared RM can still offer the right Finished
  // Goods Items checklist regardless of which customer is currently primary.
  const rmFormCustomers = [formData.customerName, ...formData.customerNames].filter(Boolean);
  const customerParts = parts.filter(p =>
    partMatchesRMCategory(p, formData.category) && (
      rmFormCustomers.length === 0 ||
      rmFormCustomers.some(cust =>
        p.mappedCustomers?.some(c => c.toUpperCase().trim() === cust.toUpperCase().trim()) ||
        (p.schedules && Object.keys(p.schedules).some(k => k.toUpperCase().trim() === cust.toUpperCase().trim()))
      )
    )
  );
  const displayedParts = customerParts.length > 0
    ? customerParts
    : parts.filter(p => partMatchesRMCategory(p, formData.category));

  // Search box inside the "Map to Finished Goods Items" checklist — matches
  // name, SAP code, SKU, or size, so a shop-floor user can type any of what
  // they'd recognize a part by. Purely a display filter: items outside the
  // filtered set stay checked/selected even while hidden by a search term.
  const partSearchQuery = partSearchTerm.trim().toLowerCase();
  const searchedDisplayedParts = partSearchQuery
    ? displayedParts.filter(p =>
        p.name.toLowerCase().includes(partSearchQuery) ||
        p.sapCode.toLowerCase().includes(partSearchQuery) ||
        p.sku.toLowerCase().includes(partSearchQuery) ||
        p.size.toLowerCase().includes(partSearchQuery)
      )
    : displayedParts;

  const filteredRMs = rawMaterials.filter(rm => {
    const matchesSearch = rm.size.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          rm.partName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCustomer = selectedCustFilter === 'All' || rmMatchesCustomer(rm, selectedCustFilter);
    const matchesCategory = selectedCategoryFilter === 'All' || (rm.category || 'tube') === selectedCategoryFilter;
    return matchesSearch && matchesCustomer && matchesCategory;
  });

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col md:flex-row justify-between items-end gap-6">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2 text-left">RM Master</h2>
          <p className="text-slate-500 font-medium text-left">Define Raw Materials, and map sizes to Consignees & Part Items</p>
        </div>
        <div className="flex gap-4">
          <input 
            type="text" 
            placeholder="Search RM sizes / mappings..." 
            className="px-6 py-4 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none font-bold text-slate-700 bg-white w-64 shadow-sm"
            value={searchTerm} 
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select
            className="px-5 py-4 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm font-bold bg-white text-slate-700 shadow-sm"
            value={selectedCategoryFilter}
            onChange={(e) => setSelectedCategoryFilter(e.target.value as 'All' | RMCategory)}
          >
            <option value="All">Tube + Sheet</option>
            <option value="tube">Tube Only</option>
            <option value="sheet">Sheet Metal Only</option>
          </select>
          <select
            className="px-5 py-4 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm font-bold bg-white text-slate-700 shadow-sm"
            value={selectedCustFilter}
            onChange={(e) => setSelectedCustFilter(e.target.value)}
          >
            <option value="All">All Customers</option>
            {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <button
            onClick={handleOpenAdd}
            className="bg-amber-500 text-slate-900 px-8 py-4 rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-amber-600 transition-all shadow-xl shadow-amber-100 active:scale-95"
          >
            Create RM spec +
          </button>
        </div>
      </header>

      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
            <tr>
              <th className="px-8 py-6 border-r border-slate-200/40">RM Specification</th>
              <th className="px-8 py-6 border-r border-slate-200/40">Technical Specs</th>
              <th className="px-8 py-6 border-r border-slate-200/40">Mappings</th>
              <th className="px-8 py-6 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredRMs.map(rm => (
              <tr key={rm.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-8 py-6">
                  <div className="text-[10px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5 flex items-center gap-2">
                    RM SIZE
                    {(rm.category || 'tube') === 'sheet' && <span className="bg-violet-50 text-violet-700 px-1.5 py-0.5 rounded text-[8px] font-black normal-case">Sheet Metal</span>}
                  </div>
                  <div className="font-black text-slate-900 text-base uppercase">{rm.size}</div>
                </td>
                <td className="px-8 py-6">
                  {(rm.category || 'tube') === 'sheet' ? (
                    <div className="space-y-1">
                      <div className="text-xs text-slate-500 font-medium">Thickness: <span className="font-bold text-slate-800">{rm.thickness || '—'}</span></div>
                      <div className="text-xs text-slate-500 font-medium">Grade: <span className="font-bold text-slate-800">{rm.grade || '—'}</span></div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="text-xs text-slate-500 font-medium">Standard Length: <span className="font-bold text-slate-800">{rm.length} mm</span></div>
                      <div className="text-xs text-slate-500 font-medium">Weight Factor: <span className="font-bold text-slate-800">{rm.weightPer1000} Kg / 1000 mm</span></div>
                    </div>
                  )}
                </td>
                <td className="px-8 py-6">
                  <div className="space-y-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded text-[9px] font-black uppercase">Customer</span>
                      <span className="font-bold text-slate-800 text-xs">{rmAllCustomers(rm).join(' + ')}</span>
                    </div>
                    {(rm.customerNames && rm.customerNames.length > 0) && (
                      <div className="text-[9px] text-indigo-400 font-bold pl-1">Shared stock — same RM used for all of the above</div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded text-[9px] font-black uppercase">Item</span>
                      <span className="font-bold text-slate-800 text-xs">{rm.partName}</span>
                    </div>
                  </div>
                </td>
                <td className="px-8 py-6 text-center">
                  <div className="flex justify-center gap-3">
                    <button onClick={(e) => handleOpenEdit(e, rm)} className="w-10 h-10 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-100 transition-all flex items-center justify-center shadow-sm">✏️</button>
                    <button onClick={(e) => handleDelete(e, rm)} className="w-10 h-10 bg-rose-50 text-rose-600 rounded-xl hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center shadow-sm">🗑️</button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredRMs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-8 py-12 text-center text-slate-400 font-medium uppercase tracking-tight text-xs">
                  No RM configurations found. Click "Create RM spec +" to define one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-xl w-full p-10 border border-white/20 animate-in zoom-in-95 overflow-y-auto max-h-[90vh]">
            <h3 className="text-2xl font-black text-slate-900 mb-8 leading-none text-left">
              {editingId ? 'Update RM Configuration' : 'Define Raw Material Spec'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-6 text-left">
              <div className="space-y-4">
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">RM Category</label>
                  <div className="grid grid-cols-2 gap-3">
                    {(['tube', 'sheet'] as RMCategory[]).map(cat => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => {
                          if (formData.category === cat) return;
                          // Switching category invalidates the previous part
                          // selection (a Tube part can't be mapped to a Sheet
                          // RM and vice versa) — reset it so the guardrail in
                          // customerParts/displayedParts can't be bypassed by
                          // leftover selections from before the switch.
                          setFormData({ ...formData, category: cat, partId: '', partIds: [] });
                        }}
                        className={`py-4 rounded-2xl font-black uppercase text-[11px] tracking-widest border-2 transition-all ${formData.category === cat ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 text-slate-500 border-slate-100 hover:border-slate-200'}`}
                      >
                        {cat === 'tube' ? 'Tube' : 'Sheet Metal'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">RM Size Description</label>
                  <input
                    type="text"
                    required
                    placeholder={formData.category === 'sheet' ? 'e.g. CRCA Sheet 1.6mm' : 'e.g. Round Bar 45mm dia'}
                    className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900"
                    value={formData.size}
                    onChange={(e) => setFormData({...formData, size: e.target.value})}
                  />
                </div>
                {formData.category === 'sheet' ? (
                  <div className="grid grid-cols-2 gap-4 text-left">
                    <div className="text-left">
                      <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Thickness</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. 1.6mm"
                        className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900"
                        value={formData.thickness}
                        onChange={(e) => setFormData({...formData, thickness: e.target.value})}
                      />
                    </div>
                    <div className="text-left">
                      <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Grade</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. IS 513 CR2"
                        className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900"
                        value={formData.grade}
                        onChange={(e) => setFormData({...formData, grade: e.target.value})}
                      />
                    </div>
                    <p className="col-span-2 text-[11px] text-slate-400 font-medium -mt-1">
                      Sheet size (e.g. 2500x1250) isn't fixed here — it varies per delivery, so it's recorded per Inward entry instead (Inventory → RM Inward).
                    </p>
                  </div>
                ) : (
                <div className="grid grid-cols-2 gap-4 text-left">
                  <div className="text-left">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Standard Length (mm)</label>
                    <input
                      type="number"
                      required
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900"
                      value={formData.length}
                      onChange={(e) => setFormData({...formData, length: parseInt(e.target.value) || 0})}
                    />
                  </div>
                  <div className="text-left">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Weight (Kg / 1000 mm)</label>
                    <input
                      type="number"
                      step="0.001"
                      required
                      placeholder="e.g. 1.578"
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900"
                      value={formData.weightPer1000 || ''}
                      onChange={(e) => setFormData({...formData, weightPer1000: parseFloat(e.target.value) || 0})}
                    />
                  </div>
                </div>
                )}
                <div className="grid grid-cols-2 gap-4 text-left">
                  <div className="text-left col-span-2 sm:col-span-1">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Map to Customer</label>
                    <select 
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900"
                      value={formData.customerName}
                      onChange={(e) => {
                        const nextCust = e.target.value;
                        // Pre-populate with first item of this customer to make UX smooth
                        const filtered = parts.filter(p => partMatchesRMCategory(p, formData.category) && (p.mappedCustomers?.some(c => c.toUpperCase().trim() === nextCust.toUpperCase().trim()) || (p.schedules && Object.keys(p.schedules).some(k => k.toUpperCase().trim() === nextCust.toUpperCase().trim()))));
                        const nextPartId = filtered[0]?.id || '';
                        setFormData({
                          ...formData,
                          customerName: nextCust,
                          partId: nextPartId,
                          partIds: nextPartId ? [nextPartId] : [],
                        });
                      }}
                    >
                      {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>

                  <div className="col-span-2 text-left">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 text-left">
                      Also Used By (Optional) — Shares This Same RM Stock
                    </label>
                    <p className="text-[11px] text-slate-400 font-medium mb-3">
                      Check other customers only when this is genuinely the SAME physical material/stock going to more than one of them (e.g. two plants of one customer group). This does NOT create separate stock — dispatches to every checked customer will all draw from, and count against, this one RM's stock number.
                    </p>
                    <div className="border-2 border-slate-100 rounded-2xl p-3 max-h-32 overflow-y-auto space-y-1 bg-slate-50">
                      {customers.filter(c => c.name.toUpperCase().trim() !== formData.customerName.toUpperCase().trim()).map(c => {
                        const isChecked = formData.customerNames.some(cn => cn.toUpperCase().trim() === c.name.toUpperCase().trim());
                        return (
                          <label key={c.id} className="flex items-center gap-3 p-1.5 hover:bg-white rounded-lg cursor-pointer select-none transition-all">
                            <input
                              type="checkbox"
                              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded cursor-pointer"
                              checked={isChecked}
                              onChange={() => {
                                const updated = isChecked
                                  ? formData.customerNames.filter(cn => cn.toUpperCase().trim() !== c.name.toUpperCase().trim())
                                  : [...formData.customerNames, c.name];
                                setFormData({ ...formData, customerNames: updated });
                              }}
                            />
                            <span className="text-xs font-bold text-slate-800">{c.name}</span>
                          </label>
                        );
                      })}
                      {customers.length <= 1 && (
                        <div className="text-xs text-slate-400 font-medium py-2 text-center">No other customers to add yet.</div>
                      )}
                    </div>
                  </div>

                  <div className="text-left col-span-2 sm:col-span-1">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Model</label>
                    <select
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900"
                      value={formData.model}
                      onChange={(e) => {
                        if (e.target.value === '__new__') {
                          const entered = window.prompt(`New model for ${formData.customerName}:`)?.trim();
                          if (entered) setFormData({...formData, model: entered});
                          return;
                        }
                        setFormData({...formData, model: e.target.value});
                      }}
                    >
                      <option value="">Not Applicable</option>
                      {modelsByCustomer[formData.customerName]?.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                      <option value="__new__">+ Add new model...</option>
                    </select>
                  </div>
                  
                  <div className="col-span-2 text-left pt-2">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">
                      Map to Finished Goods Items ({formData.partIds.length} item{formData.partIds.length === 1 ? '' : 's'} selected)
                    </label>
                    <input
                      type="text"
                      placeholder="Search items by name, SAP code, SKU or size..."
                      className="w-full px-4 py-3 mb-2 border-2 border-slate-100 rounded-xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-200 outline-none font-bold text-xs text-slate-700 bg-white"
                      value={partSearchTerm}
                      onChange={(e) => setPartSearchTerm(e.target.value)}
                    />
                    <div className="border-2 border-slate-100 rounded-2xl p-4 max-h-48 overflow-y-auto space-y-1 bg-slate-50">
                      {searchedDisplayedParts.map(p => {
                        const isChecked = formData.partIds.includes(p.id);
                        return (
                          <label key={p.id} className="flex items-start gap-3 p-2 hover:bg-white rounded-xl cursor-pointer select-none transition-all border border-transparent hover:border-slate-200/60">
                            <input 
                              type="checkbox"
                              className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded cursor-pointer"
                              checked={isChecked}
                              onChange={() => {
                                let updatedIds = [...formData.partIds];
                                if (isChecked) {
                                  updatedIds = updatedIds.filter(id => id !== p.id);
                                } else {
                                  updatedIds.push(p.id);
                                }
                                setFormData({
                                  ...formData,
                                  partIds: updatedIds,
                                })
                              }}
                            />
                            <div className="text-left">
                              <span className="text-xs font-black text-slate-800 block leading-tight">{p.name}</span>
                              <span className="text-[10px] text-slate-500 font-mono font-medium">{p.sapCode} • {p.size} {p.itemLength ? `• ${p.itemLength} mm` : ''}</span>
                            </div>
                          </label>
                        );
                      })}
                      {displayedParts.length === 0 && (
                        <div className="text-xs text-slate-400 font-medium py-4 text-center">
                          No items found for this customer in Item Master.
                        </div>
                      )}
                      {displayedParts.length > 0 && searchedDisplayedParts.length === 0 && (
                        <div className="text-xs text-slate-400 font-medium py-4 text-center">
                          No items match "{partSearchTerm}".
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-4 text-left pt-4">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest">Cancel</button>
                <button type="submit" className="flex-[2] py-4 bg-amber-500 text-slate-900 rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl shadow-amber-100">Save Configuration</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default RMMaster;
