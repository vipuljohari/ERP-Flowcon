import React, { useState } from 'react';
import { doc, writeBatch, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Part, Sale, InwardLog, MonthlyArchive, Customer, RawMaterial, RMInwardLog } from '../types';

interface LegacyBackup {
  parts?: Part[];
  sales?: Sale[];
  inwardLogs?: InwardLog[];
  archives?: MonthlyArchive[];
  customers?: Customer[];
  rawMaterials?: RawMaterial[];
  rmInwardLogs?: RMInwardLog[];
  localRMOpeningBalances?: Record<string, string>;
  timestamp?: string;
  lastModifiedBy?: string;
}

// Matches your old app's backup shape exactly: collection name -> [Firestore
// collection to write into, how to derive each item's document ID].
const COLLECTION_MAP: { key: keyof LegacyBackup; firestoreName: string; getId: (item: any) => string }[] = [
  { key: 'parts', firestoreName: 'parts', getId: (p) => p.id },
  { key: 'sales', firestoreName: 'sales', getId: (s) => s.id },
  { key: 'inwardLogs', firestoreName: 'inwardLogs', getId: (l) => l.id },
  { key: 'customers', firestoreName: 'customers', getId: (c) => c.id },
  { key: 'rawMaterials', firestoreName: 'rawMaterials', getId: (r) => r.id },
  { key: 'rmInwardLogs', firestoreName: 'rmInwardLogs', getId: (l) => l.id },
  { key: 'archives', firestoreName: 'archives', getId: (a) => a.monthKey },
];

const ImportLegacyData: React.FC = () => {
  const [fileName, setFileName] = useState<string | null>(null);
  const [backup, setBackup] = useState<LegacyBackup | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ collection: string; count: number }[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

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

  const counts = backup
    ? [
        ...COLLECTION_MAP.map(({ key }) => ({ key, count: (backup[key] as any[])?.length || 0 })),
        { key: 'localRMOpeningBalances', count: Object.keys(backup.localRMOpeningBalances || {}).length },
      ]
    : [];

  const handleImport = async () => {
    if (!backup) return;
    setImporting(true);
    setImportError(null);
    try {
      const summary: { collection: string; count: number }[] = [];
      for (const { key, firestoreName, getId } of COLLECTION_MAP) {
        const items = (backup[key] as any[]) || [];
        if (items.length === 0) continue;

        // Firestore batches cap at 500 operations — chunk larger collections.
        for (let i = 0; i < items.length; i += 450) {
          const chunk = items.slice(i, i + 450);
          const batch = writeBatch(db);
          chunk.forEach((item) => {
            const id = getId(item);
            if (id) batch.set(doc(db, firestoreName, String(id)), item, { merge: true });
          });
          await batch.commit();
        }
        summary.push({ collection: firestoreName, count: items.length });
      }

      // Opening balances aren't a per-record collection — they're a single
      // settings-style map (RM identifier -> balance string). This is what
      // was missing before, causing the negative "phantom consumption" you saw.
      if (backup.localRMOpeningBalances && Object.keys(backup.localRMOpeningBalances).length > 0) {
        await setDoc(doc(db, 'settings', 'rmOpeningBalances'), backup.localRMOpeningBalances, { merge: true });
        summary.push({ collection: 'localRMOpeningBalances (settings)', count: Object.keys(backup.localRMOpeningBalances).length });
      }
      setResult(summary);
    } catch (e: any) {
      setImportError(e.message || 'Import failed partway through — check the console for details.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-xl font-black text-slate-900 mb-1">Import Legacy Data</h2>
      <p className="text-xs text-slate-500 font-medium mb-6">
        One-time migration from your old app's backup file into this app's live Firestore data.
        This <strong>merges</strong> by ID — it fills in fields from the backup without wiping out fields
        added since (like manual sort order), so it's safe to run again with a newer backup.
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
          <div className="grid grid-cols-2 gap-2 mb-4">
            {counts.map(({ key, count }) => (
              <div key={key} className="flex justify-between text-sm">
                <span className="text-slate-500 capitalize">{key}</span>
                <span className={`font-bold ${count > 0 ? 'text-slate-900' : 'text-slate-300'}`}>{count}</span>
              </div>
            ))}
          </div>
          <button
            onClick={handleImport}
            disabled={importing}
            className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold text-sm disabled:opacity-50"
          >
            {importing ? 'Importing…' : 'Import into Firestore'}
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
            <div key={r.collection} className="flex justify-between text-sm text-emerald-700">
              <span className="capitalize">{r.collection}</span>
              <span className="font-bold">{r.count} records</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ImportLegacyData;
