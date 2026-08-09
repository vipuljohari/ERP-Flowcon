import React, { useState } from 'react';
import { RawMaterial, Customer, Part } from '../types';

interface RMMasterProps {
  rawMaterials: RawMaterial[];
  parts: Part[];
  customers: Customer[];
  onAdd: (rmData: Partial<RawMaterial>) => void;
  onEdit: (id: string, rmData: Partial<RawMaterial>) => void;
  onDelete: (id: string) => void;
}

const RMMaster: React.FC<RMMasterProps> = ({ rawMaterials, parts, customers, onAdd, onEdit, onDelete }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCustFilter, setSelectedCustFilter] = useState('All');

  const [formData, setFormData] = useState({
    size: '',
    length: 6000,
    weightPer1000: 0,
    customerName: '',
    partId: '',
    partIds: [] as string[],
  });

  const handleOpenAdd = () => {
    setEditingId(null);
    const initialCustomer = customers[0]?.name || '';
    const initialPartId = parts[0]?.id || '';
    setFormData({
      size: '',
      length: 6000,
      weightPer1000: 0,
      customerName: initialCustomer,
      partId: initialPartId,
      partIds: initialPartId ? [initialPartId] : [],
    });
    setShowModal(true);
  };

  const handleOpenEdit = (e: React.MouseEvent, rm: RawMaterial) => {
    e.stopPropagation();
    setEditingId(rm.id);
    setFormData({
      size: rm.size,
      length: rm.length,
      weightPer1000: rm.weightPer1000,
      customerName: rm.customerName,
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

    const submitData = {
      ...formData,
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

  const customerParts = parts.filter(p => 
    !formData.customerName || 
    p.mappedCustomers?.some(c => c.toUpperCase().trim() === formData.customerName.toUpperCase().trim()) ||
    (p.schedules && Object.keys(p.schedules).some(k => k.toUpperCase().trim() === formData.customerName.toUpperCase().trim()))
  );
  const displayedParts = customerParts.length > 0 ? customerParts : parts;

  const filteredRMs = rawMaterials.filter(rm => {
    const matchesSearch = rm.size.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          rm.partName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCustomer = selectedCustFilter === 'All' || rm.customerName.toUpperCase().trim() === selectedCustFilter.toUpperCase().trim();
    return matchesSearch && matchesCustomer;
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
                  <div className="text-[10px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5">RM SIZE</div>
                  <div className="font-black text-slate-900 text-base uppercase">{rm.size}</div>
                </td>
                <td className="px-8 py-6">
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500 font-medium">Standard Length: <span className="font-bold text-slate-800">{rm.length} mm</span></div>
                    <div className="text-xs text-slate-500 font-medium">Weight Factor: <span className="font-bold text-slate-800">{rm.weightPer1000} Kg / 1000 mm</span></div>
                  </div>
                </td>
                <td className="px-8 py-6">
                  <div className="space-y-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded text-[9px] font-black uppercase">Customer</span>
                      <span className="font-bold text-slate-800 text-xs">{rm.customerName}</span>
                    </div>
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
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">RM Size Description</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. Round Bar 45mm dia" 
                    className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900" 
                    value={formData.size} 
                    onChange={(e) => setFormData({...formData, size: e.target.value})} 
                  />
                </div>
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
                <div className="grid grid-cols-2 gap-4 text-left">
                  <div className="text-left col-span-2 sm:col-span-1">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Map to Customer</label>
                    <select 
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900"
                      value={formData.customerName}
                      onChange={(e) => {
                        const nextCust = e.target.value;
                        // Pre-populate with first item of this customer to make UX smooth
                        const filtered = parts.filter(p => p.mappedCustomers?.some(c => c.toUpperCase().trim() === nextCust.toUpperCase().trim()) || (p.schedules && Object.keys(p.schedules).some(k => k.toUpperCase().trim() === nextCust.toUpperCase().trim())));
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
                  
                  <div className="col-span-2 text-left pt-2">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">
                      Map to Finished Goods Items (Select one or more)
                    </label>
                    <div className="border-2 border-slate-100 rounded-2xl p-4 max-h-48 overflow-y-auto space-y-1 bg-slate-50">
                      {displayedParts.map(p => {
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
