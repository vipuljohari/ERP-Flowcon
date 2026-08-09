
import React, { useState, useMemo } from 'react';
import { Part, Sale, Customer } from '../types';
import * as XLSX from 'xlsx';

// Fix: Made onAddSale optional as it's currently unused within the component
interface SalesLogProps {
  parts: Part[];
  sales: Sale[];
  onAddSale?: (sale: Sale) => void;
  readOnly?: boolean;
  activeCustomer: string;
  onCustomerChange: (customer: string) => void;
  auditDate?: Date;
  isAdmin?: boolean;
  onDeleteSale?: (id: string) => void;
  customers: Customer[];
}

const SalesLog: React.FC<SalesLogProps> = ({ 
  parts, 
  sales, 
  onAddSale, 
  readOnly = false, 
  activeCustomer, 
  onCustomerChange,
  auditDate = new Date(),
  isAdmin = false,
  onDeleteSale,
  customers
}) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState('');
  const [selectedFilterPartId, setSelectedFilterPartId] = useState('All');
  const [quantity, setQuantity] = useState(1);
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>({});

  const toLocalISO = (date: Date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const defaultStart = useMemo(() => {
    const d = new Date(auditDate);
    return toLocalISO(new Date(d.getFullYear(), d.getMonth(), 1));
  }, [auditDate]);
  
  const defaultEnd = useMemo(() => {
    return toLocalISO(auditDate);
  }, [auditDate]);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);

  React.useEffect(() => {
    setStartDate(defaultStart);
    setEndDate(defaultEnd);
  }, [defaultStart, defaultEnd]);

  const filteredSalesData = useMemo(() => {
    const start = new Date(startDate);
    start.setHours(0,0,0,0);
    const end = new Date(endDate);
    end.setHours(23,59,59,999);

    return sales.filter(s => {
      const matchesCustomer = s.customer && activeCustomer && s.customer.toUpperCase().trim() === activeCustomer.toUpperCase().trim();
      const matchesPart = selectedFilterPartId === 'All' || s.partId === selectedFilterPartId;
      const d = new Date(s.timestamp);
      const matchesDate = d >= start && d <= end;
      return matchesCustomer && matchesPart && matchesDate;
    });
  }, [sales, activeCustomer, selectedFilterPartId, startDate, endDate]);

  const groupedSales = useMemo(() => {
    const groups: Record<string, Sale[]> = {};
    filteredSalesData.forEach(sale => {
      const dateKey = new Date(sale.timestamp).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey] = [...groups[dateKey], sale];
    });
    
    return Object.entries(groups).sort((a, b) => {
      return new Date(b[1][0].timestamp).getTime() - new Date(a[1][0].timestamp).getTime();
    });
  }, [filteredSalesData]);

  const totalRangeVolume = useMemo(() => {
    return filteredSalesData.reduce((acc, s) => acc + s.quantity, 0);
  }, [filteredSalesData]);

  const toggleDate = (date: string) => {
    setExpandedDates(prev => ({ ...prev, [date]: !prev[date] }));
  };

  const formatDateDisplay = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${d}-${m}-${y}`;
  };

  const exportToExcel = () => {
    if (filteredSalesData.length === 0) return;
    const worksheetData = filteredSalesData.map(sale => {
      const date = new Date(sale.timestamp);
      const part = parts.find(p => p.id === sale.partId || p.sapCode === sale.sapCode);
      const sizeSpec = part?.size || '';
      return {
        'Date': date.toLocaleDateString('en-GB'),
        'Time': date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        'Consignee': sale.customer,
        'Invoice Number': sale.invoiceNumber || '-',
        'SAP Code': sale.sapCode,
        'Size/Specifications': sizeSpec,
        'Part Description': sale.partName,
        'Quantity (Pcs)': sale.quantity,
        'Total Value (INR)': sale.totalPrice.toFixed(2)
      };
    });
    const worksheet = XLSX.utils.json_to_sheet(worksheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Dispatch Logs');
    worksheet['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 15 }, { wch: 20 }, { wch: 30 }, { wch: 15 }, { wch: 18 }];
    XLSX.writeFile(workbook, `Dispatch_Report_${activeCustomer}_${startDate}_to_${endDate}.xlsx`);
  };

  const handleDelete = (id: string) => {
    if (window.confirm("Admin Alert: Are you sure you want to delete this dispatch entry? Units will be added back to plant balance.")) {
      onDeleteSale?.(id);
    }
  };

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col gap-6">
        <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-6">
          <div>
            <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2">Dispatch Report</h2>
            <p className="text-slate-500 font-medium leading-none">Detailed audit trail for consignee operations</p>
          </div>
          <div className="flex flex-col items-stretch md:items-end gap-2 text-right">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Consignee Filter</label>
            <select className="px-6 py-3 bg-white border border-slate-200 rounded-2xl font-black text-slate-800 shadow-sm outline-none w-full md:w-64" value={activeCustomer} onChange={(e) => onCustomerChange(e.target.value)}>
              {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <div className={`p-8 rounded-[2.5rem] shadow-sm border flex flex-col xl:flex-row gap-8 items-stretch xl:items-end transition-all ${isAdmin ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-100'}`}>
          <div className="flex-1 space-y-3 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Audit Item Filter</label>
            <select className="px-6 py-4 bg-white border-2 border-slate-100 rounded-2xl font-black text-slate-800 focus:border-indigo-500 outline-none w-full transition-all shadow-inner" value={selectedFilterPartId} onChange={(e) => setSelectedFilterPartId(e.target.value)}>
              <option value="All">All 16 Specialized Parts</option>
              {parts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div className="flex-[1.5] space-y-3 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Audit Period Range</label>
            <div className="flex flex-col sm:flex-row items-center gap-4 bg-white/50 border-2 border-slate-100 rounded-2xl p-3 shadow-inner">
              <div className="relative flex-1 w-full bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between hover:border-indigo-500 transition-colors group">
                <div className="flex flex-col">
                  <span className="text-[9px] font-black text-slate-400 uppercase">From</span>
                  <span className="text-sm font-black text-slate-800">{formatDateDisplay(startDate)}</span>
                </div>
                <div className="relative">
                  <input type="date" className="absolute inset-0 opacity-0 cursor-pointer w-full" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-all">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </div>
                </div>
              </div>
              <div className="relative flex-1 w-full bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between hover:border-indigo-500 transition-colors group">
                <div className="flex flex-col">
                  <span className="text-[9px] font-black text-slate-400 uppercase">To</span>
                  <span className="text-sm font-black text-slate-800">{formatDateDisplay(endDate)}</span>
                </div>
                <div className="relative">
                  <input type="date" className="absolute inset-0 opacity-0 cursor-pointer w-full" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                  <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-all">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4 min-w-[180px]">
            <button onClick={exportToExcel} disabled={filteredSalesData.length === 0} className="flex-1 bg-emerald-600 text-white px-6 py-4 h-[72px] rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-emerald-700 transition-all flex items-center justify-center gap-3 shadow-xl active:scale-95 disabled:opacity-50">
              <span>Download Excel</span>
              <span className="text-2xl leading-none">📊</span>
            </button>
          </div>
        </div>

        <div className={`rounded-[2rem] p-8 text-white flex flex-col md:flex-row items-center justify-between shadow-2xl transition-all ${isAdmin ? 'bg-amber-600 shadow-amber-100' : 'bg-indigo-600 shadow-indigo-100'}`}>
           <div className="flex items-center gap-6 text-left">
              <div className="w-16 h-16 bg-white/20 rounded-3xl flex items-center justify-center text-3xl shadow-inner backdrop-blur-sm">📊</div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest opacity-60 mb-1">Total Period volume for audit</p>
                <h4 className="text-3xl font-black tracking-tighter leading-none">{totalRangeVolume.toLocaleString()} Units</h4>
              </div>
           </div>
        </div>
      </header>

      <div className="space-y-4 pb-12">
        {groupedSales.map(([date, dailySales]) => (
          <div key={date} className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
            <button onClick={() => toggleDate(date)} className={`w-full flex items-center justify-between p-8 text-left transition-colors ${expandedDates[date] ? 'bg-indigo-50/30' : 'hover:bg-slate-50'}`}>
              <div className="flex items-center gap-12 text-left">
                <div className="flex flex-col items-center">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Items</span>
                  <span className="text-2xl font-black text-indigo-600 leading-none">{dailySales.length}</span>
                </div>
                <div className="flex flex-col border-l border-slate-100 pl-12">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Audit Point</span>
                  <span className="text-lg font-black text-slate-900 uppercase tracking-tight leading-none">{date}</span>
                </div>
              </div>
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 ${expandedDates[date] ? 'rotate-180 bg-indigo-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400'}`}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M19 9l-7 7-7-7"></path></svg>
              </div>
            </button>

            {expandedDates[date] && (
              <div className="border-t border-slate-100 bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
                      <tr>
                        <th className="px-10 py-6 border-r border-slate-200/40">Part Identity</th>
                        <th className="px-10 py-6 text-center border-r border-slate-200/40">Qty</th>
                        <th className="px-10 py-6 text-center border-r border-slate-200/40">Price (₹)</th>
                        {isAdmin && <th className="px-10 py-6 text-center">Admin</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {dailySales.map(sale => (
                        <tr key={sale.id} className="hover:bg-indigo-50/10 transition-colors group">
                          <td className="px-10 py-6">
                            <div className="text-[10px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5">{sale.sapCode}</div>
                            <div className="text-sm font-black text-slate-800 uppercase">{sale.partName}</div>
                          </td>
                          <td className="px-10 py-6 text-center">
                            <span className="font-black text-indigo-600 text-base">{sale.quantity}</span>
                          </td>
                          <td className="px-10 py-6 text-center">
                            <div className="font-black text-slate-800 text-sm">₹{sale.totalPrice.toLocaleString()}</div>
                          </td>
                          {isAdmin && (
                            <td className="px-10 py-6 text-center">
                              <button onClick={() => handleDelete(sale.id)} className="w-10 h-10 bg-rose-50 text-rose-600 rounded-xl hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center">
                                🗑️
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default SalesLog;
