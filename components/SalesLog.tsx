
import React, { useState, useMemo, useEffect } from 'react';
import { Part, Sale, Customer } from '../types';
// Loaded on demand inside exportToExcel (below), not statically here —
// exceljs is a large library and a static import put it in every user's
// initial page load, nearly doubling the app's main JS bundle, even for
// users who never click "Download Excel" on this one screen.

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

// 24-Oct-26, Vipul's ask — an "All Customers" option on this screen's
// Consignee Filter, so dispatches of the same part across multiple
// customers can be seen (and totalled) together. `activeCustomer` is the
// app-wide selected customer shared with Dashboard/Inventory/Schedules/
// etc, so it can never itself become "All" without risking every other
// screen that assumes it's one real customer name. Instead this sentinel
// only lives in this component's own local filter state (see
// `consigneeFilter` below) — picking a real customer here still also
// updates the shared `activeCustomer` exactly as before (so the rest of
// the app keeps following along), but "All Customers" stays local to this
// report and touches nothing else.
const ALL_CUSTOMERS_VALUE = '__ALL_CUSTOMERS__';

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
  const [consigneeFilter, setConsigneeFilter] = useState<string>(activeCustomer);

  // Keep this screen's local filter following the app-wide active customer
  // whenever it changes from elsewhere (another screen, or the Consignee
  // dropdown below picking a real customer) — same behaviour as before
  // "All Customers" existed, just moved into local state.
  useEffect(() => {
    setConsigneeFilter(activeCustomer);
  }, [activeCustomer]);

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

  // 24-Oct-26, Vipul's ask — the Parts dropdowns below should only list
  // parts actually mapped (Item Master's `mappedCustomers`) to whichever
  // consignee is selected, instead of every part in the app regardless of
  // customer. Falls back to every part when "All Customers" is selected,
  // since there's no single customer left to scope by.
  const customerScopedParts = useMemo(() => {
    if (consigneeFilter === ALL_CUSTOMERS_VALUE) return parts;
    return parts.filter(p => p.mappedCustomers?.includes(consigneeFilter));
  }, [parts, consigneeFilter]);

  // If the previously-selected part filter doesn't belong to the newly
  // selected consignee anymore, fall back to "All" rather than silently
  // filtering against a part that's no longer a valid option.
  useEffect(() => {
    if (selectedFilterPartId !== 'All' && !customerScopedParts.some(p => p.id === selectedFilterPartId)) {
      setSelectedFilterPartId('All');
    }
  }, [customerScopedParts, selectedFilterPartId]);

  const filteredSalesData = useMemo(() => {
    const start = new Date(startDate);
    start.setHours(0,0,0,0);
    const end = new Date(endDate);
    end.setHours(23,59,59,999);

    const rows = sales.filter(s => {
      const matchesCustomer = consigneeFilter === ALL_CUSTOMERS_VALUE
        ? true
        : (s.customer && consigneeFilter && s.customer.toUpperCase().trim() === consigneeFilter.toUpperCase().trim());
      const matchesPart = selectedFilterPartId === 'All' || s.partId === selectedFilterPartId;
      const d = new Date(s.timestamp);
      const matchesDate = d >= start && d <= end;
      return matchesCustomer && matchesPart && matchesDate;
    });

    // 24-Oct-26, Vipul's ask — date ascending, invoice number ascending
    // within the same date (the previous "newest first" grouping is gone
    // along with the accordion it supported).
    return rows.sort((a, b) => {
      const dA = new Date(a.timestamp).getTime();
      const dB = new Date(b.timestamp).getTime();
      if (dA !== dB) return dA - dB;
      return (a.invoiceNumber || '').localeCompare(b.invoiceNumber || '');
    });
  }, [sales, consigneeFilter, selectedFilterPartId, startDate, endDate]);

  // One row per sale, pre-joined with its Item Master record so the table
  // and the Excel export both read Size/Specifications and the new Part
  // Length (mm) column from the same place, the same way.
  const reportRows = useMemo(() => {
    return filteredSalesData.map(sale => {
      const part = parts.find(p => p.id === sale.partId || p.sapCode === sale.sapCode);
      return {
        sale,
        date: new Date(sale.timestamp),
        sizeSpec: part?.size || '',
        partLength: part?.itemLength,
      };
    });
  }, [filteredSalesData, parts]);

  const totalRangeVolume = useMemo(() => {
    return filteredSalesData.reduce((acc, s) => acc + s.quantity, 0);
  }, [filteredSalesData]);

  const reportTotals = useMemo(() => {
    return filteredSalesData.reduce((acc, s) => {
      acc.qty += s.quantity;
      acc.value += s.totalPrice;
      return acc;
    }, { qty: 0, value: 0 });
  }, [filteredSalesData]);

  const formatDateDisplay = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${d}-${m}-${y}`;
  };

  // 24-Oct-26 rewrite — the free `xlsx` package can't write cell colors,
  // fills or borders at all (that's a paid-tier feature of that library),
  // so the bold wrapped light-blue header + full grid borders Vipul asked
  // to match from his proposed file needed a different library. Switched
  // to `exceljs` (new dependency — see package.json), which supports full
  // cell styling. Column order/removal also matches the proposed file:
  // Time is gone, Invoice Number moved before Consignee, Part Description
  // before Size/Specifications, and the new Part Length (mm) column reads
  // straight from Item Master's `itemLength` (already populated there per
  // Vipul — see reportRows above).
  const exportToExcel = async () => {
    if (filteredSalesData.length === 0) return;

    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Dispatch Logs');

    worksheet.columns = [
      { width: 10.375 }, // Date
      { width: 17.375 }, // Invoice Number
      { width: 33 },     // Consignee
      { width: 14.875 }, // SAP Code
      { width: 26.75 },  // Part Description
      { width: 16.75 },  // Size/Specifications
      { width: 13.625 }, // Part Length (mm)
      { width: 12.375 }, // Quantity (Pcs)
      { width: 14.125 }, // Total Value (INR)
    ];

    const headerRow = worksheet.addRow([
      'Date', 'Invoice Number', 'Consignee', 'SAP Code', 'Part Description',
      'Size/\nSpecifications', 'Part \nLength (mm)', 'Quantity (Pcs)', 'Total Value (INR)',
    ]);
    headerRow.height = 33.75;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, size: 12 };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    });

    reportRows.forEach(r => {
      const row = worksheet.addRow([
        r.date.toLocaleDateString('en-GB'),
        r.sale.invoiceNumber || '-',
        r.sale.customer,
        r.sale.sapCode,
        r.sale.partName,
        r.sizeSpec,
        r.partLength ?? '',
        r.sale.quantity,
        Number(r.sale.totalPrice.toFixed(2)),
      ]);
      row.getCell(8).numFmt = '#,##0';
      row.getCell(9).numFmt = '#,##0.00';
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' },
        };
      });
    });

    const consigneeLabel = consigneeFilter === ALL_CUSTOMERS_VALUE ? 'All Customers' : consigneeFilter;
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Dispatch_Report_${consigneeLabel}_${startDate}_to_${endDate}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
            <select
              className="px-6 py-3 bg-white border border-slate-200 rounded-2xl font-black text-slate-800 shadow-sm outline-none w-full md:w-64"
              value={consigneeFilter}
              onChange={(e) => {
                const v = e.target.value;
                setConsigneeFilter(v);
                if (v !== ALL_CUSTOMERS_VALUE) {
                  onCustomerChange(v);
                }
              }}
            >
              <option value={ALL_CUSTOMERS_VALUE}>All Customers</option>
              {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <div className={`p-8 rounded-[2.5rem] shadow-sm border flex flex-col xl:flex-row gap-8 items-stretch xl:items-end transition-all ${isAdmin ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-100'}`}>
          <div className="flex-1 flex flex-col sm:flex-row gap-4">
            <div className="flex-1 space-y-3 text-left">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">SAP Code</label>
              <select className="px-6 py-4 bg-white border-2 border-slate-100 rounded-2xl font-black text-slate-800 focus:border-indigo-500 outline-none w-full transition-all shadow-inner" value={selectedFilterPartId} onChange={(e) => setSelectedFilterPartId(e.target.value)}>
                <option value="All">All SAP Codes</option>
                {customerScopedParts.map(p => <option key={p.id} value={p.id}>{p.sapCode}</option>)}
              </select>
            </div>
            <div className="flex-1 space-y-3 text-left">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Part Description</label>
              <select className="px-6 py-4 bg-white border-2 border-slate-100 rounded-2xl font-black text-slate-800 focus:border-indigo-500 outline-none w-full transition-all shadow-inner" value={selectedFilterPartId} onChange={(e) => setSelectedFilterPartId(e.target.value)}>
                <option value="All">All Part Descriptions</option>
                {customerScopedParts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
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
                  <input type="date" className="date-icon-overlay absolute inset-0 opacity-0 cursor-pointer w-full" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
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
                  <input type="date" className="date-icon-overlay absolute inset-0 opacity-0 cursor-pointer w-full" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
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

      {/* 24-Oct-26, Vipul's ask — the date-grouped expand/collapse accordion
          below replaced with a single flat table, same column set/order as
          the Excel export, so what's on screen matches what downloads.
          Column widths are fixed percentages (table-layout: fixed) derived
          from the proposed file's own Excel column widths, so the table
          never needs a horizontal scrollbar — anything too long to fit
          (long Consignee names, Part Descriptions) truncates with an
          ellipsis; the full value is still available on hover via title. */}
      <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden pb-2">
        <div className="max-h-[70vh] overflow-y-auto">
          <table className="w-full text-left border-collapse table-fixed text-[11px]">
            <colgroup>
              <col style={{ width: '7%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: isAdmin ? '18%' : '20%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: isAdmin ? '15%' : '16%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: isAdmin ? '8%' : '10%' }} />
              {isAdmin && <col style={{ width: '5%' }} />}
            </colgroup>
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr className="text-slate-900 uppercase font-black tracking-widest border-b-2 border-slate-200">
                <th className="px-3 py-3">Date</th>
                <th className="px-3 py-3">Invoice No.</th>
                <th className="px-3 py-3">Consignee</th>
                <th className="px-3 py-3">SAP Code</th>
                <th className="px-3 py-3">Part Description</th>
                <th className="px-3 py-3">Size/Spec</th>
                <th className="px-3 py-3 text-right">Length (mm)</th>
                <th className="px-3 py-3 text-right">Qty (Pcs)</th>
                <th className="px-3 py-3 text-right">Value (INR)</th>
                {isAdmin && <th className="px-3 py-3 text-center">Admin</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reportRows.map(r => (
                <tr key={r.sale.id} className="hover:bg-indigo-50/20 transition-colors">
                  <td className="px-3 py-2.5 truncate" title={r.date.toLocaleDateString('en-GB')}>{r.date.toLocaleDateString('en-GB')}</td>
                  <td className="px-3 py-2.5 truncate" title={r.sale.invoiceNumber || '-'}>{r.sale.invoiceNumber || '-'}</td>
                  <td className="px-3 py-2.5 truncate font-bold text-indigo-700" title={r.sale.customer}>{r.sale.customer}</td>
                  <td className="px-3 py-2.5 truncate font-mono" title={r.sale.sapCode}>{r.sale.sapCode}</td>
                  <td className="px-3 py-2.5 truncate" title={r.sale.partName}>{r.sale.partName}</td>
                  <td className="px-3 py-2.5 truncate" title={r.sizeSpec}>{r.sizeSpec}</td>
                  <td className="px-3 py-2.5 text-right truncate">{r.partLength ?? ''}</td>
                  <td className="px-3 py-2.5 text-right font-bold">{r.sale.quantity.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-bold">{r.sale.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  {isAdmin && (
                    <td className="px-3 py-2.5 text-center">
                      <button onClick={() => handleDelete(r.sale.id)} className="w-7 h-7 bg-rose-50 text-rose-600 rounded-lg hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center mx-auto">
                        🗑️
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {reportRows.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 10 : 9} className="px-3 py-10 text-center text-slate-400 font-bold">
                    No dispatch entries match this filter.
                  </td>
                </tr>
              )}
            </tbody>
            {reportRows.length > 0 && (
              <tfoot className="sticky bottom-0 z-10">
                <tr className="bg-amber-50 border-t-2 border-amber-200 font-black text-slate-900">
                  <td className="px-3 py-3" colSpan={6}>TOTAL</td>
                  <td className="px-3 py-3 text-right"></td>
                  <td className="px-3 py-3 text-right">{reportTotals.qty.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right">{reportTotals.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  {isAdmin && <td className="px-3 py-3"></td>}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
};

export default SalesLog;
