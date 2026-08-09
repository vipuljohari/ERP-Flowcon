import React, { useMemo, useState } from 'react';
import { InwardLog, Part, RawMaterial } from '../types';
import * as XLSX from 'xlsx';

interface InwardLogsProps {
  logs: InwardLog[];
  parts: Part[];
  auditDate?: Date;
  isAdmin?: boolean;
  onDeleteLog?: (id: string) => void;
  rawMaterials?: RawMaterial[];
  localRMOpeningBalances?: Record<string, string>;
}

const InwardLogs: React.FC<InwardLogsProps> = ({ 
  logs, 
  parts, 
  auditDate = new Date(), 
  isAdmin = false, 
  onDeleteLog,
  rawMaterials = [],
  localRMOpeningBalances = {}
}) => {
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>({});
  const [selectedSize, setSelectedSize] = useState<string>('All');

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

  const uniqueRmNames = useMemo(() => {
    const sizes = parts.map(p => p.size);
    return Array.from(new Set(sizes)).sort();
  }, [parts]);

  const isAuditLog = (log: InwardLog) => {
    return (
      log.supplier === 'ADMIN_AUDIT' ||
      Boolean(log.remarks?.startsWith('[OPENING_BALANCE_SET:')) ||
      Boolean(log.remarks?.startsWith('[RM_OPENING_BALANCE_SET:')) ||
      log.remarks === '[OPENING_BALANCE_ADJUSTMENT]' ||
      Boolean(log.remarks?.toLowerCase().includes('opening_balance')) ||
      Boolean(log.remarks?.toLowerCase().includes('opening balance'))
    );
  };

  const formatAuditRemarks = (log: InwardLog) => {
    const isAudit = isAuditLog(log);
    if (!isAudit) return log.remarks || 'Standard Inward';

    const raw = log.remarks || '';

    if (raw.includes('from Previous')) {
      return raw.replace(/\[(RM_)?OPENING_BALANCE_SET:[^\]]+\]\s*/g, '').trim();
    }

    const tagWithPrevMatch = raw.match(/\[(RM_)?OPENING_BALANCE_SET:([\d.-]+)\|PREV:([\d.-]+)\]/);
    if (tagWithPrevMatch) {
      const isRM = Boolean(tagWithPrevMatch[1]);
      const newVal = tagWithPrevMatch[2];
      const prevVal = tagWithPrevMatch[3];
      const unit = isRM ? 'Pipes' : 'Pcs';
      const label = isRM ? 'RM Opening Balance' : 'Item Opening Balance';
      const delta = log.quantity;
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
      const context = raw.replace(/\[(RM_)?OPENING_BALANCE_SET:[^\]]+\]\s*/g, '').trim();

      return `${label} set to ${newVal} ${unit} from Previous ${prevVal} ${unit} (${deltaStr} ${unit})${context ? ` - ${context}` : ''}`;
    }

    const tagMatch = raw.match(/\[(RM_)?OPENING_BALANCE_SET:([\d.-]+)\]/);
    if (tagMatch) {
      const isRM = Boolean(tagMatch[1]) || raw.includes('Pipes') || raw.includes('RM');
      const newValNum = parseFloat(tagMatch[2]);
      if (!isNaN(newValNum)) {
        const delta = log.quantity;
        const prevValNum = newValNum - delta;
        const unit = isRM ? 'Pipes' : 'Pcs';
        const label = isRM ? 'RM Opening Balance' : 'Item Opening Balance';
        const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
        
        let context = raw.replace(/\[(RM_)?OPENING_BALANCE_SET:[^\]]+\]\s*/g, '').trim();
        if (context.toLowerCase().includes('opening balance set to')) {
          context = context.replace(/RM Opening Balance set to [\d.-]+ Pipes/i, '')
                           .replace(/Item Opening Balance set to [\d.-]+ Pcs/i, '')
                           .trim();
        }

        return `${label} set to ${newValNum} ${unit} from Previous ${prevValNum} ${unit} (${deltaStr} ${unit})${context ? ` ${context}` : ''}`;
      }
    }

    return raw.replace(/\[(RM_)?OPENING_BALANCE_SET:[^\]]+\]\s*/g, '').trim() || 'Opening Inventory Correction';
  };

  const allLogsWithAudits = useMemo(() => {
    const combined = [...logs];
    if (localRMOpeningBalances && Object.keys(localRMOpeningBalances).length > 0) {
      Object.entries(localRMOpeningBalances).forEach(([key, valStr]) => {
        if (!valStr) return;
        const val = parseFloat(valStr);
        if (isNaN(val)) return;

        let mK = `${auditDate.getFullYear()}-${String(auditDate.getMonth() + 1).padStart(2, '0')}`;
        let rmId = key;
        if (key.includes('_')) {
          const partsArr = key.split('_');
          if (partsArr.length >= 2) {
            mK = partsArr[0];
            rmId = partsArr.slice(1).join('_');
          }
        }

        const rm = rawMaterials.find(r => r.id === rmId);
        const part = parts.find(p => p.id === rm?.partId || (rm?.customerName && p.customerRMMappings?.[rm.customerName] === rm.id));

        const alreadyExists = logs.some(
          l => (l.remarks?.includes(`[RM_OPENING_BALANCE_SET:${val}]`) || l.remarks?.includes(`[OPENING_BALANCE_SET:${val}]`)) &&
               (l.partId === part?.id || l.partId === rm?.partId)
        );

        if (!alreadyExists) {
          const dateStr = `${mK}-01T00:00:00.000Z`;
          combined.push({
            id: `audit_local_rm_${key}`,
            partId: part?.id || rm?.partId || 'audit_rm',
            partName: rm ? `${rm.customerName} - ${rm.size}` : (part?.name || 'Opening Balance Override'),
            sapCode: part?.sapCode || 'RM-AUDIT',
            quantity: val,
            supplier: 'ADMIN_AUDIT',
            timestamp: dateStr,
            remarks: `[RM_OPENING_BALANCE_SET:${val}|PREV:0] RM Opening Balance set to ${val} Pipes from Previous 0 Pipes (+${val} Pipes) for ${rm?.customerName || 'Customer'} (${rm?.size || 'RM'}) [${mK}]`
          });
        }
      });
    }
    return combined;
  }, [logs, localRMOpeningBalances, rawMaterials, parts, auditDate]);

  const filteredLogs = useMemo(() => {
    const start = new Date(startDate);
    start.setHours(0,0,0,0);
    const end = new Date(endDate);
    end.setHours(23,59,59,999);

    return allLogsWithAudits.filter(log => {
      const d = new Date(log.timestamp);
      const matchesDate = d >= start && d <= end;
      const isAudit = isAuditLog(log);

      if (selectedSize === 'Opening inventory correction') {
        return matchesDate && isAudit;
      }

      if (isAudit) return false;

      if (selectedSize === 'Discrepancy Control Entry') {
        return matchesDate && log.quantity < 0;
      }

      if (selectedSize !== 'All') {
        const part = parts.find(p => p.id === log.partId);
        return matchesDate && part?.size === selectedSize;
      }

      return matchesDate;
    });
  }, [allLogsWithAudits, parts, startDate, endDate, selectedSize]);

  const groupedLogs = useMemo(() => {
    const groups: Record<string, InwardLog[]> = {};
    filteredLogs.forEach(log => {
      const dateKey = new Date(log.timestamp).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey] = [...groups[dateKey], log];
    });
    
    return Object.entries(groups).sort((a, b) => {
      return new Date(b[1][0].timestamp).getTime() - new Date(a[1][0].timestamp).getTime();
    });
  }, [filteredLogs]);

  const totalRangeInward = useMemo(() => {
    return filteredLogs.reduce((acc, l) => acc + l.quantity, 0);
  }, [filteredLogs]);

  const toggleDate = (date: string) => {
    setExpandedDates(prev => ({ ...prev, [date]: !prev[date] }));
  };

  const formatDateDisplay = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${d}-${m}-${y}`;
  };

  const exportToExcel = () => {
    if (filteredLogs.length === 0) return;
    const worksheetData = filteredLogs.map(log => {
      const date = new Date(log.timestamp);
      const part = parts.find(p => p.id === log.partId);
      const rm = rawMaterials.find(r => r.partId === log.partId || r.id === log.partId);
      const isAudit = isAuditLog(log);

      return {
        'Date': date.toLocaleDateString('en-GB'),
        'Time': date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        'Customer Name': part?.mappedCustomers?.join(', ') || rm?.customerName || 'N/A',
        'Invoice / Ref No.': log.invoiceNumber || (isAudit ? 'ADMIN_AUDIT' : '-'),
        'SAP Code': log.sapCode,
        'Part / Material Description': log.partName,
        'RM Size/Specifications': part?.size || rm?.size || 'N/A',
        'Supplier/Authorized By': log.supplier,
        'Quantity / Adjustment (Pcs/Pipes)': log.quantity,
        'Remarks / Audit Record': formatAuditRemarks(log)
      };
    });
    const worksheet = XLSX.utils.json_to_sheet(worksheetData);
    const workbook = XLSX.utils.book_new();

    const sheetName = 
      selectedSize === 'Discrepancy Control Entry' ? 'Discrepancy Control' :
      selectedSize === 'Opening inventory correction' ? 'Opening Corrections' :
      'Inward Logs';

    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    worksheet['!cols'] = [
      { wch: 12 },
      { wch: 12 },
      { wch: 25 },
      { wch: 20 },
      { wch: 15 },
      { wch: 30 },
      { wch: 25 },
      { wch: 20 },
      { wch: 18 },
      { wch: 55 }
    ];

    const specName = 
      selectedSize === 'Discrepancy Control Entry' ? 'Discrepancy_Control_Entry' :
      selectedSize === 'Opening inventory correction' ? 'Opening_Inventory_Correction' :
      selectedSize.replace(/[/\\?%*:|"<>]/g, '-');

    XLSX.writeFile(workbook, `RM_Ledger_Report_${specName}_${startDate}_to_${endDate}.xlsx`);
  };

  const handleDelete = (id: string) => {
    if (window.confirm("Admin Alert: Are you sure you want to delete this log? Plant balance will be adjusted.")) {
      onDeleteLog?.(id);
    }
  };

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col gap-6 text-left">
        <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-6 text-left">
          <div>
            <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2 text-left">RM Ledger Report</h2>
            <p className="text-slate-500 font-medium leading-none text-left">Register of inward deliveries and stock adjustments</p>
          </div>
        </div>
        
        <div className={`p-8 rounded-[2.5rem] shadow-sm border flex flex-col xl:flex-row gap-8 items-stretch xl:items-end transition-all ${isAdmin ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-100'}`}>
          <div className="flex-1 space-y-3 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 text-left">RM Size/Specifications</label>
            <select 
              className="px-6 py-4 bg-white border-2 border-slate-100 rounded-2xl focus:border-emerald-500 outline-none w-full transition-all shadow-inner font-bold text-slate-800"
              value={selectedSize}
              onChange={(e) => setSelectedSize(e.target.value)}
            >
              <option value="All">All Specifications</option>
              <option value="Discrepancy Control Entry">⚠️ Discrepancy Control Entry (Negative Values)</option>
              <option value="Opening inventory correction">⚙️ Opening inventory correction</option>
              {uniqueRmNames.map(size => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>

          <div className="flex-[1.5] space-y-3 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 text-left">Receipt Period Range</label>
            <div className="flex flex-col sm:flex-row items-center gap-4 bg-white/50 border-2 border-slate-100 rounded-2xl p-3 shadow-inner">
              <div className="relative flex-1 w-full bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between hover:border-emerald-500 transition-colors group">
                <div className="flex flex-col text-left">
                  <span className="text-[9px] font-black text-slate-400 uppercase text-left">From</span>
                  <span className="text-sm font-black text-slate-800 text-left">{formatDateDisplay(startDate)}</span>
                </div>
                <div className="relative">
                  <input type="date" className="absolute inset-0 opacity-0 cursor-pointer w-full" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-all">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </div>
                </div>
              </div>

              <div className="text-slate-300 hidden sm:block">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
              </div>

              <div className="relative flex-1 w-full bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between hover:border-emerald-500 transition-colors group">
                <div className="flex flex-col text-left">
                  <span className="text-[9px] font-black text-slate-400 uppercase text-left">To</span>
                  <span className="text-sm font-black text-slate-800 text-left">{formatDateDisplay(endDate)}</span>
                </div>
                <div className="relative">
                  <input type="date" className="absolute inset-0 opacity-0 cursor-pointer w-full" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                  <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-all">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4 min-w-[180px]">
            <button onClick={exportToExcel} disabled={filteredLogs.length === 0} className="flex-1 bg-emerald-600 text-white px-8 py-4 h-[72px] rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-emerald-700 transition-all flex items-center justify-center gap-3 shadow-xl shadow-emerald-100 active:scale-95 disabled:opacity-50 disabled:grayscale">
              <span>Download Excel</span>
              <span className="text-2xl leading-none">📊</span>
            </button>
          </div>
        </div>
      </header>

      <div className={`rounded-[2.5rem] p-8 text-white flex items-center justify-between shadow-2xl transition-all ${
        isAdmin 
          ? 'bg-amber-600 shadow-amber-100' 
          : (selectedSize === 'Discrepancy Control Entry' 
              ? 'bg-rose-600 shadow-rose-100' 
              : (selectedSize === 'Opening inventory correction' 
                  ? 'bg-indigo-600 shadow-indigo-100' 
                  : 'bg-emerald-600 shadow-emerald-100'))
      }`}>
         <div className="flex items-center gap-6 text-left">
            <div className="w-16 h-16 bg-white/20 rounded-3xl flex items-center justify-center text-3xl shadow-inner backdrop-blur-sm">
              {selectedSize === 'Discrepancy Control Entry' ? '⚠️' : (selectedSize === 'Opening inventory correction' ? '⚙️' : '📦')}
            </div>
            <div className="text-left">
              <p className="text-[10px] font-black uppercase tracking-widest opacity-60 mb-1 text-left">
                {selectedSize === 'Discrepancy Control Entry' 
                  ? 'Discrepancy Control Total (Negative Values)' 
                  : (selectedSize === 'Opening inventory correction' 
                      ? 'Opening Inventory Corrections (Admin Audit Log)' 
                      : 'Net Period Change (Inward - Adj)')}
              </p>
              <h4 className="text-3xl font-black tracking-tighter leading-none text-left">{totalRangeInward.toLocaleString()} Pcs</h4>
            </div>
         </div>
         {selectedSize === 'Discrepancy Control Entry' && (
           <span className="bg-white/20 px-5 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest backdrop-blur-sm">
             {filteredLogs.length} Negative {filteredLogs.length === 1 ? 'Entry' : 'Entries'}
           </span>
         )}
         {selectedSize === 'Opening inventory correction' && (
           <span className="bg-white/20 px-5 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest backdrop-blur-sm">
             {filteredLogs.length} Correction {filteredLogs.length === 1 ? 'Record' : 'Records'}
           </span>
         )}
      </div>

      <div className="space-y-4 pb-12 text-left">
        {groupedLogs.map(([date, dailyLogs]) => (
          <div key={date} className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden text-left">
            <button onClick={() => toggleDate(date)} className={`w-full flex items-center justify-between p-8 text-left transition-colors ${expandedDates[date] ? 'bg-emerald-50/30' : 'hover:bg-slate-50'}`}>
              <div className="flex items-center gap-12 text-left">
                <div className="flex flex-col items-center text-center">
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Entries</span>
                    <span className="text-2xl font-black text-emerald-600 leading-none">{dailyLogs.length}</span>
                </div>
                <div className="flex flex-col border-l border-slate-100 pl-12 text-left">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 text-left">Receipt Date</span>
                  <span className="text-lg font-black text-slate-900 uppercase tracking-tight leading-none text-left">{date}</span>
                </div>
              </div>
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 ${expandedDates[date] ? 'rotate-180 bg-emerald-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400'}`}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M19 9l-7 7-7-7"></path></svg>
              </div>
            </button>

            {expandedDates[date] && (
              <div className="border-t border-slate-100 bg-white text-left">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
                      <tr>
                        <th className="px-10 py-6 text-left border-r border-slate-200/40">Part & Size/Specifications</th>
                        <th className="px-10 py-6 text-center border-r border-slate-200/40">Customer Name</th>
                        <th className="px-10 py-6 text-center border-r border-slate-200/40">Invoice No.</th>
                        <th className="px-10 py-6 text-center border-r border-slate-200/40">Responsible</th>
                        <th className="px-10 py-6 text-center border-r border-slate-200/40">Qty</th>
                        <th className="px-10 py-6 text-center border-r border-slate-200/40">Type / Remark</th>
                        <th className="px-10 py-6 text-center">Time</th>
                        {isAdmin && <th className="px-10 py-6 text-center">Admin</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {dailyLogs.map(log => {
                        const isAdj = log.quantity < 0;
                        const isAudit = isAuditLog(log);
                        const part = parts.find(p => p.id === log.partId);
                        const rm = rawMaterials.find(r => r.partId === log.partId || r.id === log.partId);

                        return (
                          <tr key={log.id} className={`${isAudit ? 'bg-amber-50/50 hover:bg-amber-100/50 border-l-4 border-l-amber-500' : (isAdj ? 'bg-rose-50/30' : 'hover:bg-emerald-50/10')} transition-colors group`}>
                            <td className="px-10 py-6 text-left border-r border-slate-200/40">
                              <div className="text-[10px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5 text-left">{log.sapCode}</div>
                              <div className="text-sm font-black text-slate-800 uppercase text-left">{log.partName}</div>
                              <div className="text-[9px] text-indigo-500 font-bold uppercase mt-1 text-left">{part?.size || rm?.size || 'N/A'}</div>
                            </td>
                            <td className="px-10 py-6 text-center border-r border-slate-200/40">
                              <span className="text-xs font-black text-slate-700 uppercase">
                                {part?.mappedCustomers?.join(', ') || rm?.customerName || 'N/A'}
                              </span>
                            </td>
                            <td className="px-10 py-6 text-center border-r border-slate-200/40">
                              <span className="text-xs font-mono font-bold text-indigo-600">
                                {log.invoiceNumber || (isAudit ? 'ADMIN_AUDIT' : '-')}
                              </span>
                            </td>
                            <td className="px-10 py-6 text-center border-r border-slate-200/40">
                              <span className={`inline-block px-4 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest border ${
                                isAudit ? 'bg-amber-100 text-amber-800 border-amber-300' : (isAdj ? 'bg-rose-100 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-100')
                              }`}>
                                {log.supplier}
                              </span>
                            </td>
                            <td className="px-10 py-6 text-center border-r border-slate-200/40">
                              <span className={`font-black text-base ${isAudit ? 'text-amber-700' : (isAdj ? 'text-rose-600' : 'text-emerald-600')}`}>
                                {log.quantity > 0 ? `+${log.quantity}` : log.quantity}
                              </span>
                            </td>
                            <td className="px-10 py-6 text-center border-r border-slate-200/40 max-w-[300px]">
                              {isAudit ? (
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] font-black text-amber-800 uppercase tracking-widest mb-1 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded">⚙️ Opening Audit Record</span>
                                  <span className="text-[11px] font-bold text-slate-800 leading-snug text-center mt-0.5">{formatAuditRemarks(log)}</span>
                                </div>
                              ) : isAdj ? (
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] font-black text-rose-500 uppercase tracking-widest mb-1">Adjustment</span>
                                  <span className="text-[10px] font-bold text-slate-500 line-clamp-2 italic leading-tight">"{log.remarks}"</span>
                                </div>
                              ) : (
                                <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest italic">Standard Inward</span>
                              )}
                            </td>
                            <td className="px-10 py-6 text-center border-r border-slate-200/40">
                              <div className="text-xs font-black text-slate-600 font-mono">{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                            </td>
                            {isAdmin && (
                              <td className="px-10 py-6 text-center">
                                <button onClick={() => handleDelete(log.id)} className="w-10 h-10 bg-rose-50 text-rose-600 rounded-xl hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center">
                                  🗑️
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
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

export default InwardLogs;