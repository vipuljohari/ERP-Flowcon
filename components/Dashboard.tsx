
import React, { useMemo, useState, useEffect } from 'react';
import { Part, Sale, InventoryStats, Customer, RawMaterial } from '../types';
import ReportGenerator from './ReportGenerator';
import { useBrandName } from '../contexts/CompanyContext';

const getCustomerSchedule = (p: Part, customerName: string) => {
  if (!p.schedules) return 0;
  const key = Object.keys(p.schedules).find(k => k.toUpperCase().trim() === customerName.toUpperCase().trim());
  return key ? p.schedules[key] || 0 : 0;
};

const getCustomerRate = (p: Part, customerName: string) => {
  if (!p.customerRates) return p.rate || 0;
  const key = Object.keys(p.customerRates).find(k => k.toUpperCase().trim() === customerName.toUpperCase().trim());
  return key ? p.customerRates[key] ?? p.rate : p.rate;
};

interface DashboardProps {
  parts: Part[];
  sales: Sale[];
  allSales?: Sale[];
  forcedMonthDisplay?: string;
  activeCustomer: string;
  onCustomerChange: (customer: string) => void;
  customers: Customer[];
  selectedDate: Date;
  rawMaterials?: RawMaterial[];
  localRMOpeningBalances?: Record<string, string>;
  rmInwardLogs?: any[];
}

