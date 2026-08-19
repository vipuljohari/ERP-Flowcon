import React, { useEffect, useRef, useState } from 'react';

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  // Used in the "+ Add "<value>" as new ___" row, e.g. "manufacturer".
  newItemLabel: string;
  required?: boolean;
}

// A styled, app-matching dropdown with free-text entry — replaces the
// browser's native <datalist> popup, which renders with its own
// unstylable (often dark) UI and has no way to offer an explicit
// "add a new one" affordance.
const Combobox: React.FC<ComboboxProps> = ({ value, onChange, options, placeholder, newItemLabel, required }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const typed = value.trim().toLowerCase();
  const filtered = typed ? options.filter(o => o.toLowerCase().includes(typed)) : options;
  const hasExactMatch = options.some(o => o.toLowerCase() === typed);
  const showCreateOption = value.trim().length > 0 && !hasExactMatch;

  return (
    <div className="relative" ref={containerRef}>
      <input
        required={required}
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        className="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm"
      />
      {open && (filtered.length > 0 || showCreateOption) && (
        <div className="absolute z-50 mt-1 w-full bg-white border-2 border-slate-200 rounded-xl shadow-xl max-h-56 overflow-y-auto py-1">
          {showCreateOption && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-xs font-black uppercase tracking-widest text-emerald-700 bg-emerald-50/70 hover:bg-emerald-50"
            >
              + Add "{value.trim()}" as new {newItemLabel}
            </button>
          )}
          {filtered.map(opt => (
            <button
              key={opt}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onChange(opt); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default Combobox;
