import React, { useRef, useState } from 'react';
import { Part, Customer } from '../types';
import {
  downloadItemMasterTemplate,
  parseItemMasterExcel,
  BulkItemImportResult,
} from '../services/bulkItemImport';

interface BulkItemImportProps {
  isOpen: boolean;
  onClose: () => void;
  parts: Part[];
  customers: Customer[];
  onConfirm: (newParts: Partial<Part>[]) => void;
}

const BulkItemImport: React.FC<BulkItemImportProps> = ({ isOpen, onClose, parts, customers, onConfirm }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<BulkItemImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);

  if (!isOpen) return null;

  const reset = () => {
    setResult(null);
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
      const parsed = parseItemMasterExcel(buffer, parts, customers);
      setResult(parsed);
    } catch (err: any) {
      window.alert(`Could not read this file: ${err?.message || 'Unknown error'}`);
      reset();
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = () => {
    if (!result || result.newParts.length === 0) return;
    onConfirm(result.newParts.map(np => np.data));
    reset();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4 text-left">
      <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-3xl w-full p-10 border border-white/20 animate-in zoom-in-95 overflow-y-auto max-h-[90vh]">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="text-2xl font-black text-slate-900 leading-none mb-2">Bulk Upload Items (.xlsx)</h3>
            <p className="text-slate-500 font-medium text-sm">Download the template, fill in item details, then upload it here for review before anything is created.</p>
          </div>
          <button onClick={() => { reset(); onClose(); }} className="w-10 h-10 rounded-xl border border-slate-200 text-slate-400 hover:bg-slate-100 flex items-center justify-center">✕</button>
        </div>

        <div className="flex flex-wrap gap-4 mb-8">
          <button
            onClick={() => downloadItemMasterTemplate(customers)}
            className="px-6 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-slate-800 transition-all flex items-center gap-2"
          >
            📥 Download Template
          </button>
          <label className="px-6 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-indigo-700 transition-all cursor-pointer flex items-center gap-2">
            📤 Upload Filled Template
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFile} />
          </label>
          {fileName && <span className="self-center text-xs font-bold text-slate-500">{fileName}</span>}
        </div>

        {busy && <p className="text-sm font-bold text-slate-400 mb-6">Parsing…</p>}

        {result && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
                <div className="text-3xl font-black text-emerald-700">{result.newParts.length}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mt-1">New Items</div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-center">
                <div className="text-3xl font-black text-amber-700">{result.skippedRows.length}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-amber-600 mt-1">Skipped (SAP exists)</div>
              </div>
              <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 text-center">
                <div className="text-3xl font-black text-rose-700">{result.invalidRows.length}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-rose-600 mt-1">Invalid Rows</div>
              </div>
            </div>

            {result.newParts.length > 0 && (
              <div>
                <h4 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">New items to be created</h4>
                <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-2xl divide-y divide-slate-100">
                  {result.newParts.map(np => (
                    <div key={np.rowNum} className="px-5 py-3 flex items-center justify-between text-sm">
                      <div>
                        <span className="font-mono text-[10px] text-slate-400 mr-2">Row {np.rowNum}</span>
                        <span className="font-black text-slate-800">{np.data.name}</span>
                        <span className="text-slate-400 ml-2 font-mono text-xs">{np.data.sapCode}</span>
                        <span className="ml-2 text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">{np.data.partType === 'sheet_metal' ? 'Sheet Metal' : 'Tubular'}</span>
                      </div>
                      {np.unmatchedCustomers.length > 0 && (
                        <span className="text-[9px] font-black text-rose-500 uppercase">Unmatched customer: {np.unmatchedCustomers.join(', ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.skippedRows.length > 0 && (
              <div>
                <h4 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">Skipped rows</h4>
                <div className="max-h-40 overflow-y-auto border border-amber-100 rounded-2xl divide-y divide-amber-50">
                  {result.skippedRows.map(r => (
                    <div key={r.rowNum} className="px-5 py-2.5 flex items-center justify-between text-xs">
                      <span className="font-mono text-slate-400">Row {r.rowNum} · {r.sapCode}</span>
                      <span className="font-bold text-amber-600">{r.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.invalidRows.length > 0 && (
              <div>
                <h4 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">Invalid rows (not imported)</h4>
                <div className="max-h-40 overflow-y-auto border border-rose-100 rounded-2xl divide-y divide-rose-50">
                  {result.invalidRows.map(r => (
                    <div key={r.rowNum} className="px-5 py-2.5 flex items-center justify-between text-xs">
                      <span className="font-mono text-slate-400">Row {r.rowNum}</span>
                      <span className="font-bold text-rose-600">{r.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-4 pt-2">
              <button onClick={() => { reset(); }} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest">Start Over</button>
              <button
                onClick={handleConfirm}
                disabled={result.newParts.length === 0}
                className="flex-[2] py-4 bg-emerald-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Confirm Import ({result.newParts.length} item{result.newParts.length === 1 ? '' : 's'})
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BulkItemImport;