const Dashboard: React.FC<DashboardProps> = ({ parts, sales, allSales, forcedMonthDisplay, activeCustomer, onCustomerChange, customers, selectedDate, rawMaterials, localRMOpeningBalances, rmInwardLogs }) => {
  const brandName = useBrandName();
  const [triggerReport, setTriggerReport] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [show1PMAlert, setShow1PMAlert] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showShortageModal, setShowShortageModal] = useState(false);
  const [expandedInvoices, setExpandedInvoices] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const checkTime = () => {
      const now = new Date();
      const lastShared = localStorage.getItem('last_shared_report_date');
      const today = now.toDateString();
      
      if (now.getHours() >= 13 && now.getHours() < 14 && lastShared !== today) {
        setShow1PMAlert(true);
      } else {
        setShow1PMAlert(false);
      }
    };
    checkTime();
    const interval = setInterval(checkTime, 60000);
    return () => clearInterval(interval);
  }, []);

  const currentMonthYearLive = new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const isHistorical = forcedMonthDisplay && forcedMonthDisplay !== currentMonthYearLive;

  const filteredSales = useMemo(() => {
    return sales.filter(s => s.customer && s.customer.toUpperCase().trim() === activeCustomer.toUpperCase().trim());
  }, [sales, activeCustomer]);
  
  // Grouping Sales by Invoice for the Global Feed
  const recentInvoices = useMemo(() => {
    const groups: Record<string, Sale[]> = {};
    const salesDataSource = allSales || sales;
    
    const parseTs = (ts: string): number => {
      if (!ts) return 0;
      try {
        const d = new Date(ts);
        const t = d.getTime();
        return isNaN(t) ? 0 : t;
      } catch {
        return 0;
      }
    };

    salesDataSource.forEach(s => {
      const invNo = (s.invoiceNumber || '').trim();
      const isManual = !invNo || invNo.toUpperCase() === 'MANUAL';
      
      let dateKey = 'unknown';
      const timeMs = parseTs(s.timestamp);
      if (timeMs > 0) {
        const d = new Date(timeMs);
        dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      const custName = (s.customer || '').toUpperCase().trim();

      // If explicit invoice number exists and is not MANUAL, group by Invoice + Customer.
      // If MANUAL or empty, group by Customer + Date so each manual dispatch slip on a specific date is its own group.
      const key = !isManual 
        ? `INV-${invNo.toUpperCase()}-${custName}` 
        : `MAN-${custName}-${dateKey}`;

      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });

    // Sort items within each invoice group descending by timestamp so invoiceItems[0] is the most recent
    Object.keys(groups).forEach(key => {
      groups[key].sort((a, b) => parseTs(b.timestamp) - parseTs(a.timestamp));
    });

    // Sort invoice groups descending by their latest item's timestamp
    return Object.entries(groups)
      .sort((a, b) => {
        const timeA = parseTs(a[1][0]?.timestamp);
        const timeB = parseTs(b[1][0]?.timestamp);
        return timeB - timeA;
      })
      .slice(0, 10); 
  }, [sales, allSales]);

  const toggleInvoice = (invoiceKey: string) => {
    setExpandedInvoices(prev => ({
      ...prev,
      [invoiceKey]: !prev[invoiceKey]
    }));
  };

  const mappedParts = useMemo(() => {
    return parts.filter(p => p.mappedCustomers?.some(c => c.toUpperCase().trim() === activeCustomer.toUpperCase().trim()));
  }, [parts, activeCustomer]);

  // --- BUSINESS LOGIC: Commitment-Based Shortage Alerts ---
  const shortageAnalysis = useMemo(() => {
    return mappedParts.map(p => {
      const target = getCustomerSchedule(p, activeCustomer);
      const dispatched = filteredSales.filter(s => s.partId === p.id).reduce((sum, s) => sum + s.quantity, 0);
      const balanceNeeded = Math.max(0, target - dispatched);
      const isShortage = p.stock < balanceNeeded;
      const gap = isShortage ? balanceNeeded - p.stock : 0;

      // Find mapped RM for this part to calculate pipe/kg shortages
      const rm = rawMaterials?.find(r => 
        (p.customerRMMappings?.[activeCustomer] === r.id) || 
        (r.partId === p.id) || 
        (r.partIds && r.partIds.includes(p.id))
      );

      let factor = 0;
      let pipeWeight = 0;
      let kgShort = 0;
      let pipesShort = 0;

      if (rm) {
        const rmLength = rm.length || 6000;
        const rmStandardMeters = rmLength / 1000;
        let lengthFactorMeters = 0;
        if (p.itemLength && p.itemLength > 0) {
          lengthFactorMeters = p.itemLength / 1000;
        } else if (p.itemWeight && p.itemWeight > 0 && rm.weightPer1000 > 0) {
          lengthFactorMeters = (p.itemWeight / (rm.weightPer1000 / 1000)) / 1000;
        }
        const itemLengthMm = p.itemLength || (lengthFactorMeters * 1000);

        let scrapMmPerPipe = 0;
        let yieldFactor = 0;
        if (p.hasCustomScrap) {
          scrapMmPerPipe = p.customScrapMm || 0;
          if (itemLengthMm > 0) {
            yieldFactor = Math.floor(Math.max(0, rmLength - scrapMmPerPipe) / itemLengthMm);
          }
        } else {
          if (itemLengthMm > 0) {
            yieldFactor = Math.floor(rmLength / itemLengthMm);
            scrapMmPerPipe = rmLength % itemLengthMm;
          }
        }

        if (gap > 0) {
          if (yieldFactor > 0) {
            pipesShort = Math.ceil(gap / yieldFactor);
          } else if (rmStandardMeters > 0) {
            pipesShort = Math.ceil((gap * lengthFactorMeters) / rmStandardMeters);
          }
          const scrapMeters = pipesShort * (scrapMmPerPipe / 1000);
          const totalMetersShort = (gap * lengthFactorMeters) + scrapMeters;
          kgShort = totalMetersShort * (rm.weightPer1000 || 0);
        }
      }

      return {
        ...p,
        target,
        dispatched,
        balanceNeeded,
        isShortage,
        gap,
        linkedRM: rm,
        kgShort,
        pipesShort
      };
    }).filter(p => p.isShortage)
      .sort((a, b) => b.gap - a.gap);
  }, [mappedParts, filteredSales, activeCustomer, rawMaterials]);

  // Aggregate Raw Material-wise Shortages (Schedule vs Stock as of Date)
  const rmShortageAnalysis = useMemo(() => {
    if (!rawMaterials) return [];
    
    const activeRMs = rawMaterials.filter(rm => 
      rm.customerName.toUpperCase().trim() === activeCustomer.toUpperCase().trim()
    );

    const actualInwardLogs = rmInwardLogs || [];
    const actualOpeningBalances = localRMOpeningBalances || {};

    return activeRMs.map(rm => {
      // Standard RM pipe details
      const rmLength = rm.length || 6000;
      const rmStandardMeters = rmLength / 1000;
      const pipeWeight = (rmLength * (rm.weightPer1000 || 0)) / 1000;

      // 1. Raw Material Inward matching this month
      const monthRMInwardPipes = actualInwardLogs
        .filter((l: any) => l.rmId === rm.id)
        .reduce((sum: number, l: any) => sum + l.quantity, 0);
      const monthRMInwardKg = parseFloat((monthRMInwardPipes * pipeWeight).toFixed(2));
      const monthRMInwardMeters = monthRMInwardPipes * rmStandardMeters;

      // 2. Find all parts linked to this RM
      const linkedParts = parts.filter(p => 
        (p.customerRMMappings?.[activeCustomer] === rm.id) || 
        (rm.partId === p.id) || 
        (rm.partIds && rm.partIds.includes(p.id)) ||
        (p.mappedCustomers?.some(c => c.toUpperCase().trim() === activeCustomer.toUpperCase().trim()) && 
         (p.customerRMMappings?.[p.mappedCustomers.find(c => c.toUpperCase().trim() === activeCustomer.toUpperCase().trim()) || ''] === rm.id))
      );

      // 3. Compute RM consumed so far: dispatches (Sales) + scrap of those dispatches
      let totalSalesMeters = 0;
      let totalSalesScrapMeters = 0;
      let totalSalesScrapKg = 0;

      linkedParts.forEach(item => {
        const salesQty = filteredSales
          .filter(s => s.partId === item.id)
          .reduce((sum, s) => sum + s.quantity, 0);

        let lengthFactorMeters = 0;
        if (item.itemLength && item.itemLength > 0) {
          lengthFactorMeters = item.itemLength / 1000;
        } else if (item.itemWeight && item.itemWeight > 0 && rm.weightPer1000 > 0) {
          lengthFactorMeters = (item.itemWeight / (rm.weightPer1000 / 1000)) / 1000;
        }

        const itemLengthMm = item.itemLength || (lengthFactorMeters * 1000);
        const itemMeters = salesQty * lengthFactorMeters;

        let scrapMmPerPipe = 0;
        let yieldFactor = 0;
        if (item.hasCustomScrap) {
          scrapMmPerPipe = item.customScrapMm || 0;
          if (itemLengthMm > 0) {
            yieldFactor = Math.floor(Math.max(0, rmLength - scrapMmPerPipe) / itemLengthMm);
          }
        } else {
          if (itemLengthMm > 0) {
            yieldFactor = Math.floor(rmLength / itemLengthMm);
            scrapMmPerPipe = rmLength % itemLengthMm;
          }
        }

        let pipesUsed = 0;
        if (yieldFactor > 0) {
          pipesUsed = Math.ceil(salesQty / yieldFactor);
        } else if (rmStandardMeters > 0 && salesQty > 0) {
          pipesUsed = Math.ceil(itemMeters / rmStandardMeters);
        }

        const itemScrapMeters = pipesUsed * (scrapMmPerPipe / 1000);
        const itemScrapKg = itemScrapMeters * (rm.weightPer1000 || 0);

        totalSalesMeters += itemMeters;
        totalSalesScrapMeters += itemScrapMeters;
        totalSalesScrapKg += itemScrapKg;
      });

      // 4. Calculate actual RM closing stock as of date: (opening + inward - dispatched - scrap)
      const opBalancePipesStr = actualOpeningBalances[rm.id] || '0';
      const openingBalancePipes = parseFloat(opBalancePipesStr);
      const openingBalanceKg = parseFloat((openingBalancePipes * pipeWeight).toFixed(2));
      const openingBalanceMeters = openingBalancePipes * rmStandardMeters;

      const closingBalanceMeters = parseFloat((openingBalanceMeters + monthRMInwardMeters - totalSalesMeters - totalSalesScrapMeters).toFixed(2));
      const closingBalancePipes = rmStandardMeters > 0 ? parseFloat((closingBalanceMeters / rmStandardMeters).toFixed(1)) : 0;
      const closingBalanceKg = parseFloat((openingBalanceKg + monthRMInwardKg - (totalSalesMeters * (rm.weightPer1000 || 0)) - totalSalesScrapKg).toFixed(2));

      // 5. Calculate total Raw Material required to fulfill the remaining balance monthly schedule
      let totalTargetMetersNeeded = 0;
      let totalTargetScrapMetersNeeded = 0;

      const partDetails = linkedParts.map(p => {
        const target = getCustomerSchedule(p, activeCustomer);
        const dispatched = filteredSales.filter(s => s.partId === p.id).reduce((sum, s) => sum + s.quantity, 0);
        const balanceNeeded = Math.max(0, target - dispatched);

        let lengthFactorMeters = 0;
        if (p.itemLength && p.itemLength > 0) {
          lengthFactorMeters = p.itemLength / 1000;
        } else if (p.itemWeight && p.itemWeight > 0 && rm.weightPer1000 > 0) {
          lengthFactorMeters = (p.itemWeight / (rm.weightPer1000 / 1000)) / 1000;
        }

        const itemLengthMm = p.itemLength || (lengthFactorMeters * 1000);
        const balanceMetersNeeded = balanceNeeded * lengthFactorMeters;

        let scrapMmPerPipe = 0;
        let yieldFactor = 0;
        if (p.hasCustomScrap) {
          scrapMmPerPipe = p.customScrapMm || 0;
          if (itemLengthMm > 0) {
            yieldFactor = Math.floor(Math.max(0, rmLength - scrapMmPerPipe) / itemLengthMm);
          }
        } else {
          if (itemLengthMm > 0) {
            yieldFactor = Math.floor(rmLength / itemLengthMm);
            scrapMmPerPipe = rmLength % itemLengthMm;
          }
        }

        let balancePipesUsed = 0;
        if (yieldFactor > 0) {
          balancePipesUsed = Math.ceil(balanceNeeded / yieldFactor);
        } else if (rmStandardMeters > 0 && balanceNeeded > 0) {
          balancePipesUsed = Math.ceil(balanceMetersNeeded / rmStandardMeters);
        }

        const balanceScrapMeters = balancePipesUsed * (scrapMmPerPipe / 1000);

        totalTargetMetersNeeded += balanceMetersNeeded;
        totalTargetScrapMetersNeeded += balanceScrapMeters;

        const partRequiredMeters = balanceMetersNeeded + balanceScrapMeters;
        const partRequiredKg = partRequiredMeters * (rm.weightPer1000 || 0);
        const partRequiredPipes = rmStandardMeters > 0 ? partRequiredMeters / rmStandardMeters : 0;

        return {
          id: p.id,
          name: p.name,
          sapCode: p.sapCode,
          target,
          dispatched,
          balanceNeeded,
          isShortage: balanceNeeded > p.stock,
          gap: balanceNeeded,
          factor: lengthFactorMeters * (rm.weightPer1000 || 0),
          kgShort: partRequiredKg,
          pipesShort: partRequiredPipes,
          metersShort: partRequiredMeters
        };
      });

      // 6. Net RM shortage calculation: Stock as on date vs Balance required for schedule
      const totalRmRequiredMeters = totalTargetMetersNeeded + totalTargetScrapMetersNeeded;
      
      const deficitMeters = Math.max(0, totalRmRequiredMeters - closingBalanceMeters);
      const totalKgShort = parseFloat((deficitMeters * (rm.weightPer1000 || 0)).toFixed(2));
      const totalPipesShort = rmStandardMeters > 0 ? parseFloat((deficitMeters / rmStandardMeters).toFixed(1)) : 0;
      const totalMetersShort = parseFloat(deficitMeters.toFixed(2));
      const hasShortage = totalMetersShort > 0;

      return {
        rm,
        rmLength,
        rmStandardMeters,
        pipeWeight,
        actualStockMeters: closingBalanceMeters,
        actualStockPipes: closingBalancePipes,
        actualStockKg: closingBalanceKg,
        requiredMeters: totalRmRequiredMeters,
        partDetails,
        totalKgShort,
        totalPipesShort,
        totalMetersShort,
        hasShortage
      };
    }).sort((a, b) => b.totalMetersShort - a.totalMetersShort);
  }, [parts, rawMaterials, activeCustomer, filteredSales, rmInwardLogs, localRMOpeningBalances]);

  const stats: InventoryStats = {
    totalValue: parts.reduce((acc, p) => acc + (p.stock * p.rate), 0),
    lowStockItems: parts.filter(p => p.status === 'Low Stock').length,
    outOfStockItems: parts.filter(p => p.status === 'Out of Stock').length,
    totalSalesToday: filteredSales.length,
    overallAchievement: (() => {
      const totSalesValue = filteredSales.reduce((acc, s) => acc + s.totalPrice, 0);
      const totScheduledValue = mappedParts.reduce((acc, p) => {
        const target = getCustomerSchedule(p, activeCustomer);
        const rate = getCustomerRate(p, activeCustomer);
        return acc + (target * rate);
      }, 0) || 1;
      return (totSalesValue / totScheduledValue) * 100;
    })()
  };

  const handleShareToWhatsApp = async (blob: Blob) => {
    try {
      const safeDate = selectedDate.toISOString().split('T')[0];
      const fileName = `Performance_${activeCustomer.substring(0, 10).replace(/\s/g, '_')}_${safeDate}.jpg`;
      const file = new File([blob], fileName, { type: 'image/jpeg' });
      
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const newPreview = URL.createObjectURL(blob);
      setPreviewUrl(newPreview);

      const shareData = {
        files: [file],
        title: 'Achievement Report',
        text: `📊 Performance Report for ${activeCustomer} as of ${selectedDate.toLocaleDateString('en-GB')} - ${stats.overallAchievement.toFixed(1)}% Achievement.`
      };

      if (navigator.canShare && navigator.canShare(shareData)) {
        await navigator.share(shareData);
        localStorage.setItem('last_shared_report_date', new Date().toDateString());
        setShow1PMAlert(false);
      } else {
        throw new Error('Native share unavailable');
      }
    } catch (err) {
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `Performance_Report_${activeCustomer}_${selectedDate.toISOString().split('T')[0]}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      alert("Report Ready! Downloaded to device. Please share manually.");
    } finally {
      setTriggerReport(false);
      setIsSharing(false);
    }
  };

  const currentMonthYear = useMemo(() => {
    return forcedMonthDisplay || currentMonthYearLive;
  }, [forcedMonthDisplay, currentMonthYearLive]);

  return (
    <div className="space-y-8 relative text-left">
      <ReportGenerator 
        parts={parts} 
        sales={sales} 
        activeCustomer={activeCustomer} 
        trigger={triggerReport} 
        onImageGenerated={handleShareToWhatsApp} 
        reportDate={selectedDate}
      />

      {isHistorical && (
        <div className="bg-slate-900 text-white p-6 rounded-[2rem] shadow-2xl flex items-center justify-between gap-4 animate-in slide-in-from-top-4 border border-white/10">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-xl">📜</div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Viewing Archive</p>
              <h4 className="font-black text-sm uppercase tracking-tight">Audit Trail for {currentMonthYear}</h4>
            </div>
          </div>
          <div className="px-5 py-2 bg-rose-500/20 border border-rose-500/30 rounded-xl">
             <span className="text-[10px] font-black uppercase tracking-widest text-rose-300">Locked Data</span>
          </div>
        </div>
      )}

      <header className="flex flex-col md:flex-row md:justify-between md:items-end gap-6 text-left">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2 text-left">Summary {currentMonthYear}</h2>
          <p className="text-slate-500 font-medium text-left">Operations Monitoring - {brandName}</p>
        </div>
        
        <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4 text-left">
          <div className="flex items-center gap-3 text-left">
            {previewUrl && (
              <div className="w-12 h-12 rounded-xl overflow-hidden border-2 border-indigo-500 shadow-lg animate-in zoom-in-50">
                <img src={previewUrl} className="w-full h-full object-cover" alt="Preview" />
              </div>
            )}
            <button 
              onClick={() => { setIsSharing(true); setTriggerReport(true); }}
              disabled={isSharing}
              className={`px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-xl ${isSharing ? 'bg-slate-100 text-slate-400' : (show1PMAlert ? 'bg-indigo-600 text-white animate-bounce shadow-indigo-200' : 'bg-white border border-slate-200 text-slate-800 hover:bg-slate-50')}`}
            >
              {isSharing ? 'Syncing...' : (show1PMAlert ? '🔔 Send 1PM Report' : '📲 Share Achievement')}
            </button>
          </div>

          <div className="flex flex-col gap-1.5 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 text-left">Viewing Performance For</label>
            <select 
              className="px-6 py-3 bg-white border border-slate-200 rounded-2xl font-black text-slate-800 shadow-sm focus:ring-4 focus:ring-indigo-500/10 outline-none min-w-[200px]"
              value={activeCustomer}
              onChange={(e) => onCustomerChange(e.target.value)}
            >
              {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 text-left">
        {[
          { label: 'Qty Dispatched Period', val: `${filteredSales.reduce((a,b) => a + b.quantity, 0).toLocaleString()} Pcs`, color: 'text-indigo-600', sub: `${activeCustomer} Output` },
          { label: 'Shortage Alerts', val: shortageAnalysis.length, color: 'text-rose-500', sub: 'Action Required', onClick: () => setShowShortageModal(true) },
          { label: 'PERIOD ACHIEVEMENT', val: `${stats.overallAchievement.toFixed(1)}%`, color: 'text-indigo-600', sub: 'Target Compliance' },
          { label: 'Valuation', val: `₹${(stats.totalValue / 100000).toFixed(2)}L`, color: 'text-emerald-600', sub: 'Stock Assets' }
        ].map((s, idx) => (
          <div key={idx} onClick={s.onClick} className={`bg-white p-6 rounded-3xl border border-slate-100 shadow-sm transition-all text-left ${s.onClick ? 'cursor-pointer hover:shadow-lg hover:border-rose-200 ring-2 ring-transparent hover:ring-rose-500/20' : ''}`}>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 text-left">{s.label}</p>
            <p className={`text-3xl font-black ${s.color} text-left`}>{s.val}</p>
            <p className="text-[10px] font-bold text-slate-400 mt-2 uppercase text-left">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* CONSOLIDATED RAW MATERIAL SHORTAGES SECTION */}
      {rmShortageAnalysis.some(x => x.hasShortage) && (
        <div className="bg-rose-50/25 border-2 border-rose-100/60 rounded-[2.5rem] p-8 shadow-sm transition-all animate-in slide-in-from-bottom-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 border-b border-rose-100/40 pb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2.5 h-2.5 bg-rose-600 rounded-full animate-ping" />
                <h3 className="text-xs font-black text-rose-700 uppercase tracking-widest">Raw Material-wise Shortage Highlights (Schedule vs Stock)</h3>
              </div>
              <p className="text-xs text-rose-600/80 font-semibold leading-relaxed">
                Calculated shortage of balance schedules vs stock levels. Shared Raw Material sizes consolidated collectively across all linked items.
              </p>
            </div>
            <div className="bg-rose-600 text-white font-black text-[10px] uppercase tracking-widest px-4 py-2 rounded-xl h-fit w-fit shadow-md shadow-rose-200/50">
              {rmShortageAnalysis.filter(x => x.hasShortage).length} RM Deficits Active
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {rmShortageAnalysis.filter(x => x.hasShortage).map(({ rm, totalKgShort, totalPipesShort, totalMetersShort, actualStockMeters, requiredMeters, partDetails }) => (
              <div key={rm.id} className="bg-white border border-rose-100/70 rounded-[2rem] p-6 shadow-sm hover:shadow-md transition-all flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest">Raw Material Size</p>
                      <h4 className="text-base font-black text-slate-800 uppercase leading-none">{rm.size}</h4>
                      <p className="text-[9px] text-slate-400 font-bold mt-1.5">Length: {rm.length}mm • Factor: {rm.weightPer1000} Kg/1k mm</p>
                    </div>
                  </div>

                  {/* Highlights of meters, pipes and kgs short on the main dashboard */}
                  <div className="grid grid-cols-3 gap-2 bg-rose-50/40 p-3 rounded-xl border border-rose-50 mb-4 text-left">
                    <div className="text-left">
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-wide mb-1">Meters Short</p>
                      <p className="text-base font-black text-rose-700 leading-none">-{totalMetersShort.toFixed(1)} <span className="text-[9px] font-bold">m</span></p>
                    </div>
                    <div className="text-left border-l border-rose-100 pl-2">
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-wide mb-1">Pipes Short</p>
                      <p className="text-base font-black text-rose-700 leading-none">-{totalPipesShort.toFixed(1)} <span className="text-[9px] font-bold">Pipes</span></p>
                    </div>
                    <div className="text-left border-l border-rose-100 pl-2">
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-wide mb-1">Weight Short</p>
                      <p className="text-base font-black text-rose-700 leading-none">-{totalKgShort.toFixed(1)} <span className="text-[9px] font-bold">Kg</span></p>
                    </div>
                  </div>

                  {/* Stock vs Requirement summary */}
                  <div className="text-[9.5px] text-slate-500 font-bold mb-4 bg-slate-50 p-2.5 rounded-xl border border-slate-100/70 flex justify-between">
                     <span>Stock: <strong className="text-slate-800">{(actualStockMeters || 0).toFixed(1)} m</strong></span>
                     <span>Schedule needed: <strong className="text-slate-800">{(requiredMeters || 0).toFixed(1)} m</strong></span>
                  </div>

                  {/* Deficit breakdown by parts mapping to intermediate RM */}
                  <div>
                    <h5 className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2">Item-wise Shortage Breakdown</h5>
                    <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1">
                      {partDetails.filter(p => p.gap > 0).map(p => (
                        <div key={p.id} className="flex justify-between items-center text-xs bg-slate-50/50 p-2.5 rounded-xl border border-slate-100">
                          <div>
                            <p className="font-extrabold text-slate-700 uppercase leading-tight text-xs">{p.name}</p>
                            <p className="text-[9px] text-slate-400 font-mono tracking-tight">{p.sapCode}</p>
                          </div>
                          <div className="text-right">
                            <p className="font-extrabold text-rose-600">-{Math.round(p.gap)} pcs</p>
                            <p className="text-[9px] text-slate-400 font-black">-{p.metersShort.toFixed(1)} m (-{p.pipesShort.toFixed(1)} Pipes / -{p.kgShort.toFixed(1)} Kg)</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">
        <div className="lg:col-span-2 bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden text-left">
          <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-center text-left">
            <h3 className="font-black text-slate-900 text-xs uppercase tracking-widest text-left">Performance Ledger - {activeCustomer}</h3>
            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase text-left ${isHistorical ? 'bg-slate-100 text-slate-600' : 'bg-indigo-50 text-indigo-700'}`}>
              {isHistorical ? 'Archive Data' : 'Live Stats'}
            </span>
          </div>
          <div className="overflow-x-auto text-left">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest text-left">
                <tr>
                  <th className="px-8 py-5 border-r border-slate-200/40 text-left">Description</th>
                  <th className="px-8 py-5 text-center border-r border-slate-200/40">Available Stock</th>
                  <th className="px-8 py-5 text-center border-r border-slate-200/40">Target</th>
                  <th className="px-8 py-5 text-center border-r border-slate-200/40">Dispatch</th>
                  <th className="px-8 py-5 text-center border-r border-slate-200/40">ACH %</th>
                  <th className="px-8 py-5 text-center">Bal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-left">
                {mappedParts.map(p => {
                  const target = getCustomerSchedule(p, activeCustomer);
                  const dispatchCount = filteredSales.filter(s => s.partId === p.id).reduce((sum, s) => sum + s.quantity, 0);
                  const achv = Math.round((dispatchCount / (target || 1)) * 100);
                  const balance = Math.max(0, target - dispatchCount);

                  return (
                    <tr key={p.id} className="hover:bg-indigo-50/30 transition-all group text-left">
                      <td className="px-8 py-5 text-left">
                        <div className="text-[11px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5 text-left">{p.sapCode}</div>
                        <div className="font-bold text-slate-800 text-sm leading-tight group-hover:text-indigo-600 transition-colors uppercase text-left">{p.name}</div>
                      </td>
                      <td className="px-8 py-5 text-center border-r border-slate-200/20 font-black">
                        <span className={`px-3 py-1.5 rounded-full text-xs font-black ${p.stock < 0 ? 'bg-rose-100 text-rose-700' : p.stock <= p.minThreshold ? 'bg-amber-100 text-amber-700' : 'bg-slate-50 text-slate-800 border border-slate-100'}`}>
                          {Math.round(p.stock)}
                        </span>
                      </td>
                      <td className="px-8 py-5 text-center font-black text-slate-600 text-sm">{target}</td>
                      <td className="px-8 py-5 text-center font-black text-indigo-600 text-sm">{dispatchCount}</td>
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-3 justify-center">
                          <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-700 ${achv >= 90 ? 'bg-emerald-500' : achv < 40 ? 'bg-rose-500' : 'bg-indigo-500'}`} style={{ width: `${Math.min(achv, 100)}%` }} />
                          </div>
                          <span className={`text-[10px] font-black w-8 text-right ${achv >= 90 ? 'text-emerald-600' : achv < 40 ? 'text-rose-600' : 'text-indigo-600'}`}>{achv}%</span>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-center">
                        <span className={`font-black text-xs ${balance > 0 ? 'text-slate-900' : 'text-emerald-500'}`}>{balance}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Global Recent Activity Feed - Grouped by Invoice */}
        <div className="bg-slate-900 rounded-[2.5rem] shadow-xl border border-slate-800 p-8 text-left flex flex-col min-h-[500px]">
          <div className="flex items-center justify-between mb-8 text-left">
            <h3 className="font-black text-white text-[10px] uppercase tracking-widest text-left">Global Dispatch Feed</h3>
            <div className="flex items-center gap-2 text-left">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></div>
              <span className="text-[8px] font-black text-emerald-500 uppercase tracking-widest text-left">Live Channel</span>
            </div>
          </div>
          
          <div className="space-y-4 flex-1 text-left overflow-y-auto pr-2 custom-scrollbar">
            {recentInvoices.map(([invoiceKey, invoiceItems], i) => {
              const isExpanded = expandedInvoices[invoiceKey];
              const firstSale = invoiceItems[0];
              const displayInvoice = firstSale.invoiceNumber || 'Manual';
              const displayCustomer = firstSale.customer.split(' ')[0];
              const totalQty = invoiceItems.reduce((sum, s) => sum + s.quantity, 0);

              return (
                <div key={invoiceKey} className={`bg-slate-800/40 rounded-2xl border transition-all duration-300 overflow-hidden ${isExpanded ? 'border-indigo-500/50 ring-1 ring-indigo-500/20' : 'border-slate-800 hover:border-slate-700'}`}>
                  <div 
                    onClick={() => toggleInvoice(invoiceKey)}
                    className="p-4 flex items-center justify-between cursor-pointer group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center text-lg shadow-inner">📄</div>
                      <div>
                        <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest leading-none mb-1">
                          {displayCustomer} • {new Date(firstSale.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                        </p>
                        <h4 className="text-xs font-black text-slate-100 uppercase tracking-tight flex items-center gap-2">
                          Invoice: {displayInvoice}
                          {String(displayInvoice).includes('/BT/') && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[8px] font-black tracking-widest" title="Branch Transfer — not a GST tax invoice">
                              BT
                            </span>
                          )}
                        </h4>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-[9px] font-black text-slate-500 uppercase tracking-tighter">Total Qty</p>
                        <p className="text-sm font-black text-emerald-400">{totalQty}</p>
                      </div>
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-300 ${isExpanded ? 'bg-indigo-600 text-white rotate-180' : 'bg-slate-800 text-slate-500 group-hover:bg-slate-700 group-hover:text-slate-300'}`}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-4 animate-in slide-in-from-top-2 duration-300">
                      <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 overflow-hidden">
                        <table className="w-full text-left text-[10px]">
                          <thead className="bg-slate-800/80 text-slate-500 font-black uppercase tracking-widest">
                            <tr>
                              <th className="px-3 py-2">Item Detail</th>
                              <th className="px-3 py-2 text-center">Qty</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/50">
                            {invoiceItems.map((item, idx) => (
                              <tr key={idx} className="hover:bg-indigo-500/5">
                                <td className="px-3 py-2">
                                  <div className="font-black text-slate-200 uppercase">{item.partName}</div>
                                  <div className="text-[8px] font-mono text-slate-500 uppercase">{item.sapCode}</div>
                                </td>
                                <td className="px-3 py-2 text-center font-black text-emerald-400">{item.quantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            
            {recentInvoices.length === 0 && (
              <div className="py-20 text-center">
                <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest text-center">No recent activity detected</p>
              </div>
            )}
          </div>
          
          <div className="mt-8 pt-6 border-t border-slate-800 text-left">
            <p className="text-[9px] text-slate-500 font-bold text-left italic">Invoices grouped by number. Click the pointer tab to audit specific parts & quantities.</p>
          </div>
        </div>
      </div>

      {/* Shortage Alerts Modal - Commitment Focused */}
      {showShortageModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-xl flex items-center justify-center z-[200] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-10 border border-slate-100 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh] text-left">
            <div className="flex justify-between items-start mb-8 text-left">
              <div className="text-left">
                <h3 className="text-2xl font-black text-slate-900 leading-none mb-2 text-left">Commitment Shortage</h3>
                <p className="text-sm text-slate-500 font-medium text-left">Stock is insufficient to fulfill the remaining monthly schedule for {activeCustomer ? activeCustomer.split(' ')[0] : 'customer'}</p>
              </div>
              <button onClick={() => setShowShortageModal(false)} className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center hover:bg-slate-200 transition-colors">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 space-y-4 pr-2 custom-scrollbar text-left">
              {shortageAnalysis.map(item => (
                <div key={item.id} className="bg-slate-50 border border-slate-100 p-6 rounded-3xl hover:bg-rose-50/20 transition-all text-left group">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-left flex-1">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 text-left">{item.sapCode}</p>
                      <p className="font-extrabold text-slate-800 text-sm uppercase leading-tight text-left">{item.name}</p>
                      <div className="flex gap-4 mt-2">
                         <p className="text-[10px] text-slate-400 font-bold uppercase text-left">Available: <span className="text-slate-900 font-black">{Math.round(item.stock)}</span></p>
                         <p className="text-[10px] text-slate-400 font-bold uppercase text-left">Req. Bal: <span className="text-slate-900 font-black">{Math.round(item.balanceNeeded)}</span></p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest mb-1">Stock Gap</p>
                      <div className="bg-rose-600 text-white px-4 py-2 rounded-xl text-lg font-black shadow-lg shadow-rose-200 group-hover:scale-105 transition-transform">
                        -{Math.round(item.gap)} pcs
                      </div>
                    </div>
                  </div>
                  {item.linkedRM && (
                    <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap gap-x-6 gap-y-2 text-xs">
                      <p className="text-[10px] font-black text-rose-700 uppercase flex items-center gap-1">
                        ⛓️ Mapped RM size: <span className="text-slate-800 font-extrabold">{item.linkedRM.size}</span>
                      </p>
                      <p className="text-[10px] text-slate-500 font-black uppercase flex items-center gap-1">
                        ⚖️ RM Weight Short: <span className="text-rose-600 font-black">{item.kgShort.toFixed(2)} Kg</span>
                      </p>
                      <p className="text-[10px] text-slate-500 font-black uppercase flex items-center gap-1">
                        📏 Standard Pipes Short: <span className="text-rose-600 font-black">{item.pipesShort.toFixed(1)} Pipes</span>
                      </p>
                    </div>
                  )}
                </div>
              ))}
              {shortageAnalysis.length === 0 && (
                <div className="py-20 text-center flex flex-col items-center">
                  <div className="w-20 h-20 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center text-3xl mb-4">✅</div>
                  <p className="text-sm font-black text-slate-800 uppercase tracking-tight">Fully Scheduled</p>
                  <p className="text-xs text-slate-400 font-medium mt-1">Stock levels cover all remaining commits for this customer.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
