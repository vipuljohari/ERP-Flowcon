
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
import ImportLegacyData from './components/ImportLegacyData';
import ImportIssues from './components/ImportIssues';
import RMCrossBillCheck from './components/RMCrossBillCheck';
import Notifications from './components/Notifications';
import ErrorBoundary from './components/ErrorBoundary';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { CompanyProvider, useBrandName } from './contexts/CompanyContext';
import { useFirestoreArray } from './hooks/useFirestoreArray';
import { useFirestoreDoc } from './hooks/useFirestoreDoc';
import { Part, Sale, InwardLog, MonthlyArchive, StockStatus, Customer, RawMaterial, RMInwardLog, RMManufacturerInvoice, RMCustomerCrossInvoice, RMMaterialLength, AdminAlert, canAccessView } from './types';
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
  const [pendingItemDraft, setPendingItemDraft] = useState<{ sapCode: string; name: string; customer?: string } | null>(null);
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

  // Creates a persisted Admin Notifications entry. Called only from
  // human-initiated actions (Discrepancy Control Entry, RM Inward, manual
  // Dispatch Slip, Tally Excel/XML import) — never from the automatic
  // Tally sync — so Admin can cross-check/cross-question exactly what was
  // entered, by whom, and when.
  const pushAdminAlert = (partial: Partial<AdminAlert> & Pick<AdminAlert, 'type'>) => {
    const merged: AdminAlert = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: getLocalISOString(),
      createdBy: appUser?.displayName || userName,
      role,
      verified: false,
      ...partial,
    };
    // Firestore rejects an explicit `undefined` field value outright — strip
    // any (e.g. a Discrepancy Entry has no invoiceNumber, a plain RM Inward
    // has no responsibleName) so the write never fails silently.
    const newAlert = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined)
    ) as AdminAlert;
    setAdminAlerts(prev => [newAlert, ...prev]);
  };

  const verifyAdminAlert = (id: string) => {
    setAdminAlerts(prev => prev.map(a => a.id === id ? {
      ...a,
      verified: true,
      verifiedAt: getLocalISOString(),
      verifiedBy: appUser?.displayName || userName,
    } : a));
  };

  const [parts, setParts] = useFirestoreArray<Part>('parts', INITIAL_PARTS);
  const [sales, setSales] = useFirestoreArray<Sale>('sales');
  const [inwardLogs, setInwardLogs] = useFirestoreArray<InwardLog>('inwardLogs');
  const [archives, setArchives] = useFirestoreArray<MonthlyArchive>('archives', [], (a) => a.monthKey);
  const [customers, setCustomers] = useFirestoreArray<Customer>('customers', INITIAL_CUSTOMERS);
  const [rawMaterials, setRawMaterials] = useFirestoreArray<RawMaterial>('rawMaterials');
  const [rmInwardLogs, setRmInwardLogs] = useFirestoreArray<RMInwardLog>('rmInwardLogs');
  const [rmManufacturerInvoices, setRmManufacturerInvoices] = useFirestoreArray<RMManufacturerInvoice>('rmManufacturerInvoices');
  const [rmCrossInvoices, setRmCrossInvoices] = useFirestoreArray<RMCustomerCrossInvoice>('rmCustomerCrossInvoices');
  const [rmMaterialLengths, setRmMaterialLengths] = useFirestoreArray<RMMaterialLength>('rmMaterialLengths', [], (m) => m.materialCode);
  // Admin-only Notifications feed — persisted so an alert raised from any
  // login (Store, PPC, Accounts) is visible to Admin on any other
  // device/session. Never written to by the fully-automatic Tally sync;
  // only human-initiated entries push here. See pushAdminAlert below.
  const [adminAlerts, setAdminAlerts] = useFirestoreArray<AdminAlert>('adminAlerts');
  const [localRMOpeningBalances, setLocalRMOpeningBalances] = useFirestoreDoc<Record<string, string>>('settings', 'rmOpeningBalances', {});
  // Item-wise (Part) opening balances — same idea as RM's above: a stored,
  // month-keyed override map, NOT a live-recomputed value. Previously,
  // Item-wise Opening Balance was recalculated from p.stock and the
  // ENTIRE inwardLogs/sales history every render, with an optional
  // override hidden inside an inwardLogs entry's remarks text
  // ("[OPENING_BALANCE_SET:...]"). That meant a legacy-data restore could
  // silently reintroduce an old, stale override and corrupt the current
  // month's Opening Balance — exactly what happened. This map fixes that:
  // it's the ONLY source of truth for Opening Balance now, set explicitly
  // via the Inventory screen's audit-lock UI, and it carries forward
  // month-to-month like RM's does (see resolvedPartOpeningBalances below).
  const [localPartOpeningBalances, setLocalPartOpeningBalances] = useFirestoreDoc<Record<string, string>>('settings', 'partOpeningBalances', {});

  // Single source of truth for display order across the WHOLE app — the
  // Admin's sortOrder (set via the reorder pencil icon) applies everywhere
  // parts/RM/customers are listed, for every role, on every device,
  // INCLUDING every customer-selection dropdown. Anything that doesn't have
  // a sortOrder yet sorts to the end, keeping its relative order.
  const sortedParts = useMemo(
    () => [...parts].sort((a, b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999)),
    [parts]
  );
  const sortedRawMaterials = useMemo(
    () => [...rawMaterials].sort((a, b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999)),
    [rawMaterials]
  );
  const sortedCustomers = useMemo(
    () => [...customers].sort((a, b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999)),
    [customers]
  );

  const [activeCustomer, setActiveCustomer] = useState(() => customers[0]?.name || '');
  const [activeModel, setActiveModel] = useState<string>('All');

  // Which Model tags exist for the currently active customer's parts —
  // drives the Model dropdown and resets it if it becomes invalid (e.g.
  // switching to a customer that doesn't use this Model tag at all).
  const availableModels = useMemo(() => {
    const set = new Set<string>();
    parts.forEach(p => {
      const m = p.customerModels?.[activeCustomer];
      if (m) set.add(m);
    });
    return Array.from(set).sort();
  }, [parts, activeCustomer]);

  useEffect(() => {
    if (activeModel !== 'All' && !availableModels.includes(activeModel)) {
      setActiveModel('All');
    }
  }, [availableModels, activeModel]);

  // Applied everywhere parts/RM are shown operationally (Dashboard,
  // Inventory, Sales, Dispatch, Schedules, Inward Logs) — NOT in Item
  // Master / RM Master / Data Management, where Admin needs to see and
  // manage everything regardless of the current Model filter.
  const modelFilteredParts = useMemo(() => {
    if (activeModel === 'All') return sortedParts;
    return sortedParts.filter(p => p.customerModels?.[activeCustomer] === activeModel);
  }, [sortedParts, activeCustomer, activeModel]);

  const modelFilteredRawMaterials = useMemo(() => {
    if (activeModel === 'All') return sortedRawMaterials;
    return sortedRawMaterials.filter(rm => rm.customerName === activeCustomer && rm.model === activeModel);
  }, [sortedRawMaterials, activeCustomer, activeModel]);

  // customers loads asynchronously from Firestore — it's empty for a moment
  // when the app first opens, so the line above picks "no customer" before
  // real data arrives. This catches up once the list is actually populated,
  // and also recovers if the previously active customer gets deleted.
  useEffect(() => {
    if (sortedCustomers.length === 0) return;
    const stillValid = sortedCustomers.some(c => c.name === activeCustomer);
    if (!activeCustomer || !stillValid) {
      setActiveCustomer(sortedCustomers[0].name);
    }
  }, [sortedCustomers, activeCustomer]);

  const partsRef = useRef(parts);
  const salesRef = useRef(sales);
  const customersRef = useRef(customers);
  const inwardLogsRef = useRef(inwardLogs);
  const archivesRef = useRef(archives);
  const activeCustomerRef = useRef(activeCustomer);
  const rawMaterialsRef = useRef(rawMaterials);
  const rmInwardLogsRef = useRef(rmInwardLogs);
  const localRMOpeningBalancesRef = useRef(localRMOpeningBalances);
  const localPartOpeningBalancesRef = useRef(localPartOpeningBalances);
  const lastSyncTimeRef = useRef(0);

  useEffect(() => {
    partsRef.current = parts; salesRef.current = sales; customersRef.current = customers;
    inwardLogsRef.current = inwardLogs; archivesRef.current = archives;
    activeCustomerRef.current = activeCustomer;
    rawMaterialsRef.current = rawMaterials; rmInwardLogsRef.current = rmInwardLogs;
    localRMOpeningBalancesRef.current = localRMOpeningBalances;
    localPartOpeningBalancesRef.current = localPartOpeningBalances;

    // parts/sales/inwardLogs/archives/customers/rawMaterials/rmInwardLogs now
    // live in Firestore (see useFirestoreArray above) — no longer written to
    // localStorage. Only small local-only preferences stay here.
    localStorage.setItem('autopart_local_rm_opening_balances', JSON.stringify(localRMOpeningBalances));
    localStorage.setItem('autopart_username', userName);
  }, [parts, sales, inwardLogs, archives, customers, rawMaterials, rmInwardLogs, localRMOpeningBalances, localPartOpeningBalances, userName]);

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

  // An inwardLogs/RM-audit entry tagged this way is a SYNTHETIC quantity
  // delta injected purely to nudge a stored balance during an audit
  // correction — never a real physical receipt. Both the old Item-wise
  // formula and RM's own audit action write these; excluded everywhere a
  // "how much actually came in this month" total is computed, so an audit
  // correction never gets double-counted as if goods had arrived.
  const isAuditDeltaRemark = (remarks?: string) =>
    !!remarks && (remarks.startsWith('[OPENING_BALANCE_SET:') || remarks.startsWith('[RM_OPENING_BALANCE_SET:') || remarks === '[OPENING_BALANCE_ADJUSTMENT]');

  // Item-wise (Part) Opening Balance — same month-by-month rolling
  // simulation as resolvedRMOpeningBalances above, just without RM's
  // yield/scrap conversion (a Part's own inwardLogs/sales are already in
  // the same unit as its stock, so each month's delta is direct).
  // Anchored at the same base month as RM for consistency. Each month's
  // opening = the previous month's closing UNLESS an admin explicitly
  // locked a value for that specific month (via the Inventory screen's
  // audit-lock UI, or the one-time "Freeze" migration) — that lock then
  // becomes the new anchor going forward, exactly like RM's does.
  const resolvedPartOpeningBalances = useMemo(() => {
    const result: Record<string, string> = {};

    const baseYear = 2026;
    const baseMonth = 5; // June, same anchor as RM

    const targetYear = sD.getFullYear();
    const targetMonth = sD.getMonth();
    const targetMonthKey = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`;

    const getYM = (timestamp: string): [number, number] => {
      if (timestamp && timestamp.includes('T')) {
        const dp = timestamp.split('T')[0].split('-');
        return [parseInt(dp[0]), parseInt(dp[1]) - 1];
      }
      const d = new Date(timestamp);
      return [d.getFullYear(), d.getMonth()];
    };

    parts.forEach(p => {
      const baseOverrideKey = `2026-06_${p.id}`;
      let currentBal = parseFloat(
        localPartOpeningBalances[baseOverrideKey] !== undefined
          ? localPartOpeningBalances[baseOverrideKey]
          : (localPartOpeningBalances[p.id] || '0')
      );

      if (targetYear < baseYear || (targetYear === baseYear && targetMonth <= baseMonth)) {
        const monthOverrideKey = `${targetMonthKey}_${p.id}`;
        result[p.id] = localPartOpeningBalances[monthOverrideKey] !== undefined
          ? localPartOpeningBalances[monthOverrideKey]
          : currentBal.toString();
        return;
      }

      let simYear = baseYear;
      let simMonth = baseMonth;

      while (simYear < targetYear || (simYear === targetYear && simMonth < targetMonth)) {
        const simMonthKey = `${simYear}-${String(simMonth + 1).padStart(2, '0')}`;
        const simOverrideKey = `${simMonthKey}_${p.id}`;

        if (localPartOpeningBalances[simOverrideKey] !== undefined) {
          currentBal = parseFloat(localPartOpeningBalances[simOverrideKey]);
        }

        const monthInward = inwardLogs
          .filter(l => {
            if (l.partId !== p.id || isAuditDeltaRemark(l.remarks)) return false;
            const [y, m] = getYM(l.timestamp);
            return y === simYear && m === simMonth;
          })
          .reduce((sum, l) => sum + l.quantity, 0);

        const monthSales = sales
          .filter(s => {
            if (s.partId !== p.id) return false;
            const [y, m] = getYM(s.timestamp);
            return y === simYear && m === simMonth;
          })
          .reduce((sum, s) => sum + s.quantity, 0);

        currentBal = currentBal + monthInward - monthSales;

        simMonth++;
        if (simMonth > 11) { simMonth = 0; simYear++; }
      }

      const targetOverrideKey = `${targetMonthKey}_${p.id}`;
      if (localPartOpeningBalances[targetOverrideKey] !== undefined) {
        currentBal = parseFloat(localPartOpeningBalances[targetOverrideKey]);
      }

      result[p.id] = currentBal.toString();
    });

    return result;
  }, [sD, parts, sales, inwardLogs, localPartOpeningBalances]);

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
          localPartOpeningBalances: localPartOpeningBalancesRef.current,
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
  }, [parts, sales, inwardLogs, archives, customers, localRMOpeningBalances, localPartOpeningBalances]);

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
            localPartOpeningBalances: localPartOpeningBalancesRef.current,
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

    // Support restoring localPartOpeningBalances (Item-wise), mirroring RM's above.
    const restoredPartOpeningBalances = data.localPartOpeningBalances || {};
    setLocalPartOpeningBalances(restoredPartOpeningBalances);

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
      
      const isInMonth = year === sYear && month === sMonth;
      // Bug fix: this used to short-circuit on `isCurrentMonth ||`, which
      // skipped the day check entirely whenever the selected date fell in
      // today's calendar month — so picking a back-date earlier this month
      // silently showed the WHOLE month's data (including entries after the
      // selected day) instead of only entries up to and including it. The
      // general year/month/day comparison below already handles "today's
      // month, day <= sDay" correctly on its own, so the special case was
      // both redundant and wrong.
      const isBeforeOrOnDay = year < sYear || (year === sYear && (month < sMonth || (month === sMonth && day <= sDay)));
      
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
      
      const isInMonth = year === sYear && month === sMonth;
      // Bug fix: this used to short-circuit on `isCurrentMonth ||`, which
      // skipped the day check entirely whenever the selected date fell in
      // today's calendar month — so picking a back-date earlier this month
      // silently showed the WHOLE month's data (including entries after the
      // selected day) instead of only entries up to and including it. The
      // general year/month/day comparison below already handles "today's
      // month, day <= sDay" correctly on its own, so the special case was
      // both redundant and wrong.
      const isBeforeOrOnDay = year < sYear || (year === sYear && (month < sMonth || (month === sMonth && day <= sDay)));
      
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
      
      const isInMonth = year === sYear && month === sMonth;
      // Bug fix: this used to short-circuit on `isCurrentMonth ||`, which
      // skipped the day check entirely whenever the selected date fell in
      // today's calendar month — so picking a back-date earlier this month
      // silently showed the WHOLE month's data (including entries after the
      // selected day) instead of only entries up to and including it. The
      // general year/month/day comparison below already handles "today's
      // month, day <= sDay" correctly on its own, so the special case was
      // both redundant and wrong.
      const isBeforeOrOnDay = year < sYear || (year === sYear && (month < sMonth || (month === sMonth && day <= sDay)));
      
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

    return modelFilteredParts.map(p => {
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
  }, [sD, modelFilteredParts, sales, inwardLogs, archives, rawMaterials, resolvedRMOpeningBalances]);

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
      <Sidebar currentView={currentView} onViewChange={setCurrentView} currentMonthDisplay={sD.toLocaleDateString('en-GB',{month:'short',year:'numeric'})} role={role} userDisplayName={appUser?.displayName || userName} onLogout={logout} userName={userName} onUserNameChange={setUserName} pendingAlertsCount={adminAlerts.filter(a => !a.verified).length} />
      <main className="flex-1 md:ml-64 p-6 md:p-10 relative text-left">
        <div className="max-w-7xl mx-auto">
          <div className="flex justify-between items-start mb-8 text-left">
            <TimeMachine selectedDate={sD} onDateChange={setSelectedDate} sales={sales} inwardLogs={inwardLogs} />
            {availableModels.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-5 py-3 flex items-center gap-3">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Model</span>
                <select
                  value={activeModel}
                  onChange={(e) => setActiveModel(e.target.value)}
                  className="text-sm font-bold text-slate-900 outline-none bg-transparent cursor-pointer"
                >
                  <option value="All">All models</option>
                  {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
          </div>
          <ErrorBoundary key={currentView} label={currentView}>
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
              customers={sortedCustomers} 
              forcedMonthDisplay={sD.toLocaleDateString('en-GB',{month:'short',year:'numeric'})} 
              selectedDate={sD} 
              rawMaterials={modelFilteredRawMaterials} 
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
              // Bug fix: previously only role-gated, so Inventory stayed
              // editable while browsing a past date via the calendar —
              // unlike Dispatch/Schedule, which already go read-only in
              // that case. A new entry made while viewing history still
              // posts with TODAY's real timestamp (see handleAddInward),
              // so it silently landed on the wrong day. Now matches the
              // same historical-view lock used elsewhere in the app.
              readOnly={!(isAdmin || role === 'store') || isH}
              selectedDate={sD}
              selectedDateDisplay={sD.toLocaleDateString('en-GB')}
              rawMaterials={modelFilteredRawMaterials}
              rmInwardLogs={contextRmInwardLogs}
              customers={sortedCustomers}
              onAddRMInward={handleAddRMInward}
              localRMOpeningBalances={resolvedRMOpeningBalances}
              setLocalRMOpeningBalances={setLocalRMOpeningBalances}
              localPartOpeningBalances={resolvedPartOpeningBalances}
              setLocalPartOpeningBalances={setLocalPartOpeningBalances}
              setRawMaterials={setRawMaterials}
              setParts={setParts}
              onCreateAlert={pushAdminAlert}
            />
          )}
          {canAccessView(role, currentView) && currentView === 'inward_logs' && <InwardLogs logs={inwardLogs} parts={cDP} auditDate={sD} isAdmin={isAdmin} rawMaterials={modelFilteredRawMaterials} localRMOpeningBalances={resolvedRMOpeningBalances} onDeleteLog={(id) => {
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
          }} onCreateAlert={pushAdminAlert} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={sortedCustomers} isHistorical={isH} selectedDate={sD} selectedDateDisplay={sD.toLocaleDateString('en-GB')} />}
          {canAccessView(role, currentView) && currentView === 'sales' && <SalesLog parts={cDP} sales={contextSales} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={sortedCustomers} isAdmin={isAdmin} auditDate={sD} onDeleteSale={(id) => {
             const sale = sales.find(s => s.id === id);
             if (sale) {
               setSales(prev => prev.filter(s => s.id !== id));
               setParts(prev => prev.map(p => p.id === sale.partId ? { ...p, stock: p.stock + sale.quantity } : p));
             }
          }} />}
          {canAccessView(role, currentView) && currentView === 'analytics' && <AIAnalyst parts={cDP} sales={contextSales} />}
          {canAccessView(role, currentView) && currentView === 'data_mgmt' && <DataManagement parts={parts} sales={sales} inwardLogs={inwardLogs} archives={archives} customers={customers} rawMaterials={rawMaterials} rmInwardLogs={rmInwardLogs} localRMOpeningBalances={localRMOpeningBalances} localPartOpeningBalances={localPartOpeningBalances} isAdmin={isAdmin} onImportData={handleFullImport} syncLog={syncLog} userName={userName} />}
          {canAccessView(role, currentView) && currentView === 'item_master' && isAdmin && (
            <ItemMaster 
              parts={sortedParts} 
              customers={sortedCustomers} 
              rawMaterials={sortedRawMaterials}
              setParts={setParts}
              prefillDraft={pendingItemDraft}
              onDraftConsumed={() => setPendingItemDraft(null)}
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
              rawMaterials={sortedRawMaterials} 
              parts={sortedParts} 
              customers={sortedCustomers} 
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
              customers={sortedCustomers} 
              sales={sales} 
              activeCustomerInSession={activeCustomer} 
              setCustomers={setCustomers}
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
          {isAdmin && currentView === 'notifications' && <Notifications alerts={adminAlerts} onVerify={verifyAdminAlert} />}
          {isAdmin && currentView === 'user_master' && <UserMaster />}
          {isAdmin && currentView === 'company_master' && <CompanyMaster />}
          {isAdmin && currentView === 'import_legacy' && <ImportLegacyData />}
          {canAccessView(role, currentView) && currentView === 'import_issues' && (
            <ImportIssues
              isAdmin={isAdmin}
              customers={sortedCustomers}
              onAddToItemMaster={(draft) => {
                setPendingItemDraft(draft);
                setCurrentView('item_master');
              }}
            />
          )}
          {canAccessView(role, currentView) && currentView === 'rm_crossbill' && (
            <RMCrossBillCheck
              manufacturerInvoices={rmManufacturerInvoices}
              crossInvoices={rmCrossInvoices}
              materialLengths={rmMaterialLengths}
              customers={sortedCustomers}
              setManufacturerInvoices={setRmManufacturerInvoices}
              setCrossInvoices={setRmCrossInvoices}
              setMaterialLengths={setRmMaterialLengths}
              isAdmin={isAdmin}
            />
          )}
          {canAccessView(role, currentView) && currentView === 'schedule' && <ScheduleManager parts={cDP} onUpdateSchedule={(id, val, cust) => setParts(prev => prev.map(p => p.id === id ? { ...p, schedules: { ...p.schedules, [cust]: val }, revisionCount: p.revisionCount + 1 } : p))} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={sortedCustomers} isHistorical={isH} selectedMonthDisplay={sD.toLocaleDateString('en-GB',{month:'long',year:'numeric'})} />}
          </ErrorBoundary>
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
  const brandName = useBrandName();

  useEffect(() => {
    document.title = brandName;
  }, [brandName]);

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
