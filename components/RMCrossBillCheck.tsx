import React, { useState, useMemo, useEffect } from 'react';
import { RMManufacturerInvoice, RMCustomerCrossInvoice, RMMaterialLength, Customer } from '../types';

const NEW_OPTION = '__new__';

interface RMCrossBillCheckProps {
  manufacturerInvoices: RMManufacturerInvoice[];
  crossInvoices: RMCustomerCrossInvoice[];
  materialLengths: RMMaterialLength[];
  customers: Customer[];
  setManufacturerInvoices: (update: RMManufacturerInvoice[] | ((prev: RMManufacturerInvoice[]) => RMManufacturerInvoice[])) => void;
  setCrossInvoices: (update: RMCustomerCrossInvoice[] | ((prev: RMCustomerCrossInvoice[]) => RMCustomerCrossInvoice[])) => void;
  setMaterialLengths: (update: RMMaterialLength[] | ((prev: RMMaterialLength[]) => RMMaterialLength[])) => void;
  isAdmin?: boolean;
}

const genId = () => Math.random().toString(36).substr(2, 9);

const ageInDays = (dateStr: string) => Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));

const ageBand = (days: number) => {
  if (days <= 21) return { label: 'Normal wait', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  if (days <= 42) return { label: 'Getting old', color: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { label: 'Overdue — chase this', color: 'bg-rose-50 text-rose-700 border-rose-200' };
};

// Material names encode the piece length differently depending on the
// manufacturer's own convention, so this tries two patterns:
//   A) a dimension chain followed by "/<length>", e.g.
//      "80.00X40.00X4.80/5100 YST310" -> 5100 (Avon Tubetech style — the
//      "/" is an explicit, unambiguous separator, so this is tried first).
//   B) the LAST number in an all-"x"-separated dimension chain, e.g.
//      "ERW STEEL TUBES-REC-SBR-60x30x3x4250-AS ROLLED" -> 4250 (Tube
//      Investments style — length is just the trailing number).
// Best-effort guess at your naming convention, not a guarantee — always
// editable/correctable.
const parsePieceLengthFromMaterialName = (name: string): number | null => {
  const slashMatch = name.match(/\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)+\s*\/\s*(\d+(?:\.\d+)?)/i);
  if (slashMatch) {
    const length = parseFloat(slashMatch[1]);
    if (Number.isFinite(length)) return length;
  }
  const chains = name.match(/\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?){1,}/gi);
  if (!chains || chains.length === 0) return null;
  const lastChain = chains[chains.length - 1];
  const numbers = lastChain.split(/x/i).map(s => parseFloat(s.trim()));
  const lastNumber = numbers[numbers.length - 1];
  return Number.isFinite(lastNumber) ? lastNumber : null;
};

// Permanent field header above an input/select — unlike a placeholder, this
// stays visible once the field has a value, so it's always clear what the
// box is for even after it's filled in.
const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 px-1">{label}</label>
    {children}
  </div>
);

