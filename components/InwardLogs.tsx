import React, { useMemo, useState } from 'react';
import { InwardLog, Part, RawMaterial, RMInwardLog, InventoryCorrectionReason, INVENTORY_CORRECTION_REASON_LABELS } from '../types';
import { isSheetRM, rmAllCustomers } from '../services/rmYield';
import { getCustomerDisplayName } from '../services/customerDisplay';

// 21-Sep-26: this report was Part/SAP-code-only (InwardLog) — a raw
// material receipt only ever showed up here if its bars/pieces were
// allotted to a specific Item on the Material Entry screen. A line saved
// with Auto-Assign (or with no items ticked at all) always bumps RM stock
// correctly (visible on Inventory (RM-wise)'s RM Inward Log column) but,
// by design, never created a Part-level row here — there's nothing
// specific to attribute it to. Per Vipul's 21-Sep confirmation (Auto-Assign
// WAS ticked on the entries he couldn't find here), this report now also
// merges in every raw RMInwardLog row directly, so it's a true "everything
// that came in" ledger — both Part-allotted rows and RM-only rows,
// visually distinguished (see the 🔧 RM Receipt badge below). RM totals
// are kept in a SEPARATE stat from the Part Pcs headline (different units
// — Pipes/Kg vs Pcs — summing them together would be meaningless).
type LedgerRow = { kind: 'part'; log: InwardLog } | { kind: 'rm'; log: RMInwardLog };

// 24-Oct-26 — one normalized shape both the on-screen table and the Excel
// export read from, same pattern as SalesLog.tsx's Dispatch Report: build
// it once per row (whichever kind it is), render it twice. `customerName`
// is always the FULL real name here (used for the Excel export and as the
// un-shortened source value) — the table applies getCustomerDisplayName()
// only at render time, same as Dispatch Report.
interface NormalizedRow {
  key: string;
  kind: 'part' | 'rm';
  date: Date;
  invoiceNo: string;
  customerName: string;
  sapCode: string;
  description: string;
  sizeSpec: string;
  supplier: string;
  qty: number;
  unit: 'Pcs' | 'Pipes' | 'Kg';
  isAdj: boolean;
  isAudit: boolean;
  remarkBadge: string;
  remarkNote: string;
  deleteId: string;
}

interface InwardLogsProps {
  logs: InwardLog[];
  parts: Part[];
  auditDate?: Date;
  isAdmin?: boolean;
  onDeleteLog?: (id: string) => void;
  rmLogs?: RMInwardLog[];
  onDeleteRmLog?: (id: string) => void;
  rawMaterials?: RawMaterial[];
  localRMOpeningBalances?: Record<string, string>;
}

