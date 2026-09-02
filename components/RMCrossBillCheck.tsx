import React, { useState, useMemo, useEffect } from 'react';
import { RMManufacturerInvoice, RMCustomerCrossInvoice, RMMaterialLength, Customer, AdminAlert, RMInwardLog, RMPurchaseVoucher } from '../types';
import { extractInvoiceFromPhoto, extractCustomerInvoiceFromPhoto } from '../services/gemini';

const NEW_OPTION = '__new__';

interface RMCrossBillCheckProps {
  manufacturerInvoices: RMManufacturerInvoice[];
  crossInvoices: RMCustomerCrossInvoice[];
  materialLengths: RMMaterialLength[];
  customers: Customer[];
  // Read-only here — used only to check whether anything has actually been
  // logged into RM stock against a given invoice number (see the Weight &
  // Stock Reconciliation section). Deliberately matched by invoice number
  // alone, NOT by material/RM identity — many RM deliveries arrive for a
  // material that doesn't have an RM Master / Item Master entry yet, so
  // there's often no reliable link to a specific RawMaterial to check
  // against. Invoice number is the one thing guaranteed to exist on both
  // sides.
  rmInwardLogs: RMInwardLog[];
  // Mirrored hourly from Tally's own Purchase vouchers by the Tally
  // Connector script on the 24x7 server (see import-tally.js) — never
  // written by the app. Lets this screen automatically show whether a
  // Manufacturer Invoice typed in by hand from the paper invoice/photo
  // has actually been booked in Tally yet, and for what amount, instead
  // of relying on Admin to remember and tick a checkbox.
  tallyPurchaseVouchers: RMPurchaseVoucher[];
  setManufacturerInvoices: (update: RMManufacturerInvoice[] | ((prev: RMManufacturerInvoice[]) => RMManufacturerInvoice[])) => void;
  setCrossInvoices: (update: RMCustomerCrossInvoice[] | ((prev: RMCustomerCrossInvoice[]) => RMCustomerCrossInvoice[])) => void;
  setMaterialLengths: (update: RMMaterialLength[] | ((prev: RMMaterialLength[]) => RMMaterialLength[])) => void;
  isAdmin?: boolean;
  // Pushes an entry into the Admin-only Notifications feed, mirroring the
  // RM Inward pattern — Admin gets a "Verify" prompt for every Manufacturer
  // or Customer Invoice saved here, whether typed in by hand or auto-filled
  // from a photo, so they can cross-check it against the source invoice.
  onCreateAlert?: (alert: Partial<AdminAlert> & Pick<AdminAlert, 'type'>) => void;
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

// Downscales/re-encodes a photo client-side before it's sent to the
// extraction endpoint — a full-resolution phone photo can be 5-10MB, well
// past what's sensible to upload for OCR-style reading and close to (or
// over) typical serverless body-size limits in production. Re-encoding to
// JPEG here also sidesteps HEIC (iPhone photos) not being accepted by the
// vision model directly — if the browser itself can't decode the source
// file (rare, but possible for some HEIC variants), this rejects with a
// clear error asking for a JPG/PNG instead, rather than silently failing.
const MAX_INVOICE_PHOTO_DIMENSION = 1600;
const readAndCompressInvoicePhoto = (file: File): Promise<{ base64: string; mimeType: string }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_INVOICE_PHOTO_DIMENSION / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('This browser can\'t process images — try a different device.')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Could not process this photo.')); return; }
        resolve({ base64, mimeType: 'image/jpeg' });
      };
      img.onerror = () => reject(new Error('Could not open this photo — try a JPG or PNG.'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('Could not read this file.'));
    reader.readAsDataURL(file);
  });
};

// Material codes on a photographed invoice sometimes carry trailing print
// artifacts (e.g. "RMSS00000119." with a stray period, from the column
// layout on the source document) that aren't part of the actual code. Used
// to compare a freshly-read code against what's already on file without
// that kind of noise causing a real match to be missed.
const normalizeMaterialCode = (code: string) => code.trim().replace(/[.\s]+$/, '').toUpperCase();

// Permanent field header above an input/select — unlike a placeholder, this
// stays visible once the field has a value, so it's always clear what the
// box is for even after it's filled in.
const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 px-1">{label}</label>
    {children}
  </div>
);

// Loose name matching for the Tally auto-match below — same tiered idea as
// the Tally Connector's own findMatchingCustomer (exact, then substring
// either direction), since "Tube Investments of India Ltd" typed by Store
// and "TUBE INVESTMENTS OF INDIA LTD" as Tally's ledger name are the same
// supplier but never byte-identical.
const namesLooselyMatch = (a: string, b: string): boolean => {
  const A = (a || '').toUpperCase().trim();
  const B = (b || '').toUpperCase().trim();
  if (!A || !B) return false;
  if (A === B || A.includes(B) || B.includes(A)) return true;
  const cleanA = A.replace(/[^A-Z0-9]/g, '');
  const cleanB = B.replace(/[^A-Z0-9]/g, '');
  return cleanA.length >= 3 && cleanB.length >= 3 && (cleanA.includes(cleanB) || cleanB.includes(cleanA));
};

