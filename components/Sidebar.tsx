import React, { useState } from 'react';
import { UserRole, canAccessView } from '../types';
import { useActiveCompany, useBrandName } from '../contexts/CompanyContext';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  currentMonthDisplay: string;
  role: UserRole;
  userDisplayName: string;
  onLogout: () => void;
  showInstallBtn?: boolean;
  onInstall?: () => void;
  userName: string;
  onUserNameChange: (name: string) => void;
  pendingAlertsCount?: number;
}

const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onViewChange,
  currentMonthDisplay,
  role,
  userDisplayName,
  onLogout,
  showInstallBtn = false,
  onInstall,
  userName,
  onUserNameChange,
  pendingAlertsCount = 0
}) => {
  const isAdmin = role === 'admin';
  const company = useActiveCompany();
  const brandName = useBrandName();
  const summaryLabel = `Summary ${currentMonthDisplay}`;

  // Mobile-only: the desktop sidebar below is `hidden` under the md
  // breakpoint (unchanged), so phones/narrow screens instead get a fixed
  // top bar with a hamburger button that opens this same nav as a
  // slide-out drawer. Nothing here changes what renders at md+.
  const [mobileOpen, setMobileOpen] = useState(false);

  const allNavItems = [
    { id: 'dashboard', label: summaryLabel, icon: '📊' },
    { id: 'inventory', label: 'Inventory (RM)', icon: '📦' },
    { id: 'inward_logs', label: 'RM Inward Report', icon: '📥' },
    { id: 'schedule', label: 'Monthly Schedule', icon: '📅' },
    { id: 'dispatch_daily', label: 'Daily Dispatch', icon: '📝' },
    { id: 'sales', label: 'Dispatch Report', icon: '🚚' },
    { id: 'analytics', label: 'AI Analyst', icon: '🤖' },
    { id: 'item_master', label: 'Item Master', icon: '⚙️' },
    { id: 'customer_master', label: 'Customer Master', icon: '🏢' },
    { id: 'rm_master', label: 'RM Master (Admin)', icon: '🛠️' },
    { id: 'data_mgmt', label: 'Cloud & Backup', icon: '☁️' },
  ];

  // Only show items this role is permitted to open.
  const navItems = allNavItems.filter((item) => canAccessView(role, item.id));

  // 'import_issues' and 'rm_crossbill' aren't in allNavItems above (they
  // don't fit the simple filter's position), so they're spliced in here —
  // but which of the two show must still follow canAccessView per role,
  // same as everything else. Store now has rm_crossbill but not
  // import_issues; Accounts now has neither... except rm_crossbill, which
  // it keeps; ppc has neither. Admin always gets both via the '*' wildcard.
  const extraNavItems: { id: string; label: string; icon: string }[] = [];
  if (canAccessView(role, 'import_issues')) extraNavItems.push({ id: 'import_issues', label: 'Import Issues', icon: '⚠️' });
  if (canAccessView(role, 'rm_crossbill')) extraNavItems.push({ id: 'rm_crossbill', label: 'RM Cross-Bill Check', icon: '🧾' });
  if (extraNavItems.length > 0) {
    const salesIdx = navItems.findIndex((i) => i.id === 'sales');
    navItems.splice(salesIdx >= 0 ? salesIdx + 1 : navItems.length, 0, ...extraNavItems);
  }

  // Admin-only management items, always pinned at the end.
  if (isAdmin) {
    navItems.push(
      { id: 'notifications', label: pendingAlertsCount > 0 ? `Notifications (${pendingAlertsCount})` : 'Notifications', icon: '🔔' },
      { id: 'user_master', label: 'User Master', icon: '👤' },
      { id: 'company_master', label: 'Company Master', icon: '🏭' },
      { id: 'import_legacy', label: 'Import Legacy Data', icon: '📤' },
    );
  }

  // Used by both the desktop sidebar and the mobile drawer — on mobile,
  // picking an item also closes the drawer; on desktop this is a no-op
  // since mobileOpen is never true there.
  const handleNav = (id: string) => {
    onViewChange(id);
    setMobileOpen(false);
  };

  // Shared nav body — identical content/behavior in both the fixed desktop
  // sidebar and the mobile slide-out drawer, so the two never drift apart.
  const navContent = (
    <>
      <div className="mb-8 flex flex-col gap-1 text-left">
        <div className="flex items-center gap-3">
          <div className={`h-10 px-1.5 bg-white rounded-lg flex items-center justify-center shadow-lg transition-all duration-500 ${isAdmin ? 'shadow-amber-500/20' : 'shadow-indigo-500/20'}`}>
            <img src="/logo.png" alt={brandName} className="h-full w-auto object-contain" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-tight">{brandName}</h1>
            {isAdmin && <span className="text-[10px] text-amber-500 font-black uppercase tracking-widest animate-pulse">Admin Active</span>}
          </div>
        </div>
        <p className="text-[10px] text-slate-500 font-medium ml-13 mt-1 uppercase tracking-tighter">{company.address}</p>
      </div>

      <nav className="space-y-1 flex-1 overflow-y-auto pr-2 custom-scrollbar">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleNav(item.id)}
            className={`w-full flex items-center gap-4 px-4 py-3 rounded-xl transition-all ${
              currentView === item.id
              ? (isAdmin && (item.id === 'customer_master' || item.id === 'item_master') ? 'bg-amber-500 text-slate-900 shadow-md shadow-amber-500/20' :
                 (currentView === item.id ? (isAdmin ? 'bg-amber-500 text-slate-900' : 'bg-indigo-600 text-white') : ''))
              : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            } ${currentView === item.id && !isAdmin ? 'bg-indigo-600 text-white' : ''} ${currentView === item.id && isAdmin ? 'bg-amber-500 text-slate-900' : ''}`}
          >
            <span className="text-lg">{item.icon}</span>
            <span className="font-semibold text-sm text-left">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="mt-auto space-y-4 pt-6">
        {/* Station Identifier */}
        <div className="px-4 py-3 bg-slate-800/50 rounded-2xl border border-slate-700/50 mb-2">
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Station ID</p>
          <input
            type="text"
            value={userName}
            onChange={(e) => onUserNameChange(e.target.value)}
            className="w-full bg-transparent border-none p-0 text-xs font-bold text-slate-300 focus:ring-0 placeholder-slate-600"
            placeholder="Assign station..."
          />
        </div>

        {showInstallBtn && (
          <button
            onClick={onInstall}
            className="w-full p-4 bg-emerald-600/10 border border-emerald-500/30 rounded-2xl text-emerald-400 hover:bg-emerald-600 hover:text-white transition-all flex items-center justify-between group overflow-hidden relative shadow-lg shadow-emerald-900/10"
          >
            <div className="text-left relative z-10">
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-500 group-hover:text-emerald-200">System Ready</p>
              <p className="text-xs font-bold">Setup Desktop App</p>
            </div>
            <span className="text-xl group-hover:scale-110 transition-transform relative z-10">💻</span>
          </button>
        )}

        <div className="w-full p-4 rounded-2xl border bg-slate-800/50 border-slate-700/50">
          <div className="flex items-center justify-between mb-3">
            <div className="text-left">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Signed in as</p>
              <p className="text-xs font-bold text-slate-200">{userDisplayName}</p>
              <p className={`text-[10px] font-black uppercase tracking-widest mt-1 ${isAdmin ? 'text-amber-500' : 'text-indigo-400'}`}>{role}</p>
            </div>
            <span className="text-xl">{isAdmin ? '👑' : '👋'}</span>
          </div>
          <button
            onClick={onLogout}
            className="w-full py-2 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-400 hover:text-white hover:bg-slate-700/50 transition-all"
          >
            Log Out
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar — fixed, only below md. Replaces the hidden desktop
          sidebar with a hamburger button that opens the drawer below. */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-16 bg-slate-900 text-white flex items-center justify-between px-4 z-50 border-b border-slate-800">
        <button
          onClick={() => setMobileOpen(true)}
          className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-slate-800 transition-colors"
          aria-label="Open menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div className="flex items-center gap-2">
          <div className="h-8 px-1 bg-white rounded-lg flex items-center justify-center shadow">
            <img src="/logo.png" alt={brandName} className="h-full w-auto object-contain" />
          </div>
          <span className="font-bold text-sm tracking-tight">{brandName}</span>
        </div>

        {pendingAlertsCount > 0 ? (
          <span className="w-7 h-7 rounded-full bg-rose-600 text-[10px] font-black flex items-center justify-center">
            {pendingAlertsCount > 9 ? '9+' : pendingAlertsCount}
          </span>
        ) : (
          <span className="w-10 h-10" aria-hidden="true" />
        )}
      </div>

      {/* Mobile drawer + backdrop — only below md, only while open. */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex">
          <div
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative w-72 max-w-[80vw] h-full bg-slate-900 text-white p-6 flex flex-col border-r border-slate-800 overflow-y-auto animate-in slide-in-from-left duration-200">
            <button
              onClick={() => setMobileOpen(false)}
              className="self-end w-9 h-9 mb-4 rounded-xl bg-slate-800 flex items-center justify-center hover:bg-slate-700 transition-colors"
              aria-label="Close menu"
            >
              ✕
            </button>
            {navContent}
          </div>
        </div>
      )}

      {/* Desktop sidebar — unchanged: fixed, only visible at md and up. */}
      <div className="w-64 bg-slate-900 h-screen fixed left-0 top-0 text-white p-6 hidden md:flex flex-col border-r border-slate-800 z-50">
        {navContent}
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
        .animate-shake { animation: shake 0.2s ease-in-out infinite; }
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
      `}</style>
    </>
  );
};

export default Sidebar;
