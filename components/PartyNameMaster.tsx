import React, { useEffect, useMemo, useState } from 'react';

// ============================================================
// Party Name Master (Admin-only)
// ============================================================
// Controls which Tally-synced Purchase party names are treated as genuine
// RM suppliers for the WhatsApp gate-photo intake pipeline (see
// services/apiHandlers.ts's handleGateUpload and components/GateDocumentsQueue.tsx).
// A gate photo whose OCR-read supplier resolves to a Tally party NOT ticked
// here — including a real party Admin simply hasn't reviewed yet — is
// archived straight to the Dropbox "Unprocessed" folder instead of ever
// reaching Gate Documents for Approval. This is a deliberate allow-list,
// not a deny-list: nothing reaches the queue by default.
//
// The full candidate list (tallySupplierNames) is every distinct
// supplierName seen in rmPurchaseVouchers — the hourly Tally mirror App.tsx
// already keeps live — so it always reflects Tally, never needs manual
// upkeep, and a party that stops appearing in Tally simply stops being
// offered here (though it stays ticked/stored until Admin unticks it).
// ============================================================

interface PartyNameMasterProps {
  tallySupplierNames: string[];
  approvedNames: string[];
  onSave: (names: string[]) => void;
  updatedAt?: string;
  updatedBy?: string;
}

const PartyNameMaster: React.FC<PartyNameMasterProps> = ({ tallySupplierNames, approvedNames, onSave, updatedAt, updatedBy }) => {
  // Local working copy — Admin can tick/untick freely and only commits on
  // "Save Changes", same review-before-commit convention as everywhere
  // else in this app that touches a shared master list. Re-seeded whenever
  // the saved list actually changes underneath (e.g. another Admin session
  // saved first), never on every keystroke of the search box.
  const [working, setWorking] = useState<Set<string>>(() => new Set(approvedNames));
  const [search, setSearch] = useState('');

  // Re-seed the working copy whenever the SAVED list actually changes
  // underneath (a fresh load, or another Admin session saved first) — never
  // on every keystroke of the search box, and never wiping out an in-flight
  // unsaved tick/untick just because this component re-rendered for an
  // unrelated reason.
  const approvedKey = useMemo(() => JSON.stringify([...approvedNames].sort()), [approvedNames]);
  useEffect(() => {
    setWorking(new Set(approvedNames));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvedKey]);

  const sortedNames = useMemo(
    () => Array.from(new Set(tallySupplierNames.map(n => (n || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [tallySupplierNames]
  );

  const filteredNames = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedNames;
    return sortedNames.filter(n => n.toLowerCase().includes(q));
  }, [sortedNames, search]);

  const dirty = useMemo(() => {
    const a = [...working].sort();
    const b = [...approvedNames].sort();
    return JSON.stringify(a) !== JSON.stringify(b);
  }, [working, approvedNames]);

  const toggle = (name: string) => {
    setWorking(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const selectAllFiltered = () => setWorking(prev => new Set([...prev, ...filteredNames]));
  const clearAllFiltered = () => setWorking(prev => {
    const next = new Set(prev);
    filteredNames.forEach(n => next.delete(n));
    return next;
  });

  const handleSave = () => {
    onSave(Array.from(working).sort());
  };

  // Ticked names that no longer appear in Tally's own list at all — kept in
  // the saved list (never silently dropped), but called out so Admin knows
  // they're stale and can decide whether to untick them.
  const staleApproved = useMemo(
    () => Array.from(working).filter(n => !sortedNames.includes(n)).sort((a, b) => a.localeCompare(b)),
    [working, sortedNames]
  );

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-slate-900">Party Name Master</h2>
        <p className="text-sm text-slate-500 mt-1">
          Tick every Purchase party whose WhatsApp gate photos should reach the "Gate Documents for Approval" queue. Anything
          else — including a real Tally party you simply haven't reviewed yet — is archived straight to the Dropbox
          "Unprocessed" folder instead, so nothing is lost, but nothing new shows up here without your say.
        </p>
        {(updatedAt || updatedBy) && (
          <p className="text-[11px] text-slate-400 mt-2">
            Last saved{updatedBy ? ` by ${updatedBy}` : ''}{updatedAt ? ` on ${new Date(updatedAt).toLocaleString('en-IN')}` : ''}.
          </p>
        )}
      </div>

      <div className="bg-white border-2 border-slate-100 rounded-[1.5rem] shadow-sm p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Tally Purchase party names…"
            className="flex-1 border-2 border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
          <span className="text-[11px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">
            {working.size} of {sortedNames.length} approved
          </span>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <button onClick={selectAllFiltered} className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800">
            Tick all shown
          </button>
          <span className="text-slate-300">|</span>
          <button onClick={clearAllFiltered} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600">
            Untick all shown
          </button>
        </div>

        <div className="border-2 border-slate-100 rounded-2xl max-h-[50vh] overflow-y-auto divide-y divide-slate-100">
          {filteredNames.length === 0 && (
            <p className="text-sm text-slate-400 p-4 text-center">
              {sortedNames.length === 0 ? 'No Purchase parties found yet in the Tally mirror (rmPurchaseVouchers).' : 'No party name matches this search.'}
            </p>
          )}
          {filteredNames.map(name => (
            <label key={name} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer">
              <input type="checkbox" checked={working.has(name)} onChange={() => toggle(name)} className="w-4 h-4" />
              <span className="text-sm font-semibold text-slate-700">{name}</span>
            </label>
          ))}
        </div>

        {staleApproved.length > 0 && (
          <div className="mt-4 border border-amber-200 bg-amber-50 rounded-xl p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-1">Approved but not seen in Tally right now</p>
            <p className="text-[11px] text-amber-700">{staleApproved.join(', ')}</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 mt-5 pt-4 border-t border-slate-100">
          {dirty && <span className="text-[11px] font-bold text-rose-500">Unsaved changes</span>}
          <button
            onClick={handleSave}
            disabled={!dirty}
            className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black uppercase text-[10px] tracking-widest"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default PartyNameMaster;
