import React, { useMemo, useRef, useState } from 'react';
import { writeBatch, doc, collection } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Part, Customer, AdminAlert } from '../types';
import {
  parseScheduleWorkbook,
  buildScheduleRows,
  ParsedScheduleSheet,
} from '../services/bulkScheduleImport';

interface BulkScheduleImportProps {
  isOpen: boolean;
  onClose: () => void;
  parts: Part[];
  customers: Customer[];
  onConfirm: (updates: { partId: string; customerName: string; qty: number }[]) => void;
  onCreateAlert?: (partial: Partial<AdminAlert> & Pick<AdminAlert, 'type'>) => void;
}

const colLabel = (idx: number): string => {
  let n = idx, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

const columnPreview = (rows: any[][], colIdx: number, n = 3): string => {
  const samples: string[] = [];
  for (const row of rows) {
    const v = row[colIdx];
    const text = v === undefined || v === null ? '' : String(v).trim();
    if (text) samples.push(text);
    if (samples.length >= n) break;
  }
  return samples.join(', ') || '(empty)';
};

const BulkScheduleImport: React.FC<BulkScheduleImportProps> = ({ isOpen, onClose, parts, customers, onConfirm, onCreateAlert }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sheets, setSheets] = useState<ParsedScheduleSheet[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);

  // Must run on every render regardless of `isOpen` — the early return
  // below skips everything after it, and a hook called only when isOpen is
  // true changes this component's hook count between renders, which is
  // exactly what triggered the "Rendered more hooks than during the
  // previous render" crash the moment the modal was opened (React error
  // #310). All hooks live above the early return now.
  const totals = useMemo(() => {
    if (!sheets) return { updates: 0, unmatched: 0, readySheets: 0 };
    let updates = 0, unmatched = 0, readySheets = 0;
    sheets.forEach(s => {
      if (s.customerName) { updates += s.updates.length; readySheets++; }
      unmatched += s.unmatched.length;
    });
    return { updates, unmatched, readySheets };
  }, [sheets]);

  if (!isOpen) return null;

  const reset = () => {
    setSheets(null);
    setFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseScheduleWorkbook(buffer, parts, customers);
      setSheets(parsed);
    } catch (err: any) {
      window.alert(`Could not read this file: ${err?.message || 'Unknown error'}`);
      reset();
    } finally {
      setBusy(false);
    }
  };

  const overrideSheet = (idx: number, patch: { customerName?: string | null; sapColIndex?: number; qtyColIndex?: number }) => {
    setSheets(prev => {
      if (!prev) return prev;
      const next = [...prev];
      const sheet = { ...next[idx], ...patch };
      const { updates, unmatched } = buildScheduleRows(sheet.rows, sheet.sapColIndex, sheet.qtyColIndex, sheet.customerName, parts);
      sheet.updates = updates;
      sheet.unmatched = unmatched;
      next[idx] = sheet;
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!sheets) return;
    const allUpdates: { partId: string; customerName: string; qty: number }[] = [];
    const unresolvedIssues: { sheetName: string; customerName: string | null; sapCodeText: string; qtyText: string }[] = [];

    sheets.forEach(s => {
      if (s.customerName) {
        s.updates.forEach(u => allUpdates.push({ partId: u.partId, customerName: s.customerName as string, qty: u.qty }));
      }
      s.unmatched.forEach(u => unresolvedIssues.push({ sheetName: s.sheetName, customerName: s.customerName, sapCodeText: u.sapCodeText, qtyText: u.qtyText }));
    });

    if (allUpdates.length === 0) {
      window.alert('No matched rows with a customer assigned — nothing to import. Pick a customer for at least one sheet first.');
      return;
    }

    setWriting(true);
    try {
      // Log every row we couldn't confidently match to importIssues (Admin
      // write is allowed per firestore.rules) so it isn't silently dropped —
      // same "unresolved rows recorded, not discarded" pattern the Tally
      // importer already uses for its own unmatched items.
      if (unresolvedIssues.length > 0) {
        const nowIso = new Date().toISOString();
        for (let i = 0; i < unresolvedIssues.length; i += 450) {
          const chunk = unresolvedIssues.slice(i, i + 450);
          const batch = writeBatch(db);
          chunk.forEach(u => {
            const ref = doc(collection(db, 'importIssues'));
            batch.set(ref, {
              type: 'schedule_unmatched',
              invoiceNumber: u.sheetName,
              date: nowIso,
              customer: u.customerName,
              rawText: `${u.sapCodeText}${u.qtyText ? ` — Qty: ${u.qtyText}` : ''}`,
              quantity: parseFloat(u.qtyText) || 0,
              createdAt: nowIso,
            });
          });
          // eslint-disable-next-line no-await-in-loop
          await batch.commit();
        }
      }

      onConfirm(allUpdates);

      if (onCreateAlert) {
        const bySheet = sheets.filter(s => s.customerName && s.updates.length > 0);
        onCreateAlert({
          type: 'schedule_bulk_import',
          itemCount: allUpdates.length,
          details: bySheet.map(s => `${s.customerName} (${s.sheetName}): ${s.updates.length} schedule(s) updated`).join('\n')
            + (unresolvedIssues.length > 0 ? `\n${unresolvedIssues.length} row(s) unmatched — see Import Issues` : ''),
        });
      }

      reset();
      onClose();
    } catch (err: any) {
      window.alert(`Import failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4 text-left">
      <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-5xl w-full p-10 border border-white/20 animate-in zoom-in-95 overflow-y-auto max-h-[92vh]">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="text-2xl font-black text-slate-900 leading-none mb-2">Bulk Upload Customer Schedules (.xlsx)</h3>
            <p className="text-slate-500 font-medium text-sm max-w-2xl">
              One sheet per customer — paste each customer's schedule table from the email into its own sheet, name the sheet after the customer, then upload. SAP Code and Quantity columns are auto-detected; check and correct them below before confirming. This <span className="font-black text-slate-700">overwrites</span> existing schedule values for matched rows.
            </p>
          </div>
          <button onClick={() => { reset(); onClose(); }} className="w-10 h-10 rounded-xl border border-slate-200 text-slate-400 hover:bg-slate-100 flex items-center justify-center">✕</button>
        </div>

        <div className="flex flex-wrap gap-4 mb-8">
          <label className="px-6 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-indigo-700 transition-all cursor-pointer flex items-center gap-2">
            📤 Upload Workbook
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFile} />
          </label>
          {fileName && <span className="self-center text-xs font-bold text-slate-500">{fileName}</span>}
        </div>

        {busy && <p className="text-sm font-bold text-slate-400 mb-6">Parsing…</p>}

        {sheets && (
          <div className="space-y-8">
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
                <div className="text-3xl font-black text-emerald-700">{totals.updates}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mt-1">Schedules to Update</div>
              </div>
              <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-5 text-center">
                <div className="text-3xl font-black text-indigo-700">{totals.readySheets}/{sheets.length}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-indigo-600 mt-1">Sheets with Customer Assigned</div>
              </div>
              <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 text-center">
                <div className="text-3xl font-black text-rose-700">{totals.unmatched}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-rose-600 mt-1">Unmatched Rows</div>
              </div>
            </div>

            {sheets.map((sheet, idx) => (
              <div key={sheet.sheetName} className="border border-slate-200 rounded-[2rem] p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <h4 className="text-sm font-black text-slate-900 uppercase tracking-tight">📄 {sheet.sheetName}</h4>
                  <div className="flex flex-wrap gap-3">
                    <div className="flex flex-col">
                      <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Customer</label>
                      <select
                        className={`px-4 py-2.5 border-2 rounded-xl font-bold text-xs outline-none ${sheet.customerName ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-700'}`}
                        value={sheet.customerName || ''}
                        onChange={(e) => overrideSheet(idx, { customerName: e.target.value || null })}
                      >
                        <option value="">-- Select Customer --</option>
                        {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col">
                      <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">SAP Code Column</label>
                      <select
                        className="px-4 py-2.5 border-2 border-slate-200 rounded-xl font-bold text-xs outline-none bg-white"
                        value={sheet.sapColIndex}
                        onChange={(e) => overrideSheet(idx, { sapColIndex: parseInt(e.target.value) })}
                      >
                        <option value={-1}>-- Not detected --</option>
                        {Array.from({ length: sheet.columnCount }, (_, c) => (
                          <option key={c} value={c}>Col {colLabel(c)} — e.g. {columnPreview(sheet.rows, c)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col">
                      <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Quantity Column</label>
                      <select
                        className="px-4 py-2.5 border-2 border-slate-200 rounded-xl font-bold text-xs outline-none bg-white"
                        value={sheet.qtyColIndex}
                        onChange={(e) => overrideSheet(idx, { qtyColIndex: parseInt(e.target.value) })}
                      >
                        <option value={-1}>-- Not detected --</option>
                        {Array.from({ length: sheet.columnCount }, (_, c) => (
                          <option key={c} value={c}>Col {colLabel(c)} — e.g. {columnPreview(sheet.rows, c)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {!sheet.customerName && (
                  <p className="text-[10px] font-black text-rose-600 uppercase tracking-widest">⚠️ No customer assigned — this sheet's {sheet.updates.length} matched row(s) will NOT be imported until you pick one.</p>
                )}

                {sheet.updates.length > 0 && (
                  <div className="max-h-52 overflow-y-auto border border-slate-100 rounded-2xl divide-y divide-slate-100">
                    <div className="px-5 py-2 bg-slate-50 flex items-center justify-between text-[9px] font-black uppercase tracking-widest text-slate-400 sticky top-0">
                      <span>Item</span>
                      <span>Old → New</span>
                    </div>
                    {sheet.updates.map(u => (
                      <div key={u.rowIndex} className="px-5 py-2.5 flex items-center justify-between text-sm">
                        <div>
                          <span className="font-black text-slate-800">{u.partName}</span>
                          <span className="text-slate-400 ml-2 font-mono text-xs">{u.sapCode}</span>
                        </div>
                        <span className="font-black text-xs">
                          <span className="text-slate-400">{u.oldValue}</span>
                          <span className="text-slate-300 mx-1">→</span>
                          <span className={u.qty !== u.oldValue ? 'text-emerald-600' : 'text-slate-500'}>{u.qty}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {sheet.unmatched.length > 0 && (
                  <div className="max-h-32 overflow-y-auto border border-amber-100 rounded-2xl divide-y divide-amber-50">
                    <div className="px-5 py-2 bg-amber-50 text-[9px] font-black uppercase tracking-widest text-amber-600 sticky top-0">
                      Unmatched ({sheet.unmatched.length}) — will be logged to Import Issues
                    </div>
                    {sheet.unmatched.map(u => (
                      <div key={u.rowIndex} className="px-5 py-2 text-xs font-mono text-slate-500">
                        {u.sapCodeText} {u.qtyText && `— Qty: ${u.qtyText}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            <div className="flex gap-4 pt-2">
              <button onClick={() => { reset(); }} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest">Start Over</button>
              <button
                onClick={handleConfirm}
                disabled={totals.updates === 0 || writing}
                className="flex-[2] py-4 bg-emerald-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {writing ? 'Importing…' : `Confirm Import (${totals.updates} schedule${totals.updates === 1 ? '' : 's'})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BulkScheduleImport;