const RMCrossBillCheck: React.FC<RMCrossBillCheckProps> = ({
  manufacturerInvoices, crossInvoices, materialLengths, customers,
  setManufacturerInvoices, setCrossInvoices, setMaterialLengths, isAdmin,
}) => {
  const [showMfgForm, setShowMfgForm] = useState(false);
  const [showCrossForm, setShowCrossForm] = useState(false);
  const [markupThreshold, setMarkupThreshold] = useState<string>('');
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkFile, setBulkFile] = useState<{ name: string; data: any } | null>(null);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [showMaterialLengths, setShowMaterialLengths] = useState(false);
  const [filterManufacturer, setFilterManufacturer] = useState('');
  const [filterMonth, setFilterMonth] = useState('');

  const handleBulkFile = (file: File) => {
    setBulkStatus(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        setBulkFile({ name: file.name, data: parsed });
      } catch {
        setBulkStatus('Could not parse this file as JSON.');
        setBulkFile(null);
      }
    };
    reader.readAsText(file);
  };

  const runBulkImport = () => {
    if (!bulkFile) return;
    const { rmManufacturerInvoices = [], rmCustomerCrossInvoices = [], rmMaterialLengths = [] } = bulkFile.data;
    setManufacturerInvoices(prev => [...prev, ...rmManufacturerInvoices]);
    setCrossInvoices(prev => [...prev, ...rmCustomerCrossInvoices]);
    setMaterialLengths(prev => {
      const existingCodes = new Set(prev.map((m: RMMaterialLength) => m.materialCode));
      return [...prev, ...rmMaterialLengths.filter((m: RMMaterialLength) => !existingCodes.has(m.materialCode))];
    });
    setBulkStatus(`Imported ${rmManufacturerInvoices.length} manufacturer invoices, ${rmCustomerCrossInvoices.length} matched cross-invoices, ${rmMaterialLengths.length} material lengths.`);
    setBulkFile(null);
  };

  // --- Material Lengths admin editor ---
  // Piece length is locked on the Manufacturer Invoice form once a material
  // is selected (by design — see the Material Name field below), which
  // means a wrong recorded value (e.g. from an early parsing bug, or a
  // typo) has no other way to get corrected. This gives admins a direct,
  // explicit place to fix one.
  const [lengthEdits, setLengthEdits] = useState<Record<string, string>>({});
  const [justSavedCode, setJustSavedCode] = useState<string | null>(null);
  useEffect(() => {
    if (!showMaterialLengths) return;
    const initial: Record<string, string> = {};
    materialLengths.forEach(m => { initial[m.materialCode] = String(m.lengthMm); });
    setLengthEdits(initial);
    // Only re-seed when the modal opens, not on every materialLengths
    // change thereafter — otherwise saving one row while another is
    // mid-edit would wipe out the unsaved one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMaterialLengths]);
  const saveMaterialLength = (code: string) => {
    const parsed = parseFloat(lengthEdits[code]);
    if (!Number.isFinite(parsed)) return;
    setMaterialLengths(prev => prev.map(m => m.materialCode === code ? { ...m, lengthMm: parsed, updatedAt: new Date().toISOString() } : m));
    setJustSavedCode(code);
    setTimeout(() => setJustSavedCode(current => (current === code ? null : current)), 1500);
  };

  const outstanding = useMemo(
    () => manufacturerInvoices.filter(m => !m.matchedCrossInvoiceId).sort((a, b) => a.date.localeCompare(b.date)),
    [manufacturerInvoices]
  );
  const matched = useMemo(
    () => manufacturerInvoices.filter(m => m.matchedCrossInvoiceId).sort((a, b) => b.date.localeCompare(a.date)),
    [manufacturerInvoices]
  );

  // Filter bar options — manufacturer names and months are both derived
  // straight from the data on file, so the dropdowns only ever offer
  // choices that actually have invoices behind them.
  const filterManufacturerOptions = useMemo(
    () => Array.from(new Set(manufacturerInvoices.map(m => m.manufacturerName.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [manufacturerInvoices]
  );
  const filterMonthOptions = useMemo(() => {
    const months = new Set(manufacturerInvoices.map(m => (m.date || '').slice(0, 7)).filter(Boolean));
    return Array.from(months).sort().reverse().map(ym => {
      const [y, mo] = ym.split('-').map(Number);
      return { value: ym, label: new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
    });
  }, [manufacturerInvoices]);

  const matchesFilters = (m: RMManufacturerInvoice) =>
    (!filterManufacturer || m.manufacturerName === filterManufacturer) &&
    (!filterMonth || (m.date || '').slice(0, 7) === filterMonth);

  const filteredOutstanding = useMemo(() => outstanding.filter(matchesFilters), [outstanding, filterManufacturer, filterMonth]);
  const filteredMatched = useMemo(() => matched.filter(matchesFilters), [matched, filterManufacturer, filterMonth]);
  const filtersActive = Boolean(filterManufacturer || filterMonth);

  // --- Manufacturer Invoice form ---
  const blankMfgForm = () => ({
    manufacturerName: '', customerName: customers[0]?.name || '', invoiceNo: '', date: '',
    materialName: '', materialCode: '', quantityPcs: 0, ratePerPc: 0, itemValue: 0,
  });
  const [mfgForm, setMfgForm] = useState(blankMfgForm);
  const [mfgLengthInput, setMfgLengthInput] = useState('');
  const [addingNewManufacturer, setAddingNewManufacturer] = useState(false);
  const [addingNewMaterial, setAddingNewMaterial] = useState(false);
  const knownLength = materialLengths.find(m => m.materialCode.toUpperCase() === mfgForm.materialCode.toUpperCase().trim());

  // Every open of the modal (via the "+ Manufacturer Invoice" button or
  // Cancel) should start completely fresh — nothing carried over from a
  // previous open, whether it was submitted, cancelled, or left mid-"+ Add
  // New" entry.
  const openFreshMfgForm = () => {
    setMfgForm(blankMfgForm());
    setMfgLengthInput('');
    setAddingNewManufacturer(false);
    setAddingNewMaterial(false);
    setShowMfgForm(true);
  };
  const closeMfgForm = () => {
    setMfgForm(blankMfgForm());
    setMfgLengthInput('');
    setAddingNewManufacturer(false);
    setAddingNewMaterial(false);
    setShowMfgForm(false);
  };

  // Manufacturer names seen before, for the dropdown suggestions on the Add
  // Manufacturer Invoice form. Typing a name not in this list is still fine —
  // it just means a new manufacturer.
  const knownManufacturerNames = useMemo(
    () => Array.from(new Set(manufacturerInvoices.map(m => m.manufacturerName.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [manufacturerInvoices]
  );

  // Material name/code pairs to suggest for the Material fields. Once the
  // manufacturer name matches one we've seen before, this narrows to just
  // that manufacturer's materials (per user request: "once I select
  // manufacturer name, its material name/code should come in the dropdown").
  // With no manufacturer typed yet, it shows everything as a starting point.
  // A manufacturer name that doesn't match anything known yields no
  // suggestions (correct — no history exists for it) but the fields stay
  // free text either way, so a brand-new material/code is always fine.
  const mfgMaterialsForSelectedManufacturer = useMemo(() => {
    const typed = mfgForm.manufacturerName.trim().toLowerCase();
    const source = typed
      ? manufacturerInvoices.filter(m => m.manufacturerName.trim().toLowerCase() === typed)
      : manufacturerInvoices;
    const seen = new Set<string>();
    const result: { materialName: string; materialCode: string }[] = [];
    source.forEach(m => {
      const key = `${m.materialName}::${m.materialCode}`;
      if (m.materialCode && !seen.has(key)) {
        seen.add(key);
        result.push({ materialName: m.materialName, materialCode: m.materialCode });
      }
    });
    return result.sort((a, b) => a.materialName.localeCompare(b.materialName));
  }, [manufacturerInvoices, mfgForm.manufacturerName]);

  const mfgMaterialNameOptions = useMemo(
    () => Array.from(new Set(mfgMaterialsForSelectedManufacturer.map(m => m.materialName))),
    [mfgMaterialsForSelectedManufacturer]
  );

  // When adding a brand-new material, pre-fill the piece length from the
  // material name as you type it (see parsePieceLengthFromMaterialName)
  // so it's a starting point, not a blank box — still fully editable.
  // Existing materials skip this entirely: their length comes straight
  // from the recorded value and is locked (see the Material Name select
  // below), never re-guessed from the name.
  useEffect(() => {
    if (!addingNewMaterial) return;
    if (mfgLengthInput) return;
    const parsed = parsePieceLengthFromMaterialName(mfgForm.materialName);
    if (parsed !== null) setMfgLengthInput(String(parsed));
  }, [addingNewMaterial, mfgForm.materialName, mfgLengthInput]);

  const submitMfgInvoice = (e: React.FormEvent) => {
    e.preventDefault();
    const id = genId();
    setManufacturerInvoices(prev => [...prev, { id, ...mfgForm, createdAt: new Date().toISOString() }]);
    if (!knownLength && mfgLengthInput) {
      setMaterialLengths(prev => [
        ...prev.filter(m => m.materialCode.toUpperCase() !== mfgForm.materialCode.toUpperCase().trim()),
        { materialCode: mfgForm.materialCode.trim(), materialName: mfgForm.materialName, lengthMm: parseFloat(mfgLengthInput) || 0, updatedAt: new Date().toISOString() },
      ]);
    }
    setMfgForm({ manufacturerName: mfgForm.manufacturerName, customerName: mfgForm.customerName, invoiceNo: '', date: '', materialName: '', materialCode: '', quantityPcs: 0, ratePerPc: 0, itemValue: 0 });
    setMfgLengthInput('');
    setAddingNewMaterial(false);
    setShowMfgForm(false);
  };

  // --- Customer Cross-Invoice form ---
  const [crossForm, setCrossForm] = useState({
    customerName: customers[0]?.name || '', invoiceNo: '', date: '', refManufacturerInvoiceId: '',
    quantityMtr: 0, rate: 0, itemValue: 0,
  });
  const selectedMfgInvoice = manufacturerInvoices.find(m => m.id === crossForm.refManufacturerInvoiceId);

  const submitCrossInvoice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMfgInvoice) return;
    const id = genId();
    setCrossInvoices(prev => [...prev, {
      id, customerName: crossForm.customerName, invoiceNo: crossForm.invoiceNo, date: crossForm.date,
      refManufacturerInvoiceId: crossForm.refManufacturerInvoiceId,
      materialName: selectedMfgInvoice.materialName, materialCode: selectedMfgInvoice.materialCode,
      quantityMtr: crossForm.quantityMtr, rate: crossForm.rate, itemValue: crossForm.itemValue,
      createdAt: new Date().toISOString(),
    }]);
    setManufacturerInvoices(prev => prev.map(m => m.id === selectedMfgInvoice.id ? { ...m, matchedCrossInvoiceId: id } : m));
    setCrossForm({ customerName: crossForm.customerName, invoiceNo: '', date: '', refManufacturerInvoiceId: '', quantityMtr: 0, rate: 0, itemValue: 0 });
    setShowCrossForm(false);
  };

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex justify-between items-start mb-1">
        <div>
          <h2 className="text-xl font-black text-slate-900">RM Cross-Bill Check</h2>
          <p className="text-xs text-slate-500 font-medium mt-1 max-w-2xl">
            Cross-checks the manufacturer's original RM invoice (e.g. Tube Investments) against your customer's
            resold invoice for the same material (e.g. SIAC) — flags invoices still awaiting a match, and shows
            the markup so you can spot over-valuing before you book it.
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          {isAdmin && (
            <button onClick={() => setShowMaterialLengths(true)} className="px-4 py-2 border-2 border-slate-200 text-slate-600 rounded-xl text-xs font-black uppercase tracking-widest hover:border-emerald-500 hover:text-emerald-600">
              Material Lengths
            </button>
          )}
          {isAdmin && (
            <button onClick={() => setShowBulkImport(true)} className="px-4 py-2 border-2 border-slate-200 text-slate-600 rounded-xl text-xs font-black uppercase tracking-widest hover:border-emerald-500 hover:text-emerald-600">
              Bulk Import from File
            </button>
          )}
          <button onClick={openFreshMfgForm} className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-black uppercase tracking-widest">
            + Manufacturer Invoice
          </button>
          <button onClick={() => setShowCrossForm(true)} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-black uppercase tracking-widest">
            + Customer Invoice
          </button>
        </div>
      </div>
      {bulkStatus && (
        <div className="mt-3 text-xs font-bold text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 inline-block">{bulkStatus}</div>
      )}

      {/* Filter bar */}
      <div className="flex items-end gap-3 mt-6 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">
        <FormField label="Manufacturer">
          <select value={filterManufacturer} onChange={(e) => setFilterManufacturer(e.target.value)}
            className="w-48 border-2 border-slate-200 rounded-xl px-3 py-2 text-sm bg-white">
            <option value="">All manufacturers</option>
            {filterManufacturerOptions.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </FormField>
        <FormField label="Month">
          <select value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)}
            className="w-44 border-2 border-slate-200 rounded-xl px-3 py-2 text-sm bg-white">
            <option value="">All months</option>
            {filterMonthOptions.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </FormField>
        {filtersActive && (
          <button type="button" onClick={() => { setFilterManufacturer(''); setFilterMonth(''); }}
            className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 pb-2.5">
            × Clear filters
          </button>
        )}
      </div>

      {/* Outstanding */}
      <div className="mt-8">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest">Awaiting Customer Invoice ({filteredOutstanding.length})</h3>
        </div>
        {filteredOutstanding.length === 0 && (
          <div className="bg-emerald-50 text-emerald-700 text-sm font-bold rounded-2xl px-6 py-6 text-center">
            {filtersActive ? 'Nothing outstanding for this filter.' : 'Nothing outstanding 🎉'}
          </div>
        )}
        <div className="space-y-2">
          {filteredOutstanding.map(inv => {
            const days = ageInDays(inv.date);
            const band = ageBand(days);
            return (
              <div key={inv.id} className={`border rounded-2xl px-5 py-4 flex justify-between items-center ${band.color}`}>
                <div>
                  <p className="font-bold text-slate-900 text-sm">{inv.materialName} <span className="text-xs text-slate-400 font-mono ml-1">{inv.materialCode}</span></p>
                  <p className="text-xs mt-1">{inv.manufacturerName} → {inv.customerName} • Invoice {inv.invoiceNo} • {new Date(inv.date).toLocaleDateString('en-GB')} • {inv.quantityPcs} Pcs • ₹{(inv.itemValue ?? 0).toLocaleString('en-IN')}</p>
                </div>
                <span className="text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border">{band.label} · {days}d</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Matched */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest">Matched ({filteredMatched.length})</h3>
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Alert if markup exceeds</label>
            <input type="number" placeholder="e.g. 3" value={markupThreshold} onChange={(e) => setMarkupThreshold(e.target.value)}
              className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
            <span className="text-xs text-slate-400 font-bold">%</span>
          </div>
        </div>
        <div className="space-y-2">
          {filteredMatched.map(inv => {
            const cross = crossInvoices.find(c => c.id === inv.matchedCrossInvoiceId);
            if (!cross) return null;
            const safeInvValue = inv.itemValue ?? 0;
            const safeCrossValue = cross.itemValue ?? 0;
            const markupPct = safeInvValue === 0 ? 0 : ((safeCrossValue - safeInvValue) / safeInvValue) * 100;
            const lengthEntry = materialLengths.find(m => m.materialCode.toUpperCase() === inv.materialCode.toUpperCase());
            const expectedMtr = lengthEntry ? (inv.quantityPcs * lengthEntry.lengthMm) / 1000 : null;
            const qtyMismatch = expectedMtr !== null && Math.abs(expectedMtr - cross.quantityMtr) / expectedMtr > 0.01;
            const overThreshold = markupThreshold && markupPct > parseFloat(markupThreshold);
            return (
              <div key={inv.id} className={`border rounded-2xl px-5 py-4 ${overThreshold ? 'border-rose-300 bg-rose-50/50' : 'border-slate-100 bg-white'}`}>
                <div className="flex justify-between items-start">
                  <p className="font-bold text-slate-900 text-sm">{inv.materialName} <span className="text-xs text-slate-400 font-mono ml-1">{inv.materialCode}</span></p>
                  <span className={`text-xs font-black px-2 py-1 rounded-lg ${overThreshold ? 'bg-rose-600 text-white' : markupPct < 0 ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}>
                    {markupPct >= 0 ? '+' : ''}{markupPct.toFixed(2)}% markup
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-3 text-xs">
                  <div className="bg-slate-50 rounded-xl px-3 py-2">
                    <p className="font-black text-slate-400 uppercase tracking-widest text-[9px] mb-1">{inv.manufacturerName}</p>
                    <p className="text-slate-600">Invoice {inv.invoiceNo} • {new Date(inv.date).toLocaleDateString('en-GB')}</p>
                    <p className="text-slate-900 font-bold mt-1">{inv.quantityPcs} Pcs @ ₹{inv.ratePerPc} = ₹{safeInvValue.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-indigo-50/50 rounded-xl px-3 py-2">
                    <p className="font-black text-indigo-400 uppercase tracking-widest text-[9px] mb-1">{cross.customerName}</p>
                    <p className="text-slate-600">Invoice {cross.invoiceNo} • {new Date(cross.date).toLocaleDateString('en-GB')}</p>
                    <p className="text-slate-900 font-bold mt-1">{cross.quantityMtr} Mtr @ ₹{cross.rate} = ₹{safeCrossValue.toLocaleString('en-IN')}</p>
                  </div>
                </div>
                {qtyMismatch && (
                  <p className="text-[11px] font-bold text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5 mt-2 inline-block">
                    ⚠ Quantity check: expected ~{expectedMtr?.toFixed(1)}m from {inv.quantityPcs} Pcs, customer billed {cross.quantityMtr}m — worth a second look.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Manufacturer Invoice modal */}
      {showMfgForm && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl max-w-lg w-full p-8 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-black text-slate-900 mb-4">Add Manufacturer Invoice</h3>
            <form onSubmit={submitMfgInvoice} className="space-y-3">
              <FormField label="Manufacturer Name">
                <select
                  required={!addingNewManufacturer}
                  value={addingNewManufacturer ? NEW_OPTION : mfgForm.manufacturerName}
                  onChange={(e) => {
                    const v = e.target.value;
                    // Manufacturer changed — the material list below is
                    // scoped to whichever manufacturer is selected, so
                    // whatever material was picked no longer applies.
                    setAddingNewMaterial(false);
                    setMfgLengthInput('');
                    if (v === NEW_OPTION) {
                      setAddingNewManufacturer(true);
                      setMfgForm({ ...mfgForm, manufacturerName: '', materialName: '', materialCode: '' });
                    } else {
                      setAddingNewManufacturer(false);
                      setMfgForm({ ...mfgForm, manufacturerName: v, materialName: '', materialCode: '' });
                    }
                  }}
                  className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm"
                >
                  <option value="">Select manufacturer</option>
                  {knownManufacturerNames.map(name => <option key={name} value={name}>{name}</option>)}
                  <option value={NEW_OPTION}>+ Add New Manufacturer</option>
                </select>
                {addingNewManufacturer && (
                  <div className="mt-2">
                    <input required autoFocus placeholder="e.g. Tube Investments of India Ltd" value={mfgForm.manufacturerName}
                      onChange={(e) => setMfgForm({ ...mfgForm, manufacturerName: e.target.value })}
                      className="w-full border-2 border-emerald-200 bg-emerald-50/40 rounded-xl px-3 py-2 text-sm" />
                    <button type="button" onClick={() => { setAddingNewManufacturer(false); setMfgForm({ ...mfgForm, manufacturerName: '' }); }}
                      className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 mt-1 px-1">
                      ‹ Back to list
                    </button>
                  </div>
                )}
              </FormField>
              <FormField label="Cross-Invoicing Customer">
                <select required value={mfgForm.customerName} onChange={(e) => setMfgForm({ ...mfgForm, customerName: e.target.value })}
                  className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
                  <option value="">Which customer will cross-invoice you?</option>
                  {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Invoice No">
                  <input required placeholder="Invoice No" value={mfgForm.invoiceNo}
                    onChange={(e) => setMfgForm({ ...mfgForm, invoiceNo: e.target.value })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Date">
                  <input required type="date" value={mfgForm.date}
                    onChange={(e) => setMfgForm({ ...mfgForm, date: e.target.value })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
              </div>
              <FormField label="Material Name">
                <select
                  required={!addingNewMaterial}
                  value={addingNewMaterial ? NEW_OPTION : mfgForm.materialName}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === NEW_OPTION) {
                      setAddingNewMaterial(true);
                      setMfgForm({ ...mfgForm, materialName: '', materialCode: '' });
                      setMfgLengthInput('');
                    } else {
                      setAddingNewMaterial(false);
                      const match = mfgMaterialsForSelectedManufacturer.find(m => m.materialName === v);
                      const code = match ? match.materialCode : '';
                      const lengthEntry = materialLengths.find(m => m.materialCode.toUpperCase() === code.toUpperCase());
                      // No formally recorded length for this code? Fall back
                      // to parsing it straight out of the material name
                      // (e.g. "...60x30x3x4250-AS ROLLED" -> 4250) rather
                      // than showing "Not recorded" when it's plainly right
                      // there in the name. submitMfgInvoice will persist
                      // this as the recorded length going forward.
                      const resolvedLength = lengthEntry ? lengthEntry.lengthMm : parsePieceLengthFromMaterialName(v);
                      setMfgForm({ ...mfgForm, materialName: v, materialCode: code });
                      setMfgLengthInput(resolvedLength !== null ? String(resolvedLength) : '');
                    }
                  }}
                  className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm"
                >
                  <option value="">Select material</option>
                  {mfgMaterialNameOptions.map(name => <option key={name} value={name}>{name}</option>)}
                  <option value={NEW_OPTION}>+ Add New Material</option>
                </select>
              </FormField>
              {addingNewMaterial ? (
                <>
                  <FormField label="Material Name">
                    <input required autoFocus placeholder="e.g. ERW STEEL TUBES-REC-SBR-60x30x3x4250-AS ROLLED" value={mfgForm.materialName}
                      onChange={(e) => setMfgForm({ ...mfgForm, materialName: e.target.value })}
                      className="w-full border-2 border-emerald-200 bg-emerald-50/40 rounded-xl px-3 py-2 text-sm" />
                  </FormField>
                  <FormField label="Material Code">
                    <input required placeholder="Material code" value={mfgForm.materialCode}
                      onChange={(e) => setMfgForm({ ...mfgForm, materialCode: e.target.value })}
                      className="w-full border-2 border-emerald-200 bg-emerald-50/40 rounded-xl px-3 py-2 text-sm" />
                  </FormField>
                  <FormField label="Piece Length (mm)">
                    <input type="number" placeholder="Piece length in mm (for the Pcs→Meter check)" value={mfgLengthInput}
                      onChange={(e) => setMfgLengthInput(e.target.value)}
                      className="w-full border-2 border-emerald-200 bg-emerald-50/40 rounded-xl px-3 py-2 text-sm" />
                    <p className="text-[10px] text-slate-400 mt-1 px-1">
                      {parsePieceLengthFromMaterialName(mfgForm.materialName) !== null
                        ? 'Auto-detected from the material name — check it\'s right, then it\'s reused (locked) on every future invoice for this material.'
                        : 'New material — enter once, then it\'s reused (locked) on every future invoice for this material.'}
                    </p>
                  </FormField>
                  <button type="button" onClick={() => { setAddingNewMaterial(false); setMfgForm({ ...mfgForm, materialName: '', materialCode: '' }); setMfgLengthInput(''); }}
                    className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 px-1 -mt-2">
                    ‹ Back to list
                  </button>
                </>
              ) : mfgForm.materialName && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Material Code">
                    <input disabled value={mfgForm.materialCode} placeholder="—"
                      className="w-full border-2 border-slate-100 bg-slate-50 text-slate-500 rounded-xl px-3 py-2 text-sm cursor-not-allowed" />
                  </FormField>
                  <FormField label="Piece Length (mm)">
                    <input disabled value={mfgLengthInput} placeholder="Not recorded"
                      className="w-full border-2 border-slate-100 bg-slate-50 text-slate-500 rounded-xl px-3 py-2 text-sm cursor-not-allowed" />
                  </FormField>
                </div>
              )}
              <div className="grid grid-cols-3 gap-3">
                <FormField label="Qty (Pcs)">
                  <input required type="number" placeholder="Qty (Pcs)" value={mfgForm.quantityPcs || ''}
                    onChange={(e) => setMfgForm({ ...mfgForm, quantityPcs: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Rate / Pc">
                  <input required type="number" step="0.01" placeholder="Rate/Pc" value={mfgForm.ratePerPc || ''}
                    onChange={(e) => setMfgForm({ ...mfgForm, ratePerPc: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Item Value">
                  <input required type="number" step="0.01" placeholder="Item Value" value={mfgForm.itemValue || ''}
                    onChange={(e) => setMfgForm({ ...mfgForm, itemValue: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={closeMfgForm} className="flex-1 py-3 border-2 border-slate-200 text-slate-500 rounded-xl font-bold text-sm">Cancel</button>
                <button type="submit" className="flex-[2] py-3 bg-slate-900 text-white rounded-xl font-bold text-sm">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Customer Cross-Invoice modal */}
      {showCrossForm && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl max-w-lg w-full p-8 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-black text-slate-900 mb-4">Add Customer Cross-Invoice</h3>
            <form onSubmit={submitCrossInvoice} className="space-y-3">
              <FormField label="Manufacturer Invoice Being Matched">
                <select required value={crossForm.refManufacturerInvoiceId}
                  onChange={(e) => setCrossForm({ ...crossForm, refManufacturerInvoiceId: e.target.value })}
                  className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
                  <option value="">Which outstanding manufacturer invoice is this for?</option>
                  {outstanding.map(m => (
                    <option key={m.id} value={m.id}>{m.manufacturerName} — {m.invoiceNo} — {m.materialName} ({m.materialCode}) — {new Date(m.date).toLocaleDateString('en-GB')}</option>
                  ))}
                </select>
              </FormField>
              {selectedMfgInvoice && (
                <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
                  Material and code auto-linked from the selected invoice: <strong>{selectedMfgInvoice.materialName}</strong> ({selectedMfgInvoice.materialCode})
                </p>
              )}
              <FormField label="Customer">
                <select required value={crossForm.customerName} onChange={(e) => setCrossForm({ ...crossForm, customerName: e.target.value })}
                  className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
                  <option value="">Customer</option>
                  {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Invoice No">
                  <input required placeholder="Invoice No" value={crossForm.invoiceNo}
                    onChange={(e) => setCrossForm({ ...crossForm, invoiceNo: e.target.value })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Date">
                  <input required type="date" value={crossForm.date}
                    onChange={(e) => setCrossForm({ ...crossForm, date: e.target.value })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <FormField label="Qty (Mtr)">
                  <input required type="number" placeholder="Qty (Mtr)" value={crossForm.quantityMtr || ''}
                    onChange={(e) => setCrossForm({ ...crossForm, quantityMtr: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Rate">
                  <input required type="number" step="0.01" placeholder="Rate" value={crossForm.rate || ''}
                    onChange={(e) => setCrossForm({ ...crossForm, rate: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Item Value">
                  <input required type="number" step="0.01" placeholder="Item Value" value={crossForm.itemValue || ''}
                    onChange={(e) => setCrossForm({ ...crossForm, itemValue: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowCrossForm(false)} className="flex-1 py-3 border-2 border-slate-200 text-slate-500 rounded-xl font-bold text-sm">Cancel</button>
                <button type="submit" disabled={!selectedMfgInvoice} className="flex-[2] py-3 bg-indigo-600 text-white rounded-xl font-bold text-sm disabled:opacity-50">Save & Resolve</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Bulk Import modal */}
      {showBulkImport && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl max-w-lg w-full p-8">
            <h3 className="text-lg font-black text-slate-900 mb-2">Bulk Import from File</h3>
            <p className="text-xs text-slate-500 mb-4">
              Adds records without touching anything already here — safe to run once with your prepared import file.
            </p>
            <div className="border-2 border-dashed border-slate-200 rounded-2xl p-6 text-center mb-4">
              <input type="file" accept="application/json" id="rm-bulk-file" className="hidden"
                onChange={(e) => e.target.files?.[0] && handleBulkFile(e.target.files[0])} />
              <label htmlFor="rm-bulk-file" className="cursor-pointer">
                <p className="text-sm font-bold text-slate-700">{bulkFile?.name || 'Click to choose the import .json file'}</p>
              </label>
            </div>
            {bulkFile && (
              <div className="bg-slate-50 rounded-xl px-4 py-3 mb-4 text-xs text-slate-600">
                <p><strong>{bulkFile.data.rmManufacturerInvoices?.length || 0}</strong> manufacturer invoices</p>
                <p><strong>{bulkFile.data.rmCustomerCrossInvoices?.length || 0}</strong> matched cross-invoices</p>
                <p><strong>{bulkFile.data.rmMaterialLengths?.length || 0}</strong> material lengths</p>
              </div>
            )}
            {bulkStatus && <p className="text-xs font-bold text-rose-600 mb-3">{bulkStatus}</p>}
            <div className="flex gap-3">
              <button onClick={() => { setShowBulkImport(false); setBulkFile(null); }} className="flex-1 py-3 border-2 border-slate-200 text-slate-500 rounded-xl font-bold text-sm">Cancel</button>
              <button onClick={() => { runBulkImport(); setShowBulkImport(false); }} disabled={!bulkFile} className="flex-[2] py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm disabled:opacity-50">Import</button>
            </div>
          </div>
        </div>
      )}

      {/* Material Lengths admin modal */}
      {showMaterialLengths && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl max-w-2xl w-full p-8 max-h-[85vh] flex flex-col">
            <h3 className="text-lg font-black text-slate-900 mb-1">Material Lengths</h3>
            <p className="text-xs text-slate-500 mb-4">
              The recorded piece length (mm) for each material code — used for the Pcs→Meter check, and locked on the
              Manufacturer Invoice form once a material is selected. Fix a wrong value here.
            </p>
            <div className="overflow-y-auto flex-1 -mx-2 px-2 space-y-2">
              {[...materialLengths].sort((a, b) => a.materialName.localeCompare(b.materialName)).map(m => {
                const edited = lengthEdits[m.materialCode] ?? String(m.lengthMm);
                const dirty = parseFloat(edited) !== m.lengthMm;
                return (
                  <div key={m.materialCode} className="flex items-center gap-3 border border-slate-100 rounded-xl px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{m.materialName}</p>
                      <p className="text-xs text-slate-400 font-mono">{m.materialCode}</p>
                    </div>
                    <input type="number" value={edited}
                      onChange={(e) => setLengthEdits({ ...lengthEdits, [m.materialCode]: e.target.value })}
                      className="w-28 border-2 border-slate-200 rounded-lg px-2 py-1.5 text-sm text-right" />
                    <span className="text-xs text-slate-400 font-bold">mm</span>
                    <button
                      type="button"
                      onClick={() => saveMaterialLength(m.materialCode)}
                      disabled={!dirty}
                      className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest ${
                        justSavedCode === m.materialCode
                          ? 'bg-emerald-600 text-white'
                          : dirty
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-300 cursor-not-allowed'
                      }`}
                    >
                      {justSavedCode === m.materialCode ? 'Saved' : 'Save'}
                    </button>
                  </div>
                );
              })}
              {materialLengths.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-8">No material lengths recorded yet.</p>
              )}
            </div>
            <div className="flex gap-3 pt-4">
              <button type="button" onClick={() => setShowMaterialLengths(false)} className="flex-1 py-3 bg-slate-900 text-white rounded-xl font-bold text-sm">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RMCrossBillCheck;
