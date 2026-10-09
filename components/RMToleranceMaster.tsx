import React, { useMemo, useState } from 'react';
import { DimensionTolerance, RawMaterial } from '../types';
import { parseRMCrossSection } from '../services/dimensionTolerance';

interface RMToleranceMasterProps {
  dimensionTolerances: DimensionTolerance[];
  setDimensionTolerances: (update: DimensionTolerance[] | ((prev: DimensionTolerance[]) => DimensionTolerance[])) => void;
  rawMaterials: RawMaterial[];
}

// 9-Oct-26 — Vipul's ask, after the "40X40X1" camera-upload matching
// failure: a proper Admin tab for managing Dimension Tolerances (what a
// measured OD/Thickness can be invoiced as for a given nominal size, so
// Camera Upload still recognises it as the right Raw Material), instead of
// the small collapsible editor buried inside Material Entry's Longer Pipe
// form. Same underlying data (App.tsx's dimensionTolerances/
// setDimensionTolerances, backed by Firestore) — this is just a better,
// dedicated home for managing the full list, plus a reference panel
// showing the actual OD/Thickness values already in use across RM Master
// so Admin isn't guessing which nominal values to add tolerances for.
//
// NOTE: this tab does NOT replace Material Entry's own inline editor
// (left untouched, still works) — both read/write the exact same
// dimensionTolerances state, so they can never drift out of sync.
const RMToleranceMaster: React.FC<RMToleranceMasterProps> = ({ dimensionTolerances, setDimensionTolerances, rawMaterials }) => {
  const [newTolerance, setNewTolerance] = useState<{ field: 'OD' | 'Thickness'; nominal: string; acceptedValues: string }>({ field: 'Thickness', nominal: '', acceptedValues: '' });

  const addTolerance = () => {
    const nominal = parseFloat(newTolerance.nominal);
    const acceptedValues = newTolerance.acceptedValues.split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n));
    if (!Number.isFinite(nominal) || acceptedValues.length === 0) return;
    setDimensionTolerances(prev => [
      ...prev.filter(t => !(t.field === newTolerance.field && t.nominal === nominal)),
      { id: `${newTolerance.field.toLowerCase()}-${nominal}`, field: newTolerance.field, nominal, acceptedValues, updatedAt: new Date().toISOString() },
    ]);
    setNewTolerance({ field: 'Thickness', nominal: '', acceptedValues: '' });
  };
  const removeTolerance = (id: string) => setDimensionTolerances(prev => prev.filter(t => t.id !== id));

  // Every distinct OD/Thickness value actually in use across RM Master
  // right now (tube RMs only — Sheet has no OD/Thickness concept here),
  // read via the SAME parseRMCrossSection helper the Camera Upload matcher
  // itself uses, so this list can never show a value the matcher reads
  // differently. Grouped by field, sorted, with which RM size(s) it came
  // from and whether a tolerance row already covers it — a quick way to
  // see what's still uncovered.
  const usedValues = useMemo(() => {
    const byField: Record<'OD' | 'Thickness', Map<number, Set<string>>> = { OD: new Map(), Thickness: new Map() };
    rawMaterials
      .filter(rm => rm.category !== 'sheet')
      .forEach(rm => {
        const { odMm, thicknessMm } = parseRMCrossSection(rm.size, rm.length);
        if (typeof thicknessMm === 'number') {
          if (!byField.Thickness.has(thicknessMm)) byField.Thickness.set(thicknessMm, new Set());
          byField.Thickness.get(thicknessMm)!.add(rm.size);
        }
        if (typeof odMm === 'number') {
          if (!byField.OD.has(odMm)) byField.OD.set(odMm, new Set());
          byField.OD.get(odMm)!.add(rm.size);
        }
      });
    const covered = new Set(dimensionTolerances.map(t => `${t.field}:${t.nominal}`));
    const toRows = (field: 'OD' | 'Thickness') =>
      Array.from(byField[field].entries())
        .map(([value, sizes]) => ({ field, value, sizes: Array.from(sizes).sort(), covered: covered.has(`${field}:${value}`) }))
        .sort((a, b) => a.value - b.value);
    return [...toRows('Thickness'), ...toRows('OD')];
  }, [rawMaterials, dimensionTolerances]);

  return (
    <div className="space-y-8 text-left">
      <header>
        <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none text-left">RM Tolerance Master</h2>
        <p className="text-slate-500 font-medium text-left mt-2 max-w-3xl">
          What a measured OD or Thickness can be invoiced as for a given nominal size, so Material Entry's Camera Upload still
          recognises it as the right Raw Material — e.g. nominal Thickness 2 accepting 1.8 or 1.9 (real manufacturing tolerance,
          not a mismatch). A photo that can't find any match at all — even with these — still falls back to picking the Raw
          Material by hand; nothing here ever auto-locks a selection.
        </p>
      </header>

      <div className="bg-white border-2 border-slate-100 rounded-[2rem] p-6 shadow-sm">
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest mb-4">Add / Update a Tolerance</h3>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <select
            value={newTolerance.field}
            onChange={(e) => setNewTolerance({ ...newTolerance, field: e.target.value as 'OD' | 'Thickness' })}
            className="border-2 border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold"
          >
            <option value="Thickness">Thickness</option>
            <option value="OD">OD</option>
          </select>
          <input
            type="number" placeholder="Nominal (e.g. 2)" value={newTolerance.nominal}
            onChange={(e) => setNewTolerance({ ...newTolerance, nominal: e.target.value })}
            className="w-full sm:w-32 border-2 border-slate-200 rounded-xl px-3 py-2.5 text-sm"
          />
          <input
            placeholder="Accepts (e.g. 1.8, 1.9)" value={newTolerance.acceptedValues}
            onChange={(e) => setNewTolerance({ ...newTolerance, acceptedValues: e.target.value })}
            className="flex-1 border-2 border-slate-200 rounded-xl px-3 py-2.5 text-sm"
          />
          <button type="button" onClick={addTolerance} className="px-5 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-black uppercase tracking-widest">
            Add
          </button>
        </div>
      </div>

      <div className="bg-white border-2 border-slate-100 rounded-[2rem] overflow-hidden shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100">
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest">Current Tolerances ({dimensionTolerances.length})</h3>
        </div>
        {dimensionTolerances.length === 0 ? (
          <p className="px-6 py-6 text-sm text-slate-400">No tolerances added yet.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {dimensionTolerances
              .slice()
              .sort((a, b) => a.field.localeCompare(b.field) || a.nominal - b.nominal)
              .map(t => (
                <div key={t.id} className="px-6 py-3 flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-700">
                    <span className="inline-block px-2 py-0.5 mr-2 rounded-full text-[9px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-600">{t.field}</span>
                    {t.nominal} → accepts {t.acceptedValues.join(', ')}
                  </span>
                  <button type="button" onClick={() => removeTolerance(t.id)} className="text-rose-500 hover:text-rose-700 text-[10px] font-black uppercase tracking-widest">
                    Remove
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="bg-white border-2 border-slate-100 rounded-[2rem] overflow-hidden shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100">
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest">OD / Thickness Values In RM Master</h3>
          <p className="text-[11px] text-slate-400 mt-1">
            Every distinct value Camera Upload's matcher currently reads off your tube RM sizes — the same values an invoice's
            measured OD/Thickness is compared against. "Covered" means a tolerance row above already handles it.
          </p>
        </div>
        {usedValues.length === 0 ? (
          <p className="px-6 py-6 text-sm text-slate-400">No tube Raw Materials found.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {usedValues.map(row => (
              <div key={`${row.field}-${row.value}`} className="px-6 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <span className="inline-block px-2 py-0.5 mr-2 rounded-full text-[9px] font-black uppercase tracking-widest bg-slate-100 text-slate-500">{row.field}</span>
                  <span className="text-sm font-bold text-slate-700">{row.value}</span>
                  <span className="block text-[11px] text-slate-400 truncate">{row.sizes.join(', ')}</span>
                </div>
                {row.covered ? (
                  <span className="shrink-0 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-600">Covered</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setNewTolerance({ field: row.field, nominal: String(row.value), acceptedValues: '' })}
                    className="shrink-0 text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800"
                  >
                    Add Tolerance ›
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RMToleranceMaster;
