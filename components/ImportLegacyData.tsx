import React, { useState } from 'react';
import { doc, writeBatch, getDocs, query, where, documentId, collection, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Part, InwardLog, RMInwardLog } from '../types';

interface LegacyBackup {
  parts?: Part[];
  sales?: any[];
  inwardLogs?: InwardLog[];
  archives?: any[];
  customers?: any[];
  rawMaterials?: any[];
  rmInwardLogs?: RMInwardLog[];
  localRMOpeningBalances?: Record<string, string>;
  timestamp?: string;
  lastModifiedBy?: string;
}

interface ResultRow {
  label: string;
  count: number;
  note?: string;
}

// Full-record restore targets — safe to restore wholesale because the live
// Tally import never writes to either of these two collections at all, so
// there's nothing live to clobber.
const FULL_RESTORE_MAP: { key: 'inwardLogs' | 'rmInwardLogs'; firestoreName: string; label: string; getId: (item: any) => string }[] = [
  { key: 'inwardLogs', firestoreName: 'inwardLogs', label: 'Item-wise Inward Logs', getId: (l) => l.id },
  { key: 'rmInwardLogs', firestoreName: 'rmInwardLogs', label: 'RM-wise Inward Logs', getId: (l) => l.id },
];

// Firestore 'in' queries cap at 30 IDs per query — chunk larger id lists.
async function findExistingIds(collectionName: string, ids: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    if (chunk.length === 0) continue;
    const snap = await getDocs(query(collection(db, collectionName), where(documentId(), 'in', chunk)));
    snap.forEach((d) => existing.add(d.id));
  }
  return existing;
}

// "2026-07" -> "2026-08". A Monthly Archive is a snapshot of every part's
// live stock taken automatically at month-end — i.e. that month's real,
// physically-verified CLOSING balance, which is exactly the next month's
// correct OPENING balance. Chaining archive months forward like this is how
// we rebuild Item-wise Opening Balance from verified ground truth instead of
// a live-recomputed guess.
function nextMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