const InwardLogs: React.FC<InwardLogsProps> = ({
  logs,
  parts,
  auditDate = new Date(),
  isAdmin = false,
  onDeleteLog,
  rmLogs = [],
  onDeleteRmLog,
  rawMaterials = [],
  localRMOpeningBalances = {}
}) => {
  const [selectedSize, setSelectedSize] = useState<string>('All');
  // 12-Oct-26, Vipul's ask — this report mixes two different units in the
  // same list (Part-allotted rows are always Pcs; RM-only rows are Pipes,
  // or occasionally Kg — see unitLabel below), which made it hard to see
  // just one side at a time. 'Pipes' here means "every RM-kind row" (kind
  // === 'rm'), not literally unit === 'pipes' — a Kg-denominated RM
  // receipt is still an RM row, not a Pcs row, and Vipul only asked for
  // these two buckets rather than a third Kg option.
  const [selectedUom, setSelectedUom] = useState<'All' | 'Pipes' | 'Pcs'>('All');

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

  // Combines Part sizes AND RM sizes — the same size string is used for
  // both (a Part's `.size` mirrors whichever RM it's cut from), so one
  // dropdown filters both Part-allotted rows and RM-only rows together.
  const uniqueRmNames = useMemo(() => {
    const sizes = [...parts.map(p => p.size), ...rawMaterials.map(r => r.size)];
    return Array.from(new Set(sizes.filter(Boolean))).sort();
  }, [parts, rawMaterials]);

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

  // Inventory Correction ± (21-Sep-26) tags its remarks with
  // [INVENTORY_CORRECTION:reason_key] so this report can show the reason as
  // its own badge/label instead of falling through to the generic
  // "Adjustment" treatment every other negative entry gets. Store's
  // "Rejection sent to scrap" note lands here as reason 'rejection_scrap'.
  const parseInventoryCorrectionTag = (remarks?: string): { reasonKey: string; reasonLabel: string; note: string } | null => {
    if (!remarks) return null;
    const m = remarks.match(/^\[INVENTORY_CORRECTION:([a-z_]+)\]\s*/);
    if (!m) return null;
    const reasonKey = m[1];
    const reasonLabel = INVENTORY_CORRECTION_REASON_LABELS[reasonKey as InventoryCorrectionReason] || reasonKey;
    const rest = remarks.slice(m[0].length).trim();
    // rest is "<Label>" or "<Label> — <note>" (see buildCorrectionRemarks in
    // App.tsx) — strip the repeated label back off, keep only the note.
    const note = rest.replace(new RegExp(`^${reasonLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(—\\s*)?`), '').trim();
    return { reasonKey, reasonLabel, note };
  };

  // This used to also synthesize a fake "opening balance" log entry for
  // every key in localRMOpeningBalances, to backfill visibility for
  // corrections made before onAddInward-based audit logging existed. Now
  // that every real correction (commitOpeningBalance/commitRMOpeningBalance
  // in Inventory.tsx) always writes a real, properly-dated `logs` entry via
  // onAddInward, that synthesis was pure liability: App.tsx passes this
  // component the ALREADY-RESOLVED per-month balance (resolvedRMOpeningBalances
  // — one flat value per RM, no month embedded in its keys), but the
  // synthesis logic was written expecting the raw multi-month override map
  // (keys like "2026-09_<rmId>"). Since a bare RM id never contains an
  // underscore, `key.includes('_')` was always false here, so `mK` always
  // fell back to whatever month is currently being viewed — meaning EVERY
  // RM's balance got stamped as "set today, from Previous 0" for whichever
  // month you happened to have open, every time, regardless of whether any
  // real correction happened that month. That's what made RM Opening
  // Balance look like it "auto-freezes every month" when it doesn't, and
  // why the date-range filter here looked unreliable — confirmed bug, now
  // just returning the real, already-logged entries directly.
  const allLogsWithAudits = logs;

  const filteredLogs = useMemo(() => {
    const start = new Date(startDate);
    start.setHours(0,0,0,0);
    const end = new Date(endDate);
    end.setHours(23,59,59,999);

    if (selectedUom === 'Pipes') return [];

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
  }, [allLogsWithAudits, parts, startDate, endDate, selectedSize, selectedUom]);

  // RM-only rows for the same date/size window. 'Opening inventory
  // correction' stays a Part-level-only concept (RM has no equivalent
  // audit-tagged opening-balance log here) so that mode still returns
  // nothing for RM. 'Discrepancy Control Entry' USED to be Part-only too,
  // but since Inventory Correction ± (21-Sep-26) can now post a negative
  // entry on the RM side as well (e.g. Longer Pipe rejection/scrap), this
  // mode now also surfaces negative RM receipts so Store's "Rejection sent
  // to scrap" entries are filterable here regardless of which side (RM or
  // Part) they were posted against.
  const filteredRmLogs = useMemo(() => {
    if (selectedSize === 'Opening inventory correction') return [];
    if (selectedUom === 'Pcs') return [];
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    return rmLogs.filter(log => {
      const d = new Date(log.timestamp);
      const matchesDate = d >= start && d <= end;

      if (selectedSize === 'Discrepancy Control Entry') {
        return matchesDate && log.quantity < 0;
      }

      if (selectedSize !== 'All') {
        const rm = rawMaterials.find(r => r.id === log.rmId);
        return matchesDate && (rm?.size || log.rmSize) === selectedSize;
      }
      return matchesDate;
    });
  }, [rmLogs, rawMaterials, startDate, endDate, selectedSize, selectedUom]);

  // Separate from totalRangeInward below on purpose — Pipes/Kg (RM) and
  // Pcs (Part) are different units and summing them into one number would
  // be meaningless.
  const rmTotals = useMemo(() => {
    let pipes = 0, kg = 0;
    filteredRmLogs.forEach(l => { if (l.unit === 'kg') kg += l.quantity; else pipes += l.quantity; });
    return { pipes, kg };
  }, [filteredRmLogs]);

  const combinedRows = useMemo((): LedgerRow[] => [
    ...filteredLogs.map((log): LedgerRow => ({ kind: 'part', log })),
    ...filteredRmLogs.map((log): LedgerRow => ({ kind: 'rm', log })),
  ], [filteredLogs, filteredRmLogs]);

  const totalRangeInward = useMemo(() => {
    return filteredLogs.reduce((acc, l) => acc + l.quantity, 0);
  }, [filteredLogs]);

  // 24-Oct-26 — one normalized row per entry (whichever kind), newest
  // first (same net ordering the old date-grouped accordion produced:
  // dates newest-first, and within a date, entries newest-first too — a
  // single descending sort by full timestamp reproduces that exactly).
  // Feeds both the flat table below and the Excel export, so they always
  // show the same rows in the same order.
  const reportRows = useMemo((): NormalizedRow[] => {
    const rows: NormalizedRow[] = combinedRows.map(row => {
      if (row.kind === 'rm') {
        const log = row.log;
        const isAdj = log.quantity < 0;
        const rm = rawMaterials.find(r => r.id === log.rmId);
        const correctionTag = isAdj ? parseInventoryCorrectionTag(log.remarks) : null;
        return {
          key: `rm_${log.id}`,
          kind: 'rm',
          date: new Date(log.timestamp),
          invoiceNo: log.invoiceNumber || '-',
          customerName: rm ? rmAllCustomers(rm).join(', ') : 'N/A',
          sapCode: '—',
          description: `RM Receipt — ${rm?.size || log.rmSize}`,
          sizeSpec: rm?.size || log.rmSize,
          supplier: log.supplier,
          qty: log.quantity,
          unit: log.unit === 'kg' ? 'Kg' : 'Pipes',
          isAdj,
          isAudit: false,
          remarkBadge: correctionTag ? `📋 ${correctionTag.reasonLabel}` : '🔧 RM Receipt',
          remarkNote: correctionTag ? correctionTag.note : (log.remarks || 'Standard RM Inward — not yet allotted to a specific item'),
          deleteId: log.id,
        };
      }

      const log = row.log;
      const isAdj = log.quantity < 0;
      const isAudit = isAuditLog(log);
      const part = parts.find(p => p.id === log.partId);
      const rm = rawMaterials.find(r => r.partId === log.partId || r.id === log.partId);
      const correctionTag = isAdj ? parseInventoryCorrectionTag(log.remarks) : null;

      let remarkBadge = '📝 Standard Inward';
      let remarkNote = '';
      if (isAudit) {
        remarkBadge = '⚙️ Opening Audit Record';
        remarkNote = formatAuditRemarks(log);
      } else if (correctionTag) {
        remarkBadge = `📋 ${correctionTag.reasonLabel}`;
        remarkNote = correctionTag.note;
      } else if (isAdj) {
        remarkBadge = '⚠️ Adjustment';
        remarkNote = log.remarks || '';
      }

      return {
        key: `part_${log.id}`,
        kind: 'part',
        date: new Date(log.timestamp),
        invoiceNo: log.invoiceNumber || (isAudit ? 'ADMIN_AUDIT' : '-'),
        customerName: part?.mappedCustomers?.join(', ') || rm?.customerName || 'N/A',
        sapCode: log.sapCode,
        description: log.partName,
        sizeSpec: part?.size || rm?.size || 'N/A',
        supplier: log.supplier,
        qty: log.quantity,
        unit: 'Pcs',
        isAdj,
        isAudit,
        remarkBadge,
        remarkNote,
        deleteId: log.id,
      };
    });

    return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [combinedRows, parts, rawMaterials]);

  const formatDateDisplay = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${d}-${m}-${y}`;
  };

  // 24-Oct-26 rewrite — same move as Dispatch Report's exportToExcel:
  // switched from the free `xlsx` package (can't style cells at all) to
  // `exceljs`, loaded on demand (not a static import) so it doesn't bloat
  // every user's initial page load. Column set/order is unchanged from
  // before — only the styling (bold colored header, grid borders) and a
  // new TOTAL row are new.
  const exportToExcel = async () => {
    if (reportRows.length === 0) return;

    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();

    const sheetName =
      selectedSize === 'Discrepancy Control Entry' ? 'Discrepancy Control' :
      selectedSize === 'Opening inventory correction' ? 'Opening Corrections' :
      'Inward Logs';
    const worksheet = workbook.addWorksheet(sheetName);

    worksheet.columns = [
      { width: 10.375 }, // Date
      { width: 9 },      // Time
      { width: 24 },     // Customer Name
      { width: 17.375 }, // Invoice / Ref No.
      { width: 13 },     // SAP Code
      { width: 28 },     // Part / Material Description
      { width: 16.75 },  // RM Size/Specifications
      { width: 18 },     // Supplier/Authorized By
      { width: 13 },     // Quantity / Adjustment
      { width: 8 },      // Unit
      { width: 45 },     // Remarks / Audit Record
    ];

    const headerRow = worksheet.addRow([
      'Date', 'Time', 'Customer Name', 'Invoice / Ref No.', 'SAP Code',
      'Part / Material Description', 'RM Size/\nSpecifications', 'Supplier/Authorized By',
      'Quantity / Adjustment', 'Unit', 'Remarks / Audit Record',
    ]);
    headerRow.height = 30;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, size: 11 };
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
        r.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        r.customerName,
        r.invoiceNo,
        r.sapCode,
        r.description,
        r.sizeSpec,
        r.supplier,
        r.qty,
        r.unit,
        [r.remarkBadge.replace(/^[^\s]+\s/, ''), r.remarkNote].filter(Boolean).join(' — '),
      ]);
      row.getCell(9).numFmt = '#,##0';
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' },
        };
      });
    });

    const totalParts = [
      totalRangeInward !== 0 ? `${totalRangeInward.toLocaleString()} Pcs` : null,
      rmTotals.pipes !== 0 ? `${rmTotals.pipes > 0 ? '+' : ''}${rmTotals.pipes.toLocaleString()} Pipes` : null,
      rmTotals.kg !== 0 ? `${rmTotals.kg > 0 ? '+' : ''}${rmTotals.kg.toLocaleString()} Kg` : null,
    ].filter(Boolean).join(' / ');
    const totalRow = worksheet.addRow(['TOTAL', '', '', '', '', '', '', '', totalParts, '', '']);
    totalRow.eachCell(cell => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    });
    worksheet.mergeCells(`A${totalRow.number}:H${totalRow.number}`);

    const specName =
      selectedSize === 'Discrepancy Control Entry' ? 'Discrepancy_Control_Entry' :
      selectedSize === 'Opening inventory correction' ? 'Opening_Inventory_Correction' :
      selectedSize.replace(/[/\\?%*:|"<>]/g, '-');

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RM_Ledger_Report_${specName}_${startDate}_to_${endDate}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDelete = (id: string) => {
    if (window.confirm("Admin Alert: Are you sure you want to delete this log? Plant balance will be adjusted.")) {
      onDeleteLog?.(id);
    }
  };

  const handleDeleteRm = (id: string) => {
    if (window.confirm("Admin Alert: Are you sure you want to delete this RM receipt? Raw material stock will be adjusted.")) {
      onDeleteRmLog?.(id);
    }
  };

  const qtyColorClass = (r: NormalizedRow) => {
    if (r.kind === 'rm') return r.isAdj ? 'text-rose-600' : 'text-indigo-600';
    if (r.isAudit) return 'text-amber-700';
    return r.isAdj ? 'text-rose-600' : 'text-emerald-600';
  };

  const rowTintClass = (r: NormalizedRow) => {
    if (r.kind === 'rm') return r.isAdj ? 'bg-rose-50/40 border-l-4 border-l-rose-400' : 'bg-indigo-50/40 border-l-4 border-l-indigo-400';
    if (r.isAudit) return 'bg-amber-50/60 border-l-4 border-l-amber-400';
    if (r.isAdj) return 'bg-rose-50/40 border-l-4 border-l-rose-400';
    return '';
  };

  const badgeClass = (r: NormalizedRow) => {
    if (r.isAudit) return 'bg-amber-100 text-amber-800 border-amber-300';
    if (r.kind === 'rm' && !r.isAdj) return 'bg-indigo-100 text-indigo-800 border-indigo-300';
    if (r.isAdj && r.remarkBadge.includes('📋')) return 'bg-amber-100 text-amber-800 border-amber-300';
    if (r.isAdj) return 'bg-rose-100 text-rose-700 border-rose-200';
    return 'bg-slate-100 text-slate-400 border-slate-200';
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

          <div className="space-y-3 text-left">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 text-left">UOM</label>
            <select
              className="px-6 py-4 bg-white border-2 border-slate-100 rounded-2xl focus:border-emerald-500 outline-none w-full transition-all shadow-inner font-bold text-slate-800"
              value={selectedUom}
              onChange={(e) => setSelectedUom(e.target.value as 'All' | 'Pipes' | 'Pcs')}
            >
              <option value="All">All</option>
              <option value="Pipes">Pipes</option>
              <option value="Pcs">Pcs</option>
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
                  <input type="date" className="date-icon-overlay absolute inset-0 opacity-0 cursor-pointer w-full" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
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
                  <input type="date" className="date-icon-overlay absolute inset-0 opacity-0 cursor-pointer w-full" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                  <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-all">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4 min-w-[180px]">
            <button onClick={exportToExcel} disabled={reportRows.length === 0} className="flex-1 bg-emerald-600 text-white px-8 py-4 h-[72px] rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-emerald-700 transition-all flex items-center justify-center gap-3 shadow-xl shadow-emerald-100 active:scale-95 disabled:opacity-50 disabled:grayscale">
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
              {(rmTotals.pipes !== 0 || rmTotals.kg !== 0) && (
                <p className="text-[11px] font-bold opacity-80 mt-1.5 text-left">
                  {[
                    rmTotals.pipes !== 0 ? `${rmTotals.pipes > 0 ? '+' : ''}${rmTotals.pipes.toLocaleString()} Pipes` : null,
                    rmTotals.kg !== 0 ? `${rmTotals.kg > 0 ? '+' : ''}${rmTotals.kg.toLocaleString()} Kg` : null,
                  ].filter(Boolean).join(' / ')} {selectedSize === 'Discrepancy Control Entry' ? 'RM-side correction (raw material)' : 'RM received (raw material, before item allotment)'}
                </p>
              )}
            </div>
         </div>
         {selectedSize === 'Discrepancy Control Entry' && (
           <span className="bg-white/20 px-5 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest backdrop-blur-sm">
             {filteredLogs.length + filteredRmLogs.length} Negative {(filteredLogs.length + filteredRmLogs.length) === 1 ? 'Entry' : 'Entries'}
           </span>
         )}
         {selectedSize === 'Opening inventory correction' && (
           <span className="bg-white/20 px-5 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest backdrop-blur-sm">
             {filteredLogs.length} Correction {filteredLogs.length === 1 ? 'Record' : 'Records'}
           </span>
         )}
      </div>

      {/* 24-Oct-26 — date-grouped expand/collapse accordion replaced with a
          flat table + pinned TOTAL row, same pattern as Dispatch Report.
          Fixed percentage column widths (table-layout: fixed) so this never
          needs a horizontal scrollbar — long text truncates with the full
          value on hover via title. Pcs/Pipes/Kg are kept as separate
          figures in the total row, same as the banner above — summing them
          together would be meaningless. */}
      <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden pb-2">
        <div className="max-h-[70vh] overflow-y-auto">
          <table className="w-full text-left border-collapse table-fixed text-[11px]">
            <colgroup>
              <col style={{ width: '9%' }} />
              <col style={{ width: isAdmin ? '8%' : '9%' }} />
              <col style={{ width: isAdmin ? '13%' : '14%' }} />
              <col style={{ width: '6%' }} />
              <col style={{ width: isAdmin ? '14%' : '15%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: isAdmin ? '15%' : '18%' }} />
              {isAdmin && <col style={{ width: '5%' }} />}
            </colgroup>
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr className="text-slate-900 uppercase font-black tracking-widest border-b-2 border-slate-200">
                <th className="px-3 py-3">Date</th>
                <th className="px-3 py-3">Invoice No.</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3">SAP Code</th>
                <th className="px-3 py-3">Description</th>
                <th className="px-3 py-3">Size/Spec</th>
                <th className="px-3 py-3">Supplier</th>
                <th className="px-3 py-3 text-right">Qty</th>
                <th className="px-3 py-3">Remark</th>
                {isAdmin && <th className="px-3 py-3 text-center">Admin</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reportRows.map(r => (
                <tr key={r.key} className={`hover:bg-slate-50 transition-colors ${rowTintClass(r)}`}>
                  <td className="px-3 py-2.5 truncate" title={r.date.toLocaleString('en-GB')}>
                    {r.date.toLocaleDateString('en-GB')} <span className="text-slate-400">{r.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </td>
                  <td className="px-3 py-2.5 truncate font-mono text-indigo-600" title={r.invoiceNo}>{r.invoiceNo}</td>
                  <td className="px-3 py-2.5 truncate" title={r.customerName}>{getCustomerDisplayName(r.customerName)}</td>
                  <td className="px-3 py-2.5 truncate font-mono" title={r.sapCode}>{r.sapCode}</td>
                  <td className="px-3 py-2.5 truncate font-bold" title={r.description}>{r.description}</td>
                  <td className="px-3 py-2.5 truncate" title={r.sizeSpec}>{r.sizeSpec}</td>
                  <td className="px-3 py-2.5 truncate" title={r.supplier}>{r.supplier}</td>
                  <td className={`px-3 py-2.5 text-right font-black ${qtyColorClass(r)}`}>
                    {r.qty > 0 ? `+${r.qty.toLocaleString()}` : r.qty.toLocaleString()} <span className="text-[9px] font-bold uppercase">{r.unit}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-tight border ${badgeClass(r)}`}>{r.remarkBadge}</span>
                    {r.remarkNote && <div className="text-[10px] text-slate-500 italic truncate mt-0.5" title={r.remarkNote}>{r.remarkNote}</div>}
                  </td>
                  {isAdmin && (
                    <td className="px-3 py-2.5 text-center">
                      <button onClick={() => r.kind === 'rm' ? handleDeleteRm(r.deleteId) : handleDelete(r.deleteId)} className="w-7 h-7 bg-rose-50 text-rose-600 rounded-lg hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center mx-auto">
                        🗑️
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {reportRows.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 10 : 9} className="px-3 py-10 text-center text-slate-400 font-bold">
                    No inward entries match this filter.
                  </td>
                </tr>
              )}
            </tbody>
            {reportRows.length > 0 && (
              <tfoot className="sticky bottom-0 z-10">
                <tr className="bg-amber-50 border-t-2 border-amber-200 font-black text-slate-900">
                  <td className="px-3 py-3" colSpan={7}>TOTAL</td>
                  <td className="px-3 py-3 text-right whitespace-normal leading-tight">
                    {[
                      totalRangeInward !== 0 ? `${totalRangeInward.toLocaleString()} Pcs` : null,
                      rmTotals.pipes !== 0 ? `${rmTotals.pipes > 0 ? '+' : ''}${rmTotals.pipes.toLocaleString()} Pipes` : null,
                      rmTotals.kg !== 0 ? `${rmTotals.kg > 0 ? '+' : ''}${rmTotals.kg.toLocaleString()} Kg` : null,
                    ].filter(Boolean).map((t, i) => <div key={i}>{t}</div>)}
                  </td>
                  <td className="px-3 py-3"></td>
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

export default InwardLogs;
