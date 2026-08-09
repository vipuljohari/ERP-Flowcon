import React, { useState } from 'react';
import { Part, Customer, RawMaterial } from '../types';
import { CATEGORIES } from '../constants';

interface ItemMasterProps {
  parts: Part[];
  onAdd: (partData: Partial<Part>) => void;
  onEdit: (id: string, partData: Partial<Part>) => void;
  onDelete: (id: string) => void;
  customers: Customer[];
  rawMaterials: RawMaterial[];
}

const ItemMaster: React.FC<ItemMasterProps> = ({ parts, onAdd, onEdit, onDelete, customers, rawMaterials }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  
  const [formData, setFormData] = useState({
    name: '',
    sapCode: '',
    sku: '',
    category: CATEGORIES[0],
    rate: 0,
    customerRates: {} as Record<string, number>,
    size: '',
    minThreshold: 100,
    mappedCustomers: [] as string[],
    itemWeight: 0,
    itemLength: 0,
    customerRMMappings: {} as Record<string, string>,
    hasCustomScrap: false,
    customScrapMm: 0
  });

  const handleOpenAdd = () => {
    setEditingId(null);
    setFormData({
      name: '', sapCode: '', sku: '', category: CATEGORIES[0],
      rate: 0, customerRates: {}, size: '', minThreshold: 100, mappedCustomers: [],
      itemWeight: 0, itemLength: 0, customerRMMappings: {},
      hasCustomScrap: false, customScrapMm: 0
    });
    setShowModal(true);
  };

  const handleOpenEdit = (e: React.MouseEvent, p: Part) => {
    e.stopPropagation();
    setEditingId(p.id);
    setFormData({
      name: p.name, sapCode: p.sapCode, sku: p.sku, category: p.category,
      rate: p.rate, customerRates: p.customerRates || {}, size: p.size, minThreshold: p.minThreshold, mappedCustomers: p.mappedCustomers || [],
      itemWeight: p.itemWeight || 0, itemLength: p.itemLength || 0,
      customerRMMappings: p.customerRMMappings || {},
      hasCustomScrap: p.hasCustomScrap || false,
      customScrapMm: p.customScrapMm || 0
    });
    setShowModal(true);
  };

  const toggleCustomerMapping = (customerName: string) => {
    setFormData(prev => {
      const isMapped = prev.mappedCustomers.includes(customerName);
      const nextMapped = isMapped 
        ? prev.mappedCustomers.filter(c => c !== customerName) 
        : [...prev.mappedCustomers, customerName];
      
      const nextRates = { ...prev.customerRates };
      const nextMappings = { ...(prev.customerRMMappings || {}) };
      
      if (!isMapped && nextRates[customerName] === undefined) {
        nextRates[customerName] = prev.rate || 0;
      }
      if (isMapped) {
        delete nextMappings[customerName];
      }
      
      return { ...prev, mappedCustomers: nextMapped, customerRates: nextRates, customerRMMappings: nextMappings };
    });
  };

  const handleCustomerRateChange = (customerName: string, value: string) => {
    const num = parseFloat(value) || 0;
    setFormData(prev => ({
      ...prev,
      customerRates: { ...prev.customerRates, [customerName]: num }
    }));
  };

  const handleCustomerRMChange = (customerName: string, rmId: string) => {
    setFormData(prev => ({
      ...prev,
      customerRMMappings: {
        ...(prev.customerRMMappings || {}),
        [customerName]: rmId
      }
    }));
  };

  const syncAllRatesToBase = () => {
    const nextRates = { ...formData.customerRates };
    formData.mappedCustomers.forEach(c => {
      nextRates[c] = formData.rate;
    });
    setFormData(prev => ({ ...prev, customerRates: nextRates }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId) onEdit(editingId, formData);
    else onAdd(formData);
    setShowModal(false);
  };

  const handleDeletePart = (e: React.MouseEvent, p: Part) => {
    e.stopPropagation();
    if(window.confirm(`Delete part "${p.name}"? This will remove all associated logs and schedules.`)) {
      onDelete(p.id);
    }
  };

  const filteredParts = parts.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    p.sapCode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col md:flex-row justify-between items-end gap-6">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2 text-left">Item Master</h2>
          <p className="text-slate-500 font-medium text-left">Define technical specifications and customer-specific commercial rates</p>
        </div>
        <div className="flex gap-4">
          <input 
            type="text" placeholder="Search items..." 
            className="px-6 py-4 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none font-bold text-slate-700 bg-white w-64 shadow-sm"
            value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
          />
          <button 
            onClick={handleOpenAdd}
            className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95"
          >
            Create New Item +
          </button>
        </div>
      </header>

      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
            <tr>
              <th className="px-8 py-6 border-r border-slate-200/40">Item Identity</th>
              <th className="px-8 py-6 border-r border-slate-200/40">Size/Specifications</th>
              <th className="px-8 py-6 border-r border-slate-200/40">Commercial Rates</th>
              <th className="px-8 py-6 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredParts.map(p => (
              <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-8 py-6">
                  <div className="text-[10px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5">{p.sapCode}</div>
                  <div className="font-black text-slate-900 text-base uppercase">{p.name}</div>
                </td>
                <td className="px-8 py-6">
                  <div className="flex flex-col gap-1 items-start">
                    <span className="bg-slate-100 text-slate-600 px-3 py-1 rounded-md text-[10px] font-black uppercase tracking-tight border border-slate-200">{p.size}</span>
                    {(p.itemWeight !== undefined && p.itemWeight > 0) && (
                      <div className="text-[10px] text-slate-500 font-medium">Weight: <span className="font-bold text-slate-700">{p.itemWeight} Kg</span></div>
                    )}
                    {(p.itemLength !== undefined && p.itemLength > 0) && (
                      <div className="text-[10px] text-slate-500 font-medium">Length: <span className="font-bold text-slate-700">{p.itemLength} mm</span></div>
                    )}
                    {p.itemLength !== undefined && p.itemLength > 0 && (
                      <div className="text-[10px] text-slate-500 font-medium">
                        End Scrap: {p.hasCustomScrap ? (
                          <span className="font-black text-amber-600 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded text-[9px] uppercase">Custom: {p.customScrapMm} mm</span>
                        ) : (
                          <span className="font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1 py-0.5 rounded text-[9px] uppercase">Remainder %</span>
                        )}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-8 py-6">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-black text-slate-400 uppercase w-16">Base:</span>
                      <span className="font-black text-slate-900 text-sm">₹{p.rate.toFixed(2)}</span>
                    </div>
                    {p.mappedCustomers?.map(cn => {
                      const rmId = p.customerRMMappings?.[cn];
                      const linkedRM = rmId ? rawMaterials.find(rm => rm.id === rmId) : null;
                      return (
                        <div key={cn} className="border-l-2 border-indigo-100 pl-2 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] font-black text-indigo-400 uppercase tracking-wider" title={cn}>
                              {cn.split(' ')[0]}:
                            </span>
                            <span className="font-black text-indigo-600 text-sm">
                              ₹{(p.customerRates?.[cn] ?? p.rate).toFixed(2)}
                            </span>
                          </div>
                          {linkedRM && (
                            <div className="text-[9px] text-amber-600 font-extrabold uppercase bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200/50 inline-block">
                              RM: {linkedRM.size}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {(!p.mappedCustomers || p.mappedCustomers.length === 0) && (
                      <span className="text-[9px] font-black text-rose-400 uppercase tracking-widest italic">No Mappings</span>
                    )}
                  </div>
                </td>
                <td className="px-8 py-6 text-center">
                  <div className="flex justify-center gap-3">
                    <button onClick={(e) => handleOpenEdit(e, p)} className="w-10 h-10 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-100 transition-all flex items-center justify-center shadow-sm">✏️</button>
                    <button onClick={(e) => handleDeletePart(e, p)} className="w-10 h-10 bg-rose-50 text-rose-600 rounded-xl hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center shadow-sm">🗑️</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-10 border border-white/20 animate-in zoom-in-95 overflow-y-auto max-h-[90vh]">
            <h3 className="text-2xl font-black text-slate-900 mb-8 leading-none text-left">
              {editingId ? 'Update Master Record' : 'Define New Part'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-8 text-left">
              <div className="grid grid-cols-2 gap-6 text-left">
                <div className="col-span-2 text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Part Description</label>
                  <input type="text" required className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900" value={formData.name} onChange={(e) => setFormData({...formData, name: e.target.value})} />
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">SAP Code</label>
                  <input type="text" required className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900" value={formData.sapCode} onChange={(e) => setFormData({...formData, sapCode: e.target.value})} />
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">SKU / Drawing No.</label>
                  <input type="text" className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900" value={formData.sku} onChange={(e) => setFormData({...formData, sku: e.target.value})} />
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Category</label>
                  <select className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900" value={formData.category} onChange={(e) => setFormData({...formData, category: e.target.value})}>
                    {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Size/Specifications</label>
                  <input type="text" required placeholder="e.g. 60x40x4" className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900" value={formData.size} onChange={(e) => setFormData({...formData, size: e.target.value})} />
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Base Rate (₹)</label>
                  <input type="number" step="0.01" required className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900" value={formData.rate} onChange={(e) => setFormData({...formData, rate: parseFloat(e.target.value) || 0})} />
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Min Stock Threshold</label>
                  <input type="number" required className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900" value={formData.minThreshold} onChange={(e) => setFormData({...formData, minThreshold: parseInt(e.target.value) || 0})} />
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Item Weight (Kg)</label>
                  <input type="number" step="0.001" placeholder="Weight in Kg..." className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900" value={formData.itemWeight || ''} onChange={(e) => setFormData({...formData, itemWeight: parseFloat(e.target.value) || 0})} />
                </div>
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Item Length (mm)</label>
                  <input type="number" step="1" placeholder="Length in mm..." className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900" value={formData.itemLength || ''} onChange={(e) => setFormData({...formData, itemLength: parseInt(e.target.value) || 0})} />
                </div>
                <div className="col-span-2 flex flex-col md:flex-row gap-6 items-start md:items-center bg-amber-50/40 border border-amber-200/50 p-5 rounded-[1.5rem] mt-1">
                  <label className="flex items-center gap-3 cursor-pointer flex-1">
                    <input 
                      type="checkbox" 
                      className="w-5 h-5 rounded text-amber-600 focus:ring-amber-500 border-amber-300 cursor-pointer" 
                      checked={formData.hasCustomScrap || false} 
                      onChange={(e) => setFormData({...formData, hasCustomScrap: e.target.checked})} 
                    />
                    <div className="text-left">
                      <span className="block text-xs font-black text-slate-800">Specify Custom End-Piece Scrap</span>
                      <span className="block text-[10px] text-slate-500 font-medium">Check to override automatic length-remainder calculations with a constant scrap value per raw pipe</span>
                    </div>
                  </label>
                  {formData.hasCustomScrap && (
                    <div className="w-full md:w-56 text-left">
                      <label className="block text-[9px] font-black text-amber-700 uppercase tracking-widest mb-1.5">End-Piece Scrap (mm)</label>
                      <input 
                        type="number" 
                        required 
                        min="0" 
                        placeholder="e.g. 50" 
                        className="w-full px-4 py-3 bg-white border-2 border-amber-250 rounded-xl focus:border-amber-500 focus:ring-1 focus:ring-amber-500 outline-none font-black text-slate-900" 
                        value={formData.customScrapMm || ''} 
                        onChange={(e) => setFormData({...formData, customScrapMm: parseInt(e.target.value) || 0})} 
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="text-left">
                <div className="flex justify-between items-center mb-4 text-left">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest text-left">Map to Consignees, Define Rates & RMs</label>
                  {formData.mappedCustomers.length > 0 && (
                    <button type="button" onClick={syncAllRatesToBase} className="text-[9px] font-black text-indigo-600 uppercase tracking-widest hover:underline">Apply Base Rate to All</button>
                  )}
                </div>
                <div className="space-y-4 bg-slate-50 p-6 rounded-[2rem] border border-slate-100 text-left">
                  {customers.map(c => {
                    const isSelected = formData.mappedCustomers.includes(c.name);
                    const customerRMs = rawMaterials.filter(rm => rm.customerName === c.name);
                    const selectedRMId = formData.customerRMMappings?.[c.name] || '';

                    return (
                      <div key={c.id} className="bg-white p-5 rounded-2xl border border-slate-200/60 flex flex-col gap-3 shadow-sm text-left">
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 text-left">
                          <label className="flex items-center gap-3 cursor-pointer flex-1">
                            <input type="checkbox" className="w-5 h-5 rounded border-slate-300 text-indigo-600" checked={isSelected} onChange={() => toggleCustomerMapping(c.name)} />
                            <span className={`text-[11px] font-black uppercase tracking-tight ${isSelected ? 'text-indigo-600' : 'text-slate-400'}`}>{c.name}</span>
                          </label>
                          {isSelected && (
                            <div className="flex items-center gap-2">
                               <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Rate (₹)</span>
                               <input 
                                 type="number" 
                                 step="0.01"
                                 className="w-28 px-4 py-2 bg-white border border-indigo-200 rounded-xl font-black text-slate-900 text-sm focus:border-indigo-600 outline-none"
                                 value={formData.customerRates[c.name] ?? formData.rate}
                                 onChange={(e) => handleCustomerRateChange(c.name, e.target.value)}
                               />
                            </div>
                          )}
                        </div>

                        {isSelected && (
                          <div className="border-t border-slate-100/80 pt-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 text-left">
                            <span className="text-[10px] font-black text-amber-500 uppercase tracking-widest w-24">Link RM Spec:</span>
                            <select
                              className="flex-1 px-4 py-2.5 bg-amber-50/40 border-2 border-amber-100 rounded-xl font-bold text-slate-900 text-xs focus:border-amber-500 outline-none"
                              value={selectedRMId}
                              onChange={(e) => handleCustomerRMChange(c.name, e.target.value)}
                            >
                              <option value="">-- No Raw Material (Manual updates only) --</option>
                              {customerRMs.map(rm => (
                                <option key={rm.id} value={rm.id}>
                                  {rm.size} (Len: {rm.length}mm, {rm.weightPer1000} Kg/1000mm)
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {customers.length === 0 && <p className="text-[10px] text-slate-400 uppercase text-center py-4">No customers defined in Master</p>}
                </div>
              </div>

              <div className="flex gap-4 text-left">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest">Cancel</button>
                <button type="submit" className="flex-[2] py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl">Save Master Record</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ItemMaster;