const ImportLegacyData: React.FC = () => {
  const [fileName, setFileName] = useState<string | null>(null);
  const [backup, setBackup] = useState<LegacyBackup | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ResultRow[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [restoreInwardLogs, setRestoreInwardLogs] = useState(true);
  const [restoreSchedules, setRestoreSchedules] = useState(true);
  const [restoreOpeningBalances, setRestoreOpeningBalances] = useState(true);

  const handleFile = (file: File) => {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        setBackup(parsed);
      } catch (e) {
        setParseError('Could not parse this file as JSON. Make sure it\'s the raw backup file, not a screenshot or export from something else.');
        setBackup(null);
      }
    };
    reader.readAsText(file);
  };

  const partsWithSchedule = (backup?.parts || []).filter(
    (p) => p && p.id && p.schedules && Object.keys(p.schedules).length > 0
  );

  // Item-wise Opening Balance corrections, derived from this backup's
  // Monthly Archives — one entry per (target month, part), keyed by the
  // month whose OPENING balance this fixes. E.g. an archive for "2026-07"
  // (July's verified closing stock) produces corrections keyed "2026-08"
  // (August's opening balance).
  const openingBalanceCorrections: Record<string, { partId: string; partName: string; value: number }[]> = {};
  (backup?.archives || []).forEach((arc: any) => {
    if (!arc?.monthKey || !Array.isArray(arc.parts)) return;
    const targetMonth = nextMonthKey(arc.monthKey);
    openingBalanceCorrections[targetMonth] = arc.parts
      .filter((p: any) => p && p.id && typeof p.stock === 'number')
      .map((p: any) => ({ partId: p.id, partName: p.name, value: Math.round(p.stock) }));
  });
  const correctionMonths = Object.keys(openingBalanceCorrections).sort();
  const totalCorrections = correctionMonths.reduce((sum, mk) => sum + openingBalanceCorrections[mk].length, 0);

  const counts = backup
    ? [
        { label: 'Item-wise Inward Logs', count: backup.inwardLogs?.length || 0 },
        { label: 'RM-wise Inward Logs', count: backup.rmInwardLogs?.length || 0 },
        { label: 'Item Master parts with a Monthly Schedule', count: partsWithSchedule.length },
        { label: 'Item-wise Opening Balance corrections (from Monthly Archives)', count: totalCorrections },
      ]
    : [];

  const handleImport = async () => {
    if (!backup) return;
    setImporting(true);
    setImportError(null);
    try {
      const summary: ResultRow[] = [];

      if (restoreInwardLogs) {
        for (const { key, firestoreName, label, getId } of FULL_RESTORE_MAP) {
          const items = (backup[key] as any[]) || [];
          if (items.length === 0) {
            summary.push({ label, count: 0 });
            continue;
          }
          for (let i = 0; i < items.length; i += 450) {
            const chunk = items.slice(i, i + 450);
            const batch = writeBatch(db);
            chunk.forEach((item) => {
              const id = getId(item);
              if (id) batch.set(doc(db, firestoreName, String(id)), item, { merge: true });
            });
            await batch.commit();
          }
          summary.push({ label, count: items.length });
        }
      }

      if (restoreSchedules) {
        if (partsWithSchedule.length === 0) {
          summary.push({ label: 'Item Master — Monthly Schedule', count: 0, note: 'nothing in the backup file had a schedule' });
        } else {
          const ids = partsWithSchedule.map((p) => p.id);
          const existingIds = await findExistingIds('parts', ids);
          const toRestore = partsWithSchedule.filter((p) => existingIds.has(p.id));
          const skipped = partsWithSchedule.length - toRestore.length;

          for (let i = 0; i < toRestore.length; i += 450) {
            const chunk = toRestore.slice(i, i + 450);
            const batch = writeBatch(db);
            chunk.forEach((part) => {
              // ONLY the schedules field. A Firestore set() with merge:true
              // replaces just the field(s) present in this payload on the
              // live doc — schedules gets replaced wholesale with the
              // backup's value, and every other field on that Part
              // (rate, stock, customerRates, sapCode, etc. — all
              // live-Tally-driven) is left completely untouched.
              batch.set(doc(db, 'parts', String(part.id)), { schedules: part.schedules }, { merge: true });
            });
            await batch.commit();
          }
          summary.push({
            label: 'Item Master — Monthly Schedule',
            count: toRestore.length,
            note: skipped > 0 ? `${skipped} skipped — no matching live part with that ID` : undefined,
          });
        }
      }

      if (restoreOpeningBalances) {
        if (correctionMonths.length === 0) {
          summary.push({ label: 'Item-wise Opening Balance (from Monthly Archives)', count: 0, note: 'no Monthly Archives in this backup' });
        } else {
          const allPartIds = Array.from(new Set(correctionMonths.flatMap((mk) => openingBalanceCorrections[mk].map((c) => c.partId))));
          const existingPartIds = await findExistingIds('parts', allPartIds);

          const updatePayload: Record<string, string> = {};
          let written = 0;
          let skipped = 0;
          correctionMonths.forEach((mk) => {
            openingBalanceCorrections[mk].forEach((c) => {
              if (!existingPartIds.has(c.partId)) { skipped++; return; }
              // Same key format resolvedPartOpeningBalances in App.tsx reads:
              // "<month>_<partId>" — a locked Opening Balance for that
              // specific month that then carries forward automatically.
              updatePayload[`${mk}_${c.partId}`] = c.value.toString();
              written++;
            });
          });

          if (written > 0) {
            // A flat merge write — every key here is a distinct top-level
            // field on settings/partOpeningBalances, so this only touches
            // the exact (month, part) pairs computed above. Any other
            // stored value (a different month, or a manual audit lock you
            // set after upgrading) is left completely untouched.
            await setDoc(doc(db, 'settings', 'partOpeningBalances'), updatePayload, { merge: true });
          }

          summary.push({
            label: 'Item-wise Opening Balance (from Monthly Archives)',
            count: written,
            note: `${correctionMonths.join(', ')}${skipped > 0 ? ` — ${skipped} skipped, no longer in Item Master` : ''}`,
          });
        }
      }

      setResult(summary);
    } catch (e: any) {
      setImportError(e.message || 'Import failed partway through — check the console for details.');
    } finally {
      setImporting(false);
    }
  };

  const nothingSelected = !restoreInwardLogs && !restoreSchedules && !restoreOpeningBalances;

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-xl font-black text-slate-900 mb-1">Import Legacy Data</h2>
      <p className="text-xs text-slate-500 font-medium mb-6">
        Selective, one-time restore from your old app's backup file. <strong>Sales, Item Master, and RM
        Master are deliberately NOT touched here</strong> — your live Tally import already keeps those
        current, so restoring them from an old backup would risk overwriting newer data or creating
        duplicates. Only the items below can be restored, and each is opt-in.
      </p>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6 text-xs text-amber-800 font-medium">
        Where to find the file: your old app's Google Drive backup folder, or Dropbox at
        <code className="bg-amber-100 px-1 rounded mx-1">/latest_master.json</code>
        — grab the most recent one before importing.
      </div>

      <div className="border-2 border-dashed border-slate-200 rounded-2xl p-8 text-center mb-6">
        <input
          type="file"
          accept="application/json"
          id="legacy-file"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <label htmlFor="legacy-file" className="cursor-pointer">
          <p className="text-sm font-bold text-slate-700 mb-1">
            {fileName || 'Click to choose your backup .json file'}
          </p>
          <p className="text-xs text-slate-400">Not uploaded anywhere until you click Import below</p>
        </label>
      </div>

      {parseError && (
        <div className="bg-rose-50 text-rose-600 text-xs font-semibold rounded-xl px-4 py-3 mb-6">
          {parseError}
        </div>
      )}

      {backup && !result && (
        <div className="bg-slate-50 rounded-2xl p-6 mb-6">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
            Found in this file {backup.timestamp ? `(backed up ${new Date(backup.timestamp).toLocaleString()})` : ''}
          </p>
          <div className="grid grid-cols-1 gap-2 mb-5">
            {counts.map(({ label, count }) => (
              <div key={label} className="flex justify-between text-sm">
                <span className="text-slate-500">{label}</span>
                <span className={`font-bold ${count > 0 ? 'text-slate-900' : 'text-slate-300'}`}>{count}</span>
              </div>
            ))}
          </div>

          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
            Select what to restore
          </p>
          <div className="space-y-3 mb-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={restoreInwardLogs}
                onChange={(e) => setRestoreInwardLogs(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className="font-bold text-slate-800">RM Inward Logs</span>
                <span className="block text-xs text-slate-500">
                  Both Item-wise and RM-wise inward logs, restored in full — the live Tally sync never
                  writes to these collections, so there's nothing new here to conflict with.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={restoreSchedules}
                onChange={(e) => setRestoreSchedules(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className="font-bold text-slate-800">Item Master — Monthly Schedule</span>
                <span className="block text-xs text-slate-500">
                  Only the Monthly Schedule tab's values, and only for parts that already exist in your
                  live Item Master (matched by ID). Every other field on those parts — rate, stock,
                  customer rates, SAP code, everything — is left exactly as it is now.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={restoreOpeningBalances}
                onChange={(e) => setRestoreOpeningBalances(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className="font-bold text-slate-800">Item-wise Opening Balance — rebuild from Monthly Archives</span>
                <span className="block text-xs text-slate-500">
                  This backup's Monthly Archive is a verified snapshot of every part's real stock at each
                  month's end — that's the correct Opening Balance for the month right after it. This locks
                  Opening Balance for {correctionMonths.length > 0 ? correctionMonths.join(', ') : 'each month found in this backup'} from
                  those snapshots{totalCorrections > 0 ? ` (${totalCorrections} part-month values)` : ''}. Only
                  touches those specific months for parts still in your live Item Master — nothing else.
                </span>
              </span>
            </label>
          </div>

          <button
            onClick={handleImport}
            disabled={importing || nothingSelected}
            className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold text-sm disabled:opacity-50"
          >
            {importing ? 'Importing…' : nothingSelected ? 'Select at least one option above' : 'Import selected'}
          </button>
        </div>
      )}

      {importError && (
        <div className="bg-rose-50 text-rose-600 text-xs font-semibold rounded-xl px-4 py-3 mb-6">
          {importError}
        </div>
      )}

      {result && (
        <div className="bg-emerald-50 rounded-2xl p-6">
          <p className="text-sm font-bold text-emerald-700 mb-3">Import complete ✅</p>
          {result.map((r) => (
            <div key={r.label} className="text-sm text-emerald-700 mb-2">
              <div className="flex justify-between">
                <span>{r.label}</span>
                <span className="font-bold">{r.count} restored</span>
              </div>
              {r.note && <div className="text-xs text-emerald-600">{r.note}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ImportLegacyData;
