
import React, { useState, useEffect, useMemo, useRef } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import Inventory from './components/Inventory';
import SalesLog from './components/SalesLog';
import InwardLogs from './components/InwardLogs';
import AIAnalyst from './components/AIAnalyst';
import DailyDispatch from './components/DailyDispatch';
import ScheduleManager from './components/ScheduleManager';
import TimeMachine from './components/TimeMachine';
import DataManagement from './components/DataManagement';
import CustomerMaster from './components/CustomerMaster';
import ItemMaster from './components/ItemMaster';
import RMMaster from './components/RMMaster';
import Login from './components/Login';
import UserMaster from './components/UserMaster';
import CompanyMaster from './components/CompanyMaster';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { CompanyProvider } from './contexts/CompanyContext';
import { Part, Sale, InwardLog, MonthlyArchive, StockStatus, Customer, RawMaterial, RMInwardLog, canAccessView } from './types';
import { INITIAL_PARTS, INITIAL_CUSTOMERS } from './constants';
import { GoogleDriveService } from './services/googleDrive';
import { DropboxService } from './services/dropbox';
import { TallyService } from './services/tally';

const getLocalISOString = (date: Date = new Date()): string => {
  const pad = (num: number) => String(num).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}.${ms}`;
};

const MainApp: React.FC = () => {
  const { appUser, logout } = useAuth();
  const role = appUser?.role || 'store';
  const isAdmin = role === 'admin';
  const [currentView, setCurrentView] = useState('dashboard');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [userName, setUserName] = useState(() => appUser?.displayName || localStorage.getItem('autopart_username') || 'Vipul PC');
  const [syncNotifications, setSyncNotifications] = useState<{id: string, message: string, type: 'success' | 'warning', action?: () => void}[]>([]);
  const [syncLog, setSyncLog] = useState<{timestamp: string, message: string}[]>([]);

  // Track settings changes to reset interval
  const [syncSettingsTrigger, setSyncSettingsTrigger] = useState(0);

  const addNotification = (message: string, type: 'success' | 'warning' = 'success', action?: () => void) => {
    const id = Math.random().toString(36).substr(2, 9);
    setSyncNotifications(prev => [...prev, { id, message, type, action }]);
    setSyncLog(prev => [{ timestamp: new Date().toLocaleTimeString(), message }, ...prev].slice(0, 50));
    if (type === 'success') {
      setTimeout(() => setSyncNotifications(prev => prev.filter(n => n.id !== id)), 8000);
    }
  };

  const [parts, setParts] = useState<Part[]>(() => JSON.parse(localStorage.getItem('autopart_inventory') || JSON.stringify(INITIAL_PARTS)));
  const [sales, setSales] = useState<Sale[]>(() => JSON.parse(localStorage.getItem('autopart_sales') || '[]'));
  const [inwardLogs, setInwardLogs] = useState<InwardLog[]>(() => JSON.parse(localStorage.getItem('autopart_inward_logs') || '[]'));
  const [archives, setArchives] = useState<MonthlyArchive[]>(() => JSON.parse(localStorage.getItem('autopart_archives') || '[]'));
  const [customers, setCustomers] = useState<Customer[]>(() => JSON.parse(localStorage.getItem('autopart_customers') || JSON.stringify(INITIAL_CUSTOMERS)));
  const [activeCustomer, setActiveCustomer] = useState(() => customers[0]?.name || '');
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>(() => JSON.parse(localStorage.getItem('autopart_raw_materials') || '[]'));
  const [rmInwardLogs, setRmInwardLogs] = useState<RMInwardLog[]>(() => JSON.parse(localStorage.getItem('autopart_rm_inward_logs') || '[]'));
  const [localRMOpeningBalances, setLocalRMOpeningBalances] = useState<Record<string, string>>(() => {
    return JSON.parse(localStorage.getItem('autopart_local_rm_opening_balances') || '{}');
  });

  const partsRef = useRef(parts);
  const salesRef = useRef(sales);
  const customersRef = useRef(customers);
  const inwardLogsRef = useRef(inwardLogs);
  const archivesRef = useRef(archives);
  const activeCustomerRef = useRef(activeCustomer);
  const rawMaterialsRef = useRef(rawMaterials);
  const rmInwardLogsRef = useRef(rmInwardLogs);
  const localRMOpeningBalancesRef = useRef(localRMOpeningBalances);
  const lastSyncTimeRef = useRef(0);

  useEffect(() => {
    partsRef.current = parts; salesRef.current = sales; customersRef.current = customers;
    inwardLogsRef.current = inwardLogs; archivesRef.current = archives; 
    activeCustomerRef.current = activeCustomer;
    rawMaterialsRef.current = rawMaterials; rmInwardLogsRef.current = rmInwardLogs;
    localRMOpeningBalancesRef.current = localRMOpeningBalances;
    
    localStorage.setItem('autopart_inventory', JSON.stringify(parts));
    localStorage.setItem('autopart_sales', JSON.stringify(sales));
    localStorage.setItem('autopart_inward_logs', JSON.stringify(inwardLogs));
    localStorage.setItem('autopart_archives', JSON.stringify(archives));
    localStorage.setItem('autopart_customers', JSON.stringify(customers));
    localStorage.setItem('autopart_raw_materials', JSON.stringify(rawMaterials));
    localStorage.setItem('autopart_rm_inward_logs', JSON.stringify(rmInwardLogs));
    localStorage.setItem('autopart_username', userName);
  }, [parts, sales, inwardLogs, archives, customers, rawMaterials, rmInwardLogs, localRMOpeningBalances, userName]);

  const sD = selectedDate;
  const sDK = `${sD.getFullYear()}-${String(sD.getMonth()+1).padStart(2,'0')}-${String(sD.getDate()).padStart(2,'0')}`;
  const isH = sDK !== `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;

  const resolvedRMOpeningBalances = useMemo(() => {
    const result: Record<string, string> = {};

    // Base month is June 2026 (year 2026, month index 5)
    const baseYear = 2026;
    const baseMonth = 5; // June is index 5

    const targetYear = sD.getFullYear();
    const targetMonth = sD.getMonth();
    const targetMonthKey = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`;

    rawMaterials.forEach(rm => {
      const rmLength = rm.length || 6000;
      const rmStandardMeters = rmLength / 1000;

      // Base opening balance for June 2026
      const baseOverrideKey = `2026-06_${rm.id}`;
      let currentPipes = parseFloat(
        localRMOpeningBalances[baseOverrideKey] !== undefined
          ? localRMOpeningBalances[baseOverrideKey]
          : (localRMOpeningBalances[rm.id] || '0')
      );

      // If selected month is earlier than or equal to June 2026
      if (targetYear < baseYear || (targetYear === baseYear && targetMonth <= baseMonth)) {
        const monthOverrideKey = `${targetMonthKey}_${rm.id}`;
        if (localRMOpeningBalances[monthOverrideKey] !== undefined) {
          result[rm.id] = localRMOpeningBalances[monthOverrideKey];
        } else {
          result[rm.id] = currentPipes.toString();
        }
        return;
      }

      // Otherwise, simulate month-by-month from June 2026 up to targetMonth
      let simYear = baseYear;
      let simMonth = baseMonth;

      while (simYear < targetYear || (simYear === targetYear && simMonth < targetMonth)) {
        const simMonthKey = `${simYear}-${String(simMonth + 1).padStart(2, '0')}`;
        const simOverrideKey = `${simMonthKey}_${rm.id}`;

        // If an explicit opening balance was audited and saved for simMonth, start from that value
        if (localRMOpeningBalances[simOverrideKey] !== undefined) {
          currentPipes = parseFloat(localRMOpeningBalances[simOverrideKey]);
        }

        // 1. Calculate inward for simMonth
        const monthInwardPipes = rmInwardLogs
          .filter(l => {
            let y: number, m: number;
            if (l.timestamp && l.timestamp.includes('T')) {
              const dateParts = l.timestamp.split('T')[0].split('-');
              y = parseInt(dateParts[0]);
              m = parseInt(dateParts[1]) - 1;
            } else {
              const d = new Date(l.timestamp);
              y = d.getFullYear();
              m = d.getMonth();
            }
            return l.rmId === rm.id && y === simYear && m === simMonth;
          })
          .reduce((sum, l) => sum + l.quantity, 0);

        const monthInwardMeters = monthInwardPipes * rmStandardMeters;

        // 2. Map RM to Parts
        const mappedParts = parts.filter(
          p => p.id === rm.partId || (rm.partIds && rm.partIds.includes(p.id)) || (p.customerRMMappings?.[rm.customerName] === rm.id)
        );

        // 3. Compute consumption (Sales) and Scrap for simMonth
        let totalConsumedMeters = 0;
        let totalScrapMeters = 0;

        mappedParts.forEach(item => {
          let lengthFactorMeters = 0;
          if (item.itemLength && item.itemLength > 0) {
            lengthFactorMeters = item.itemLength / 1000;
          } else if (item.itemWeight && item.itemWeight > 0 && rm.weightPer1000 > 0) {
            lengthFactorMeters = (item.itemWeight / (rm.weightPer1000 / 1000)) / 1000;
          }

          const salesQty = sales
            .filter(s => {
              if (s.partId !== item.id) return false;
              if (s.customer.toUpperCase().trim() !== rm.customerName.toUpperCase().trim()) return false;
              let y: number, m: number;
              if (s.timestamp && s.timestamp.includes('T')) {
                const dateParts = s.timestamp.split('T')[0].split('-');
                y = parseInt(dateParts[0]);
                m = parseInt(dateParts[1]) - 1;
              } else {
                const d = new Date(s.timestamp);
                y = d.getFullYear();
                m = d.getMonth();
              }
              return y === simYear && m === simMonth;
            })
            .reduce((sum, s) => sum + s.quantity, 0);

          const itemMeters = salesQty * lengthFactorMeters;
          totalConsumedMeters += itemMeters;

          // Scrap calculation
          const itemLengthMm = item.itemLength || (lengthFactorMeters * 1000);
          let scrapMmPerPipe = 0;
          let yieldFactor = 0;

          if (item.hasCustomScrap) {
            scrapMmPerPipe = item.customScrapMm || 0;
            if (itemLengthMm > 0) {
              yieldFactor = Math.floor(Math.max(0, rmLength - scrapMmPerPipe) / itemLengthMm);
            }
          } else {
            if (itemLengthMm > 0) {
              yieldFactor = Math.floor(rmLength / itemLengthMm);
              scrapMmPerPipe = rmLength % itemLengthMm;
            }
          }

          let pipesUsed = 0;
          if (yieldFactor > 0) {
            pipesUsed = Math.ceil(salesQty / yieldFactor);
          } else if (rmStandardMeters > 0 && salesQty > 0) {
            pipesUsed = Math.ceil(itemMeters / rmStandardMeters);
          }

          const itemScrapMeters = pipesUsed * (scrapMmPerPipe / 1000);
          totalScrapMeters += itemScrapMeters;
        });

        // 4. Calculate closing stock for simMonth
        const openingMeters = currentPipes * rmStandardMeters;
        const closingMeters = openingMeters + monthInwardMeters - totalConsumedMeters - totalScrapMeters;

        if (rmStandardMeters > 0) {
          currentPipes = parseFloat((closingMeters / rmStandardMeters).toFixed(1));
        } else {
          currentPipes = 0;
        }

        // Increment month
        simMonth++;
        if (simMonth > 11) {
          simMonth = 0;
          simYear++;
        }
      }

      // Finally, check if the target month itself has an explicit override
      const targetOverrideKey = `${targetMonthKey}_${rm.id}`;
      if (localRMOpeningBalances[targetOverrideKey] !== undefined) {
        currentPipes = parseFloat(localRMOpeningBalances[targetOverrideKey]);
      }

      result[rm.id] = currentPipes.toString();
    });

    return result;
  }, [sD, rawMaterials, parts, sales, rmInwardLogs, localRMOpeningBalances]);

  // Synchronize and auto-repair parts mapping for all existing and new master template customers
  const customerNamesKey = useMemo(() => customers.map(c => c.name).join('|'), [customers]);
  
  useEffect(() => {
    if (customers.length === 0 || parts.length === 0) return;
    
    setParts(prevParts => {
      let changed = false;
      const updated = prevParts.map(p => {
        let partChanged = false;
        const schedules = p.schedules ? { ...p.schedules } : {};
        const customerRates = p.customerRates ? { ...p.customerRates } : {};

        customers.forEach(c => {
          if (schedules[c.name] === undefined) {
            schedules[c.name] = 0;
            partChanged = true;
          }
          if (customerRates[c.name] === undefined) {
            customerRates[c.name] = p.rate || 0;
            partChanged = true;
          }
        });

        if (partChanged) {
          changed = true;
          return { ...p, schedules, customerRates };
        }
        return p;
      });

      return changed ? updated : prevParts;
    });
  }, [customerNamesKey]);

  // Automatically keep linked finished good item stock in sync with RM opening balance + transactions
  useEffect(() => {
    localStorage.setItem('autopart_local_rm_opening_balances', JSON.stringify(localRMOpeningBalances));
    localRMOpeningBalancesRef.current = localRMOpeningBalances;

    setParts(prevParts => {
      let changed = false;
      const updated = prevParts.map(p => {
        const mappedRMs = rawMaterials.filter(rm => {
          return (p.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === p.id) || (rm.partIds && rm.partIds.includes(p.id));
        });

        if (mappedRMs.length === 0) return p;

        const totalRMOpeningPcs = mappedRMs.reduce((sum, rm) => {
          const opBalancePipesStr = resolvedRMOpeningBalances[rm.id] || localRMOpeningBalances[rm.id] || '0';
          const openingBalancePipes = parseFloat(opBalancePipesStr);

          const rmLength = rm.length || 6000;
          const partLength = p.itemLength || 0;
          let yieldFactor = 0;
          if (partLength > 0) {
            yieldFactor = Math.floor(rmLength / partLength);
          } else {
            const rmWeight = rmLength * (rm.weightPer1000 / 1000);
            const partWeight = p.itemWeight || 0;
            if (partWeight > 0 && rmWeight > 0) {
              yieldFactor = Math.floor(rmWeight / partWeight);
            }
          }
          return sum + Math.round(openingBalancePipes * yieldFactor);
        }, 0);

        const totalInwards = inwardLogs
          .filter(l => l.partId === p.id && !l.remarks?.startsWith("[OPENING_BALANCE_SET:") && !l.remarks?.startsWith("[RM_OPENING_BALANCE_SET:") && !l.remarks?.toLowerCase().includes("opening balance") && l.remarks !== "[OPENING_BALANCE_ADJUSTMENT]")
          .reduce((sum, l) => sum + l.quantity, 0);

        const totalSales = sales
          .filter(s => s.partId === p.id)
          .reduce((sum, s) => sum + s.quantity, 0);

        const dynamicStock = totalRMOpeningPcs + totalInwards - totalSales;

        if (p.stock !== dynamicStock) {
          changed = true;
          return { ...p, stock: dynamicStock };
        }
        return p;
      });

      return changed ? updated : prevParts;
    });
  }, [rawMaterials, inwardLogs, sales, localRMOpeningBalances, resolvedRMOpeningBalances]);

  // Instant Backup on Data Change
  const isInitialMount = useRef(true);
  useEffect(() => {
    // Skip the very first render to avoid backing up on app load
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    const autoBackupEnabled = localStorage.getItem('auto_backup_enabled') !== 'false';
    if (!autoBackupEnabled) return;

    const debounceTimer = setTimeout(async () => {
      const nowTime = new Date().getTime();
      // Cooldown: Prevent syncs within 10 seconds of each other for instant triggers
      // This protects against rapid-fire changes and overlaps with the interval sync
      if (nowTime - lastSyncTimeRef.current < 10000) {
        console.log("[SyncEngine] Skipping instant backup - cooldown active.");
        return;
      }
      
      console.log("[SyncEngine] Data change detected. Triggering instant cloud backup...");
      
      let gToken = localStorage.getItem('gdrive_token');
      const gRefreshToken = localStorage.getItem('gdrive_refresh_token');
      const gService = (gToken || gRefreshToken) ? new GoogleDriveService() : null;
      const dToken = localStorage.getItem('dropbox_token');
      const dService = dToken ? new DropboxService(dToken) : null;

      if (!gService && !dService) return;

      try {
        const backup = { 
          parts: partsRef.current, 
          sales: salesRef.current, 
          inwardLogs: inwardLogsRef.current, 
          archives: archivesRef.current, 
          customers: customersRef.current, 
          rawMaterials: rawMaterialsRef.current,
          rmInwardLogs: rmInwardLogsRef.current,
          localRMOpeningBalances: localRMOpeningBalancesRef.current,
          timestamp: new Date().toISOString(), 
          lastModifiedBy: userName 
        };
        
        // Update lastSyncTimeRef BEFORE the async call to prevent race conditions
        lastSyncTimeRef.current = nowTime;
        
        if (gService) await gService.uploadData(backup);
        if (dService) await dService.uploadData(backup);
        console.log("[SyncEngine] Instant cloud backup completed.");
      } catch (e) {
        console.error("[SyncEngine] Instant Backup Error:", e);
      }
    }, 45000); // 45 second debounce captures batch updates

    return () => clearTimeout(debounceTimer);
  }, [parts, sales, inwardLogs, archives, customers, localRMOpeningBalances]);

  // OAuth Callback Handler
  useEffect(() => {
    const handleAuthCallback = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const state = urlParams.get('state');

      if (code && state === 'gdrive') {
        try {
          addNotification("Negotiating Permanent Key Exchange...", "warning");
          const result = await GoogleDriveService.exchangeCodeForTokens(code);
          localStorage.setItem('gdrive_token', result.access_token);
          if (result.refresh_token) {
            localStorage.setItem('gdrive_refresh_token', result.refresh_token);
          }
          const expiry = new Date().getTime() + (result.expires_in * 1000);
          localStorage.setItem('gdrive_token_expiry', expiry.toString());
          window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
          addNotification("Permanent GDrive Handshake Successful ✓", "success");
          setTimeout(() => window.location.reload(), 500);
        } catch (e: any) {
          addNotification(`Handshake Failed: ${e.message}`, "warning");
        }
      }
    };
    handleAuthCallback();

    // Listen for storage events to update sync settings reactively
    const handleStorageChange = () => setSyncSettingsTrigger(t => t + 1);
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Autonomous Background Sync & Tally Import
  useEffect(() => {
    const autoBackupEnabled = localStorage.getItem('auto_backup_enabled') !== 'false';
    const autoBackupFreqMins = parseInt(localStorage.getItem('auto_backup_frequency') || '15');
    const autoTallyEnabled = localStorage.getItem('auto_tally_enabled') === 'true';

    // Cycle runs if either Backup or Tally is enabled
    if (!autoBackupEnabled && !autoTallyEnabled) return;

    const performAutonomousCycle = async () => {
      const nowTime = new Date().getTime();
      // Cooldown: Prevent syncs within 60 seconds of each other to stop double-backups from multiple triggers
      if (nowTime - lastSyncTimeRef.current < 60000) {
        console.log("[SyncEngine] Skipping cycle - cooldown active.");
        return;
      }
      lastSyncTimeRef.current = nowTime;

      console.log(`[SyncEngine] Starting cycle at ${new Date().toLocaleTimeString()} (Tally Auto: ${autoTallyEnabled}, Backup Auto: ${autoBackupEnabled})`);
      let gToken = localStorage.getItem('gdrive_token');
      const gRefreshToken = localStorage.getItem('gdrive_refresh_token');
      const gExpiry = parseInt(localStorage.getItem('gdrive_token_expiry') || '0');
      
      // Attempt token refresh if needed
      if (gRefreshToken && (!gToken || new Date().getTime() > gExpiry - 300000)) {
        try {
          console.log("[SyncEngine] Refreshing GDrive Token...");
          const res = await GoogleDriveService.refreshAccessToken(gRefreshToken);
          gToken = res.access_token;
          localStorage.setItem('gdrive_token', gToken);
          localStorage.setItem('gdrive_token_expiry', (new Date().getTime() + res.expires_in * 1000).toString());
          if (res.refresh_token) {
            localStorage.setItem('gdrive_refresh_token', res.refresh_token);
          }
          console.log("[SyncEngine] GDrive Token Refreshed Successfully.");
        } catch (e) { 
          console.error("[SyncEngine] Token Refresh Failed:", e); 
        }
      }

      const dToken = localStorage.getItem('dropbox_token');
      const gService = (gToken || gRefreshToken) ? new GoogleDriveService() : null;
      const dService = dToken ? new DropboxService(dToken) : null;
      
      if (!gService && !dService) {
        console.log("[SyncEngine] No cloud services connected. Skipping cycle.");
        return;
      }

      try {
        let changed = false; 
        let lS = [...salesRef.current]; 
        let lP = [...partsRef.current];

        // 1. Process Tally Inbox (GDrive Only)
        if (gService && autoTallyEnabled) {
          try {
            const gFiles = await gService.checkTallyInbox();
            if (gFiles.length > 0) {
              console.log(`[SyncEngine] Detected ${gFiles.length} potential Tally files.`);
              for (const file of gFiles) {
                console.log(`[SyncEngine] Processing file: ${file.name}`);
                const res = await TallyService.parseTallyExcel(file.buffer, lP, customersRef.current, activeCustomerRef.current);
                if (res.matchedItems.length > 0) {
                  const isDuplicate = lS.some(s => s.invoiceNumber === res.detectedInvoice);
                  if (!isDuplicate) {
                     res.matchedItems.forEach(i => {
                       const p = lP.find(part => part.id === i.partId);
                       if (p) {
                         const saleTimestamp = res.detectedDate || getLocalISOString();
                         const officialCustomer = customersRef.current.find(c => c.name.toUpperCase().trim() === i.customer.toUpperCase().trim())?.name || i.customer;
                         lS.push({ 
                           id: Math.random().toString(36).substr(2,9), 
                           partId: p.id, 
                           partName: p.name, 
                           sapCode: p.sapCode, 
                           quantity: i.quantity, 
                           totalPrice: (p.customerRates?.[officialCustomer] || p.rate) * i.quantity, 
                           timestamp: saleTimestamp, 
                           customer: officialCustomer, 
                           invoiceNumber: res.detectedInvoice 
                         });
                         // ALLOW NEGATIVE STOCK: Removed Math.max(0, ...)
                         p.stock = (p.stock || 0) - i.quantity; 
 

 
                         // Ensure dynamic customer rates and targets are ready
                         if (!p.schedules) p.schedules = {};
                         if (p.schedules[officialCustomer] === undefined) p.schedules[officialCustomer] = 0;
                         if (!p.customerRates) p.customerRates = {};
                         if (p.customerRates[officialCustomer] === undefined) p.customerRates[officialCustomer] = p.rate || 0;
 
                         changed = true;
                         console.log(`[SyncEngine] Deducted ${i.quantity} from ${p.name}. Mapped to ${officialCustomer}. New Stock: ${p.stock}`);
                       }
                     });
                    addNotification(`Tally Invoice ${res.detectedInvoice || file.name} Imported`, "success");
                    await gService.archiveProcessedFile(file.path);
                    console.log(`[SyncEngine] File ${file.name} processed and archived.`);
                  } else {
                    console.log(`[SyncEngine] Skipping duplicate invoice: ${res.detectedInvoice}`);
                    await gService.archiveProcessedFile(file.path);
                  }
                } else {
                  console.log(`[SyncEngine] No matching items found in ${file.name}. Leaving for manual review or check Item Master mappings.`);
                }
              }
            }
          } catch (tallyErr) {
            console.error("[SyncEngine] Tally processing error:", tallyErr);
          }
        }

        if (changed) { 
          setSales(lS); 
          setParts(lP); 
        }
        
        // 2. Perform Cloud Backup
        if (autoBackupEnabled) {
          const backup = { 
            parts: partsRef.current, 
            sales: salesRef.current, 
            inwardLogs: inwardLogsRef.current, 
            archives: archivesRef.current, 
            customers: customersRef.current, 
            rawMaterials: rawMaterialsRef.current,
            rmInwardLogs: rmInwardLogsRef.current,
            localRMOpeningBalances: localRMOpeningBalancesRef.current,
            timestamp: new Date().toISOString(), 
            lastModifiedBy: userName 
          };
          if (gService) await gService.uploadData(backup);
          if (dService) await dService.uploadData(backup);
          console.log("[SyncEngine] Cloud backup completed.");
        }
      } catch (e) { 
        console.error("[SyncEngine] Autonomous Cycle Error:", e); 
      }
    };

    performAutonomousCycle();
    const t = setInterval(performAutonomousCycle, autoBackupFreqMins * 60 * 1000);
    return () => clearInterval(t);
  }, [syncSettingsTrigger, userName]);

  // MONTH TRANSITION LOGIC
  const checkAndHandleMonthTransition = (currentParts: Part[], currentArchives: MonthlyArchive[], forceLastActiveMonth?: string) => {
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Use override (from backup) or localStorage, or compute from cloud timestamp if possible
    const lastActiveMonth = forceLastActiveMonth || localStorage.getItem('autopart_last_active_month');

    if (!lastActiveMonth) {
      localStorage.setItem('autopart_last_active_month', currentMonthKey);
      return;
    }

    if (lastActiveMonth !== currentMonthKey) {
      // Create Archive for the last active month
      const monthDate = new Date(lastActiveMonth + '-01');
      const monthLabel = monthDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      
      const newArchive: MonthlyArchive = {
        monthKey: lastActiveMonth,
        displayName: monthLabel,
        parts: JSON.parse(JSON.stringify(currentParts)) 
      };

      setArchives(prev => {
        const filtered = prev.filter(a => a.monthKey !== lastActiveMonth);
        return [...filtered, newArchive];
      });

      // Reset Live Schedules for the new month
      setParts(prev => prev.map(p => ({
        ...p,
        schedules: {}, 
        revisionCount: 0,
        lastUpdated: now.toISOString()
      })));

      localStorage.setItem('autopart_last_active_month', currentMonthKey);
      const nextMonthLabel = now.toLocaleDateString('en-GB', { month: 'short' });
      addNotification(`Monthly Cycle: ${monthLabel.split(' ')[0]} archived. ${nextMonthLabel} targets reset to Zero.`, "success");
    }
  };

  useEffect(() => {
    checkAndHandleMonthTransition(parts, archives);
  }, []); 

  const handleFullImport = (data: any) => {
    if (!data || !data.parts) return;
    
    setParts(data.parts);
    setSales(data.sales || []);
    setInwardLogs(data.inwardLogs || []);
    setArchives(data.archives || []);
    setCustomers(data.customers || INITIAL_CUSTOMERS);
    setRawMaterials(data.rawMaterials || []);
    setRmInwardLogs(data.rmInwardLogs || []);
    
    // Support restoring localRMOpeningBalances!
    const restoredOpeningBalances = data.localRMOpeningBalances || {};
    setLocalRMOpeningBalances(restoredOpeningBalances);
    localStorage.setItem('autopart_local_rm_opening_balances', JSON.stringify(restoredOpeningBalances));
    
    if (data.customers && data.customers.length > 0) {
      setActiveCustomer(data.customers[0].name);
    }
    
    addNotification("Data restored from cloud", "success");
    
    // Resolve the month context from the backup metadata
    let dataMonthKey: string | undefined;
    if (data.timestamp) {
      const d = new Date(data.timestamp);
      dataMonthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    setTimeout(() => {
      checkAndHandleMonthTransition(data.parts, data.archives || [], dataMonthKey);
    }, 200);
  };
  
  const startOfSelectedMonth = useMemo(() => {
    const d = new Date(sD.getFullYear(), sD.getMonth(), 1, 0, 0, 0);
    return d;
  }, [sD]);

  const endOfSelectedDay = useMemo(() => {
    const d = new Date(sD);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [sD]);

  const contextSales = useMemo(() => {
    return sales.filter(s => {
      let year: number, month: number, day: number;
      if (s.timestamp && s.timestamp.includes('T')) {
        const parts = s.timestamp.split('T')[0].split('-');
        year = parseInt(parts[0]);
        month = parseInt(parts[1]) - 1;
        day = parseInt(parts[2]);
      } else {
        const d = new Date(s.timestamp);
        year = d.getFullYear();
        month = d.getMonth();
        day = d.getDate();
      }
      
      const sYear = sD.getFullYear();
      const sMonth = sD.getMonth();
      const sDay = sD.getDate();
      
      const isCurrentMonth = sYear === new Date().getFullYear() && sMonth === new Date().getMonth();
      const isInMonth = year === sYear && month === sMonth;
      const isBeforeOrOnDay = isCurrentMonth || year < sYear || (year === sYear && (month < sMonth || (month === sMonth && day <= sDay)));
      
      return isInMonth && isBeforeOrOnDay;
    });
  }, [sales, sD]);

  const contextInwardLogs = useMemo(() => {
    return inwardLogs.filter(l => {
      let year: number, month: number, day: number;
      if (l.timestamp && l.timestamp.includes('T')) {
        const parts = l.timestamp.split('T')[0].split('-');
        year = parseInt(parts[0]);
        month = parseInt(parts[1]) - 1;
        day = parseInt(parts[2]);
      } else {
        const d = new Date(l.timestamp);
        year = d.getFullYear();
        month = d.getMonth();
        day = d.getDate();
      }
      
      const sYear = sD.getFullYear();
      const sMonth = sD.getMonth();
      const sDay = sD.getDate();
      
      const isCurrentMonth = sYear === new Date().getFullYear() && sMonth === new Date().getMonth();
      const isInMonth = year === sYear && month === sMonth;
      const isBeforeOrOnDay = isCurrentMonth || year < sYear || (year === sYear && (month < sMonth || (month === sMonth && day <= sDay)));
      
      return isInMonth && isBeforeOrOnDay;
    });
  }, [inwardLogs, sD]);

  const contextRmInwardLogs = useMemo(() => {
    return rmInwardLogs.filter(l => {
      let year: number, month: number, day: number;
      if (l.timestamp && l.timestamp.includes('T')) {
        const parts = l.timestamp.split('T')[0].split('-');
        year = parseInt(parts[0]);
        month = parseInt(parts[1]) - 1;
        day = parseInt(parts[2]);
      } else {
        const d = new Date(l.timestamp);
        year = d.getFullYear();
        month = d.getMonth();
        day = d.getDate();
      }
      
      const sYear = sD.getFullYear();
      const sMonth = sD.getMonth();
      const sDay = sD.getDate();
      
      const isCurrentMonth = sYear === new Date().getFullYear() && sMonth === new Date().getMonth();
      const isInMonth = year === sYear && month === sMonth;
      const isBeforeOrOnDay = isCurrentMonth || year < sYear || (year === sYear && (month < sMonth || (month === sMonth && day <= sDay)));
      
      return isInMonth && isBeforeOrOnDay;
    });
  }, [rmInwardLogs, sD]);

  const cDP = useMemo(() => {
    const mK = `${sD.getFullYear()}-${String(sD.getMonth()+1).padStart(2,'0')}`;
    const arc = archives.find(a => a.monthKey === mK);
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const isPastMonth = mK !== currentMonthKey;

    const sYear = sD.getFullYear();
    const sMonth = sD.getMonth();
    const sDay = sD.getDate();

    return parts.map(p => {
      const aP = arc?.parts.find(ap => ap.id === p.id);
      
      const mappedRMs = rawMaterials.filter(rm => {
        return (p.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === p.id) || (rm.partIds && rm.partIds.includes(p.id));
      });

      if (mappedRMs.length > 0) {
        const monthRMOpeningPcs = mappedRMs.reduce((sum, rm) => {
          const opBalancePipesStr = resolvedRMOpeningBalances[rm.id] || '0';
          const openingBalancePipes = parseFloat(opBalancePipesStr);

          const rmLength = rm.length || 6000;
          const partLength = p.itemLength || 0;
          let yieldFactor = 0;
          if (partLength > 0) {
            yieldFactor = Math.floor(rmLength / partLength);
          } else {
            const rmWeight = rmLength * (rm.weightPer1000 / 1000);
            const partWeight = p.itemWeight || 0;
            if (partWeight > 0 && rmWeight > 0) {
              yieldFactor = Math.floor(rmWeight / partWeight);
            }
          }
          return sum + Math.round(openingBalancePipes * yieldFactor);
        }, 0);

        const monthReceipts = inwardLogs.filter(l => {
          if (l.partId !== p.id) return false;
          if (l.remarks?.startsWith("[OPENING_BALANCE_SET:") || l.remarks?.startsWith("[RM_OPENING_BALANCE_SET:") || l.remarks?.toLowerCase().includes("opening balance") || l.remarks === "[OPENING_BALANCE_ADJUSTMENT]") return false;
          
          let year: number, month: number, day: number;
          if (l.timestamp && l.timestamp.includes('T')) {
            const dateParts = l.timestamp.split('T')[0].split('-');
            year = parseInt(dateParts[0]);
            month = parseInt(dateParts[1]) - 1;
            day = parseInt(dateParts[2]);
          } else {
            const d = new Date(l.timestamp);
            year = d.getFullYear();
            month = d.getMonth();
            day = d.getDate();
          }

          return year === sYear && month === sMonth && day <= sDay;
        }).reduce((sum, l) => sum + l.quantity, 0);

        const monthSales = sales.filter(s => {
          if (s.partId !== p.id) return false;
          let year: number, month: number, day: number;
          if (s.timestamp && s.timestamp.includes('T')) {
            const dateParts = s.timestamp.split('T')[0].split('-');
            year = parseInt(dateParts[0]);
            month = parseInt(dateParts[1]) - 1;
            day = parseInt(dateParts[2]);
          } else {
            const d = new Date(s.timestamp);
            year = d.getFullYear();
            month = d.getMonth();
            day = d.getDate();
          }

          return year === sYear && month === sMonth && day <= sDay;
        }).reduce((sum, s) => sum + s.quantity, 0);

        const stockAtDate = monthRMOpeningPcs + monthReceipts - monthSales;
        const schedulesAtDate = isPastMonth ? (aP ? aP.schedules : {}) : p.schedules;

        return { 
          ...p, 
          stock: stockAtDate, 
          schedules: schedulesAtDate, 
          revisionCount: isPastMonth ? (aP ? aP.revisionCount : 0) : p.revisionCount, 
          status: (stockAtDate < 0 ? 'Out of Stock' : stockAtDate === 0 ? 'Out of Stock' : stockAtDate <= p.minThreshold ? 'Low Stock' : 'In Stock') as StockStatus 
        };
      }

      const dispatchesAfter = sales.filter(s => {
        if (s.partId !== p.id) return false;
        let year: number, month: number, day: number;
        if (s.timestamp && s.timestamp.includes('T')) {
          const parts = s.timestamp.split('T')[0].split('-');
          year = parseInt(parts[0]);
          month = parseInt(parts[1]) - 1;
          day = parseInt(parts[2]);
        } else {
          const d = new Date(s.timestamp);
          year = d.getFullYear();
          month = d.getMonth();
          day = d.getDate();
        }
        
        const isAfterDay = year > sYear || (year === sYear && (month > sMonth || (month === sMonth && day > sDay)));
        return isAfterDay;
      }).reduce((a, b) => a + b.quantity, 0);

      const receiptsAfter = inwardLogs.filter(l => {
        if (l.partId !== p.id) return false;
        let year: number, month: number, day: number;
        if (l.timestamp && l.timestamp.includes('T')) {
          const parts = l.timestamp.split('T')[0].split('-');
          year = parseInt(parts[0]);
          month = parseInt(parts[1]) - 1;
          day = parseInt(parts[2]);
        } else {
          const d = new Date(l.timestamp);
          year = d.getFullYear();
          month = d.getMonth();
          day = d.getDate();
        }
        
        const isAfterDay = year > sYear || (year === sYear && (month > sMonth || (month === sMonth && day > sDay)));
        return isAfterDay;
      }).reduce((a, b) => a + b.quantity, 0);

      const stockAtDate = p.stock + dispatchesAfter - receiptsAfter;
      const schedulesAtDate = isPastMonth ? (aP ? aP.schedules : {}) : p.schedules;

      return { 
        ...p, 
        stock: stockAtDate, 
        schedules: schedulesAtDate, 
        revisionCount: isPastMonth ? (aP ? aP.revisionCount : 0) : p.revisionCount, 
        status: (stockAtDate < 0 ? 'Out of Stock' : stockAtDate === 0 ? 'Out of Stock' : stockAtDate <= p.minThreshold ? 'Low Stock' : 'In Stock') as StockStatus 
      };
    });
  }, [sD, parts, sales, inwardLogs, archives, rawMaterials, resolvedRMOpeningBalances]);

  return (
    <div className={`min-h-screen flex ${isH ? 'bg-slate-100' : 'bg-slate-50'}`}>
      <div className="fixed top-8 right-8 z-[300] flex flex-col gap-4 pointer-events-none">
        {syncNotifications.map(n => (
          <div key={n.id} className="p-5 bg-emerald-600 text-white rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-right duration-500 border border-emerald-400 pointer-events-auto">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center text-xl">✅</div>
            <div className="text-left">
              <p className="text-[10px] font-black uppercase tracking-widest opacity-80 mb-1">Cloud Sync</p>
              <p className="text-sm font-black">{n.message}</p>
            </div>
          </div>
        ))}
      </div>
      <Sidebar currentView={currentView} onViewChange={setCurrentView} currentMonthDisplay={sD.toLocaleDateString('en-GB',{month:'short',year:'numeric'})} role={role} userDisplayName={appUser?.displayName || userName} onLogout={logout} userName={userName} onUserNameChange={setUserName} />
      <main className="flex-1 md:ml-64 p-6 md:p-10 relative text-left">
        <div className="max-w-7xl mx-auto">
          <div className="flex justify-between items-start mb-8 text-left"><TimeMachine selectedDate={sD} onDateChange={setSelectedDate} sales={sales} inwardLogs={inwardLogs} /></div>
          {!canAccessView(role, currentView) ? (
            <div className="p-10 bg-rose-50 rounded-2xl text-rose-600 font-bold text-sm">
              Your role ({role}) doesn't have access to this section.
            </div>
          ) : null}
          {canAccessView(role, currentView) && currentView === 'dashboard' && (
            <Dashboard 
              parts={cDP} 
              sales={contextSales} 
              allSales={sales} 
              activeCustomer={activeCustomer} 
              onCustomerChange={setActiveCustomer} 
              customers={customers} 
              forcedMonthDisplay={sD.toLocaleDateString('en-GB',{month:'short',year:'numeric'})} 
              selectedDate={sD} 
              rawMaterials={rawMaterials} 
              localRMOpeningBalances={resolvedRMOpeningBalances}
              rmInwardLogs={contextRmInwardLogs}
            />
          )}
          {canAccessView(role, currentView) && currentView === 'inventory' && (
            <Inventory 
              parts={cDP} 
              sales={contextSales} 
              inwardLogs={contextInwardLogs} 
              onAddInward={handleAddInward} 
              isAdmin={isAdmin} 
              selectedDate={sD} 
              selectedDateDisplay={sD.toLocaleDateString('en-GB')}
              rawMaterials={rawMaterials}
              rmInwardLogs={contextRmInwardLogs}
              customers={customers}
              onAddRMInward={handleAddRMInward}
              localRMOpeningBalances={resolvedRMOpeningBalances}
              setLocalRMOpeningBalances={setLocalRMOpeningBalances}
            />
          )}
          {canAccessView(role, currentView) && currentView === 'inward_logs' && <InwardLogs logs={inwardLogs} parts={cDP} auditDate={sD} isAdmin={isAdmin} rawMaterials={rawMaterials} localRMOpeningBalances={resolvedRMOpeningBalances} onDeleteLog={(id) => {
             const log = inwardLogs.find(l => l.id === id);
             if (log) {
               setInwardLogs(prev => prev.filter(l => l.id !== id));
               setParts(prev => prev.map(p => p.id === log.partId ? { ...p, stock: p.stock - log.quantity } : p));
             }
          }} />}
          {canAccessView(role, currentView) && currentView === 'dispatch_daily' && <DailyDispatch parts={cDP} sales={contextSales} allSales={sales} inwardLogs={inwardLogs} onBulkDispatch={(items, cust, ts, inv) => {
             const finalTs = ts || getLocalISOString();
             const officialCustomer = customers.find(c => c.name.toUpperCase().trim() === cust.toUpperCase().trim())?.name || cust;
             const newSales = items.map(i => {
               const part = parts.find(p => p.id === i.partId)!;
               const specificRate = part.customerRates?.[officialCustomer] ?? part.rate;
               return { id: Math.random().toString(36).substr(2, 9), partId: part.id, partName: part.name, sapCode: part.sapCode, quantity: i.quantity, totalPrice: specificRate * i.quantity, timestamp: finalTs, customer: officialCustomer, invoiceNumber: inv };
             });
             setSales(prev => [...newSales, ...prev]);
             setParts(prev => prev.map(p => {
               const match = items.find(i => i.partId === p.id);
               if (match) {
                 const schedules = p.schedules || {};
                 const schedulesUpdate = schedules[officialCustomer] === undefined ? { ...schedules, [officialCustomer]: 0 } : schedules;
                 const customerRates = p.customerRates || {};
                 const customerRatesUpdate = customerRates[officialCustomer] === undefined ? { ...customerRates, [officialCustomer]: p.rate || 0 } : customerRates;
                 return { ...p, stock: p.stock - match.quantity, schedules: schedulesUpdate, customerRates: customerRatesUpdate };
               }
               return p;
             }));
          }} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={customers} isHistorical={isH} selectedDate={sD} selectedDateDisplay={sD.toLocaleDateString('en-GB')} />}
          {canAccessView(role, currentView) && currentView === 'sales' && <SalesLog parts={cDP} sales={contextSales} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={customers} isAdmin={isAdmin} auditDate={sD} onDeleteSale={(id) => {
             const sale = sales.find(s => s.id === id);
             if (sale) {
               setSales(prev => prev.filter(s => s.id !== id));
               setParts(prev => prev.map(p => p.id === sale.partId ? { ...p, stock: p.stock + sale.quantity } : p));
             }
          }} />}
          {canAccessView(role, currentView) && currentView === 'analytics' && <AIAnalyst parts={cDP} sales={contextSales} />}
          {canAccessView(role, currentView) && currentView === 'data_mgmt' && <DataManagement parts={parts} sales={sales} inwardLogs={inwardLogs} archives={archives} customers={customers} rawMaterials={rawMaterials} rmInwardLogs={rmInwardLogs} localRMOpeningBalances={localRMOpeningBalances} isAdmin={isAdmin} onImportData={handleFullImport} syncLog={syncLog} userName={userName} />}
          {canAccessView(role, currentView) && currentView === 'item_master' && isAdmin && (
            <ItemMaster 
              parts={parts} 
              customers={customers} 
              rawMaterials={rawMaterials}
              onAdd={(p) => {
                const newPartId = Math.random().toString(36).substr(2, 9);
                const newPart = { ...p, id: newPartId, stock: 0, inward: 0, revisionCount: 0, lastUpdated: new Date().toISOString(), status: 'Out of Stock', schedules: {} } as Part;
                setParts(prev => [...prev, newPart]);
                
                // Sync Raw Materials for this new part
                if (p.customerRMMappings) {
                  const mappings = p.customerRMMappings;
                  setRawMaterials(prevRMs => prevRMs.map(rm => {
                    const mappedRMIdForThisCustomer = mappings[rm.customerName];
                    if (mappedRMIdForThisCustomer === rm.id) {
                      return { ...rm, partId: newPartId, partName: newPart.name };
                    }
                    return rm;
                  }));
                }
              }} 
              onEdit={(id, up) => {
                setParts(prev => prev.map(p => p.id === id ? { ...p, ...up } : p));
                
                // Sync Raw Materials for this part
                const mappings = up.customerRMMappings || {};
                const partName = up.name || parts.find(p => p.id === id)?.name || '';
                setRawMaterials(prevRMs => prevRMs.map(rm => {
                  const mappedRMIdForThisCustomer = mappings[rm.customerName];
                  if (mappedRMIdForThisCustomer === rm.id) {
                    return { ...rm, partId: id, partName: partName };
                  }
                  // If previously mapped to this part but now removed or changed
                  if (rm.partId === id && mappedRMIdForThisCustomer !== rm.id) {
                    return { ...rm, partId: '', partName: '' };
                  }
                  return rm;
                }));
              }} 
              onDelete={(id) => {
                setParts(prev => prev.filter(p => p.id !== id));
                // Clear any RM mappings previously pointing to this item definition
                setRawMaterials(prevRMs => prevRMs.map(rm => {
                  if (rm.partId === id) {
                    return { ...rm, partId: '', partName: '' };
                  }
                  return rm;
                }));
              }} 
            />
          )}
          {canAccessView(role, currentView) && currentView === 'rm_master' && isAdmin && (
            <RMMaster 
              rawMaterials={rawMaterials} 
              parts={parts} 
              customers={customers} 
              onAdd={(rm) => {
                const newRMId = Math.random().toString(36).substr(2, 9);
                const newRM = { ...rm, id: newRMId, stock: 0 } as RawMaterial;
                setRawMaterials(prev => [...prev, newRM]);
                
                const selectedPartIds = newRM.partIds || (newRM.partId ? [newRM.partId] : []);
                if (selectedPartIds.length > 0 && newRM.customerName) {
                  setParts(prevParts => prevParts.map(p => {
                    if (selectedPartIds.includes(p.id)) {
                      const m = p.customerRMMappings || {};
                      return { ...p, customerRMMappings: { ...m, [newRM.customerName]: newRMId } };
                    }
                    return p;
                  }));
                }
              }} 
              onEdit={(id, rm) => {
                const updatedRM = { ...rm, id } as RawMaterial; // partName is inside rm
                setRawMaterials(prev => prev.map(r => r.id === id ? { ...r, ...rm } : r));
                
                const custName = updatedRM.customerName;
                const selectedPartIds = updatedRM.partIds || (updatedRM.partId ? [updatedRM.partId] : []);
                if (custName) {
                  setParts(prevParts => prevParts.map(p => {
                    const isTargetPart = selectedPartIds.includes(p.id);
                    const isOldMappedPart = p.customerRMMappings?.[custName] === id;
                    
                    if (isTargetPart) {
                      const m = p.customerRMMappings || {};
                      return { ...p, customerRMMappings: { ...m, [custName]: id } };
                    } else if (isOldMappedPart) {
                      const m = { ...p.customerRMMappings };
                      delete m[custName];
                      return { ...p, customerRMMappings: m };
                    }
                    return p;
                  }));
                }
              }} 
              onDelete={(id) => {
                const targetRM = rawMaterials.find(r => r.id === id);
                setRawMaterials(prev => prev.filter(r => r.id !== id));
                
                if (targetRM) {
                  const custName = targetRM.customerName;
                  const selectedPartIds = targetRM.partIds || (targetRM.partId ? [targetRM.partId] : []);
                  if (custName && selectedPartIds.length > 0) {
                    setParts(prevParts => prevParts.map(p => {
                      if (selectedPartIds.includes(p.id) && p.customerRMMappings?.[custName] === id) {
                        const m = { ...p.customerRMMappings };
                        delete m[custName];
                        return { ...p, customerRMMappings: m };
                      }
                      return p;
                    }));
                  }
                }
              }} 
            />
          )}
          {canAccessView(role, currentView) && currentView === 'customer_master' && isAdmin && (
            <CustomerMaster 
              customers={customers} 
              sales={sales} 
              activeCustomerInSession={activeCustomer} 
              onAdd={(n, k) => {
                const newCust: Customer = { id: Math.random().toString(36).substr(2, 9), name: n, matchKeywords: k };
                setCustomers(prev => [...prev, newCust]);
                setParts(prev => prev.map(p => {
                  return {
                    ...p,
                    schedules: { ...p.schedules, [n]: 0 },
                    customerRates: { ...p.customerRates, [n]: p.rate || 0 }
                  };
                }));
              }} 
              onEdit={(id, n, k) => {
                const oldCust = customers.find(c => c.id === id);
                setCustomers(prev => prev.map(c => c.id === id ? { ...c, name: n, matchKeywords: k } : c));
                if (oldCust && oldCust.name !== n) {
                  setParts(prev => prev.map(p => {
                    const newSchedules = { ...p.schedules }; newSchedules[n] = newSchedules[oldCust.name]; delete newSchedules[oldCust.name];
                    const newRates = { ...p.customerRates }; newRates[n] = newRates[oldCust.name]; delete newRates[oldCust.name];
                    return { ...p, schedules: newSchedules, customerRates: newRates, mappedCustomers: p.mappedCustomers.map(m => m === oldCust.name ? n : m) };
                  }));
                  setSales(prev => prev.map(s => s.customer === oldCust.name ? { ...s, customer: n } : s));
                  if (activeCustomer === oldCust.name) setActiveCustomer(n);
                }
              }} 
              onDelete={(id) => {
                const cust = customers.find(c => c.id === id); if (!cust) return;
                setCustomers(prev => prev.filter(c => c.id !== id));
                setParts(prev => prev.map(p => {
                  const mapped = p.mappedCustomers ? p.mappedCustomers.filter(m => m !== cust.name) : [];
                  const newSchedules = { ...p.schedules }; delete newSchedules[cust.name];
                  const newRates = { ...p.customerRates }; delete newRates[cust.name];
                  return { ...p, mappedCustomers: mapped, schedules: newSchedules, customerRates: newRates };
                }));
                if (activeCustomer === cust.name) setActiveCustomer(customers.find(c => c.id !== id)?.name || '');
              }} 
            />
          )}
          {isAdmin && currentView === 'user_master' && <UserMaster />}
          {isAdmin && currentView === 'company_master' && <CompanyMaster />}
          {canAccessView(role, currentView) && currentView === 'schedule' && <ScheduleManager parts={cDP} onUpdateSchedule={(id, val, cust) => setParts(prev => prev.map(p => p.id === id ? { ...p, schedules: { ...p.schedules, [cust]: val }, revisionCount: p.revisionCount + 1 } : p))} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={customers} isHistorical={isH} selectedMonthDisplay={sD.toLocaleDateString('en-GB',{month:'long',year:'numeric'})} />}
        </div>
      </main>
    </div>
  );

  function handleAddInward(pid: string, qty: number, sup: string, rem?: string, ts?: string, invNum?: string) {
    const finalTs = ts || getLocalISOString();
    const part = parts.find(p => pid === p.id);
    if (!part) return;
    setInwardLogs(prev => [{ id: Math.random().toString(36).substr(2, 9), partId: pid, partName: part.name, sapCode: part.sapCode, quantity: qty, supplier: sup, timestamp: finalTs, remarks: rem, invoiceNumber: invNum }, ...prev]);
    setParts(prev => prev.map(p => pid === p.id ? { ...p, stock: p.stock + qty, lastUpdated: finalTs } : p));

    // Exclude opening balance setups from auto-conversion to RM Inward
    if (rem && (rem.startsWith("[OPENING_BALANCE_SET:") || rem.startsWith("[RM_OPENING_BALANCE_SET:") || rem.includes("OPENING_BALANCE") || rem === "[OPENING_BALANCE_ADJUSTMENT]")) {
      return;
    }

    // Find linked raw materials using mappings
    const linkedRMs = rawMaterials.filter(rm => {
      return (part.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === part.id) || (rm.partIds && rm.partIds.includes(part.id));
    });

    if (linkedRMs.length > 0) {
      setRmInwardLogs(prev => {
        let nextLogs = [...prev];
        linkedRMs.forEach(rm => {
          const rmLength = rm.length || 6000;
          const partLength = part.itemLength || 0;
          let yieldFactor = 0;
          if (partLength > 0) {
            yieldFactor = Math.floor(rmLength / partLength);
          } else {
            const rmWeight = rmLength * (rm.weightPer1000 / 1000);
            const partWeight = part.itemWeight || 0;
            if (partWeight > 0 && rmWeight > 0) {
              yieldFactor = Math.floor(rmWeight / partWeight);
            }
          }
          if (yieldFactor > 0) {
            const pipesQty = parseFloat((qty / yieldFactor).toFixed(2));
            if (pipesQty !== 0) {
              nextLogs = [{
                id: Math.random().toString(36).substr(2, 9),
                rmId: rm.id,
                rmSize: rm.size,
                quantity: pipesQty,
                supplier: sup,
                timestamp: finalTs,
                invoiceNumber: invNum,
                remarks: rem || `Auto-Converted from Part Inward (${qty} Pcs of ${part.name})`
              }, ...nextLogs];
            }
          }
        });
        return nextLogs;
      });

      // Update the rawMaterials state too
      setRawMaterials(prevRMs => prevRMs.map(rm => {
        const isLinked = (part.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === part.id) || (rm.partIds && rm.partIds.includes(part.id));
        if (isLinked) {
          const rmLength = rm.length || 6000;
          const partLength = part.itemLength || 0;
          let yieldFactor = 0;
          if (partLength > 0) {
            yieldFactor = Math.floor(rmLength / partLength);
          } else {
            const rmWeight = rmLength * (rm.weightPer1000 / 1000);
            const partWeight = part.itemWeight || 0;
            if (partWeight > 0 && rmWeight > 0) {
              yieldFactor = Math.floor(rmWeight / partWeight);
            }
          }
          if (yieldFactor > 0) {
            const pipesQty = parseFloat((qty / yieldFactor).toFixed(2));
            return { ...rm, stock: rm.stock + pipesQty };
          }
        }
        return rm;
      }));
    }
  }

  function handleAddRMInward(rmId: string, qty: number, sup: string, rem?: string, ts?: string, invNum?: string) {
    const finalTs = ts || getLocalISOString();
    const rm = rawMaterials.find(r => r.id === rmId);
    if (!rm) return;
    setRmInwardLogs(prev => [{ id: Math.random().toString(36).substr(2, 9), rmId, rmSize: rm.size, quantity: qty, supplier: sup, timestamp: finalTs, remarks: rem, invoiceNumber: invNum }, ...prev]);
    setRawMaterials(prev => prev.map(r => r.id === rmId ? { ...r, stock: r.stock + qty } : r));

    // Find linked parts using RM mappings
    const linkedParts = parts.filter(p => {
      return (p.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === p.id) || (rm.partIds && rm.partIds.includes(p.id));
    });

    if (linkedParts.length > 0) {
      setInwardLogs(prev => {
        let nextLogs = [...prev];
        linkedParts.forEach(p => {
          const rmLength = rm.length || 6000;
          const partLength = p.itemLength || 0;
          let yieldFactor = 0;
          if (partLength > 0) {
            yieldFactor = Math.floor(rmLength / partLength);
          } else {
            const rmWeight = rmLength * (rm.weightPer1000 / 1000);
            const partWeight = p.itemWeight || 0;
            if (partWeight > 0 && rmWeight > 0) {
              yieldFactor = Math.floor(rmWeight / partWeight);
            }
          }
          const pcs = Math.round(qty * yieldFactor);
          if (pcs !== 0) {
            nextLogs = [{
              id: Math.random().toString(36).substr(2, 9),
              partId: p.id,
              partName: p.name,
              sapCode: p.sapCode,
              quantity: pcs,
              supplier: sup,
              timestamp: finalTs,
              invoiceNumber: invNum,
              remarks: rem || `Auto-Converted from RM Inward (${qty} Pipes of size ${rm.size})`
            }, ...nextLogs];
          }
        });
        return nextLogs;
      });
    }
  }
};

const AuthGate: React.FC = () => {
  const { appUser, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-sm font-bold">
        Loading…
      </div>
    );
  }
  if (!appUser) return <Login />;
  return <MainApp />;
};

const App: React.FC = () => (
  <AuthProvider>
    <CompanyProvider>
      <AuthGate />
    </CompanyProvider>
  </AuthProvider>
);

export default App;