// Invoice numbers rarely come out byte-identical between what Store typed
// from the paper invoice and what Tally's REFERENCE field holds (a prefix
// like "TI/" added or dropped, a leading zero, etc.) — compares only the
// letters/digits, and accepts one being a trailing match of the other, with
// a minimum overlap length so short numbers can't false-match each other.
const invoiceNumbersLooselyMatch = (a: string, b: string): boolean => {
  const cleanA = (a || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanB = (b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;
  const minLen = Math.min(cleanA.length, cleanB.length);
  return minLen >= 4 && (cleanA.endsWith(cleanB) || cleanB.endsWith(cleanA));
};

// A Tally-vs-app booked-value gap smaller than this is just rounding
// (per-line rate x qty rounding across several materials on one invoice),
// not something worth flagging as a mismatch to check before paying.
const VALUE_MISMATCH_TOLERANCE_RS = 5;

const RMCrossBillCheck: React.FC<RMCrossBillCheckProps> = ({
  manufacturerInvoices, crossInvoices, materialLengths, customers, rmInwardLogs,
  tallyPurchaseVouchers,
  setManufacturerInvoices, setCrossInvoices, setMaterialLengths, isAdmin,
  onCreateAlert,
}) => {
  const [showMfgForm, setShowMfgForm] = useState(false);
  const [showCrossForm, setShowCrossForm] = useState(false);
  // Hard-block guards: a repeat submit of the same invoice number (for the
  // same manufacturer / customer) is refused outright rather than silently
  // creating a duplicate record + duplicate admin alert. This is what
  // protects against a store user re-clicking "Save" for the same invoice
  // when a slow/dropped connection makes it look like nothing happened.
  const [mfgDuplicateError, setMfgDuplicateError] = useState<string | null>(null);
  const [crossDuplicateError, setCrossDuplicateError] = useState<string | null>(null);
  const [markupThreshold, setMarkupThreshold] = useState<string>('');
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkFile, setBulkFile] = useState<{ name: string; data: any } | null>(null);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [showMaterialLengths, setShowMaterialLengths] = useState(false);
  const [filterManufacturer, setFilterManufacturer] = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [filterMaterial, setFilterMaterial] = useState('');

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

  // Material Name filter options — scoped to whichever manufacturer is
  // currently selected in the filter bar (per user request: same "select
  // manufacturer -> narrow to its materials" behavior as the Add
  // Manufacturer Invoice form's mfgMaterialsForSelectedManufacturer above,
  // just applied to the filter bar instead). With no manufacturer filter
  // selected, this offers every material name on file.
  const filterMaterialOptions = useMemo(() => {
    const source = filterManufacturer
      ? manufacturerInvoices.filter(m => m.manufacturerName === filterManufacturer)
      : manufacturerInvoices;
    return Array.from(new Set(source.map(m => m.materialName.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [manufacturerInvoices, filterManufacturer]);

  // If the manufacturer filter changes (or clears) and the currently
  // selected material no longer belongs to it, drop the stale selection
  // instead of silently filtering everything out.
  useEffect(() => {
    if (filterMaterial && !filterMaterialOptions.includes(filterMaterial)) {
      setFilterMaterial('');
    }
  }, [filterMaterialOptions, filterMaterial]);

  const matchesFilters = (m: RMManufacturerInvoice) =>
    (!filterManufacturer || m.manufacturerName === filterManufacturer) &&
    (!filterMonth || (m.date || '').slice(0, 7) === filterMonth) &&
    (!filterMaterial || m.materialName === filterMaterial);

  const filteredOutstanding = useMemo(() => outstanding.filter(matchesFilters), [outstanding, filterManufacturer, filterMonth, filterMaterial]);
  const filteredMatched = useMemo(() => matched.filter(matchesFilters), [matched, filterManufacturer, filterMonth, filterMaterial]);
  const filtersActive = Boolean(filterManufacturer || filterMonth || filterMaterial);

  // --- Weight & Stock Reconciliation ---
  // Groups the (possibly many) RMManufacturerInvoice line items that share
  // one invoice no. + manufacturer back into a single "shipment" — one
  // vehicle, one Dharam Kanta weighment — and checks it against whatever's
  // been logged into RM stock under that same invoice number. Matched by
  // invoice number ONLY, deliberately not by material/RM identity: many RM
  // deliveries arrive for a material that has no RM Master / Item Master
  // entry yet, so there's often nothing reliable to link to on that side.
  const shipments = useMemo(() => {
    const groups = new Map<string, RMManufacturerInvoice[]>();
    manufacturerInvoices.forEach(inv => {
      const key = `${inv.invoiceNo.trim().toLowerCase()}::${inv.manufacturerName.trim().toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(inv);
    });
    return Array.from(groups.entries()).map(([key, items]) => {
      const first = items[0];
      const invoiceNoNorm = first.invoiceNo.trim().toLowerCase();
      const matchingInwardLogs = rmInwardLogs.filter(l => (l.invoiceNumber || '').trim().toLowerCase() === invoiceNoNorm);
      const totalWeightKg = first.totalWeightKg || 0;
      const actualWeightKg = first.actualWeightKg || 0;
      const hasWeights = totalWeightKg > 0 && actualWeightKg > 0;

      // Automatic Tally match — see the tallyPurchaseVouchers prop comment.
      // Matched purely by supplier name + invoice number (loosely, since
      // formatting rarely lines up byte-for-byte between what Store typed
      // and Tally's own ledger/Reference text), never by material — same
      // "invoice number is the one thing guaranteed to exist on both
      // sides" reasoning as the RM stock check above.
      const appTotalValue = Math.round(items.reduce((sum, li) => sum + (li.itemValue || 0), 0) * 100) / 100;
      const tallyMatch = tallyPurchaseVouchers.find(pv =>
        !pv.isDeleted &&
        invoiceNumbersLooselyMatch(pv.invoiceNumber, first.invoiceNo) &&
        namesLooselyMatch(pv.supplierName, first.manufacturerName)
      );
      const tallyValueMismatch = !!tallyMatch && Math.abs(tallyMatch.totalValue - appTotalValue) > VALUE_MISMATCH_TOLERANCE_RS;

      return {
        key,
        invoiceNo: first.invoiceNo,
        manufacturerName: first.manufacturerName,
        date: first.date,
        lineItems: items,
        totalWeightKg,
        actualWeightKg,
        hasWeights,
        variance: hasWeights ? actualWeightKg - totalWeightKg : 0,
        weightFlagged: !!first.weightFlagged,
        debitNoteAmount: first.debitNoteAmount,
        debitNoteRemark: first.debitNoteRemark,
        tallyBooked: !!first.tallyBooked,
        tallyVoucherNo: first.tallyVoucherNo || '',
        matchingInwardCount: matchingInwardLogs.length,
        appTotalValue,
        tallyMatch,
        tallyValueMismatch,
        // Effective booked status feeding the "booked with an open flag"
        // check below — an automatic Tally match counts the same as the
        // manual checkbox, since either way the supplier has been paid.
        effectiveTallyBooked: !!first.tallyBooked || !!tallyMatch,
      };
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [manufacturerInvoices, rmInwardLogs, tallyPurchaseVouchers]);

  // Every RMManufacturerInvoice line sharing an invoice no. + manufacturer
  // represents the same physical shipment, so a Tally-booking or debit-note
  // update applies to all of them at once — keeps them from ever showing
  // different values for what is really one shipment-level fact.
  const updateShipmentInvoices = (invoiceNo: string, manufacturerName: string, patch: Partial<RMManufacturerInvoice>) => {
    const invoiceNoNorm = invoiceNo.trim().toLowerCase();
    const manufacturerNorm = manufacturerName.trim().toLowerCase();
    setManufacturerInvoices(prev => prev.map(inv =>
      inv.invoiceNo.trim().toLowerCase() === invoiceNoNorm && inv.manufacturerName.trim().toLowerCase() === manufacturerNorm
        ? { ...inv, ...patch }
        : inv
    ));
  };

  const [debitNoteFormKey, setDebitNoteFormKey] = useState<string | null>(null);
  const [debitNoteAmountInput, setDebitNoteAmountInput] = useState('');
  const [debitNoteRemarkInput, setDebitNoteRemarkInput] = useState('');

  const openDebitNoteForm = (s: { key: string }) => {
    setDebitNoteFormKey(s.key);
    setDebitNoteAmountInput('');
    setDebitNoteRemarkInput('');
  };
  const cancelDebitNoteForm = () => setDebitNoteFormKey(null);
  const saveDebitNote = (s: { invoiceNo: string; manufacturerName: string }) => {
    updateShipmentInvoices(s.invoiceNo, s.manufacturerName, {
      debitNoteAmount: parseFloat(debitNoteAmountInput) || 0,
      debitNoteRemark: debitNoteRemarkInput.trim(),
      debitNoteAt: new Date().toISOString(),
      debitNoteBy: 'Admin',
    });
    setDebitNoteFormKey(null);
  };

  // --- Manufacturer Invoice form ---
  // One real invoice often clubs together several different materials
  // (e.g. RMSS00000118 and RMSS00000119 on the same invoice no.). The
  // header fields below (manufacturer, customer, invoice no, date, total
  // weight, actual weight) apply to the WHOLE invoice — one vehicle, one
  // Dharam Kanta weighment, regardless of how many materials are on it —
  // while each material gets its own line item via mfgLineItems, added/
  // removed with the "+ Add Another Material" / remove controls in the
  // modal. All saved together as separate RMManufacturerInvoice records
  // sharing the same invoice no., date, and both weight fields.
  //
  // Any invoice whose Dharam Kanta actual weight differs from the billed
  // Total Weight by this much or more gets auto-flagged for Admin — see
  // submitMfgInvoice.
  const WEIGHT_VARIANCE_FLAG_KG = 50;
  const blankMfgForm = () => ({
    manufacturerName: '', customerName: customers[0]?.name || '', invoiceNo: '', date: '',
    totalWeightKg: 0, actualWeightKg: 0,
  });
  interface MfgLineItem {
    key: string;
    materialName: string;
    materialCode: string;
    quantityPcs: number;
    ratePerPc: number;
    itemValue: number;
    addingNewMaterial: boolean;
    mfgLengthInput: string;
  }
  const blankMfgLineItem = (): MfgLineItem => ({
    key: genId(), materialName: '', materialCode: '', quantityPcs: 0, ratePerPc: 0, itemValue: 0,
    addingNewMaterial: false, mfgLengthInput: '',
  });
  const [mfgForm, setMfgForm] = useState(blankMfgForm);
  const [mfgLineItems, setMfgLineItems] = useState<MfgLineItem[]>([blankMfgLineItem()]);
  const [addingNewManufacturer, setAddingNewManufacturer] = useState(false);
  const [extractingInvoicePhoto, setExtractingInvoicePhoto] = useState(false);
  const [invoicePhotoError, setInvoicePhotoError] = useState<string | null>(null);
  // Whether the CURRENT form's values came from a successful photo read —
  // noted on the Admin Notifications entry (see submitMfgInvoice) so Admin
  // knows to double-check an AI-filled entry against the source invoice a
  // little more carefully than a fully hand-typed one.
  const [mfgAiExtracted, setMfgAiExtracted] = useState(false);

  const updateMfgLineItem = (idx: number, patch: Partial<MfgLineItem>) => {
    setMfgLineItems(prev => prev.map((item, i) => i === idx ? { ...item, ...patch } : item));
  };
  const addMfgLineItem = () => setMfgLineItems(prev => [...prev, blankMfgLineItem()]);
  const removeMfgLineItem = (idx: number) => setMfgLineItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  // Every open of the modal (via the "+ Manufacturer Invoice" button or
  // Cancel) should start completely fresh — nothing carried over from a
  // previous open, whether it was submitted, cancelled, or left mid-"+ Add
  // New" entry.
  const openFreshMfgForm = () => {
    setMfgForm(blankMfgForm());
    setMfgLineItems([blankMfgLineItem()]);
    setAddingNewManufacturer(false);
    setExtractingInvoicePhoto(false);
    setInvoicePhotoError(null);
    setMfgAiExtracted(false);
    setMfgDuplicateError(null);
    setShowMfgForm(true);
  };
  const closeMfgForm = () => {
    setMfgForm(blankMfgForm());
    setMfgLineItems([blankMfgLineItem()]);
    setAddingNewManufacturer(false);
    setExtractingInvoicePhoto(false);
    setInvoicePhotoError(null);
    setMfgAiExtracted(false);
    setMfgDuplicateError(null);
    setShowMfgForm(false);
  };

  // Upload a photo of the invoice -> Gemini reads it -> pre-fills the form
  // below for review. Never writes anything directly; submitMfgInvoice
  // (triggered by the admin's own "Save" click) is still the only path
  // that saves a record, same as manual entry.
  const handleInvoicePhotoUpload = async (file: File) => {
    setInvoicePhotoError(null);
    setExtractingInvoicePhoto(true);
    try {
      const { base64, mimeType } = await readAndCompressInvoicePhoto(file);
      const extracted = await extractInvoiceFromPhoto(base64, mimeType);

      const extractedManufacturer = extracted.manufacturerName.trim();
      const matchedManufacturer = knownManufacturerNames.find(
        n => n.toLowerCase() === extractedManufacturer.toLowerCase()
      );
      const resolvedManufacturerName = matchedManufacturer || extractedManufacturer;
      setAddingNewManufacturer(!matchedManufacturer && !!extractedManufacturer);

      const extractedMaterial = extracted.materialName.trim();
      const extractedCode = extracted.materialCode.trim();
      const materialsForResolvedManufacturer = resolvedManufacturerName
        ? manufacturerInvoices.filter(m => m.manufacturerName.trim().toLowerCase() === resolvedManufacturerName.toLowerCase())
        : [];
      // Match by CODE first — it's a short, structured string a photo reads
      // far more reliably than the long free-text description, and it's
      // the field that's actually meant to be a unique lookup key. Only
      // fall back to matching by name if the code doesn't match anything
      // already on file (e.g. this genuinely is a brand-new material).
      const matchedMaterial =
        (extractedCode && materialsForResolvedManufacturer.find(
          m => normalizeMaterialCode(m.materialCode) === normalizeMaterialCode(extractedCode)
        )) ||
        materialsForResolvedManufacturer.find(
          m => m.materialName.trim().toLowerCase() === extractedMaterial.toLowerCase()
        );

      // On a match, pull Material Name/Code straight from the stored
      // record rather than the photo's OCR read of them — that's what
      // keeps an already-known material from ever spawning a near-duplicate
      // over a stray character the photo happened to pick up.
      const resolvedMaterialName = matchedMaterial ? matchedMaterial.materialName : extractedMaterial;
      const resolvedCode = matchedMaterial ? matchedMaterial.materialCode : extractedCode;
      const lengthEntry = materialLengths.find(m => normalizeMaterialCode(m.materialCode) === normalizeMaterialCode(resolvedCode));
      const resolvedLength = lengthEntry ? lengthEntry.lengthMm : parsePieceLengthFromMaterialName(extractedMaterial);

      setMfgForm(prev => ({
        ...prev,
        manufacturerName: resolvedManufacturerName,
        customerName: prev.customerName || customers[0]?.name || '',
        invoiceNo: extracted.invoiceNo.trim(),
        date: extracted.date.trim(),
      }));
      // Only the first line item is read from a photo (see the note next
      // to Upload Photo below) — it fills line 1; any additional materials
      // on this invoice are added by hand via "+ Add Another Material".
      setMfgLineItems([{
        key: genId(),
        materialName: resolvedMaterialName,
        materialCode: resolvedCode,
        quantityPcs: extracted.quantityPcs,
        ratePerPc: extracted.ratePerPc,
        itemValue: extracted.itemValue,
        addingNewMaterial: !matchedMaterial && !!(extractedMaterial || extractedCode),
        mfgLengthInput: resolvedLength !== null && resolvedLength !== undefined ? String(resolvedLength) : '',
      }]);
      setMfgAiExtracted(true);
    } catch (err: any) {
      setInvoicePhotoError(err?.message || 'Could not read this photo — enter the details manually below.');
    } finally {
      setExtractingInvoicePhoto(false);
    }
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

  const submitMfgInvoice = (e: React.FormEvent) => {
    e.preventDefault();
    // Hard block: this exact material already has an entry under this
    // invoice number for this manufacturer. Scoped to manufacturer (not
    // global) since two different manufacturers can legitimately reuse the
    // same invoice numbering — and scoped to material code (not just
    // invoice+manufacturer) because one real invoice often clubs together
    // several different materials (e.g. RMSS00000118 and RMSS00000119 on
    // the same invoice no.), each of which is its own separate line here.
    // Only re-entering the SAME material against the SAME invoice twice
    // counts as a duplicate — checked both against what's already saved
    // AND against the other lines in this same submission.
    const invoiceNoTrim = mfgForm.invoiceNo.trim().toLowerCase();
    const manufacturerTrim = mfgForm.manufacturerName.trim().toLowerCase();
    const seenCodesThisSubmission = new Set<string>();
    for (const item of mfgLineItems) {
      const materialCodeTrim = item.materialCode.trim().toLowerCase();
      const alreadyOnFile = manufacturerInvoices.some(m =>
        m.invoiceNo.trim().toLowerCase() === invoiceNoTrim &&
        m.manufacturerName.trim().toLowerCase() === manufacturerTrim &&
        m.materialCode.trim().toLowerCase() === materialCodeTrim
      );
      if (alreadyOnFile || seenCodesThisSubmission.has(materialCodeTrim)) {
        setMfgDuplicateError(`Invoice "${mfgForm.invoiceNo}" from ${mfgForm.manufacturerName} already has an entry for material "${item.materialCode}" — not saving it again. If this invoice also covers a different material, that's fine — just save it as its own line.`);
        return;
      }
      seenCodesThisSubmission.add(materialCodeTrim);
    }
    setMfgDuplicateError(null);

    // Weight variance is a whole-invoice thing (one vehicle, one Dharam
    // Kanta weighment) — computed once here and stamped onto every line
    // item's record, same as the invoice no./date/weights themselves.
    const totalWeightKg = mfgForm.totalWeightKg || 0;
    const actualWeightKg = mfgForm.actualWeightKg || 0;
    const bothWeightsEntered = totalWeightKg > 0 && actualWeightKg > 0;
    const weightVarianceKg = bothWeightsEntered ? actualWeightKg - totalWeightKg : 0;
    const weightFlagged = bothWeightsEntered && Math.abs(weightVarianceKg) >= WEIGHT_VARIANCE_FLAG_KG;

    const newInvoices = mfgLineItems.map(item => ({
      id: genId(),
      manufacturerName: mfgForm.manufacturerName,
      customerName: mfgForm.customerName,
      invoiceNo: mfgForm.invoiceNo,
      date: mfgForm.date,
      materialName: item.materialName,
      materialCode: item.materialCode,
      quantityPcs: item.quantityPcs,
      ratePerPc: item.ratePerPc,
      itemValue: item.itemValue,
      totalWeightKg,
      actualWeightKg,
      weightFlagged,
      createdAt: new Date().toISOString(),
    }));
    setManufacturerInvoices(prev => [...prev, ...newInvoices]);

    // Persist a newly-entered piece length for any material that doesn't
    // already have one recorded — one per line item, same as before.
    const newLengths = mfgLineItems.filter(item =>
      item.mfgLengthInput &&
      !materialLengths.some(m => m.materialCode.toUpperCase() === item.materialCode.toUpperCase().trim())
    );
    if (newLengths.length > 0) {
      setMaterialLengths(prev => {
        let next = prev;
        for (const item of newLengths) {
          next = [
            ...next.filter(m => m.materialCode.toUpperCase() !== item.materialCode.toUpperCase().trim()),
            { materialCode: item.materialCode.trim(), materialName: item.materialName, lengthMm: parseFloat(item.mfgLengthInput) || 0, updatedAt: new Date().toISOString() },
          ];
        }
        return next;
      });
    }

    const totalQty = mfgLineItems.reduce((sum, item) => sum + (item.quantityPcs || 0), 0);
    // Sum of every line item's own Item Value — same figure Admin's Tally
    // auto-match compares against later (see the `appTotalValue` calc in
    // the shipments useMemo above), shown here too so Admin can see it the
    // moment the invoice is entered, not only later in the reconciliation
    // view. Formatted in the Indian numbering system (lakh/crore grouping),
    // same convention already used elsewhere on this screen for ₹ amounts.
    const totalBillValue = mfgLineItems.reduce((sum, item) => sum + (item.itemValue || 0), 0);
    const totalBillValueFormatted = totalBillValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const aiSuffix = mfgAiExtracted
      ? (mfgLineItems.length > 1 ? ' — first line auto-filled from photo, please verify against the invoice' : ' — auto-filled from photo, please verify against the invoice')
      : ' — entered manually';
    const materialsSummary = mfgLineItems.length === 1
      ? `${mfgLineItems[0].materialName || 'material'} (${mfgLineItems[0].materialCode || 'no code'})`
      : `${mfgLineItems.length} materials: ${mfgLineItems.map(i => `${i.materialCode || 'no code'} (${i.quantityPcs} Pcs)`).join(', ')}`;
    onCreateAlert?.({
      type: 'rm_cross_bill',
      invoiceNumber: mfgForm.invoiceNo,
      customer: mfgForm.customerName,
      supplier: mfgForm.manufacturerName,
      quantity: totalQty,
      itemCount: mfgLineItems.length,
      remarks: `Manufacturer Invoice — ${materialsSummary} — Total Weight ${totalWeightKg} Kg — Total Bill Value ₹${totalBillValueFormatted}${aiSuffix}`,
    });

    // Separate, high-visibility alert when the Dharam Kanta actual weight
    // is off from the invoice's billed weight by WEIGHT_VARIANCE_FLAG_KG
    // or more — this is the "don't overpay the RM supplier" check, kept as
    // its own alert type so it's never confused with the routine "invoice
    // entered" notification above.
    if (weightFlagged) {
      onCreateAlert?.({
        type: 'rm_weight_mismatch',
        invoiceNumber: mfgForm.invoiceNo,
        customer: mfgForm.customerName,
        supplier: mfgForm.manufacturerName,
        quantity: totalQty,
        itemCount: mfgLineItems.length,
        remarks: `${materialsSummary} — Invoice billed ${totalWeightKg} Kg, Dharam Kanta actual ${actualWeightKg} Kg — ${weightVarianceKg > 0 ? 'received MORE than billed by' : 'received LESS than billed by'} ${Math.abs(weightVarianceKg).toFixed(1)} Kg. Review for a supplier debit note.`,
      });
    }

    setMfgForm(blankMfgForm());
    setMfgLineItems([blankMfgLineItem()]);
    setAddingNewManufacturer(false);
    setMfgAiExtracted(false);
    setShowMfgForm(false);
  };

  // Admin-only cleanup for a wrongly/duplicate-entered Manufacturer Invoice
  // (e.g. one entered before the duplicate-invoice-number check above
  // existed). If it already has a matched Customer Cross-Invoice, that gets
  // removed too, since a match against a deleted invoice is meaningless.
  const deleteMfgInvoice = (inv: RMManufacturerInvoice) => {
    const hasMatch = !!inv.matchedCrossInvoiceId;
    const confirmMsg = hasMatch
      ? `Delete this Manufacturer Invoice AND its matched Customer Invoice? This cannot be undone.\n\n${inv.manufacturerName} — Invoice ${inv.invoiceNo}`
      : `Delete this Manufacturer Invoice entry? This cannot be undone.\n\n${inv.manufacturerName} — Invoice ${inv.invoiceNo}`;
    if (!window.confirm(confirmMsg)) return;
    setManufacturerInvoices(prev => prev.filter(m => m.id !== inv.id));
    if (hasMatch) {
      setCrossInvoices(prev => prev.filter(c => c.id !== inv.matchedCrossInvoiceId));
    }
  };

  // --- Customer Cross-Invoice form ---
  const blankCrossForm = () => ({
    customerName: customers[0]?.name || '', invoiceNo: '', date: '', refManufacturerInvoiceId: '',
    quantityMtr: 0, rate: 0, itemValue: 0,
  });
  const [crossForm, setCrossForm] = useState(blankCrossForm);
  const [extractingCrossPhoto, setExtractingCrossPhoto] = useState(false);
  const [crossPhotoError, setCrossPhotoError] = useState<string | null>(null);
  const [crossAiExtracted, setCrossAiExtracted] = useState(false);
  const selectedMfgInvoice = manufacturerInvoices.find(m => m.id === crossForm.refManufacturerInvoiceId);

  const openFreshCrossForm = () => {
    setCrossForm(blankCrossForm());
    setExtractingCrossPhoto(false);
    setCrossPhotoError(null);
    setCrossAiExtracted(false);
    setCrossDuplicateError(null);
    setShowCrossForm(true);
  };
  const closeCrossForm = () => {
    setCrossForm(blankCrossForm());
    setExtractingCrossPhoto(false);
    setCrossPhotoError(null);
    setCrossAiExtracted(false);
    setCrossDuplicateError(null);
    setShowCrossForm(false);
  };

  // Same pattern as handleInvoicePhotoUpload above, for the customer's own
  // cross-invoice instead of the manufacturer's. Deliberately does NOT
  // touch refManufacturerInvoiceId — which outstanding manufacturer
  // invoice this matches stays a manual pick, always.
  const handleCrossInvoicePhotoUpload = async (file: File) => {
    setCrossPhotoError(null);
    setExtractingCrossPhoto(true);
    try {
      const { base64, mimeType } = await readAndCompressInvoicePhoto(file);
      const extracted = await extractCustomerInvoiceFromPhoto(base64, mimeType);

      const extractedCustomer = extracted.customerName.trim();
      const matchedCustomer = customers.find(c => c.name.trim().toLowerCase() === extractedCustomer.toLowerCase());

      setCrossForm(prev => ({
        ...prev,
        customerName: matchedCustomer ? matchedCustomer.name : (extractedCustomer || prev.customerName),
        invoiceNo: extracted.invoiceNo.trim(),
        date: extracted.date.trim(),
        quantityMtr: extracted.quantityMtr,
        rate: extracted.rate,
        itemValue: extracted.itemValue,
      }));
      setCrossAiExtracted(true);
    } catch (err: any) {
      setCrossPhotoError(err?.message || 'Could not read this photo — enter the details manually below.');
    } finally {
      setExtractingCrossPhoto(false);
    }
  };

  const submitCrossInvoice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMfgInvoice) return;
    // Hard block: this exact Manufacturer Invoice already has a matching
    // Customer Invoice on file. Scoped to the specific manufacturer invoice
    // being matched (not just invoice number + customer) for the same
    // reason as the Manufacturer Invoice check above — one customer
    // invoice number can legitimately cover several different materials,
    // each matched to a different Manufacturer Invoice line, in separate
    // entries here.
    const invoiceNoTrim = crossForm.invoiceNo.trim().toLowerCase();
    const customerTrim = crossForm.customerName.trim().toLowerCase();
    const isDuplicate = crossInvoices.some(c =>
      c.invoiceNo.trim().toLowerCase() === invoiceNoTrim &&
      c.customerName.trim().toLowerCase() === customerTrim &&
      c.refManufacturerInvoiceId === crossForm.refManufacturerInvoiceId
    );
    if (isDuplicate) {
      setCrossDuplicateError(`Invoice "${crossForm.invoiceNo}" from ${crossForm.customerName} is already matched against this same Manufacturer Invoice — not saving it again. If this invoice also covers a different material, match it against that Manufacturer Invoice instead and save it as its own entry.`);
      return;
    }
    setCrossDuplicateError(null);
    const id = genId();
    setCrossInvoices(prev => [...prev, {
      id, customerName: crossForm.customerName, invoiceNo: crossForm.invoiceNo, date: crossForm.date,
      refManufacturerInvoiceId: crossForm.refManufacturerInvoiceId,
      materialName: selectedMfgInvoice.materialName, materialCode: selectedMfgInvoice.materialCode,
      quantityMtr: crossForm.quantityMtr, rate: crossForm.rate, itemValue: crossForm.itemValue,
      createdAt: new Date().toISOString(),
    }]);
    setManufacturerInvoices(prev => prev.map(m => m.id === selectedMfgInvoice.id ? { ...m, matchedCrossInvoiceId: id } : m));
    onCreateAlert?.({
      type: 'rm_cross_bill',
      invoiceNumber: crossForm.invoiceNo,
      customer: crossForm.customerName,
      quantity: crossForm.quantityMtr,
      remarks: `Customer Invoice — matched to ${selectedMfgInvoice.manufacturerName} invoice ${selectedMfgInvoice.invoiceNo} (${selectedMfgInvoice.materialName})${crossAiExtracted ? ' — auto-filled from photo, please verify against the invoice' : ' — entered manually'}`,
    });
    setCrossForm({ customerName: crossForm.customerName, invoiceNo: '', date: '', refManufacturerInvoiceId: '', quantityMtr: 0, rate: 0, itemValue: 0 });
    setCrossAiExtracted(false);
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
          <button onClick={openFreshCrossForm} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-black uppercase tracking-widest">
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
        <FormField label="Material Name">
          <select value={filterMaterial} onChange={(e) => setFilterMaterial(e.target.value)}
            className="w-56 border-2 border-slate-200 rounded-xl px-3 py-2 text-sm bg-white">
            <option value="">All materials</option>
            {filterMaterialOptions.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </FormField>
        {filtersActive && (
          <button type="button" onClick={() => { setFilterManufacturer(''); setFilterMonth(''); setFilterMaterial(''); }}
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
                  <p className="text-xs mt-1">{inv.manufacturerName} → {inv.customerName} • Invoice {inv.invoiceNo} • {new Date(inv.date).toLocaleDateString('en-GB')} • {inv.quantityPcs} Pcs{inv.totalWeightKg ? ` • ${inv.totalWeightKg} Kg` : ''} • ₹{(inv.itemValue ?? 0).toLocaleString('en-IN')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border">{band.label} · {days}d</span>
                  {isAdmin && (
                    <button type="button" onClick={() => deleteMfgInvoice(inv)} title="Delete this invoice entry"
                      className="text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg p-1.5 text-sm leading-none">
                      🗑
                    </button>
                  )}
                </div>
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
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-black px-2 py-1 rounded-lg ${overThreshold ? 'bg-rose-600 text-white' : markupPct < 0 ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}>
                      {markupPct >= 0 ? '+' : ''}{markupPct.toFixed(2)}% markup
                    </span>
                    {isAdmin && (
                      <button type="button" onClick={() => deleteMfgInvoice(inv)} title="Delete this matched pair"
                        className="text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg p-1.5 text-sm leading-none">
                        🗑
                      </button>
                    )}
                  </div>
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

      {/* Weight & Stock Reconciliation */}
      <div className="mt-10">
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest mb-1">⚖️ Weight & Stock Reconciliation ({shipments.length})</h3>
        <p className="text-xs text-slate-400 mb-3">One row per invoice — the Dharam Kanta weight against what was billed, whether anything's been logged into RM stock against this invoice number yet, and whether Tally has actually booked it (checked automatically every hour against Tally's own Purchase data, for the same amount). This is the check that stops you paying a supplier for more than what actually arrived.</p>
        {shipments.length === 0 && (
          <div className="bg-slate-50 text-slate-400 text-sm font-bold rounded-2xl px-6 py-6 text-center">
            No Manufacturer Invoices on file yet.
          </div>
        )}
        <div className="space-y-2">
          {shipments.map(s => {
            const noStockYet = s.matchingInwardCount === 0;
            const bookedWithOpenIssue = s.effectiveTallyBooked && ((s.weightFlagged && !s.debitNoteAmount) || noStockYet);
            return (
              <div key={s.key} className={`border rounded-2xl px-5 py-4 ${s.weightFlagged ? 'border-orange-300 bg-orange-50/40' : 'border-slate-100 bg-white'}`}>
                <div className="flex justify-between items-start flex-wrap gap-2">
                  <div>
                    <p className="font-bold text-slate-900 text-sm">{s.manufacturerName}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Invoice {s.invoiceNo} • {new Date(s.date).toLocaleDateString('en-GB')} • {s.lineItems.length} material{s.lineItems.length > 1 ? 's' : ''}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {s.hasWeights ? (
                      <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${s.weightFlagged ? 'bg-orange-100 text-orange-700 border-orange-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                        {s.weightFlagged ? `⚖️ ${s.variance > 0 ? '+' : ''}${s.variance.toFixed(1)} Kg` : 'Weight OK'}
                      </span>
                    ) : (
                      <span className="text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border bg-slate-50 text-slate-400 border-slate-200">No weights recorded</span>
                    )}
                    <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${noStockYet ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                      {noStockYet ? 'Not yet in stock' : `${s.matchingInwardCount} stock entr${s.matchingInwardCount === 1 ? 'y' : 'ies'} logged`}
                    </span>
                  </div>
                </div>
                {s.hasWeights && (
                  <p className="text-xs text-slate-600 mt-2">Billed {s.totalWeightKg} Kg • Dharam Kanta {s.actualWeightKg} Kg</p>
                )}
                {s.debitNoteAmount ? (
                  <p className="text-[11px] font-bold text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-1.5 mt-2 inline-block">
                    💸 Debit note recorded: ₹{s.debitNoteAmount.toLocaleString('en-IN')}{s.debitNoteRemark ? ` — ${s.debitNoteRemark}` : ''}
                  </p>
                ) : debitNoteFormKey === s.key ? (
                  <div className="mt-2 border-2 border-orange-200 bg-orange-50/40 rounded-xl p-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input type="number" step="0.01" placeholder="Debit amount (₹)" value={debitNoteAmountInput}
                        onChange={(e) => setDebitNoteAmountInput(e.target.value)}
                        className="border-2 border-orange-200 rounded-lg px-2 py-1.5 text-xs" />
                      <input type="text" placeholder="Remark (optional)" value={debitNoteRemarkInput}
                        onChange={(e) => setDebitNoteRemarkInput(e.target.value)}
                        className="border-2 border-orange-200 rounded-lg px-2 py-1.5 text-xs" />
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={cancelDebitNoteForm} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 px-2">Cancel</button>
                      <button type="button" onClick={() => saveDebitNote(s)} className="text-[10px] font-black uppercase tracking-widest text-white bg-orange-600 hover:bg-orange-700 rounded-lg px-3 py-1.5">Save Debit Note</button>
                    </div>
                  </div>
                ) : s.weightFlagged && isAdmin && (
                  <button type="button" onClick={() => openDebitNoteForm(s)}
                    className="text-[10px] font-black uppercase tracking-widest text-orange-600 hover:text-orange-800 mt-2">
                    + Record Debit Note
                  </button>
                )}
                <div className="mt-3 pt-3 border-t border-slate-100">
                  {s.tallyMatch ? (
                    // Auto-detected — synced hourly from Tally's own Purchase
                    // vouchers by the Tally Connector script. This is the
                    // "does what I entered match what got booked" check.
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${s.tallyValueMismatch ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                        {s.tallyValueMismatch ? '⚠ Booked in Tally — amount differs' : '✅ Confirmed in Tally'}
                      </span>
                      <span className="text-xs text-slate-600">
                        Tally: ₹{s.tallyMatch.totalValue.toLocaleString('en-IN')} (Vch #{s.tallyMatch.tallyVoucherNumber || s.tallyMatch.invoiceNumber})
                        {s.tallyValueMismatch && <> · You entered: ₹{s.appTotalValue.toLocaleString('en-IN')}</>}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border bg-slate-50 text-slate-400 border-slate-200">Not yet seen in Tally</span>
                      {isAdmin ? (
                        <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                          <input type="checkbox" checked={s.tallyBooked}
                            onChange={(e) => updateShipmentInvoices(s.invoiceNo, s.manufacturerName, { tallyBooked: e.target.checked, tallyBookedAt: e.target.checked ? new Date().toISOString() : undefined })} />
                          Mark booked manually
                        </label>
                      ) : s.tallyBooked && (
                        <span className="text-xs font-bold text-slate-500">✓ Marked booked manually</span>
                      )}
                      {s.tallyBooked && isAdmin && (
                        <input type="text" placeholder="Voucher No." value={s.tallyVoucherNo}
                          onChange={(e) => updateShipmentInvoices(s.invoiceNo, s.manufacturerName, { tallyVoucherNo: e.target.value })}
                          className="border border-slate-200 rounded-lg px-2 py-1 text-xs w-32" />
                      )}
                    </div>
                  )}
                  {bookedWithOpenIssue && (
                    <p className="text-[10px] font-black uppercase tracking-widest text-rose-600 mt-2">⚠ Booked with an open flag — check before paying</p>
                  )}
                </div>
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
            <div className="border-2 border-dashed border-indigo-200 bg-indigo-50/40 rounded-2xl p-4 text-center mb-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400 mb-2">Auto-fill from a photo (AI)</p>
              <div className="flex items-center justify-center gap-3">
                {/* capture="environment" only means anything to a browser with a camera
                    (phone/tablet, or a PC with a webcam) — it opens that camera directly
                    instead of a file browser. On a desktop with no camera it's simply
                    ignored, so this button is safe to always show; "Upload Photo" next
                    to it covers the common desktop case explicitly either way. */}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  id="mfg-invoice-camera"
                  className="hidden"
                  disabled={extractingInvoicePhoto}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleInvoicePhotoUpload(f); e.target.value = ''; }}
                />
                <label htmlFor="mfg-invoice-camera" className={`inline-flex items-center gap-2 px-4 py-2 bg-white border-2 border-indigo-200 rounded-xl text-xs font-black text-indigo-700 ${extractingInvoicePhoto ? 'cursor-wait opacity-70' : 'cursor-pointer hover:border-indigo-500'}`}>
                  📷 Use Camera
                </label>
                <input
                  type="file"
                  accept="image/*"
                  id="mfg-invoice-upload"
                  className="hidden"
                  disabled={extractingInvoicePhoto}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleInvoicePhotoUpload(f); e.target.value = ''; }}
                />
                <label htmlFor="mfg-invoice-upload" className={`inline-flex items-center gap-2 px-4 py-2 bg-white border-2 border-indigo-200 rounded-xl text-xs font-black text-indigo-700 ${extractingInvoicePhoto ? 'cursor-wait opacity-70' : 'cursor-pointer hover:border-indigo-500'}`}>
                  📁 Upload Photo
                </label>
              </div>
              {extractingInvoicePhoto && <p className="text-xs font-bold text-indigo-600 mt-3">⏳ Reading invoice photo…</p>}
              <p className="text-[10px] text-slate-400 mt-2">Reads the invoice and pre-fills the fields below — always review before saving. Only the first line item is read.</p>
              {invoicePhotoError && <p className="text-[11px] font-bold text-rose-600 mt-2">{invoicePhotoError}</p>}
            </div>
            <form onSubmit={submitMfgInvoice} className="space-y-3">
              <FormField label="Manufacturer Name">
                <select
                  required={!addingNewManufacturer}
                  value={addingNewManufacturer ? NEW_OPTION : mfgForm.manufacturerName}
                  onChange={(e) => {
                    const v = e.target.value;
                    // Manufacturer changed — the material list below is
                    // scoped to whichever manufacturer is selected, so
                    // whatever material line(s) were picked no longer apply.
                    setMfgLineItems([blankMfgLineItem()]);
                    if (v === NEW_OPTION) {
                      setAddingNewManufacturer(true);
                      setMfgForm({ ...mfgForm, manufacturerName: '' });
                    } else {
                      setAddingNewManufacturer(false);
                      setMfgForm({ ...mfgForm, manufacturerName: v });
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
                    onChange={(e) => { setMfgForm({ ...mfgForm, invoiceNo: e.target.value }); setMfgDuplicateError(null); }}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Date">
                  <input required type="date" value={mfgForm.date}
                    onChange={(e) => setMfgForm({ ...mfgForm, date: e.target.value })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
              </div>
              {/* One vehicle, one Dharam Kanta weighment — these two cover
                  the whole invoice, not any one material line below. */}
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Total Weight (Invoice)">
                  <input required type="number" step="0.01" min="0.01" placeholder="Enter weight in Kgs" value={mfgForm.totalWeightKg || ''}
                    onChange={(e) => setMfgForm({ ...mfgForm, totalWeightKg: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
                <FormField label="Actual Weight (Dharam Kanta)">
                  <input required type="number" step="0.01" min="0.01" placeholder="Enter weighbridge weight in Kgs" value={mfgForm.actualWeightKg || ''}
                    onChange={(e) => setMfgForm({ ...mfgForm, actualWeightKg: parseFloat(e.target.value) || 0 })}
                    className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                </FormField>
              </div>
              {mfgForm.totalWeightKg > 0 && mfgForm.actualWeightKg > 0 && (() => {
                const variance = mfgForm.actualWeightKg - mfgForm.totalWeightKg;
                const flagged = Math.abs(variance) >= WEIGHT_VARIANCE_FLAG_KG;
                return (
                  <p className={`text-[11px] font-bold rounded-xl px-3 py-2 border-2 ${flagged ? 'text-orange-700 bg-orange-50 border-orange-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>
                    {flagged ? '⚖️ ' : '✓ '}
                    {variance === 0
                      ? 'Weights match exactly.'
                      : `${variance > 0 ? 'Received MORE than billed by' : 'Received LESS than billed by'} ${Math.abs(variance).toFixed(1)} Kg${flagged ? ` — this is ${WEIGHT_VARIANCE_FLAG_KG} Kg or more, so it will be flagged to Admin for review on Save.` : '.'}`}
                  </p>
                );
              })()}
              {mfgLineItems.map((item, idx) => (
                <div key={item.key} className="border-2 border-slate-100 rounded-2xl p-4 space-y-3 relative">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Material {idx + 1}</p>
                    {mfgLineItems.length > 1 && (
                      <button type="button" onClick={() => removeMfgLineItem(idx)}
                        className="text-[10px] font-black uppercase tracking-widest text-rose-400 hover:text-rose-600">
                        ✕ Remove
                      </button>
                    )}
                  </div>
                  <FormField label="Material Name">
                    <select
                      required={!item.addingNewMaterial}
                      value={item.addingNewMaterial ? NEW_OPTION : item.materialName}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === NEW_OPTION) {
                          updateMfgLineItem(idx, { addingNewMaterial: true, materialName: '', materialCode: '', mfgLengthInput: '' });
                        } else {
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
                          updateMfgLineItem(idx, { addingNewMaterial: false, materialName: v, materialCode: code, mfgLengthInput: resolvedLength !== null ? String(resolvedLength) : '' });
                        }
                      }}
                      className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm"
                    >
                      <option value="">Select material</option>
                      {mfgMaterialNameOptions.map(name => <option key={name} value={name}>{name}</option>)}
                      <option value={NEW_OPTION}>+ Add New Material</option>
                    </select>
                  </FormField>
                  {item.addingNewMaterial ? (
                    <>
                      <FormField label="Material Name">
                        <input required autoFocus placeholder="e.g. ERW STEEL TUBES-REC-SBR-60x30x3x4250-AS ROLLED" value={item.materialName}
                          onChange={(e) => {
                            const name = e.target.value;
                            const patch: Partial<MfgLineItem> = { materialName: name };
                            if (!item.mfgLengthInput) {
                              const parsed = parsePieceLengthFromMaterialName(name);
                              if (parsed !== null) patch.mfgLengthInput = String(parsed);
                            }
                            updateMfgLineItem(idx, patch);
                          }}
                          className="w-full border-2 border-emerald-200 bg-emerald-50/40 rounded-xl px-3 py-2 text-sm" />
                      </FormField>
                      <FormField label="Material Code">
                        <input required placeholder="Material code" value={item.materialCode}
                          onChange={(e) => updateMfgLineItem(idx, { materialCode: e.target.value })}
                          className="w-full border-2 border-emerald-200 bg-emerald-50/40 rounded-xl px-3 py-2 text-sm" />
                      </FormField>
                      <FormField label="Piece Length (mm)">
                        <input type="number" placeholder="Piece length in mm (for the Pcs→Meter check)" value={item.mfgLengthInput}
                          onChange={(e) => updateMfgLineItem(idx, { mfgLengthInput: e.target.value })}
                          className="w-full border-2 border-emerald-200 bg-emerald-50/40 rounded-xl px-3 py-2 text-sm" />
                        <p className="text-[10px] text-slate-400 mt-1 px-1">
                          {parsePieceLengthFromMaterialName(item.materialName) !== null
                            ? 'Auto-detected from the material name — check it\'s right, then it\'s reused (locked) on every future invoice for this material.'
                            : 'New material — enter once, then it\'s reused (locked) on every future invoice for this material.'}
                        </p>
                      </FormField>
                      <button type="button" onClick={() => updateMfgLineItem(idx, { addingNewMaterial: false, materialName: '', materialCode: '', mfgLengthInput: '' })}
                        className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 px-1 -mt-2">
                        ‹ Back to list
                      </button>
                    </>
                  ) : item.materialName && (
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label="Material Code">
                        <input disabled value={item.materialCode} placeholder="—"
                          className="w-full border-2 border-slate-100 bg-slate-50 text-slate-500 rounded-xl px-3 py-2 text-sm cursor-not-allowed" />
                      </FormField>
                      <FormField label="Piece Length (mm)">
                        <input disabled value={item.mfgLengthInput} placeholder="Not recorded"
                          className="w-full border-2 border-slate-100 bg-slate-50 text-slate-500 rounded-xl px-3 py-2 text-sm cursor-not-allowed" />
                      </FormField>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-3">
                    <FormField label="Qty (Pcs)">
                      <input required type="number" placeholder="Qty (Pcs)" value={item.quantityPcs || ''}
                        onChange={(e) => updateMfgLineItem(idx, { quantityPcs: parseFloat(e.target.value) || 0 })}
                        className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                    </FormField>
                    <FormField label="Rate / Pc">
                      <input required type="number" step="0.01" placeholder="Rate/Pc" value={item.ratePerPc || ''}
                        onChange={(e) => updateMfgLineItem(idx, { ratePerPc: parseFloat(e.target.value) || 0 })}
                        className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                    </FormField>
                    <FormField label="Item Value">
                      <input required type="number" step="0.01" placeholder="Item Value" value={item.itemValue || ''}
                        onChange={(e) => updateMfgLineItem(idx, { itemValue: parseFloat(e.target.value) || 0 })}
                        className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
                    </FormField>
                  </div>
                </div>
              ))}
              <button type="button" onClick={addMfgLineItem}
                className="w-full py-2.5 border-2 border-dashed border-indigo-200 text-indigo-600 rounded-xl font-bold text-xs hover:border-indigo-400 hover:bg-indigo-50/40">
                + Add Another Material
              </button>
              {mfgDuplicateError && (
                <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border-2 border-rose-200 rounded-xl px-3 py-2">{mfgDuplicateError}</p>
              )}
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
            <div className="border-2 border-dashed border-indigo-200 bg-indigo-50/40 rounded-2xl p-4 text-center mb-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400 mb-2">Auto-fill from a photo (AI)</p>
              <div className="flex items-center justify-center gap-3">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  id="cross-invoice-camera"
                  className="hidden"
                  disabled={extractingCrossPhoto}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCrossInvoicePhotoUpload(f); e.target.value = ''; }}
                />
                <label htmlFor="cross-invoice-camera" className={`inline-flex items-center gap-2 px-4 py-2 bg-white border-2 border-indigo-200 rounded-xl text-xs font-black text-indigo-700 ${extractingCrossPhoto ? 'cursor-wait opacity-70' : 'cursor-pointer hover:border-indigo-500'}`}>
                  📷 Use Camera
                </label>
                <input
                  type="file"
                  accept="image/*"
                  id="cross-invoice-upload"
                  className="hidden"
                  disabled={extractingCrossPhoto}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCrossInvoicePhotoUpload(f); e.target.value = ''; }}
                />
                <label htmlFor="cross-invoice-upload" className={`inline-flex items-center gap-2 px-4 py-2 bg-white border-2 border-indigo-200 rounded-xl text-xs font-black text-indigo-700 ${extractingCrossPhoto ? 'cursor-wait opacity-70' : 'cursor-pointer hover:border-indigo-500'}`}>
                  📁 Upload Photo
                </label>
              </div>
              {extractingCrossPhoto && <p className="text-xs font-bold text-indigo-600 mt-3">⏳ Reading invoice photo…</p>}
              <p className="text-[10px] text-slate-400 mt-2">Fills in Customer, Invoice No, Date, Qty, Rate and Item Value below — you still pick which manufacturer invoice this matches. Always review before saving.</p>
              {crossPhotoError && <p className="text-[11px] font-bold text-rose-600 mt-2">{crossPhotoError}</p>}
            </div>
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
                    onChange={(e) => { setCrossForm({ ...crossForm, invoiceNo: e.target.value }); setCrossDuplicateError(null); }}
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
              {crossDuplicateError && (
                <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border-2 border-rose-200 rounded-xl px-3 py-2">{crossDuplicateError}</p>
              )}
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={closeCrossForm} className="flex-1 py-3 border-2 border-slate-200 text-slate-500 rounded-xl font-bold text-sm">Cancel</button>
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
