import React, { useState, useMemo } from 'react';
import { Part, Customer } from '../types';

interface ScheduleManagerProps {
  parts: Part[];
  onUpdateSchedule: (partId: string, newSchedule: number, customer: string) => void;
  readOnly?: boolean;
  activeCustomer: string;
  onCustomerChange: (customer: string) => void;
  customers: Customer[];
  isHistorical?: boolean;
  selectedMonthDisplay?: string;
}

const getCustomerSchedule = (p: Part, customerName: string) => {
  if (!p.schedules) return 0;
  const key = Object.keys(p.schedules).find(k => k.toUpperCase().trim() === customerName.toUpperCase().trim());
  return key ? p.schedules[key] || 0 : 0;
};

const ScheduleManager: React.FC<ScheduleManagerProps> = ({ 
  parts, 
  onUpdateSchedule, 
  readOnly = false, 
  activeCustomer, 
  onCustomerChange, 
  customers,
  isHistorical = false,
  selectedMonthDisplay = ''
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [newTarget, setNewTarget] = useState<number>(0);
  const [showEditModal, setShowEditModal] = useState(false);

  // Filter parts mapped to the current customer
  const mappedParts = useMemo(() => parts.filter(p => p.mappedCustomers?.some(c => c.toUpperCase().trim() === activeCustomer.toUpperCase().trim())), [parts, activeCustomer]);

  // Logic to detect if a new month setup is required (only for LIVE month)
  const isSetupRequired = useMemo(() => {
    if (isHistorical || mappedParts.length === 0) return false;
    const totalSchedule = mappedParts.reduce((acc, p) => acc + (getCustomerSchedule(p, activeCustomer) || 0), 0);
    return totalSchedule === 0;
  }, [mappedParts, activeCustomer, isHistorical]);

  const filteredParts = mappedParts.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    p.sapCode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleUpdateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || isHistorical) return;
    if (selectedPart && newTarget >= 0) {
      onUpdateSchedule(selectedPart.id, newTarget, activeCustomer);
      setShowEditModal(false);
      setSelectedPart(null);
    }
  };

  const effectiveReadOnly = readOnly || isHistorical;

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col md:flex-row md:justify-between md:items-end gap-6 text-left">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight text-left">Monthly Schedule</h2>
          <p className="text-slate-500 font-medium text-left">
            {isHistorical ? `Historical Snapshots for ${selectedMonthDisplay}` : 'Manage base and revised delivery commitments'}
          </p>
        </div>
        <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-end">
          <div className="flex flex-col gap-1.5 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 text-left">Target Customer</label>
            <select 
              className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm font-black bg-white text-slate-700 shadow-sm min-w-[180px]"
              value={activeCustomer}
              onChange={(e) => onCustomerChange(e.target.value)}
            >
              {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <input 
            type="text" 
            placeholder="Search Part/SAP..." 
            className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-600 outline-none w-full md:w-64 bg-white text-slate-900 font-medium shadow-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </header>

      {isSetupRequired && (
        <div className="bg-indigo-600 text-white p-8 rounded-[2.5rem] shadow-2xl flex flex-col md:flex-row items-center justify-between gap-6 animate-in slide-in-from-top-4 duration-500">
          <div className="flex items-center gap-6 text-left">
            <div className="w-16 h-16 bg-white/20 rounded-3xl flex items-center justify-center text-3xl shadow-inner backdrop-blur-md">📅</div>
            <div className="text-left">
              <h4 className="font-black uppercase tracking-widest text-sm text-left">New Month Detected</h4>
              <p className="text-xs font-bold text-indigo-100 text-left">Delivery schedules have been reset to zero. Please enter the new monthly commitments for <span className="underline decoration-white/30">{activeCustomer}</span> below.</p>
            </div>
          </div>
          <div className="bg-white/10 px-6 py-3 rounded-2xl border border-white/20">
            <span className="text-[10px] font-black uppercase tracking-widest opacity-80">Cycle: {new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
          </div>
        </div>
      )}

      {isHistorical && (
        <div className="bg-slate-900 text-white p-8 rounded-[2.5rem] shadow-2xl flex flex-col md:flex-row items-center justify-between gap-6 animate-in slide-in-from-top-4 duration-500">
          <div className="flex items-center gap-6 text-left">
            <div className="w-16 h-16 bg-white/10 rounded-3xl flex items-center justify-center text-3xl shadow-inner border border-white/10">📜</div>
            <div className="text-left">
              <h4 className="font-black uppercase tracking-widest text-sm text-left">Historical Archive View</h4>
              <p className="text-xs font-bold text-slate-400 text-left">You are viewing locked targets for <span className="text-white">{selectedMonthDisplay}</span>. Historical data remains intact for auditing purposes.</p>
            </div>
          </div>
          <div className="bg-rose-500/20 px-6 py-3 rounded-2xl border border-rose-500/30">
            <span className="text-[10px] font-black uppercase tracking-widest text-rose-300">Read-Only Archive</span>
          </div>
        </div>
      )}

      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden text-left">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
            <tr>
              <th className="px-8 py-6 border-r border-slate-200/40">Part Description</th>
              <th className="px-8 py-6 text-center border-r border-slate-200/40">Target Customer</th>
              <th className="px-8 py-6 text-center border-r border-slate-200/40">Monthly Target</th>
              <th className="px-8 py-6 text-center border-r border-slate-200/40">Revision Level</th>
              {!effectiveReadOnly && <th className="px-8 py-6 text-center">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredParts.map(p => {
              const currentSchedule = getCustomerSchedule(p, activeCustomer);
              return (
                <tr key={p.id} className="hover:bg-indigo-50/20 transition-all group">
                  <td className="px-8 py-6">
                    <div className="text-[9px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5">{p.sapCode}</div>
                    <div className="font-bold text-slate-800 text-sm leading-tight group-hover:text-indigo-600 transition-colors uppercase">{p.name}</div>
                    <div className="text-[9px] text-indigo-500 font-black mt-1.5 uppercase tracking-tighter bg-indigo-50 px-2 py-0.5 rounded inline-block">{p.category}</div>
                  </td>
                  <td className="px-8 py-6 text-center text-slate-500 font-black text-[10px] uppercase tracking-widest">
                    {activeCustomer}
                  </td>
                  <td className="px-8 py-6 text-center">
                    <span className={`font-black text-lg ${currentSchedule === 0 ? 'text-slate-300' : (isHistorical ? 'text-slate-600' : 'text-slate-900')}`}>
                      {currentSchedule}
                    </span>
                  </td>
                  <td className="px-8 py-6 text-center">
                    {p.revisionCount === 0 ? (
                      <span className="text-[10px] bg-slate-100 text-slate-500 px-3 py-1 rounded-full font-black uppercase tracking-tighter">Original</span>
                    ) : (
                      <span className="text-[10px] bg-amber-50 text-amber-700 px-3 py-1 rounded-full font-black uppercase tracking-tighter">Revision {p.revisionCount}</span>
                    )}
                  </td>
                  {!effectiveReadOnly && (
                    <td className="px-8 py-6 text-center">
                      <button 
                        onClick={() => {
                          setSelectedPart(p);
                          setNewTarget(currentSchedule);
                          setShowEditModal(true);
                        }}
                        className={`text-[10px] px-5 py-2.5 rounded-xl font-black uppercase tracking-widest transition-all shadow-md active:scale-95 ${currentSchedule === 0 ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-slate-900 text-white hover:bg-black'}`}
                      >
                        {currentSchedule === 0 ? 'Set Target' : 'Revise'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {filteredParts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-8 py-20 text-center text-slate-400 font-black uppercase tracking-widest opacity-50">
                  No items mapped to this customer.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showEditModal && selectedPart && !effectiveReadOnly && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-10 border border-white/20 animate-in zoom-in-95 duration-200 text-left">
            <h3 className="text-2xl font-black text-slate-900 mb-2 leading-none text-left">Schedule Revision</h3>
            <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-2 text-left">Customer: {activeCustomer}</p>
            <p className="text-sm text-slate-500 mb-8 font-medium text-left">Updating commit for: <span className="text-indigo-600 font-black">{selectedPart.name}</span></p>
            
            <form onSubmit={handleUpdateSubmit} className="space-y-6 text-left">
              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">New Monthly Commitment</label>
                <div className="relative">
                  <input 
                    autoFocus
                    type="number" 
                    required
                    className="w-full px-6 py-5 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 focus:bg-white outline-none font-black text-slate-900 text-3xl transition-all shadow-inner"
                    value={newTarget}
                    onChange={(e) => setNewTarget(parseInt(e.target.value) || 0)}
                  />
                  <div className="absolute right-6 top-1/2 -translate-y-1/2 text-slate-300 font-black text-xs uppercase tracking-widest">Units</div>
                </div>
              </div>

              <div className="flex gap-4 pt-2 text-left">
                <button type="button" onClick={() => setShowEditModal(false)} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest hover:bg-slate-50 transition-all">Discard</button>
                <button type="submit" className="flex-1 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl shadow-indigo-100 transition-all active:scale-95">Post Revision</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScheduleManager;