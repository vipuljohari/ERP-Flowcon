
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Part, Sale, InwardLog, MonthlyArchive, Customer, RawMaterial, RMInwardLog, RMManufacturerInvoice, RMCustomerCrossInvoice, RMMaterialLength, RMPurchaseVoucher, AdminAlert } from '../types';
import { GoogleDriveService, GDriveBackupFile, GDriveFolder } from '../services/googleDrive';
import { DropboxService, DropboxBackupFile } from '../services/dropbox';

interface DataManagementProps {
  parts: Part[];
  sales: Sale[];
  inwardLogs: InwardLog[];
  archives: MonthlyArchive[];
  customers: Customer[];
  rawMaterials: RawMaterial[];
  rmInwardLogs: RMInwardLog[];
  // Added so "Manual Backup" (and the automatic backups in App.tsx) capture
  // every collection this app manages, not just the original set — see the
  // Sep-2026 request for a complete backup before the Material Entry
  // feature went live. rmPurchaseVouchers is included read-only (it's an
  // hourly Tally mirror, harmless to snapshot, but never restored — see
  // App.tsx's handleFullImport for why).
  rmManufacturerInvoices?: RMManufacturerInvoice[];
  rmCrossInvoices?: RMCustomerCrossInvoice[];
  rmMaterialLengths?: RMMaterialLength[];
  rmPurchaseVouchers?: RMPurchaseVoucher[];
  adminAlerts?: AdminAlert[];
  localRMOpeningBalances?: Record<string, string>;
  localPartOpeningBalances?: Record<string, string>;
  onImportData: (data: any) => void;
  isAdmin?: boolean;
  syncLog?: {timestamp: string, message: string}[];
  userName: string;
}

interface PickerState {
  isOpen: boolean;
  targetField: 'backup' | 'inbox' | 'processed';
  currentParentId: string;
  history: { id: string, name: string }[];
  folders: GDriveFolder[];
  loading: boolean;
  searchQuery: string;
}

const DataManagement: React.FC<DataManagementProps> = ({ 
  parts, 
  sales, 
  inwardLogs, 
  archives, 
  customers, 
  rawMaterials = [],
  rmInwardLogs = [],
  rmManufacturerInvoices = [],
  rmCrossInvoices = [],
  rmMaterialLengths = [],
  rmPurchaseVouchers = [],
  adminAlerts = [],
  localRMOpeningBalances = {},
  localPartOpeningBalances = {},
  onImportData,
  isAdmin = false, 
  syncLog = [], 
  userName 
}) => {
  const [gdriveToken, setGdriveToken] = useState<string | null>(localStorage.getItem('gdrive_token'));
  const [gRefreshToken, setGRefreshToken] = useState<string | null>(localStorage.getItem('gdrive_refresh_token'));
  const [dropboxToken, setDropboxToken] = useState<string | null>(localStorage.getItem('dropbox_token'));
  const [isSyncing, setIsSyncing] = useState(false);
  
  // GDrive Config State
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [customClientId, setCustomClientId] = useState(localStorage.getItem('custom_gdrive_client_id') || '');
  const [customClientSecret, setCustomClientSecret] = useState(localStorage.getItem('custom_gdrive_client_secret') || '');
  
  // Storage for Folder Selection
  const [backupFolderName, setBackupFolderName] = useState(localStorage.getItem('gdrive_backup_folder_name') || 'backups');
  const [backupFolderId, setBackupFolderId] = useState(localStorage.getItem('gdrive_backup_folder_id') || '');
  
  const [tallyInboxName, setTallyInboxName] = useState(localStorage.getItem('gdrive_tally_inbox_name') || 'tally_inbox');
  const [tallyInboxId, setTallyInboxId] = useState(localStorage.getItem('gdrive_tally_inbox_id') || '');
  
  const [tallyProcessedName, setTallyProcessedName] = useState(localStorage.getItem('gdrive_tally_processed_name') || 'processed_tally');
  const [tallyProcessedId, setTallyProcessedId] = useState(localStorage.getItem('gdrive_tally_processed_id') || '');
  
  // Auto Backup Settings
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(localStorage.getItem('auto_backup_enabled') !== 'false');
  const [autoBackupFrequency, setAutoBackupFrequency] = useState(localStorage.getItem('auto_backup_frequency') || '15');
  
  // Tally Inbox Auto-Process Setting
  const [autoTallyEnabled, setAutoTallyEnabled] = useState(localStorage.getItem('auto_tally_enabled') === 'true');

  // Folder Picker State
  const [picker, setPicker] = useState<PickerState>({
    isOpen: false,
    targetField: 'backup',
    currentParentId: 'root',
    history: [{ id: 'root', name: 'My Drive' }],
    folders: [],
    loading: false,
    searchQuery: ''
  });

  const searchTimeoutRef = useRef<number | null>(null);

  // Backups Lists
  const [gBackups, setGBackups] = useState<GDriveBackupFile[]>([]);
  const [dBackups, setDBackups] = useState<DropboxBackupFile[]>([]);
  
  // Security Modal
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [pendingBackup, setPendingBackup] = useState<{provider: 'gdrive' | 'dropbox', data: any} | null>(null);
  const [passcode, setPasscode] = useState('');
  const [passError, setPassError] = useState(false);

  const isGdriveLinked = !!gdriveToken || !!gRefreshToken;
  const hasCredentials = !!customClientId && !!customClientSecret;

  const handleConnectGDrive = async () => {
    if (!hasCredentials) {
      alert("Please configure GDrive API Client ID and Secret first.");
      setShowConfigModal(true);
      return;
    }
    const url = await GoogleDriveService.getAuthUrl();
    window.location.href = url;
  };

  const saveGDriveConfig = () => {
    if (customClientId.trim()) {
      localStorage.setItem('custom_gdrive_client_id', customClientId.trim());
    } else {
      localStorage.removeItem('custom_gdrive_client_id');
    }
    
    if (customClientSecret.trim()) {
      localStorage.setItem('custom_gdrive_client_secret', customClientSecret.trim());
    } else {
      localStorage.removeItem('custom_gdrive_client_secret');
    }

    localStorage.setItem('gdrive_backup_folder_name', backupFolderName.trim());
    localStorage.setItem('gdrive_backup_folder_id', backupFolderId);
    
    localStorage.setItem('gdrive_tally_inbox_name', tallyInboxName.trim());
    localStorage.setItem('gdrive_tally_inbox_id', tallyInboxId);
    
    localStorage.setItem('gdrive_tally_processed_name', tallyProcessedName.trim());
    localStorage.setItem('gdrive_tally_processed_id', tallyProcessedId);

    localStorage.setItem('auto_backup_enabled', String(autoBackupEnabled));
    localStorage.setItem('auto_backup_frequency', autoBackupFrequency);
    localStorage.setItem('auto_tally_enabled', String(autoTallyEnabled));

    setShowConfigModal(false);
    alert("GDrive Configuration Updated. Settings applied.");
    window.dispatchEvent(new Event('storage')); 
  };

  // --- Folder Picker Logic ---
  const openFolderPicker = async (target: 'backup' | 'inbox' | 'processed') => {
    if (!gdriveToken) {
      alert("Please link Google Drive first.");
      return;
    }
    setPicker(prev => ({ 
      ...prev, 
      isOpen: true, 
      targetField: target, 
      loading: true, 
      currentParentId: 'root', 
      history: [{ id: 'root', name: 'My Drive' }],
      searchQuery: '' 
    }));
    const service = new GoogleDriveService();
    try {
      const folders = await service.listFolders('root');
      setPicker(prev => ({ ...prev, folders, loading: false }));
    } catch (e) {
      alert("Error fetching folders. Session might be expired.");
      setPicker(prev => ({ ...prev, isOpen: false, loading: false }));
    }
  };

  const handleSearchChange = (query: string) => {
    setPicker(prev => ({ ...prev, searchQuery: query, loading: query.length > 0 }));
    
    if (searchTimeoutRef.current) window.clearTimeout(searchTimeoutRef.current);

    if (!query.trim()) {
      // Return to current folder view
      navigateToHistory(picker.history.length - 1);
      return;
    }

    searchTimeoutRef.current = window.setTimeout(async () => {
      const service = new GoogleDriveService();
      try {
        const results = await service.searchFolders(query);
        setPicker(prev => ({ ...prev, folders: results, loading: false }));
      } catch (e) {
        console.error("Global search failed", e);
        setPicker(prev => ({ ...prev, loading: false }));
      }
    }, 500);
  };

  const navigateToFolder = async (id: string, name: string) => {
    setPicker(prev => ({ ...prev, loading: true, searchQuery: '' }));
    const service = new GoogleDriveService();
    try {
      const folders = await service.listFolders(id);
      setPicker(prev => ({ 
        ...prev, 
        folders, 
        loading: false, 
        currentParentId: id,
        history: [...prev.history, { id, name }]
      }));
    } catch (e) {
      alert("Navigation failed.");
      setPicker(prev => ({ ...prev, loading: false }));
    }
  };

  const navigateToHistory = async (index: number) => {
    const target = picker.history[index];
    setPicker(prev => ({ ...prev, loading: true, searchQuery: '' }));
    const service = new GoogleDriveService();
    try {
      const folders = await service.listFolders(target.id);
      setPicker(prev => ({ 
        ...prev, 
        folders, 
        loading: false, 
        currentParentId: target.id,
        history: prev.history.slice(0, index + 1)
      }));
    } catch (e) {
      alert("Navigation failed.");
      setPicker(prev => ({ ...prev, loading: false }));
    }
  };

  const selectFolderDirectly = (id: string, name: string) => {
    if (picker.targetField === 'backup') {
      setBackupFolderId(id === 'root' ? '' : id);
      setBackupFolderName(name);
    } else if (picker.targetField === 'inbox') {
      setTallyInboxId(id === 'root' ? '' : id);
      setTallyInboxName(name);
    } else if (picker.targetField === 'processed') {
      setTallyProcessedId(id === 'root' ? '' : id);
      setTallyProcessedName(name);
    }
    setPicker(prev => ({ ...prev, isOpen: false }));
  };

  const selectCurrentFolder = () => {
    const current = picker.history[picker.history.length - 1];
    selectFolderDirectly(current.id, current.name);
  };

  const handleConnectDropbox = () => window.location.href = DropboxService.getAuthUrl();

  const handleDisconnect = (provider: 'gdrive' | 'dropbox') => {
    if (!isAdmin) return;
    if (window.confirm(`Disconnect and unlink ${provider === 'gdrive' ? 'Google Drive' : 'Dropbox'}?`)) {
      if (provider === 'gdrive') {
        localStorage.removeItem('gdrive_token');
        localStorage.removeItem('gdrive_refresh_token');
        localStorage.removeItem('gdrive_token_expiry');
        localStorage.removeItem('gdrive_code_verifier');
        setGdriveToken(null);
        setGRefreshToken(null);
        setGBackups([]);
      } else {
        localStorage.removeItem('dropbox_token');
        setDropboxToken(null);
        setDBackups([]);
      }
    }
  };

  const handlePushToCloud = async (provider: 'gdrive' | 'dropbox') => {
    setIsSyncing(true);
    try {
      // Company Master and User Master aren't lifted into App.tsx state
      // (each manages its own onSnapshot listener), so a one-off read here
      // is the simplest way to fold them into a "everything" backup without
      // restructuring how either screen works. Both change rarely, so a
      // fresh read at click-time is more than fresh enough — no need to
      // keep either of these subscribed/live for this.
      const [companiesSnap, usersSnap] = await Promise.all([
        getDocs(collection(db, 'companies')),
        getDocs(collection(db, 'users')),
      ]);
      const companies = companiesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const data = {
        parts, sales, inwardLogs, archives, customers, rawMaterials, rmInwardLogs,
        rmManufacturerInvoices, rmCrossInvoices, rmMaterialLengths, rmPurchaseVouchers, adminAlerts,
        companies, users,
        localRMOpeningBalances, localPartOpeningBalances,
        timestamp: new Date().toISOString(), lastModifiedBy: userName,
      };
      if (provider === 'gdrive' && isGdriveLinked) {
        await new GoogleDriveService().uploadData(data);
      } else if (provider === 'dropbox' && dropboxToken) {
        await new DropboxService(dropboxToken).uploadData(data);
      }
      alert(`Manual snapshot created on ${provider === 'gdrive' ? 'Google Drive' : 'Dropbox'}.`);
    } catch (err: any) {
      alert("Sync failed: " + err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const fetchBackups = async (provider: 'gdrive' | 'dropbox') => {
    try {
      if (provider === 'gdrive' && isGdriveLinked) {
        const list = await new GoogleDriveService().listBackups();
        setGBackups(list);
      } else if (provider === 'dropbox' && dropboxToken) {
        const list = await new DropboxService(dropboxToken).listBackups();
        setDBackups(list);
      }
    } catch (e) { alert("Failed to fetch backups."); }
  };

  const initiateRestore = async (provider: 'gdrive' | 'dropbox', fileIdOrPath: string) => {
    // Defense in depth — the Restore buttons are already hidden for
    // non-admins, but a full data restore is destructive enough that this
    // path should never be reachable by role alone (e.g. a stale UI, or a
    // future caller that forgets the isAdmin check on the button itself).
    if (!isAdmin) return;
    try {
      let data;
      if (provider === 'gdrive' && isGdriveLinked) {
        data = await new GoogleDriveService().downloadData(fileIdOrPath);
      } else if (provider === 'dropbox' && dropboxToken) {
        data = await new DropboxService(dropboxToken).downloadData(fileIdOrPath);
      }
      
      if (data) {
        setPendingBackup({ provider, data });
        setPasscode('');
        setPassError(false);
        setShowRestoreModal(true);
      }
    } catch (e) { alert("Download failed."); }
  };

  const handlePasscodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      setShowRestoreModal(false);
      setPendingBackup(null);
      return;
    }
    if (passcode === "8359") {
      if (pendingBackup) {
        onImportData(pendingBackup.data);
        setShowRestoreModal(false);
        setPendingBackup(null);
        alert("System Restored Successfully.");
      }
    } else {
      setPassError(true);
      setPasscode('');
      setTimeout(() => setPassError(false), 2000);
    }
  };

  return (
    <div className="space-y-8 text-left max-w-6xl mx-auto pb-12">
      <header className="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-2">Cloud Control Center</h2>
          <p className="text-slate-500 font-medium text-left">
            {isAdmin 
              ? "Administrator Sync Configuration Active" 
              : "Managed by OAuth 2.0 PKCE & Refresh Tokens"}
          </p>
        </div>
        {!isAdmin && (
           <div className="bg-slate-100 px-4 py-2 rounded-xl border border-slate-200">
             <p className="text-[10px] font-black uppercase text-slate-400">Restricted Area</p>
             <p className="text-[9px] font-bold text-slate-500 uppercase italic">Enter Admin Mode to adjust API settings</p>
           </div>
        )}
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Google Drive Column */}
        <div className={`bg-white p-8 rounded-[2.5rem] shadow-sm border flex flex-col gap-8 transition-all ${isAdmin ? 'border-amber-500 shadow-amber-500/5' : 'border-[#34A853]/10'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-left">
              <div className="w-12 h-12 bg-[#34A853] text-white rounded-2xl flex items-center justify-center text-2xl shadow-lg">GD</div>
              <div className="text-left">
                <h3 className="font-black text-slate-900 uppercase text-xs tracking-widest leading-none mb-1 text-left">Google Drive</h3>
                <p className={`text-[10px] font-black uppercase text-left ${isGdriveLinked ? 'text-emerald-500' : 'text-slate-400'}`}>
                  {isGdriveLinked ? (gRefreshToken ? 'Permanent Link Established ✓' : 'Session Active (1h)') : 'Not Linked'}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
               {isAdmin && (
                 <button 
                   onClick={() => setShowConfigModal(true)}
                   className="w-10 h-10 bg-amber-100 text-amber-600 rounded-xl flex items-center justify-center border border-amber-200 hover:bg-amber-500 hover:text-white transition-all shadow-sm"
                   title="Configure API Credentials"
                 >
                   ⚙️
                 </button>
               )}
               {isGdriveLinked && <button onClick={() => fetchBackups('gdrive')} className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline">History</button>}
            </div>
          </div>

          {!isGdriveLinked && (
            <div className="space-y-4">
               {isAdmin && !hasCredentials && (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl animate-pulse">
                    <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1">Configuration Needed</p>
                    <p className="text-[11px] font-bold text-amber-600 leading-tight">Client ID and Secret must be set in "⚙️ API Setup" before linking.</p>
                  </div>
               )}
               <button 
                 onClick={handleConnectGDrive} 
                 className={`w-full py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-xl transition-all active:scale-95 ${hasCredentials ? 'bg-[#34A853] text-white hover:bg-[#2d9248]' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
               >
                 Link Permanent Handshake
               </button>
            </div>
          )}

          {isGdriveLinked && (
            <div className="space-y-4 text-left">
              <div className="flex gap-2">
                <button onClick={() => handlePushToCloud('gdrive')} disabled={isSyncing} className="flex-1 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-black transition-all shadow-xl">Manual Backup</button>
                {isAdmin && (
                   <button onClick={() => handleDisconnect('gdrive')} className="px-6 py-4 border border-rose-200 text-rose-500 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-rose-50">Unlink</button>
                )}
              </div>
              <p className="text-[10px] text-slate-400 font-medium -mt-2">Covers everything — Parts, Raw Materials, Sales, Inward Logs, RM Cross-Bill Invoices, Material Lengths, Notifications, Companies, Users — in one snapshot.</p>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                {gBackups.map(b => (
                  <div key={b.id} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex items-center justify-between group">
                    <div className="text-left">
                      <p className="text-sm font-black text-slate-800 leading-none mb-1 text-left">{b.displayDate}</p>
                      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter text-left">{b.name}</p>
                    </div>
                    {isAdmin && (
                      <button onClick={() => initiateRestore('gdrive', b.id)} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">Restore</button>
                    )}
                  </div>
                ))}
                {gBackups.length === 0 && <p className="text-center py-8 text-[10px] font-black text-slate-300 uppercase tracking-widest text-center">No Google backups listed</p>}
              </div>
            </div>
          )}
        </div>

        {/* Dropbox Column */}
        <div className={`bg-white p-8 rounded-[2.5rem] shadow-sm border flex flex-col gap-8 transition-all border-[#0061FF]/10`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-left">
              <div className="w-12 h-12 bg-[#0061FF] text-white rounded-2xl flex items-center justify-center text-2xl shadow-lg">DB</div>
              <div className="text-left">
                <h3 className="font-black text-slate-900 uppercase text-xs tracking-widest leading-none mb-1 text-left">Dropbox</h3>
                <p className={`text-[10px] font-black uppercase text-left ${dropboxToken ? 'text-[#0061FF]' : 'text-slate-400'}`}>
                  {dropboxToken ? 'Connected ✓' : 'Not Linked'}
                </p>
              </div>
            </div>
            {dropboxToken && <button onClick={() => fetchBackups('dropbox')} className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline">History</button>}
          </div>

          {!dropboxToken && (
            <button onClick={handleConnectDropbox} className="bg-[#0061FF] text-white px-6 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-xl hover:bg-[#0052d9] transition-all active:scale-95">Link Temporary Session</button>
          )}

          {dropboxToken && (
            <div className="space-y-4 text-left">
               <div className="flex gap-2">
                <button onClick={() => handlePushToCloud('dropbox')} disabled={isSyncing} className="flex-1 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-black transition-all shadow-xl">Manual Backup</button>
                {isAdmin && (
                   <button onClick={() => handleDisconnect('dropbox')} className="px-6 py-4 border border-rose-200 text-rose-500 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-rose-50">Unlink</button>
                )}
              </div>
              <p className="text-[10px] text-slate-400 font-medium">Covers everything — Parts, Raw Materials, Sales, Inward Logs, RM Cross-Bill Invoices, Material Lengths, Notifications, Companies, Users — in one snapshot.</p>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                {dBackups.map(b => (
                  <div key={b.path} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex items-center justify-between group">
                    <div className="text-left">
                      <p className="text-sm font-black text-slate-800 leading-none mb-1 text-left">{b.displayDate}</p>
                      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter text-left">{b.name}</p>
                    </div>
                    {isAdmin && (
                      <button onClick={() => initiateRestore('dropbox', b.path)} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">Restore</button>
                    )}
                  </div>
                ))}
                {dBackups.length === 0 && <p className="text-center py-8 text-[10px] font-black text-slate-300 uppercase tracking-widest text-center">No Dropbox backups listed</p>}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* GDrive Configuration Modal */}
      {showConfigModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-xl flex items-center justify-center z-[250] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-10 border border-slate-100 animate-in zoom-in-95 overflow-y-auto max-h-[90vh]">
            <h3 className="text-2xl font-black text-slate-900 mb-2 leading-none">Cloud Settings</h3>
            <p className="text-sm text-slate-500 mb-8 font-medium">Define your API and automation preferences.</p>
            
            <div className="space-y-6">
              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Client ID</label>
                <input 
                  type="text" 
                  className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900"
                  placeholder="...apps.googleusercontent.com"
                  value={customClientId}
                  onChange={(e) => setCustomClientId(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Client Secret</label>
                <input 
                  type="password" 
                  className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900"
                  placeholder="Paste Secret Here"
                  value={customClientSecret}
                  onChange={(e) => setCustomClientSecret(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Backup Storage Folder</label>
                <div className="flex gap-2">
                  <div className="flex-1 px-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-xl font-bold text-slate-900 text-xs flex items-center overflow-hidden">
                    <span className="truncate">{backupFolderName}</span>
                    <span className="ml-2 text-[8px] opacity-40">({backupFolderId ? 'Fixed' : 'Global Search'})</span>
                  </div>
                  <button 
                    onClick={() => openFolderPicker('backup')}
                    className="px-4 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all"
                  >
                    Browse
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Tally Inbox Folder</label>
                  <div className="flex gap-2">
                    <div className="flex-1 px-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-xl font-bold text-slate-900 text-xs flex items-center overflow-hidden">
                      <span className="truncate">{tallyInboxName}</span>
                      <span className="ml-2 text-[8px] opacity-40">({tallyInboxId ? 'Fixed' : 'Global Search'})</span>
                    </div>
                    <button 
                      onClick={() => openFolderPicker('inbox')}
                      className="px-4 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all"
                    >
                      Browse
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Tally Processed Folder</label>
                  <div className="flex gap-2">
                    <div className="flex-1 px-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-xl font-bold text-slate-900 text-xs flex items-center overflow-hidden">
                      <span className="truncate">{tallyProcessedName}</span>
                      <span className="ml-2 text-[8px] opacity-40">({tallyProcessedId ? 'Fixed' : 'Global Search'})</span>
                    </div>
                    <button 
                      onClick={() => openFolderPicker('processed')}
                      className="px-4 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all"
                    >
                      Browse
                    </button>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Auto Cloud Sync</p>
                    <p className="text-[9px] font-bold text-slate-500 uppercase">Background automation</p>
                  </div>
                  <button 
                    type="button"
                    onClick={() => setAutoBackupEnabled(!autoBackupEnabled)}
                    className={`w-12 h-6 rounded-full transition-all relative ${autoBackupEnabled ? 'bg-indigo-600' : 'bg-slate-300'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${autoBackupEnabled ? 'left-7' : 'left-1'}`} />
                  </button>
                </div>

                {autoBackupEnabled && (
                  <div className="animate-in slide-in-from-top-2 mb-4">
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Sync Interval (Minutes)</label>
                    <select 
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-black text-slate-900"
                      value={autoBackupFrequency}
                      onChange={(e) => setAutoBackupFrequency(e.target.value)}
                    >
                      <option value="5">Every 5 Minutes (Real-time)</option>
                      <option value="15">Every 15 Minutes (Standard)</option>
                      <option value="30">Every 30 Minutes</option>
                      <option value="60">Every 1 Hour</option>
                      <option value="360">Every 6 Hours</option>
                      <option value="1440">Daily (24 Hours)</option>
                    </select>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Auto-Process Tally Inbox</p>
                    <p className="text-[9px] font-bold text-slate-500 uppercase">Scan GDrive folders automatically</p>
                  </div>
                  <button 
                    type="button"
                    onClick={() => setAutoTallyEnabled(!autoTallyEnabled)}
                    className={`w-12 h-6 rounded-full transition-all relative ${autoTallyEnabled ? 'bg-[#008c45]' : 'bg-slate-300'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${autoTallyEnabled ? 'left-7' : 'left-1'}`} />
                  </button>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button type="button" onClick={() => setShowConfigModal(false)} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest">Cancel</button>
                <button type="button" onClick={saveGDriveConfig} className="flex-[2] py-4 bg-[#34A853] text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl">Save & Apply</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Google Drive Folder Picker Modal */}
      {picker.isOpen && (
        <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-xl flex items-center justify-center z-[300] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full flex flex-col max-h-[85vh] overflow-hidden animate-in zoom-in-95">
            <div className="bg-indigo-600 p-8 text-white">
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-2xl font-black uppercase tracking-tight">Select Folder</h3>
                <button onClick={() => setPicker(prev => ({ ...prev, isOpen: false }))} className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center hover:bg-white/40 transition-colors">✕</button>
              </div>

              {/* Breadcrumbs */}
              <div className="flex flex-wrap gap-2 items-center mb-6">
                {picker.history.map((h, i) => (
                  <React.Fragment key={h.id}>
                    {i > 0 && <span className="opacity-50">/</span>}
                    <button 
                      onClick={() => navigateToHistory(i)}
                      className="text-[10px] font-black uppercase tracking-widest hover:underline whitespace-nowrap"
                    >
                      {h.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>

              {/* Global Search Bar */}
              <div className="relative">
                <input 
                  type="text" 
                  placeholder="Global Drive Search..." 
                  className="w-full px-5 py-3 bg-white/10 border border-white/20 rounded-xl focus:bg-white focus:text-slate-900 outline-none text-xs font-bold transition-all placeholder-white/50"
                  value={picker.searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                />
                <div className="absolute right-4 top-1/2 -translate-y-1/2 opacity-50">🔍</div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50 min-h-[300px] custom-scrollbar">
              {picker.loading ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400 py-20">
                  <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-[10px] font-black uppercase tracking-widest">Searching Drive...</p>
                </div>
              ) : (
                <>
                  {picker.folders.length === 0 ? (
                    <div className="text-center py-20">
                      <p className="text-sm font-bold text-slate-400">No folders found.</p>
                      {picker.searchQuery && <p className="text-[10px] font-black uppercase text-slate-300 mt-2">Try a broader keyword</p>}
                    </div>
                  ) : (
                    picker.folders.map(f => (
                      <div key={f.id} className="flex gap-2">
                        <button 
                          onClick={() => navigateToFolder(f.id, f.name)}
                          className="flex-1 flex items-center gap-4 p-4 bg-white hover:bg-indigo-50 border border-slate-100 rounded-2xl transition-all group"
                        >
                          <span className="text-2xl group-hover:scale-110 transition-transform">📁</span>
                          <div className="text-left flex-1 min-w-0">
                            <span className="font-bold text-slate-800 text-sm truncate block">{f.name}</span>
                            {f.isGlobalResult && <span className="text-[8px] font-black text-indigo-500 uppercase tracking-widest">Global Discovery</span>}
                          </div>
                          <svg className="w-4 h-4 text-slate-300 group-hover:text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                        <button 
                          onClick={() => selectFolderDirectly(f.id, f.name)}
                          className="px-4 bg-slate-100 text-slate-400 rounded-2xl hover:bg-emerald-500 hover:text-white transition-all font-black text-[9px] uppercase tracking-tighter"
                          title="Select This Folder Immediately"
                        >
                          Select
                        </button>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>

            <div className="p-8 border-t border-slate-100 bg-white flex gap-4">
              <button 
                onClick={() => setPicker(prev => ({ ...prev, isOpen: false }))}
                className="flex-1 py-4 border-2 border-slate-100 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest"
              >
                Cancel
              </button>
              {!picker.searchQuery && (
                <button 
                  onClick={selectCurrentFolder}
                  className="flex-[2] py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl shadow-indigo-100"
                >
                  Confirm Current View
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showRestoreModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-xl flex items-center justify-center z-[200] p-4 text-left">
          <div className={`bg-white rounded-[2.5rem] shadow-2xl max-w-sm w-full p-10 border transition-all duration-300 ${passError ? 'border-rose-500' : 'border-white/20'} animate-in zoom-in-95 text-left`}>
            <div className="text-center mb-8">
              <div className={`w-20 h-20 rounded-[2rem] flex items-center justify-center text-3xl mx-auto mb-6 shadow-2xl ${passError ? 'bg-rose-500 text-white' : 'bg-slate-900 text-white'}`}>
                🛡️
              </div>
              <h3 className="text-2xl font-black text-slate-900 tracking-tight leading-none mb-2 text-center">Restoration Lock</h3>
              <p className="text-sm text-slate-500 font-medium uppercase tracking-tighter text-center">Enter 4-digit master code to proceed</p>
            </div>

            <form onSubmit={handlePasscodeSubmit} className="space-y-8 text-left">
              <input 
                autoFocus
                type="password"
                maxLength={4}
                placeholder="••••"
                className={`text-center text-5xl tracking-[1rem] w-full bg-slate-50 border-2 rounded-3xl py-6 focus:outline-none transition-all font-black ${passError ? 'border-rose-500 text-rose-500 animate-shake' : 'border-slate-100 focus:border-slate-900 text-slate-900'}`}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ''))}
              />
              <div className="flex gap-4 text-left">
                <button type="button" onClick={() => setShowRestoreModal(false)} className="flex-1 py-5 border-2 border-slate-100 rounded-2xl font-black text-slate-400 uppercase text-[11px] tracking-widest hover:bg-slate-50 transition-all">Cancel</button>
                <button type="submit" className="flex-[1.5] py-5 bg-slate-900 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl shadow-slate-200 hover:bg-black transition-all">Authorize Pull</button>
              </div>
            </form>
          </div>
        </div>
      )}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
      `}</style>
    </div>
  );
};

export default DataManagement;
