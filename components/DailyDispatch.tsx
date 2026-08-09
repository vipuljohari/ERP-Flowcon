
import React, { useState, useRef, useMemo } from 'react';
import { Part, Customer, Sale, InwardLog } from '../types';
import { TallyService, TallyImportResult, TallyMatchedItem } from '../services/tally';

const getLocalISOString = (date: Date = new Date()): string => {
  const pad = (num: number) => String(num).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}.${ms}`;
};

interface DailyDispatchProps {
  parts: Part[];
  sales: Sale[];
  allSales?: Sale[];
  inwardLogs: InwardLog[];
  onBulkDispatch: (items: { partId: string, quantity: number }[], customer: string, timestamp?: string, invoiceNo?: string) => void;
  readOnly?: boolean;
  isHistorical?: boolean;
  selectedDate: Date; // Added missing prop to handle timestamps correctly
  selectedDateDisplay?: string;
  activeCustomer: string;
  onCustomerChange: (customer: string) => void;
  customers: Customer[];
}

interface DispatchEntry {
  selected: boolean;
  qtyString: string; 
}

const DailyDispatch: React.FC<DailyDispatchProps> = ({ 
  parts, 
  sales,
  allSales,
  inwardLogs,
  onBulkDispatch, 
  readOnly = false, 
  isHistorical = false,
  selectedDate,
  selectedDateDisplay = '',
  activeCustomer, 
  onCustomerChange,
  customers
}) => {
  const [dispatchData, setDispatchData] = useState<Record<string, DispatchEntry>>(() => {
    const initial: Record<string, DispatchEntry> = {};
    parts.forEach(p => {
      initial[p.id] = { selected: false, qtyString: '' };
    });
    return initial;
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showSuccessOverlay, setShowSuccessOverlay] = useState(false);
  const [importSummary, setImportSummary] = useState<{ count: number, customers: string[], date?: string } | null>(null);
  const [manualInvoiceNumber, setManualInvoiceNumber] = useState('');
  
  const mappedParts = useMemo(() => parts.filter(p => p.mappedCustomers?.some(c => c.toUpperCase().trim() === activeCustomer.toUpperCase().trim())), [parts, activeCustomer]);

  const [showTallyModal, setShowTallyModal] = useState(false);
  const [tallyImportResult, setTallyImportResult] = useState<TallyImportResult | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [modalDate, setModalDate] = useState<string>('');
  const [modalInvoice, setModalInvoice] = useState<string>('');
  const [modalCustomer, setModalCustomer] = useState<string>('');
  const [isPreviousMonthBlocked, setIsPreviousMonthBlocked] = useState(false);

  const isDateInPreviousMonth = (dateStr: string): boolean => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth(); // 0-11
    
    const dYear = d.getFullYear();
    const dMonth = d.getMonth(); // 0-11
    
    return (dYear < currentYear) || (dYear === currentYear && dMonth < currentMonth);
  };

  const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  const calculateOpeningBalance = (p: Part) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    const monthLogs = inwardLogs.filter(l => 
      l.partId === p.id && 
      new Date(l.timestamp) >= startOfMonth
    );
    const adjustmentEntry = monthLogs.find(l => l.remarks && l.remarks.startsWith("[OPENING_BALANCE_SET:"));
    
    if (adjustmentEntry) {
      const match = adjustmentEntry.remarks?.match(/\[OPENING_BALANCE_SET:(\d+)\]/);
      if (match) return parseInt(match[1]);
    }

    const receiptsThisMonth = monthLogs
      .filter(l => 
        !l.remarks?.startsWith("[OPENING_BALANCE_SET:") &&
        l.remarks !== "[OPENING_BALANCE_ADJUSTMENT]"
      )
      .reduce((sum, l) => sum + l.quantity, 0);
    const salesThisMonth = sales
      .filter(s => s.partId === p.id && new Date(s.timestamp) >= startOfMonth)
      .reduce((sum, s) => sum + s.quantity, 0);
    return Math.round(p.stock - receiptsThisMonth + salesThisMonth);
  };

  const isDuplicateInvoice = useMemo(() => {
    if (!modalInvoice.trim()) return false;
    const searchSales = allSales || sales;
    return searchSales.some(s => s.invoiceNumber === modalInvoice.trim());
  }, [modalInvoice, sales, allSales]);

  const isManualDuplicateInvoice = useMemo(() => {
    if (!manualInvoiceNumber.trim()) return false;
    const searchSales = allSales || sales;
    return searchSales.some(s => s.invoiceNumber === manualInvoiceNumber.trim());
  }, [manualInvoiceNumber, sales, allSales]);

  const handleToggleSelect = (id: string) => {
    if (readOnly) return;
    setDispatchData(prev => {
      const entry = prev[id];
      if (!entry) return prev;
      return { ...prev, [id]: { ...entry, selected: !entry.selected } };
    });
  };

  const handleQtyChange = (id: string, value: string) => {
    if (readOnly) return;
    if (value !== '' && !/^\d+$/.test(value)) return;
    setDispatchData(prev => {
      const entry = prev[id];
      if (!entry) return prev;
      return { ...prev, [id]: { ...entry, qtyString: value, selected: value !== '' && parseInt(value) > 0 ? true : entry.selected } };
    });
  };

  const getValidDispatchItems = (): (Part & { dispatchQty: number })[] => {
    return parts.filter(p => {
      const entry = dispatchData[p.id] as DispatchEntry | undefined;
      if (!entry) return false;
      return entry.selected && (parseInt(entry.qtyString) || 0) > 0;
    }).map(p => {
      const entry = dispatchData[p.id] as DispatchEntry;
      return { ...p, dispatchQty: parseInt(entry.qtyString || '0') || 0 };
    });
  };

  const handlePreSubmit = () => {
    if (readOnly) return;
    const items = getValidDispatchItems();
    if (items.length === 0) return;
    
    const shortages = items.filter(item => item.dispatchQty > item.stock);
    if (shortages.length > 0) {
      const confirmPost = window.confirm(
        `STOCK ALERT: Some items exceed current plant balance. Posting will result in a negative inventory. \n\nContinue with master record posting?`
      );
      if (!confirmPost) return;
    }

    setManualInvoiceNumber(''); 
    setShowConfirmModal(true);
  };

  const handleFinalConfirm = async () => {
    if (readOnly) return;
    if (!manualInvoiceNumber.trim()) {
      alert("Invoice Number is mandatory.");
      return;
    }
    if (isManualDuplicateInvoice) {
      alert("This Invoice Number already exists in the system.");
      return;
    }

    const items = getValidDispatchItems();
    setIsSubmitting(true);
    
    // CRITICAL FIX: Use selectedDate to determine the timestamp.
    // If selectedDate is not "Today", we must use the selectedDate timestamp so it appears in historical logs.
    const finalTimestamp = isHistorical ? getLocalISOString(selectedDate) : getLocalISOString(new Date());

    try {
      onBulkDispatch(
        items.map(i => ({ partId: i.id, quantity: i.dispatchQty })), 
        activeCustomer, 
        finalTimestamp, 
        manualInvoiceNumber.trim()
      );

      setDispatchData(prev => {
        const reset = { ...prev };
        parts.forEach(p => { if (reset[p.id]) reset[p.id] = { selected: false, qtyString: '' }; });
        return reset;
      });
      setShowConfirmModal(false);
      setTallyImportResult(null);
      setManualInvoiceNumber('');
      
      setImportSummary({ count: items.length, customers: [activeCustomer] });
      setShowSuccessOverlay(true);
      setTimeout(() => setShowSuccessOverlay(false), 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTallyFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsing(true);
    const fileName = file.name.toLowerCase();
    
    try {
      if (fileName.endsWith('.xml')) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          const xmlString = event.target?.result as string;
          const result = await TallyService.parseTallyXml(xmlString, parts, customers, activeCustomer);
          setTallyImportResult(result);
          
          const parsedDate = result.detectedDate ? new Date(result.detectedDate) : (isHistorical ? selectedDate : new Date());
          const dateStr = getLocalISOString(parsedDate).split('T')[0];
          setModalDate(dateStr);
          setModalInvoice(result.detectedInvoice || '');
          setModalCustomer(result.detectedConsignee || activeCustomer);
          
          setIsPreviousMonthBlocked(isDateInPreviousMonth(dateStr));
          setIsParsing(false);
        };
        reader.readAsText(file);
      } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          const buffer = event.target?.result as ArrayBuffer;
          const result = await TallyService.parseTallyExcel(buffer, parts, customers, activeCustomer);
          setTallyImportResult(result);
          
          const parsedDate = result.detectedDate ? new Date(result.detectedDate) : (isHistorical ? selectedDate : new Date());
          const dateStr = getLocalISOString(parsedDate).split('T')[0];
          setModalDate(dateStr);
          setModalInvoice(result.detectedInvoice || '');
          setModalCustomer(result.detectedConsignee || activeCustomer);
          
          setIsPreviousMonthBlocked(isDateInPreviousMonth(dateStr));
          setIsParsing(false);
        };
        reader.readAsArrayBuffer(file);
      } else {
        alert("Unsupported file format. Please use .xml or .xlsx");
        setIsParsing(false);
      }
    } catch (error) {
      console.error("Tally Parse Error:", error);
      alert("Error reading file. Please check the format.");
      setIsParsing(false);
    }
  };

  const applyTallyImport = () => {
    if (!tallyImportResult) return;
    if (isDuplicateInvoice) {
      alert("System Block: This invoice number has already been imported.");
      return;
    }
    if (isPreviousMonthBlocked) {
      alert("System Block: Uploading invoices of a previous month is strictly blocked.");
      return;
    }

    const finalTimestamp = modalDate ? `${modalDate}T12:00:00.000` : (isHistorical ? getLocalISOString(selectedDate) : getLocalISOString(new Date()));
    const finalInvoice = modalInvoice.trim() || undefined;
    const finalCustomer = modalCustomer || activeCustomer;

    const dispatchesByCustomer: Record<string, { partId: string, quantity: number }[]> = {};
    const detectedCustomersSet = new Set<string>();

    tallyImportResult.matchedItems.forEach(item => {
      // Route all matched items to the selected modal customer
      const targetCust = finalCustomer;
      if (!dispatchesByCustomer[targetCust]) {
        dispatchesByCustomer[targetCust] = [];
      }
      dispatchesByCustomer[targetCust].push({
        partId: item.partId,
        quantity: item.quantity
      });
      detectedCustomersSet.add(targetCust);
    });

    Object.entries(dispatchesByCustomer).forEach(([customer, items]) => {
      onBulkDispatch(items, customer, finalTimestamp, finalInvoice);
    });
    
    setDispatchData(prev => {
      const reset = { ...prev };
      parts.forEach(p => { if (reset[p.id]) reset[p.id] = { selected: false, qtyString: '' }; });
      return reset;
    });
    
    setImportSummary({ 
      count: tallyImportResult.matchedItems.length, 
      customers: Array.from(detectedCustomersSet),
      date: finalTimestamp ? new Date(finalTimestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : undefined
    });

    setShowTallyModal(false);
    setTallyImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    
    setShowSuccessOverlay(true);
    setTimeout(() => setShowSuccessOverlay(false), 3000);
  };

  const groupedTallyItems = useMemo<Record<string, TallyMatchedItem[]>>(() => {
    if (!tallyImportResult) return {};
    const groups: Record<string, TallyMatchedItem[]> = {};
    tallyImportResult.matchedItems.forEach(item => {
      const targetCustomer = modalCustomer || item.customer;
      if (!groups[targetCustomer]) groups[targetCustomer] = [];
      groups[targetCustomer].push(item);
    });
    return groups;
  }, [tallyImportResult, modalCustomer]);

  const hasOpeningBalanceViolations = useMemo(() => {
    if (!tallyImportResult) return false;
    return tallyImportResult.matchedItems.some(item => {
      const part = parts.find(p => p.id === item.partId);
      if (!part) return false;
      const opening = calculateOpeningBalance(part);
      return item.quantity > opening;
    });
  }, [tallyImportResult, parts, inwardLogs, sales]);

  return (
    <div className={`space-y-8 transition-opacity duration-300 relative text-left`}>
      {showSuccessOverlay && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[200] animate-in slide-in-from-top-4 duration-500">
          <div className="bg-emerald-600 text-white px-8 py-4 rounded-3xl shadow-2xl flex items-center gap-4 border border-emerald-400/30 backdrop-blur-md">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center text-xl">✅</div>
            <div className="text-left">
              <p className="text-[10px] font-black uppercase tracking-widest opacity-80 text-left">Sync Successful</p>
              <p className="text-sm font-black text-left">
                Logged {importSummary?.count} items to {importSummary?.customers.join(', ')} 
                {importSummary?.date && ` for ${importSummary.date}`}
              </p>
            </div>
          </div>
        </div>
      )}

      <header className="flex flex-col md:flex-row md:justify-between md:items-end gap-6 text-left">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2 text-left">Dispatch Slip</h2>
          <div className="flex items-center gap-3 text-left">
             <p className={`${isHistorical ? 'text-amber-600 animate-pulse' : 'text-indigo-600'} font-black text-sm uppercase tracking-widest text-left`}>
                {isHistorical ? `Back-Dating to: ${selectedDateDisplay}` : `Operational Date: ${todayStr}`}
             </p>
             <div className="h-4 w-[1px] bg-slate-200"></div>
             <button 
               onClick={() => setShowTallyModal(true)}
               className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-[#008c45] hover:text-[#005e2e] transition-colors"
             >
               <span className="w-5 h-5 bg-[#008c45] text-white rounded-md flex items-center justify-center text-[10px]">T</span>
               Import from Tally (XML/Excel)
             </button>
          </div>
        </div>
        <div className="flex flex-col md:items-end gap-2 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 text-left">CUSTOMER</label>
            <select 
              className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-600 outline-none w-full md:w-80 font-black text-slate-700 bg-white shadow-sm"
              value={activeCustomer}
              onChange={(e) => onCustomerChange(e.target.value)}
            >
              {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
        </div>
      </header>

      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden text-left">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
            <tr>
              <th className="px-8 py-6 w-12 text-center border-r border-slate-200/40">Select</th>
              <th className="px-8 py-6 text-left border-r border-slate-200/40">Part Description</th>
              <th className="px-8 py-6 text-center border-r border-slate-200/40">RM Size/Specifications</th>
              <th className="px-8 py-6 text-center border-r border-slate-200/40">Available Stock</th>
              <th className="px-8 py-6 text-center">Dispatch Instruction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {mappedParts.map(p => {
              const entry = (dispatchData[p.id] as DispatchEntry) || { selected: false, qtyString: '' };
              const isNegative = p.stock < 0;
              return (
                <tr key={p.id} className={`transition-all cursor-pointer ${entry.selected ? 'bg-indigo-50/40' : 'hover:bg-slate-50'} ${isNegative ? 'bg-rose-50/20' : ''}`} onClick={() => handleToggleSelect(p.id)}>
                  <td className="px-8 py-6 text-center" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="w-5 h-5 rounded-lg border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" checked={entry.selected} onChange={() => handleToggleSelect(p.id)} />
                  </td>
                  <td className="px-8 py-6 text-left">
                    <div className="text-sm text-slate-400 font-mono tracking-tighter uppercase mb-0.5 text-left">{p.sapCode}</div>
                    <div className="font-bold text-slate-800 text-sm leading-tight uppercase text-left">{p.name}</div>
                  </td>
                  <td className="px-8 py-6 text-center">
                    <span className="text-[9px] text-indigo-600 font-black bg-indigo-50 px-2 py-0.5 rounded uppercase tracking-tighter">{p.size}</span>
                  </td>
                  <td className="px-8 py-6 text-center">
                    <div className={`px-5 py-2.5 rounded-full inline-block transition-all shadow-sm ${isNegative ? 'bg-rose-600 text-white animate-pulse' : 'bg-slate-50 border border-slate-100'}`}>
                      <span className={`font-black text-lg ${!isNegative && p.stock <= p.minThreshold ? 'text-rose-600' : isNegative ? 'text-white' : 'text-slate-800'}`}>
                        {Math.round(p.stock)}
                      </span>
                    </div>
                  </td>
                  <td className="px-8 py-6 text-center" onClick={(e) => e.stopPropagation()}>
                    <input type="text" inputMode="numeric" pattern="[0-9]*" placeholder="0" className={`w-32 px-4 py-3 border-2 rounded-2xl focus:outline-none transition-all font-black text-xl text-center text-slate-900 ${entry.selected ? (isHistorical ? 'border-amber-500 bg-white ring-8 ring-amber-50' : 'border-indigo-500 bg-white ring-8 ring-indigo-50') : 'border-slate-100 bg-slate-50'}`} value={entry.qtyString} onChange={(e) => handleQtyChange(p.id, e.target.value)} />
                  </td>
                </tr>
              );
            })}
            {mappedParts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-8 py-20 text-center text-slate-400 font-black uppercase tracking-widest opacity-50">
                  No items mapped to this customer. Check Item Master.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sticky bottom-6 bg-slate-900 text-white p-6 rounded-[2.5rem] shadow-2xl flex items-center justify-between mx-4 animate-in slide-in-from-bottom duration-500 text-left">
        <div className="flex items-center gap-6 pl-4 text-left">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black text-2xl shadow-xl transition-colors ${isHistorical ? 'bg-amber-500 shadow-amber-500/40' : 'bg-indigo-600 shadow-indigo-500/20'}`}>
              {Object.values(dispatchData).filter((d: DispatchEntry) => d.selected && (parseInt(d.qtyString) || 0) > 0).length}
            </div>
            <div className="text-left">
                <p className="text-sm font-black uppercase tracking-widest text-left">{isHistorical ? `BACK-DATED DISPATCH: ${selectedDateDisplay}` : 'ITEMS TO DISPATCH'}</p>
                <p className="text-xs text-slate-400 font-bold uppercase tracking-tighter text-left">Target consignee: {activeCustomer}</p>
            </div>
        </div>
        <button 
          onClick={handlePreSubmit} 
          disabled={isSubmitting || Object.values(dispatchData).filter((d: DispatchEntry) => d.selected && (parseInt(d.qtyString) || 0) > 0).length === 0} 
          className={`${isHistorical ? 'bg-amber-600 hover:bg-amber-500 shadow-amber-500/20' : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-500/20'} px-10 py-4 rounded-2xl font-black transition-all uppercase text-xs tracking-widest active:scale-95 disabled:bg-slate-700 disabled:text-slate-500`}
        >
          {isHistorical ? 'POST BACK-DATED SLIP 🚚' : 'POST LIVE DISPATCH 🚚'}
        </button>
      </div>

      {showTallyModal && (
        <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-xl flex items-center justify-center z-[100] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-0 flex flex-col max-h-[90vh] overflow-hidden border border-white/10 animate-in zoom-in-95 text-left">
            <div className="bg-[#008c45] p-8 text-white relative overflow-hidden text-left">
              <div className="absolute top-0 right-0 p-8 opacity-10">
                <div className="text-8xl font-black">T</div>
              </div>
              <h3 className="text-2xl font-black uppercase tracking-tight leading-none text-left">Consignee Intelligence</h3>
              <p className="text-[10px] mt-2 uppercase font-black tracking-widest text-emerald-100 opacity-80 text-left">Audit Check: Opening Balance vs Invoice Qty</p>
            </div>

            <div className="p-10 flex-1 overflow-y-auto space-y-8 text-left custom-scrollbar">
              {!tallyImportResult ? (
                <div className="space-y-6 text-left">
                  <div className={`bg-slate-50 border-2 border-dashed border-slate-200 rounded-[2rem] p-12 text-center group hover:border-[#008c45] transition-all cursor-pointer ${isParsing ? 'opacity-50 pointer-events-none' : ''} text-center`} onClick={() => fileInputRef.current?.click()}>
                    <input type="file" ref={fileInputRef} className="hidden" accept=".xml,.xlsx,.xls" onChange={handleTallyFileUpload} />
                    <div className={`w-20 h-20 bg-emerald-50 text-[#008c45] rounded-3xl flex items-center justify-center text-4xl mx-auto mb-6 group-hover:scale-110 transition-transform ${isParsing ? 'animate-pulse' : ''}`}>
                      {isParsing ? '⏳' : '📊'}
                    </div>
                    <h4 className="text-lg font-black text-slate-900 mb-2 text-center">{isParsing ? 'Scanning Report...' : 'Upload Tally Report'}</h4>
                    <p className="text-sm text-slate-500 font-medium max-w-xs mx-auto text-center">Dispatches will be routed based on Cell A11 (Consignee) and G4 (Invoice No).</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-8 text-left">
                  {/* Locked metadata before apply as per Consignee Intelligence */}
                  <div className="bg-slate-50 border border-slate-200/60 p-6 rounded-3xl space-y-4 text-left">
                    <h4 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-1 text-left flex items-center gap-2">
                      <span>🔒 Locked Invoice Details</span>
                      <span className="text-[9px] text-[#008c45] bg-emerald-100/80 px-2 py-0.5 rounded font-black tracking-normal">Consignee Intelligence</span>
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
                      <div>
                        <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5 ml-1 text-left flex items-center gap-1">
                          Consignee 🔒
                        </label>
                        <select 
                          value={modalCustomer} 
                          onChange={(e) => setModalCustomer(e.target.value)}
                          disabled={true}
                          className="w-full px-4 py-3 bg-slate-100 border border-slate-200 rounded-xl font-bold text-slate-400 text-xs cursor-not-allowed outline-none select-none"
                        >
                          {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5 ml-1 text-left flex items-center gap-1">
                          Invoice Date 🔒
                        </label>
                        <input 
                          type="date" 
                          value={modalDate} 
                          onChange={(e) => setModalDate(e.target.value)}
                          disabled={true}
                          className="w-full px-4 py-3 bg-slate-100 border border-slate-200 rounded-xl font-bold text-slate-400 text-xs cursor-not-allowed outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5 ml-1 text-left flex items-center gap-1">
                          Invoice Number 🔒
                        </label>
                        <input 
                          type="text" 
                          value={modalInvoice} 
                          onChange={(e) => setModalInvoice(e.target.value)}
                          disabled={true}
                          placeholder="e.g. 1245"
                          className="w-full px-4 py-3 bg-slate-100 border border-slate-200 rounded-xl font-bold text-slate-400 text-xs cursor-not-allowed outline-none"
                        />
                      </div>
                    </div>
                    {isDuplicateInvoice && (
                      <p className="text-[10px] font-bold text-rose-600 ml-1 mt-1 text-left animate-pulse">
                         🚫 Blocked: Invoice number "{modalInvoice}" already exists in the database. Please enter a different invoice number.
                      </p>
                    )}
                  </div>

                  {isPreviousMonthBlocked && (
                    <div className="bg-rose-600 text-white p-5 rounded-3xl shadow-xl flex items-start gap-4 animate-in fade-in slide-in-from-top-4 text-left">
                      <span className="text-2xl mt-0.5">🚫</span>
                      <div className="text-left">
                        <p className="text-xs font-black uppercase tracking-widest text-left">Previous Month Closed & Blocked</p>
                        <p className="text-sm font-bold opacity-90 text-left">
                          This invoice is dated {modalDate ? new Date(modalDate).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : "(Unknown)"}, which belongs to a closed previous month. Uploading invoices of a previous month is strictly blocked.
                        </p>
                      </div>
                    </div>
                  )}

                  {isDuplicateInvoice && (
                    <div className="bg-rose-600 text-white p-5 rounded-3xl shadow-xl flex items-start gap-4 animate-pulse text-left">
                      <span className="text-2xl">⚠️</span>
                      <div className="text-left">
                        <p className="text-xs font-black uppercase tracking-widest text-left">Duplicate Upload Blocked</p>
                        <p className="text-sm font-bold opacity-90 text-left">This invoice has already been posted to the database.</p>
                      </div>
                    </div>
                  )}

                  {hasOpeningBalanceViolations && (
                    <div className="bg-amber-100 border-2 border-amber-400 p-5 rounded-3xl shadow-lg flex items-start gap-4 text-left">
                      <span className="text-2xl">🛡️</span>
                      <div className="text-left">
                        <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 text-left">Audit Discrepancy Alert</p>
                        <p className="text-sm font-black text-amber-900 text-left leading-tight">Some parts have Invoice Quantities exceeding their monthly Opening Balance.</p>
                        <p className="text-[9px] font-bold text-amber-600 mt-1 uppercase tracking-widest text-left">Action: Continue import, but Admin should re-audit and adjust Opening Stock.</p>
                      </div>
                    </div>
                  )}

                  {(Object.entries(groupedTallyItems) as [string, TallyMatchedItem[]][]).map(([customer, items]) => (
                    <div key={customer} className="space-y-3 text-left">
                      <div className="flex items-center gap-2 text-left">
                        <span className="w-2 h-2 bg-indigo-600 rounded-full"></span>
                        <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest text-left">Routing items to: <span className="text-indigo-600">{customer}</span></h5>
                      </div>
                      <div className="border border-slate-100 rounded-3xl overflow-hidden shadow-inner bg-white text-left">
                        <table className="w-full text-left">
                          <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400">
                            <tr>
                              <th className="px-6 py-4 text-left">Part Details</th>
                              <th className="px-6 py-4 text-center">Billed Qty</th>
                              <th className="px-6 py-4 text-center">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {items.map((item, idx) => {
                               const part = parts.find(p => p.id === item.partId);
                               const opening = part ? calculateOpeningBalance(part) : 0;
                               const isViolation = item.quantity > opening;
                               return (
                                <tr key={idx} className={`${isViolation ? 'bg-rose-50' : 'hover:bg-emerald-50/30'} transition-colors`}>
                                  <td className="px-6 py-4 text-left">
                                    <p className="text-sm font-black text-slate-800 uppercase text-left">{item.partName}</p>
                                    <p className="text-[9px] text-slate-400 font-mono italic text-left">Opening RM: {opening}</p>
                                  </td>
                                  <td className="px-6 py-4 text-center font-black text-slate-900">{item.quantity}</td>
                                  <td className="px-6 py-4 text-center">
                                    {isViolation ? (
                                      <span className="text-[8px] font-black text-rose-600 bg-rose-100 px-2 py-1 rounded uppercase tracking-tighter shadow-sm border border-rose-200">Audit Discrepancy</span>
                                    ) : (
                                      <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Linked ✓</span>
                                    )}
                                  </td>
                                </tr>
                               );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-10 border-t border-slate-100 bg-white flex gap-4 text-left">
              <button onClick={() => { setShowTallyModal(false); setTallyImportResult(null); }} className="flex-1 py-5 border-2 border-slate-100 rounded-2xl font-black text-slate-400 uppercase text-[11px] tracking-widest hover:bg-slate-50 transition-all">Cancel</button>
              {tallyImportResult && tallyImportResult.matchedItems.length > 0 && (
                <button 
                  disabled={isDuplicateInvoice || isPreviousMonthBlocked}
                  onClick={applyTallyImport} 
                  className={`flex-[2] py-5 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl transition-all ${
                    isDuplicateInvoice || isPreviousMonthBlocked ? 'bg-slate-300 cursor-not-allowed text-slate-500' : 'bg-[#008c45] shadow-emerald-100 hover:bg-[#007037]'
                  }`}
                >
                  {isPreviousMonthBlocked ? '🔒 Previous Month Blocked' : isDuplicateInvoice ? 'Duplicate Blocked' : 'Post Routed Dispatches'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showConfirmModal && (
        <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-md flex items-center justify-center z-[110] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full flex flex-col max-h-[90vh] border border-white/10 overflow-hidden text-left">
            <div className={`p-8 text-white transition-colors ${isHistorical ? 'bg-amber-600' : 'bg-slate-900'} text-left`}>
              <h3 className="text-2xl font-black uppercase tracking-tight leading-none text-left">
                {isHistorical ? 'Back-Dated Dispatch Confirmation' : 'Dispatch Confirmation'}
              </h3>
            </div>
            
            <div className="p-8 border-b border-slate-100 bg-white">
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">
                Invoice Number <span className="text-rose-500">* (Mandatory)</span>
              </label>
              <input 
                autoFocus
                type="text" 
                placeholder="e.g. INV/2024/001"
                className={`w-full px-6 py-4 border-2 rounded-2xl font-black text-xl outline-none transition-all ${isManualDuplicateInvoice ? 'border-rose-500 bg-rose-50' : 'border-slate-100 focus:border-indigo-600 bg-slate-50 focus:bg-white'}`}
                value={manualInvoiceNumber}
                onChange={(e) => setManualInvoiceNumber(e.target.value)}
              />
              {isManualDuplicateInvoice && (
                <p className="mt-2 text-rose-500 text-[10px] font-black uppercase tracking-widest">🚫 Invoice number already exists</p>
              )}
            </div>

            <div className="p-8 overflow-y-auto bg-slate-50/50 text-left flex-1 custom-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead className="bg-white border-b border-slate-200 text-left">
                  <tr>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-left">Description</th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-center">Units</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white text-left">
                  {getValidDispatchItems().map(item => (
                    <tr key={item.id}>
                      <td className="px-6 py-4 text-left">
                        <div className="text-sm font-black text-slate-800 uppercase text-left">{item.name}</div>
                        <div className="text-xs text-slate-400 font-mono uppercase tracking-tighter text-left">{item.sapCode}</div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`${isHistorical ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'} font-black px-4 py-1.5 rounded-xl text-sm`}>
                          {item.dispatchQty}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            <div className="p-8 bg-white border-t border-slate-100 flex gap-4 text-left">
              <button onClick={() => setShowConfirmModal(false)} className="flex-1 py-5 border-2 border-slate-100 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest hover:bg-slate-50 transition-all">Modify</button>
              <button 
                onClick={handleFinalConfirm} 
                disabled={isSubmitting || !manualInvoiceNumber.trim() || isManualDuplicateInvoice} 
                className={`flex-[2] py-5 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl transition-all ${isHistorical ? 'bg-amber-600 shadow-amber-500/40' : 'bg-indigo-600 shadow-indigo-500/40'} disabled:bg-slate-200 disabled:shadow-none disabled:cursor-not-allowed`}
              >
                Confirm Dispatch Slip
              </button>
            </div>
          </div>
        </div>
      )}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
      `}</style>
    </div>
  );
};

export default DailyDispatch;
