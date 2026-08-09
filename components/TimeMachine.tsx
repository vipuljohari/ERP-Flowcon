
import React, { useState, useMemo } from 'react';
import { Sale, InwardLog } from '../types';

interface TimeMachineProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
  sales: Sale[];
  inwardLogs: InwardLog[];
}

const TimeMachine: React.FC<TimeMachineProps> = ({ selectedDate, onDateChange, sales, inwardLogs }) => {
  const [isOpen, setIsOpen] = useState(false);
  const now = new Date();
  
  // State for navigating the calendar view (defaults to selected date's month)
  const [viewDate, setViewDate] = useState(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));

  // Sync viewDate with selectedDate when calendar is opened or selectedDate changes significantly
  React.useEffect(() => {
    if (isOpen) {
      setViewDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
    }
  }, [isOpen, selectedDate]);

  const handleDateClick = (day: number) => {
    const newDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), day);
    if (newDate > now) return; // Prevent future selection
    onDateChange(newDate);
    setIsOpen(false);
  };

  const changeMonth = (offset: number) => {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + offset, 1));
  };

  const HOLIDAYS = ['01-01', '01-26', '03-14', '08-15', '10-02', '10-21', '12-25'];

  const calendarDays = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    // Adjust for Monday start (0: Sun -> 6, 1: Mon -> 0)
    const startingPadding = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
    
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();
    
    const days = [];
    
    // Previous month padding
    for (let i = startingPadding; i > 0; i--) {
      days.push({ day: prevMonthDays - i + 1, monthOffset: -1 });
    }
    
    // Current month
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({ day: i, monthOffset: 0 });
    }
    
    // Next month padding to fill grid (6 rows of 7 = 42)
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      days.push({ day: i, monthOffset: 1 });
    }
    
    return days;
  }, [viewDate]);

  const isToday = selectedDate.toDateString() === now.toDateString();

  return (
    <div className="relative z-50">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-4 px-6 py-3 rounded-[1.5rem] border transition-all shadow-sm active:scale-95 ${
          isToday 
          ? 'bg-white border-slate-100 text-slate-800' 
          : 'bg-slate-900 border-slate-800 text-white'
        }`}
      >
        <div className="flex flex-col items-start">
          <span className="text-[10px] font-black opacity-50 uppercase tracking-widest">
            {isToday ? 'Operational Date' : 'Historical Date'}
          </span>
          <span className="text-sm font-black uppercase tracking-tighter">
            {selectedDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
          </span>
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl transition-colors ${
          isToday ? 'bg-indigo-50 text-indigo-600' : 'bg-indigo-600 text-white'
        }`}>
          📅
        </div>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-4 bg-slate-900 p-6 rounded-[2.5rem] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.6)] border border-slate-800 w-80 animate-in fade-in zoom-in duration-200">
          {/* Calendar Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex flex-col">
              <span className="text-white font-black text-base uppercase tracking-tight">
                {viewDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
              </span>
              <span className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Select Audit Point</span>
            </div>
            <div className="flex gap-1">
              <button onClick={() => changeMonth(-1)} className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M15 19l-7-7 7-7"/></svg>
              </button>
              <button onClick={() => changeMonth(1)} className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9 5l7 7-7 7"/></svg>
              </button>
            </div>
          </div>

          {/* Days Week Header */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <div key={i} className={`text-center text-[10px] font-black py-1 uppercase ${i === 6 ? 'text-rose-500' : 'text-slate-500'}`}>{d}</div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((dateObj, i) => {
              const dateVal = new Date(viewDate.getFullYear(), viewDate.getMonth() + dateObj.monthOffset, dateObj.day);
              const dateKey = `${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`;
              
              const isSelected = dateVal.toDateString() === selectedDate.toDateString();
              const isSystemToday = dateVal.toDateString() === now.toDateString();
              const isFuture = dateVal > now;
              const isSunday = dateVal.getDay() === 0;
              const isHoliday = HOLIDAYS.includes(dateKey) || isSunday;
              const isCurrentMonth = dateObj.monthOffset === 0;

              // Activity indicators
              const hasInward = inwardLogs.some(log => new Date(log.timestamp).toDateString() === dateVal.toDateString());
              const hasDispatch = sales.some(sale => new Date(sale.timestamp).toDateString() === dateVal.toDateString());

              return (
                <button
                  key={i}
                  disabled={isFuture}
                  onClick={() => isCurrentMonth && handleDateClick(dateObj.day)}
                  className={`
                    relative h-9 rounded-lg flex items-center justify-center text-xs font-black transition-all
                    ${!isCurrentMonth ? 'text-slate-700 opacity-20 pointer-events-none' : ''}
                    ${isFuture ? 'text-slate-700 cursor-not-allowed' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}
                    ${isSelected ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 scale-110 z-10' : ''}
                    ${isHoliday && !isSelected ? 'bg-rose-500/10' : ''}
                    ${isHoliday && isCurrentMonth && !isSelected ? 'text-rose-400' : ''}
                    ${isSystemToday && !isSelected ? 'border border-indigo-500/50' : ''}
                  `}
                >
                  {dateObj.day}
                  
                  {/* Indicators */}
                  {isCurrentMonth && (
                    <>
                      {hasInward && <div className="absolute top-1 left-1 w-1.5 h-1.5 bg-emerald-500 rounded-full shadow-[0_0_4px_rgba(16,185,129,0.4)]"></div>}
                      {hasDispatch && <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-amber-400 rounded-full shadow-[0_0_4px_rgba(251,191,36,0.4)]"></div>}
                    </>
                  )}

                  {isSystemToday && !isSelected && <div className="absolute bottom-1 w-1 h-1 bg-indigo-400 rounded-full"></div>}
                </button>
              );
            })}
          </div>

          <div className="mt-6 pt-6 border-t border-slate-800 flex flex-col gap-3">
             <div className="flex justify-between items-center mb-1">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-tighter">Inward</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 bg-amber-400 rounded-full"></div>
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-tighter">Dispatch</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 bg-rose-500/30 rounded-sm"></div>
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-tighter">Holiday</span>
                </div>
             </div>
             <button 
                onClick={() => { 
                  const today = new Date();
                  onDateChange(today); 
                  setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
                  setIsOpen(false); 
                }}
                className="w-full py-3 bg-white text-slate-900 rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-indigo-50 transition-all active:scale-95"
              >
                Reset to Live Now
              </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TimeMachine;
