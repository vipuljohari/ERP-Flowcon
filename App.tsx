
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
import RMCrossBillCheck, { MfgInvoiceSubmission } from './components/RMCrossBillCheck';
import Notifications from './components/Notifications';
import RMApprovalQueue from './components/RMApprovalQueue';
import TrialRMReceiving from './components/TrialRMReceiving';
import GateDocumentsQueue from './components/GateDocumentsQueue';
import PartyNameMaster from './components/PartyNameMaster';
import ErrorBoundary from './components/ErrorBoundary';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { CompanyProvider, useBrandName } from './contexts/CompanyContext';
import { writeBatch, doc, collection } from 'firebase/firestore';
import { db } from './services/firebase';
import { useFirestoreArray } from './hooks/useFirestoreArray';
import { useFirestoreDoc } from './hooks/useFirestoreDoc';
import { Part, Sale, InwardLog, MonthlyArchive, StockStatus, Customer, RawMaterial, RMInwardLog, RMManufacturerInvoice, RMCustomerCrossInvoice, RMMaterialLength, RMPurchaseVoucher, AdminAlert, DimensionTolerance, PendingRMEntry, PendingRMEntryType, RMEntryModeSettings, canAccessView, GateDocumentForApproval, GateApprovedSuppliersSettings, UnmatchedDharamkantaSlip, PendingInventoryCorrectionPayload, INVENTORY_CORRECTION_REASON_LABELS, UserRole } from './types';
import { archivePhotoToDropbox, buildArchiveFileName, buildArchiveMonthFolder } from './services/dropboxArchive';
import { SEED_DIMENSION_TOLERANCES } from './services/dimensionTolerance';
import { INITIAL_PARTS, INITIAL_CUSTOMERS } from './constants';
import { GoogleDriveService } from './services/googleDrive';
import { DropboxService } from './services/dropbox';
import { TallyService } from './services/tally';
import { isSheetRM, rmKgPerPart, partsPerRMUnit, rmMatchesCustomer, rmAllCustomers } from './services/rmYield';
import { pcsPerBar, computeUnattributedScrapMm, LongerPipeLine, MaterialEntryHeader, FinishedPieceLine } from './services/materialEntry';
import { applySiblingBorrow } from './services/siblingBorrow';
// Clock-corrected timestamp helper — see services/time.ts for why a plain
// `new Date()` here is no longer trusted directly (a wrong device clock
// used to be able to produce a dispatch/inward entry dated in a future
// year, which then sorted as "most recent" forever in the Dashboard's
// Global Dispatch Feed until caught by hand).
import { getLocalISOString } from './services/time';
import { startOfflineQueueAutoFlush, subscribeQueueEvents } from './services/offlineQueue';

// 26-Sep-26: moved out of MainApp's body (was declared as a local
// `const MATERIAL_ENTRY_WEIGHT_VARIANCE_FLAG_KG = 50;` right above
// handleMaterialEntryFinishedPieces/handleMaterialEntryLongerPipe) after
// finally tracing the "ReferenceError: <minified name> is not defined"
// crash on Approve & Post to THIS binding, via a sourcemapped diagnostic
// build — the earlier fixes in this file (pushPendingRMEntry,
// normalizeInvoiceKey, and 7 other helpers) all assumed the esbuild/Vite
// production dead-code-elimination bug only hit `const NAME = (...) =>`
// FUNCTION bindings; it turns out the same bug also drops a plain
// `const NAME = <value>` binding declared deep in this enormous
// component's body, even though both its use sites (the weight-variance
// checks in each handler) survive minification renamed to a short name.
// It reproduced exactly: entry posts fully (RM stock, notification), then
// throws the instant the weight-mismatch check runs, so status never
// flips to 'approved' and the entry stays stuck showing PENDING while
// already posted — re-clicking Approve re-posts it again. Moving this to
// module scope (a plain top-level constant, not inside MainApp at all)
// sidesteps the bug entirely, the same way a hoisted `function` does for
// the helpers above. Do not move this back inside MainApp's body.
const MATERIAL_ENTRY_WEIGHT_VARIANCE_FLAG_KG = 50;

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

  // 26-Sep-26: this and every other top-level helper below it in this
  // component were converted from `const NAME = (...) => {...}` to hoisted
  // `function NAME(...) {...}` declarations as a blanket, proactive fix for
  // the recurring production-only esbuild/Vite dead-code-elimination bug
  // documented in detail on approvePendingRMEntryInner's
  // normalizeInvoiceKey fix and on pushPendingRMEntry above (search this
  // file for "dead-code-elimination" for the full writeup) — a `const ... =>`
  // binding in this enormous component can get silently dropped from the
  // production bundle while every call site survives (renamed to a short
  // minified name), throwing "Uncaught ReferenceError: <name> is not
  // defined" the instant it's called. This has now hit 3 different helpers
  // in 3 different flows within 24 hours (pushPendingRMEntry,
  // normalizeInvoiceKey, and a third one inside the Approve & Post chain
  // that couldn't be pinned to an exact line from the minified stack trace
  // alone). Rather than keep chasing single instances one at a time, every
  // remaining const-arrow helper at this scope is converted here — hoisted
  // function declarations are immune to this bug. Do not add a new
  // `const NAME = (...) => {...}` helper at this level; always use
  // `function NAME(...) {...}` instead.
  function addNotification(message: string, type: 'success' | 'warning' = 'success', action?: () => void) {
    const id = Math.random().toString(36).substr(2, 9);
    setSyncNotifications(prev => [...prev, { id, message, type, action }]);
    setSyncLog(prev => [{ timestamp: new Date().toLocaleTimeString(), message }, ...prev].slice(0, 50));
    if (type === 'success') {
      setTimeout(() => setSyncNotifications(prev => prev.filter(n => n.id !== id)), 8000);
    }
  }

  // Creates a persisted Admin Notifications entry. Called only from
  // human-initiated actions (Discrepancy Control Entry, RM Inward, manual
  // Dispatch Slip, Tally Excel/XML import) — never from the automatic
  // Tally sync — so Admin can cross-check/cross-question exactly what was
  // entered, by whom, and when.
  function pushAdminAlert(partial: Partial<AdminAlert> & Pick<AdminAlert, 'type'>) {
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
  }

  function verifyAdminAlert(id: string) {
    setAdminAlerts(prev => prev.map(a => a.id === id ? {
      ...a,
      verified: true,
      verifiedAt: getLocalISOString(),
      verifiedBy: appUser?.displayName || userName,
    } : a));
  }

  // Dismisses/sets aside a notification with a required reason — for a
  // stray or duplicate alert (e.g. one whose underlying entry never
  // actually saved) where there's nothing real to verify. Distinct from
  // Verify, which implies the underlying data was checked and is correct.
  function flagAdminAlert(id: string, remark: string) {
    setAdminAlerts(prev => prev.map(a => a.id === id ? {
      ...a,
      flagged: true,
      flaggedAt: getLocalISOString(),
      flaggedBy: appUser?.displayName || userName,
      flagRemark: remark,
    } : a));
  }

  // Safety net for when a save fails outright (Firestore quota exhausted,
  // no network, etc.) — see services/offlineQueue.ts. Every
  // useFirestoreArray/useFirestoreDoc write that fails gets queued here
  // automatically (only the specific entry that failed, nothing else) and
  // retried in the background; this just surfaces it with the same "Cloud
  // Sync" toast already used elsewhere, so nobody assumes a failed save
  // actually went through, and nobody has to wonder whether it eventually
  // did.
  useEffect(() => {
    const stopAutoFlush = startOfflineQueueAutoFlush();
    const unsubscribe = subscribeQueueEvents((e) => {
      if (e.type === 'queued') {
        addNotification(
          `Couldn't reach the cloud just now — saved on this device instead. ${e.pendingCount} ${e.pendingCount === 1 ? 'entry is' : 'entries are'} waiting to upload automatically.`,
          'warning'
        );
      } else if (e.type === 'flushed') {
        addNotification(
          `${e.flushedCount} ${e.flushedCount === 1 ? 'entry that was' : 'entries that were'} waiting have now uploaded to the cloud.`,
          'success'
        );
      }
    });
    return () => {
      stopAutoFlush();
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [parts, setParts] = useFirestoreArray<Part>('parts', INITIAL_PARTS);
  const [sales, setSales] = useFirestoreArray<Sale>('sales');
  const [inwardLogs, setInwardLogs] = useFirestoreArray<InwardLog>('inwardLogs');
  const [archives, setArchives] = useFirestoreArray<MonthlyArchive>('archives', [], (a) => a.monthKey);
  const [customers, setCustomers] = useFirestoreArray<Customer>('customers', INITIAL_CUSTOMERS);
  const [rawMaterials, setRawMaterials] = useFirestoreArray<RawMaterial>('rawMaterials');
  const [rmInwardLogs, setRmInwardLogs] = useFirestoreArray<RMInwardLog>('rmInwardLogs');
  const [rmManufacturerInvoices, setRmManufacturerInvoices] = useFirestoreArray<RMManufacturerInvoice>('rmManufacturerInvoices');
  const [pendingRMEntries, setPendingRMEntries] = useFirestoreArray<PendingRMEntry>('pendingRMEntries');
  const [rmCrossInvoices, setRmCrossInvoices] = useFirestoreArray<RMCustomerCrossInvoice>('rmCustomerCrossInvoices');
  const [rmMaterialLengths, setRmMaterialLengths] = useFirestoreArray<RMMaterialLength>('rmMaterialLengths', [], (m) => m.materialCode);
  // Admin-editable tolerance table for Material Entry's Camera Upload — see
  // services/dimensionTolerance.ts for why this is an explicit lookup
  // table rather than a formula. Seeded once with Vipul's 11-Sep-26 rules;
  // Admin can add more from Material Entry's "Dimension Tolerances" editor.
  const [dimensionTolerances, setDimensionTolerances] = useFirestoreArray<DimensionTolerance>('dimensionTolerances', SEED_DIMENSION_TOLERANCES);
  // Admin on/off switch for Material Entry's Camera Upload (both Finished
  // Pieces and Longer Pipe) — defaults to true so this ships already
  // turned on, matching what Vipul asked Camera Upload to do; Admin can
  // switch Store/PPC back to manual-only entry per Material Entry's own
  // toggle (see components/MaterialEntry.tsx).
  // Universal RM Receiving entry-mode switch — one setting, not per-screen.
  // Admin sets this from the top of the RM Approvals screen; it governs RM
  // Cross-Bill Check's Manufacturer Invoice wizard AND Material Entry's
  // Finished Pieces / Longer Pipe all at once. If both ever end up off
  // (shouldn't happen from the UI, but defends against a bad manual
  // Firestore edit), fail safe to Manual Entry rather than locking
  // Store/PPC out of entry entirely.
  const [rmEntryModeSettings, setRmEntryModeSettings] = useFirestoreDoc<RMEntryModeSettings>('settings', 'rmEntryMode', { cameraEnabled: true, manualEnabled: true });
  const rmEntryBothOff = rmEntryModeSettings.cameraEnabled === false && rmEntryModeSettings.manualEnabled === false;
  const rmEntryCameraEnabled = rmEntryBothOff ? false : rmEntryModeSettings.cameraEnabled !== false;
  const rmEntryManualEnabled = rmEntryBothOff ? true : rmEntryModeSettings.manualEnabled !== false;
  // Written only by the Tally Connector script on the 24x7 server (Admin
  // SDK, hourly) — never by the app, so the setter is never used here.
  const [tallyPurchaseVouchers] = useFirestoreArray<RMPurchaseVoucher>('rmPurchaseVouchers');
  // WhatsApp gate-photo intake — see components/GateDocumentsQueue.tsx and
  // services/apiHandlers.ts's handleGateUpload (server-side, via
  // firebase-admin) which is what actually creates docs in this collection.
  const [gateDocuments, setGateDocuments] = useFirestoreArray<GateDocumentForApproval>('gateDocumentsForApproval');
  // Dharamkanta (weighbridge) slip photos that arrived over WhatsApp but
  // couldn't be auto-matched to a pending gate entry by vehicle number —
  // the manual "pick from unmatched" fallback in GateDocumentsQueue reads
  // this. Written server-side by handleDharamkantaSlipUpload; the app only
  // reads it and, on a manual pick, flips status to 'attached'.
  const [unmatchedDharamkantaSlips, setUnmatchedDharamkantaSlips] = useFirestoreArray<UnmatchedDharamkantaSlip>('unmatchedDharamkantaSlips');
  // Admin's Party Name Master selection over the Tally Purchase party list
  // — same settings-doc pattern as rmEntryModeSettings above, and the exact
  // same collection/doc path (settings/gateApprovedSuppliers) handleGateUpload
  // reads server-side.
  const [gateApprovedSuppliers, setGateApprovedSuppliers] = useFirestoreDoc<GateApprovedSuppliersSettings>('settings', 'gateApprovedSuppliers', { selectedNames: [] });
  // Every distinct Purchase party name Tally has ever shown us — Party Name
  // Master's full checkbox candidate list (see rmPurchaseVouchers' own
  // "never written by the app" comment above; this is read-only here too).
  const tallySupplierNameOptions = useMemo(
    () => Array.from(new Set(tallyPurchaseVouchers.map(pv => (pv.supplierName || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [tallyPurchaseVouchers]
  );
  // Which Gate Documents for Approval card (if any) currently has its
  // matching entry screen open — set the moment Store/Admin picks a mode
  // on GateDocumentsQueue, cleared once that entry is actually submitted or
  // cancelled. See finalizeGateDocument / the Inventory & RMCrossBillCheck
  // render blocks below.
  const [gateDocInProgress, setGateDocInProgress] = useState<{ doc: GateDocumentForApproval; mode: PendingRMEntryType } | null>(null);
  // Admin-only Notifications feed — persisted so an alert raised from any
  // login (Store, PPC, Accounts) is visible to Admin on any other
  // device/session. Never written to by the fully-automatic Tally sync;
  // only human-initiated entries push here. See pushAdminAlert below.
  const [adminAlerts, setAdminAlerts] = useFirestoreArray<AdminAlert>('adminAlerts');
  const [localRMOpeningBalances, setLocalRMOpeningBalances, rmOpeningBalancesLoaded] = useFirestoreDoc<Record<string, string>>('settings', 'rmOpeningBalances', {});
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
  // Inventory.tsx's commitOpeningBalance ALSO still logs a tagged
  // "[OPENING_BALANCE_SET:...]" inwardLogs entry on every correction (via
  // onAddInward) — that's just a visible audit-trail record (and nudges
  // live stock by the correction delta), never read back to determine the
  // override value itself, so it can't reintroduce the old bug.
  const [localPartOpeningBalances, setLocalPartOpeningBalances, partOpeningBalancesLoaded] = useFirestoreDoc<Record<string, string>>('settings', 'partOpeningBalances', {});

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

  // Customers are auto-added to Customer Master straight from Tally import,
  // before anyone has mapped a single Item Master part to them — useful for
  // catching new consignees, but it means every "pick a customer" dropdown
  // across the app was cluttered with names that have nothing to show yet
  // (0 dispatches, 0 stock, 0 schedule). This is the one filtered list used
  // by every OPERATIONAL customer dropdown (Dashboard, Inventory, Daily
  // Dispatch, Sales Log, RM Cross-Bill Check, Schedule). It is deliberately
  // NOT used by Item Master, RM Master, Customer Master, or Import Issues —
  // those screens are exactly where Admin needs to see and act on a
  // not-yet-mapped customer (to map their first item, or to review/fix the
  // "Needs Review" auto-created entry), so they keep the full list.
  const customersWithItems = useMemo(() => {
    const withItems = sortedCustomers.filter(c => sortedParts.some(p => p.mappedCustomers?.includes(c.name)));
    // Fallback so a fresh/empty Item Master doesn't collapse every
    // operational dropdown in the app to nothing.
    return withItems.length > 0 ? withItems : sortedCustomers;
  }, [sortedCustomers, sortedParts]);

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
    return sortedRawMaterials.filter(rm => {
      if (rmMatchesCustomer(rm, activeCustomer) && rm.model === activeModel) return true;
      // Fallback: an RM that is directly mapped (RM Master's item-mapping
      // picker — rm.partId/rm.partIds) to a Part that itself is confirmed to
      // belong to the active customer+model counts too, even if the RM's own
      // separate `model` tag was never set/kept in sync with that mapping.
      // Without this, a correctly-linked RM silently drops out of every
      // screen under a Model filter (Inventory Ledger's Opening Balance and
      // Plant Balance in particular), and the affected part falls back to a
      // stale/incorrect stored Opening Balance instead of its real
      // RM-derived figure — this is the bug Vipul hit with U-TUBE/80x40x5
      // and again with A-POST LH/RH under the "3DX" filter.
      const mappedParts = sortedParts.filter(p => p.id === rm.partId || (rm.partIds && rm.partIds.includes(p.id)));
      return mappedParts.some(p => p.customerModels?.[activeCustomer] === activeModel);
    });
  }, [sortedRawMaterials, sortedParts, activeCustomer, activeModel]);

  // customers loads asynchronously from Firestore — it's empty for a moment
  // when the app first opens, so the line above picks "no customer" before
  // real data arrives. This catches up once the list is actually populated,
  // and also recovers if the previously active customer gets deleted.
  useEffect(() => {
    if (customersWithItems.length === 0) return;
    const stillValid = customersWithItems.some(c => c.name === activeCustomer);
    if (!activeCustomer || !stillValid) {
      setActiveCustomer(customersWithItems[0].name);
    }
  }, [customersWithItems, activeCustomer]);

  const partsRef = useRef(parts);
  const salesRef = useRef(sales);
  const customersRef = useRef(customers);
  const inwardLogsRef = useRef(inwardLogs);
  const archivesRef = useRef(archives);
  const activeCustomerRef = useRef(activeCustomer);
  const rawMaterialsRef = useRef(rawMaterials);
  const rmInwardLogsRef = useRef(rmInwardLogs);
  const rmManufacturerInvoicesRef = useRef(rmManufacturerInvoices);
  const rmCrossInvoicesRef = useRef(rmCrossInvoices);
  const rmMaterialLengthsRef = useRef(rmMaterialLengths);
  const adminAlertsRef = useRef(adminAlerts);
  const localRMOpeningBalancesRef = useRef(localRMOpeningBalances);
  const localPartOpeningBalancesRef = useRef(localPartOpeningBalances);
  const lastSyncTimeRef = useRef(0);
  // Bug fix, 24-Sep-26: a second click on "Approve & Post" while the first
  // click was still mid-flight (archivePhotoToDropbox alone can take several
  // seconds, and approvePendingRMEntry doesn't flip the entry's status to
  // 'approved' until everything else has finished) ran the ENTIRE posting
  // logic a second time on the same still-'pending' entry — double-crediting
  // stock and filing two inward log entries for one physical delivery.
  // Confirmed in production: Vipul double-clicked Approve on a Finished
  // Pieces entry (A.S.T. Pipes, AST/D/26-27/2682) and all 3 items posted
  // twice. A plain state check can't catch this reliably (both clicks can
  // fire from the same stale render before either write lands), so this is
  // a synchronous ref-based lock instead — checked and set before any
  // `await`, so the second call's check always sees the first call's claim.
  const approvingEntryIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    partsRef.current = parts; salesRef.current = sales; customersRef.current = customers;
    inwardLogsRef.current = inwardLogs; archivesRef.current = archives;
    activeCustomerRef.current = activeCustomer;
    rawMaterialsRef.current = rawMaterials; rmInwardLogsRef.current = rmInwardLogs;
    rmManufacturerInvoicesRef.current = rmManufacturerInvoices;
    rmCrossInvoicesRef.current = rmCrossInvoices;
    rmMaterialLengthsRef.current = rmMaterialLengths;
    adminAlertsRef.current = adminAlerts;
    localRMOpeningBalancesRef.current = localRMOpeningBalances;
    localPartOpeningBalancesRef.current = localPartOpeningBalances;

    // parts/sales/inwardLogs/archives/customers/rawMaterials/rmInwardLogs now
    // live in Firestore (see useFirestoreArray above) — no longer written to
    // localStorage. Only small local-only preferences stay here.
    localStorage.setItem('autopart_local_rm_opening_balances', JSON.stringify(localRMOpeningBalances));
    localStorage.setItem('autopart_username', userName);
  }, [parts, sales, inwardLogs, archives, customers, rawMaterials, rmInwardLogs, rmManufacturerInvoices, rmCrossInvoices, rmMaterialLengths, adminAlerts, localRMOpeningBalances, localPartOpeningBalances, userName]);

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
      const rmIsSheet = isSheetRM(rm);
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

        // Sheet RM: `quantity` on each inward log IS Kg (admin enters it
        // directly, see Inventory.tsx) — there's no bar-length conversion,
        // and no separate cut-scrap term (a Sheet part's Gross Weight
        // already bakes in its own scrap allowance, see rmKgPerPart).
        if (rmIsSheet) {
          const mappedParts = parts.filter(
            p => p.id === rm.partId || (rm.partIds && rm.partIds.includes(p.id)) || (p.customerRMMappings?.[rm.customerName] === rm.id)
          );

          let totalConsumedKg = 0;
          mappedParts.forEach(item => {
            const kgPerPiece = rmKgPerPart(item);
            if (kgPerPiece <= 0) return;
            const salesQty = sales
              .filter(s => {
                if (s.partId !== item.id) return false;
                if (!rmMatchesCustomer(rm, s.customer)) return false;
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
            totalConsumedKg += salesQty * kgPerPiece;
          });

          const openingKg = currentPipes; // for a Sheet RM, this variable already holds Kg, not pieces
          currentPipes = parseFloat((openingKg + monthInwardPipes - totalConsumedKg).toFixed(2));

          simMonth++;
          if (simMonth > 11) { simMonth = 0; simYear++; }
          continue;
        }

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
              if (!rmMatchesCustomer(rm, s.customer)) return false;
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
  function isAuditDeltaRemark(remarks?: string) {
    return !!remarks && (remarks.startsWith('[OPENING_BALANCE_SET:') || remarks.startsWith('[RM_OPENING_BALANCE_SET:') || remarks === '[OPENING_BALANCE_ADJUSTMENT]');
  }

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

  // Auto-freeze Opening Balance the first time a given month is viewed —
  // for RM and for standalone (non-RM-linked) Parts alike. Until this ran,
  // NEITHER kind of Opening Balance was ever really "frozen": both
  // resolvedRMOpeningBalances and resolvedPartOpeningBalances above just
  // simulate forward live, every render, from whatever the last explicit
  // lock was — carrying forward month to month with no stored value of
  // their own unless someone used the pencil-edit. That's exactly how a
  // number could appear to "change on its own": editing an Inward or Sales
  // entry dated in an EARLIER month retroactively shifts the simulated
  // carry-forward for every later month, with nothing in the audit log to
  // show for it, since no explicit correction was ever made. This effect
  // closes that gap by writing today's simulated value as a real, explicit
  // override for the current month the first time anyone loads it — after
  // that, resolvedRMOpeningBalances/resolvedPartOpeningBalances read that
  // stored value directly instead of re-simulating, so it can only change
  // again via a deliberate pencil-edit correction (which now always
  // requires a reason, see commitOpeningBalance/commitRMOpeningBalance in
  // Inventory.tsx). Deliberately does NOT log an InwardLog audit entry for
  // this — nothing physical happened and no number actually changed, it's
  // just locking in what was already being shown.
  useEffect(() => {
    // CRITICAL — do not remove: this effect decides what's "missing" by
    // reading localRMOpeningBalances/localPartOpeningBalances, but
    // useFirestoreDoc starts both at {} until their first real Firestore
    // snapshot arrives. Running this before that snapshot lands would see
    // EVERY item as missing its current-month override and overwrite the
    // whole stored document (a full replace, not a per-field merge) with
    // freshly re-simulated values — silently erasing real stored corrections,
    // including one made moments earlier from a pencil-edit whose own write
    // hadn't round-tripped back yet. This is exactly what happened in
    // production on 10-Sep-26: Opening Balance corrections were wiped out by
    // this race on a later page load (e.g. opening the app on a different
    // device before this doc had finished loading). Do not let this effect
    // run before both docs have confirmed-loaded.
    if (!rmOpeningBalancesLoaded || !partOpeningBalancesLoaded) return;

    const targetMonthKey = `${sD.getFullYear()}-${String(sD.getMonth() + 1).padStart(2, '0')}`;

    const missingRM = rawMaterials.filter(rm => localRMOpeningBalances[`${targetMonthKey}_${rm.id}`] === undefined);
    if (missingRM.length > 0) {
      setLocalRMOpeningBalances(prev => {
        const next = { ...prev };
        missingRM.forEach(rm => {
          const key = `${targetMonthKey}_${rm.id}`;
          if (next[key] !== undefined) return;
          next[key] = resolvedRMOpeningBalances[rm.id] || '0';
        });
        return next;
      });
    }

    // Skip RM-linked parts — Inventory.tsx's Item-wise Opening Balance
    // display never reads a stored value for those (it derives Opening
    // Balance straight from the mapped RM's own balance instead, see
    // partComputations in Inventory.tsx), so freezing one here would just
    // be a dead write nothing ever looks at.
    const standaloneParts = parts.filter(p => !rawMaterials.some(rm =>
      (p.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === p.id) || (rm.partIds && rm.partIds.includes(p.id))
    ));
    const missingParts = standaloneParts.filter(p => localPartOpeningBalances[`${targetMonthKey}_${p.id}`] === undefined);
    if (missingParts.length > 0) {
      setLocalPartOpeningBalances(prev => {
        const next = { ...prev };
        missingParts.forEach(p => {
          const key = `${targetMonthKey}_${p.id}`;
          if (next[key] !== undefined) return;
          next[key] = resolvedPartOpeningBalances[p.id] || '0';
        });
        return next;
      });
    }
  }, [sD, rawMaterials, parts, localRMOpeningBalances, localPartOpeningBalances, resolvedRMOpeningBalances, resolvedPartOpeningBalances, setLocalRMOpeningBalances, setLocalPartOpeningBalances, rmOpeningBalancesLoaded, partOpeningBalancesLoaded]);

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
          // partsPerRMUnit branches on rm.category: Tube = pieces-per-bar
          // (by length, or weight fallback); Sheet = pieces-per-Kg (the
          // opening balance for a Sheet RM is already stored in Kg).
          const yieldFactor = partsPerRMUnit(p, rm);
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
          rmManufacturerInvoices: rmManufacturerInvoicesRef.current,
          rmCrossInvoices: rmCrossInvoicesRef.current,
          rmMaterialLengths: rmMaterialLengthsRef.current,
          adminAlerts: adminAlertsRef.current,
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
  }, [parts, sales, inwardLogs, archives, customers, rawMaterials, rmInwardLogs, rmManufacturerInvoices, rmCrossInvoices, rmMaterialLengths, adminAlerts, localRMOpeningBalances, localPartOpeningBalances]);

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
                    addNotification(
                      res.unmatchedItems.length > 0
                        ? `Tally Invoice ${res.detectedInvoice || file.name} Imported (${res.unmatchedItems.length} line${res.unmatchedItems.length === 1 ? '' : 's'} sent to Import Issues)`
                        : `Tally Invoice ${res.detectedInvoice || file.name} Imported`,
                      "success"
                    );

                    // Log every unmatched line to Import Issues instead of
                    // letting it silently vanish — see the 24-Aug-26
                    // SIAC-SKH incident, where a genuinely new SAP code
                    // (a dimensional/model variant not yet in Item Master)
                    // had no consumer for `unmatchedItems` anywhere in this
                    // auto-sync cycle, so it just disappeared with zero
                    // record. This runs unattended (no admin reviewing a
                    // modal), so it's the only place this can be caught.
                    if (res.unmatchedItems.length > 0) {
                      try {
                        const nowIso = new Date().toISOString();
                        for (let ui = 0; ui < res.unmatchedItems.length; ui += 450) {
                          const chunk = res.unmatchedItems.slice(ui, ui + 450);
                          const batch = writeBatch(db);
                          chunk.forEach(u => {
                            const ref = doc(collection(db, 'importIssues'));
                            batch.set(ref, {
                              type: 'sales_unmatched',
                              invoiceNumber: res.detectedInvoice || file.name,
                              date: res.detectedDate || getLocalISOString(),
                              customer: res.detectedConsignee || null,
                              rawText: u.rawText,
                              quantity: u.quantity,
                              createdAt: nowIso,
                            });
                          });
                          // eslint-disable-next-line no-await-in-loop
                          await batch.commit();
                        }
                      } catch (issueErr) {
                        console.error('[SyncEngine] Failed to log unmatched Tally lines to Import Issues:', issueErr);
                      }
                    }

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
            rmManufacturerInvoices: rmManufacturerInvoicesRef.current,
            rmCrossInvoices: rmCrossInvoicesRef.current,
            rmMaterialLengths: rmMaterialLengthsRef.current,
            adminAlerts: adminAlertsRef.current,
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
  function checkAndHandleMonthTransition(currentParts: Part[], currentArchives: MonthlyArchive[], forceLastActiveMonth?: string) {
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
        scheduleRevisions: {},
        revisionCount: 0,
        lastUpdated: now.toISOString()
      })));

      localStorage.setItem('autopart_last_active_month', currentMonthKey);
      const nextMonthLabel = now.toLocaleDateString('en-GB', { month: 'short' });
      addNotification(`Monthly Cycle: ${monthLabel.split(' ')[0]} archived. ${nextMonthLabel} targets reset to Zero.`, "success");
    }
  }

  useEffect(() => {
    checkAndHandleMonthTransition(parts, archives);
  }, []);

  function handleFullImport(data: any) {
    if (!data || !data.parts) return;
    
    setParts(data.parts);
    setSales(data.sales || []);
    setInwardLogs(data.inwardLogs || []);
    setArchives(data.archives || []);
    setCustomers(data.customers || INITIAL_CUSTOMERS);
    setRawMaterials(data.rawMaterials || []);
    setRmInwardLogs(data.rmInwardLogs || []);
    setRmManufacturerInvoices(data.rmManufacturerInvoices || []);
    setRmCrossInvoices(data.rmCrossInvoices || []);
    setRmMaterialLengths(data.rmMaterialLengths || []);
    setAdminAlerts(data.adminAlerts || []);
    // Deliberately NOT restored, even though a complete backup captures
    // them (see components/DataManagement.tsx's handlePushToCloud):
    //  - data.rmPurchaseVouchers is an hourly-refreshed Tally mirror —
    //    restoring a stale copy is pointless, the next sync overwrites it
    //    within the hour anyway.
    //  - data.companies / data.users carry live login/session state
    //    (activeDeviceToken, pendingDevices) tied to real Firebase Auth
    //    accounts — silently overwriting those from an old snapshot could
    //    revoke or resurrect a device's access with no one aware it
    //    happened. If Company/User Master ever genuinely needs restoring,
    //    that should be a deliberate manual step, not part of this button.

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
  }

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
          const yieldFactor = partsPerRMUnit(p, rm);
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
          scheduleRevisions: isPastMonth ? (aP ? aP.scheduleRevisions : {}) : p.scheduleRevisions,
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
        scheduleRevisions: isPastMonth ? (aP ? aP.scheduleRevisions : {}) : p.scheduleRevisions,
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
      <Sidebar currentView={currentView} onViewChange={setCurrentView} currentMonthDisplay={sD.toLocaleDateString('en-GB',{month:'short',year:'numeric'})} role={role} userDisplayName={appUser?.displayName || userName} onLogout={logout} userName={userName} onUserNameChange={setUserName} pendingAlertsCount={adminAlerts.filter(a => !a.verified && !a.flagged).length} pendingRMApprovalsCount={pendingRMEntries.filter(e => e.status === 'pending' || e.status === 'not_matched').length} pendingGateDocumentsCount={gateDocuments.filter(d => d.status === 'pending' || d.status === 'in_progress').length} />
      <main className="flex-1 md:ml-64 p-6 pt-20 md:p-10 relative text-left">
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
              customers={customersWithItems}
              forcedMonthDisplay={sD.toLocaleDateString('en-GB',{month:'short',year:'numeric'})}
              selectedDate={sD} 
              rawMaterials={modelFilteredRawMaterials}
              localRMOpeningBalances={resolvedRMOpeningBalances}
              rmInwardLogs={contextRmInwardLogs}
              inwardLogs={contextInwardLogs}
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
              customers={customersWithItems}
              onAddRMInward={handleAddRMInward}
              localRMOpeningBalances={resolvedRMOpeningBalances}
              setLocalRMOpeningBalances={setLocalRMOpeningBalances}
              localPartOpeningBalances={resolvedPartOpeningBalances}
              setLocalPartOpeningBalances={setLocalPartOpeningBalances}
              setRawMaterials={setRawMaterials}
              setParts={setParts}
              onCreateAlert={pushAdminAlert}
              manufacturerInvoices={rmManufacturerInvoices}
              setManufacturerInvoices={setRmManufacturerInvoices}
              materialLengths={rmMaterialLengths}
              onMaterialEntryFinishedPieces={(header, lines, photo) => {
                const fromGateDocumentId = gateDocInProgress?.mode === 'finished_pieces' ? gateDocInProgress.doc.id : undefined;
                const outcome = stageMaterialEntryFinishedPieces(header, lines, photo, fromGateDocumentId);
                if (outcome.entry && gateDocInProgress?.mode === 'finished_pieces') {
                  finalizeGateDocument(gateDocInProgress.doc, outcome.entry);
                }
                return outcome.error;
              }}
              onMaterialEntryLongerPipe={(header, lines, photo) => {
                const fromGateDocumentId = gateDocInProgress?.mode === 'longer_pipe' ? gateDocInProgress.doc.id : undefined;
                const outcome = stageMaterialEntryLongerPipe(header, lines, photo, fromGateDocumentId);
                if (outcome.entry && gateDocInProgress?.mode === 'longer_pipe') {
                  finalizeGateDocument(gateDocInProgress.doc, outcome.entry);
                }
                return outcome.error;
              }}
              onInventoryCorrection={(payload) => {
                // Store: stageInventoryCorrection leaves it 'pending' in RM
                // Approvals until Admin approves. Admin: it posts
                // immediately AND writes the queue record as already-
                // approved in the same call — see its own comment for why
                // that's no longer a separate approvePendingRMEntry call.
                stageInventoryCorrection(payload);
              }}
              dimensionTolerances={dimensionTolerances}
              setDimensionTolerances={setDimensionTolerances}
              cameraEnabled={rmEntryCameraEnabled}
              manualEnabled={rmEntryManualEnabled}
              gateSeed={gateDocInProgress && gateDocInProgress.mode !== 'manufacturer_invoice' ? gateDocInProgress.doc : null}
              gateSeedMode={gateDocInProgress?.mode === 'finished_pieces' ? 'pieces' : gateDocInProgress?.mode === 'longer_pipe' ? 'longer' : null}
              onGateSeedCancelled={cancelGateDocumentInProgress}
            />
          )}
          {canAccessView(role, currentView) && currentView === 'inward_logs' && <InwardLogs logs={inwardLogs} parts={cDP} auditDate={sD} isAdmin={isAdmin} rawMaterials={modelFilteredRawMaterials} localRMOpeningBalances={resolvedRMOpeningBalances} onDeleteLog={(id) => {
             const log = inwardLogs.find(l => l.id === id);
             if (log) {
               setInwardLogs(prev => prev.filter(l => l.id !== id));
               setParts(prev => prev.map(p => p.id === log.partId ? { ...p, stock: p.stock - log.quantity } : p));
             }
          }} rmLogs={rmInwardLogs} onDeleteRmLog={(id) => {
             const log = rmInwardLogs.find(l => l.id === id);
             if (log) {
               setRmInwardLogs(prev => prev.filter(l => l.id !== id));
               setRawMaterials(prev => prev.map(r => r.id === log.rmId ? { ...r, stock: r.stock - log.quantity } : r));
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

             // Sibling Stock Borrow: apply this batch's own -quantity
             // deductions first, then let any part left negative cover the
             // gap from a TRUE sibling's (mutually-declared, e.g. LH/RH)
             // spare stock — never the reverse, a lender is never pushed
             // negative to cover a borrower. Every borrow is logged as an
             // Admin alert (sibling_stock_borrow) so it's visible, not silent.
             const afterDispatch = new Map(parts.map(p => {
               const match = items.find(i => i.partId === p.id);
               return [p.id, match ? p.stock - match.quantity : p.stock] as const;
             }));
             const { updatedStock, borrowEvents } = applySiblingBorrow(parts, afterDispatch);

             setParts(prev => prev.map(p => {
               const match = items.find(i => i.partId === p.id);
               const schedules = p.schedules || {};
               const schedulesUpdate = match && schedules[officialCustomer] === undefined ? { ...schedules, [officialCustomer]: 0 } : schedules;
               const customerRates = p.customerRates || {};
               const customerRatesUpdate = match && customerRates[officialCustomer] === undefined ? { ...customerRates, [officialCustomer]: p.rate || 0 } : customerRates;
               return { ...p, stock: updatedStock.get(p.id) ?? p.stock, schedules: schedulesUpdate, customerRates: customerRatesUpdate };
             }));

             borrowEvents.forEach(ev => {
               pushAdminAlert({
                 type: 'sibling_stock_borrow',
                 partId: ev.borrowerPartId,
                 partName: ev.borrowerPartName,
                 quantity: ev.quantity,
                 customer: officialCustomer,
                 invoiceNumber: inv,
                 remarks: `Borrowed ${ev.quantity} pc(s) of stock from sibling ${ev.lenderPartName} to cover this dispatch's shortfall.`,
               });
             });
          }} onCreateAlert={pushAdminAlert} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={customersWithItems} isHistorical={isH} selectedDate={sD} selectedDateDisplay={sD.toLocaleDateString('en-GB')} />}
          {canAccessView(role, currentView) && currentView === 'sales' && <SalesLog parts={cDP} sales={sales} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={customersWithItems} isAdmin={isAdmin} auditDate={sD} onDeleteSale={(id) => {
             const sale = sales.find(s => s.id === id);
             if (sale) {
               setSales(prev => prev.filter(s => s.id !== id));
               setParts(prev => prev.map(p => p.id === sale.partId ? { ...p, stock: p.stock + sale.quantity } : p));
             }
          }} />}
          {canAccessView(role, currentView) && currentView === 'analytics' && <AIAnalyst parts={cDP} sales={contextSales} />}
          {canAccessView(role, currentView) && currentView === 'data_mgmt' && <DataManagement parts={parts} sales={sales} inwardLogs={inwardLogs} archives={archives} customers={customers} rawMaterials={rawMaterials} rmInwardLogs={rmInwardLogs} rmManufacturerInvoices={rmManufacturerInvoices} rmCrossInvoices={rmCrossInvoices} rmMaterialLengths={rmMaterialLengths} rmPurchaseVouchers={tallyPurchaseVouchers} adminAlerts={adminAlerts} localRMOpeningBalances={localRMOpeningBalances} localPartOpeningBalances={localPartOpeningBalances} isAdmin={isAdmin} onImportData={handleFullImport} syncLog={syncLog} userName={userName} />}
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
                const newPart = { ...p, id: newPartId, stock: 0, inward: 0, revisionCount: 0, lastUpdated: new Date().toISOString(), status: 'Out of Stock', schedules: {}, scheduleRevisions: {} } as Part;
                setParts(prev => {
                  const withNew = [...prev, newPart];
                  // Sibling links are always symmetric — a brand-new part has no
                  // prior siblings to remove, only ones to add the reverse link for.
                  const newSiblings = newPart.siblingIds || [];
                  if (newSiblings.length === 0) return withNew;
                  return withNew.map(existing =>
                    newSiblings.includes(existing.id)
                      ? { ...existing, siblingIds: Array.from(new Set([...(existing.siblingIds || []), newPartId])) }
                      : existing
                  );
                });

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
                setParts(prev => {
                  const prevSiblings = prev.find(p => p.id === id)?.siblingIds || [];
                  const nextSiblings = up.siblingIds !== undefined ? (up.siblingIds || []) : prevSiblings;
                  const added = nextSiblings.filter(sid => !prevSiblings.includes(sid));
                  const removed = prevSiblings.filter(sid => !nextSiblings.includes(sid));
                  return prev.map(p => {
                    if (p.id === id) return { ...p, ...up };
                    if (added.includes(p.id)) return { ...p, siblingIds: Array.from(new Set([...(p.siblingIds || []), id])) };
                    if (removed.includes(p.id)) return { ...p, siblingIds: (p.siblingIds || []).filter(x => x !== id) };
                    return p;
                  });
                });

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
                setParts(prev => prev
                  .filter(p => p.id !== id)
                  .map(p => (p.siblingIds || []).includes(id) ? { ...p, siblingIds: p.siblingIds!.filter(x => x !== id) } : p)
                );
                // Clear any RM mappings previously pointing to this item definition
                setRawMaterials(prevRMs => prevRMs.map(rm => {
                  if (rm.partId === id) {
                    return { ...rm, partId: '', partName: '' };
                  }
                  return rm;
                }));
              }}
              onBulkAdd={handleBulkAddParts}
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

                // Sets Part.customerRMMappings for EVERY customer this RM
                // serves (its primary customerName + any additional
                // "Also Used By" customerNames) — a shared RM must show up
                // linked from every one of its customers, not just the
                // primary, since they all draw from the same one stock.
                const selectedPartIds = newRM.partIds || (newRM.partId ? [newRM.partId] : []);
                const rmCustomers = rmAllCustomers(newRM).filter(Boolean);
                if (selectedPartIds.length > 0 && rmCustomers.length > 0) {
                  setParts(prevParts => prevParts.map(p => {
                    if (!selectedPartIds.includes(p.id)) return p;
                    const m = { ...(p.customerRMMappings || {}) };
                    rmCustomers.forEach(cust => { m[cust] = newRMId; });
                    return { ...p, customerRMMappings: m };
                  }));
                }
              }}
              onEdit={(id, rm) => {
                // Read the PRE-edit RM (still in current state) so we know
                // which customers/parts used to be mapped, before the update
                // below changes it — same "read old, then setState" pattern
                // already used by onDelete just below.
                const oldRM = rawMaterials.find(r => r.id === id);
                const updatedRM = { ...rm, id } as RawMaterial; // partName is inside rm
                setRawMaterials(prev => prev.map(r => r.id === id ? { ...r, ...rm } : r));

                const newCustomers = rmAllCustomers(updatedRM).filter(Boolean);
                const oldCustomers = oldRM ? rmAllCustomers(oldRM).filter(Boolean) : [];
                // Union: covers a customer being ADDED to "Also Used By" (new
                // mapping to write) as well as one being REMOVED from it or
                // swapped out as primary (stale mapping to clear).
                const touchedCustomers = Array.from(new Set([...newCustomers, ...oldCustomers]));
                const selectedPartIds = updatedRM.partIds || (updatedRM.partId ? [updatedRM.partId] : []);

                if (touchedCustomers.length > 0) {
                  setParts(prevParts => prevParts.map(p => {
                    const m = { ...(p.customerRMMappings || {}) };
                    let changed = false;
                    touchedCustomers.forEach(cust => {
                      const isTargetPart = selectedPartIds.includes(p.id) && newCustomers.includes(cust);
                      if (isTargetPart) {
                        if (m[cust] !== id) { m[cust] = id; changed = true; }
                      } else if (m[cust] === id) {
                        delete m[cust];
                        changed = true;
                      }
                    });
                    return changed ? { ...p, customerRMMappings: m } : p;
                  }));
                }
              }}
              onDelete={(id) => {
                const targetRM = rawMaterials.find(r => r.id === id);
                setRawMaterials(prev => prev.filter(r => r.id !== id));

                if (targetRM) {
                  const rmCustomers = rmAllCustomers(targetRM).filter(Boolean);
                  const selectedPartIds = targetRM.partIds || (targetRM.partId ? [targetRM.partId] : []);
                  if (rmCustomers.length > 0 && selectedPartIds.length > 0) {
                    setParts(prevParts => prevParts.map(p => {
                      if (!selectedPartIds.includes(p.id)) return p;
                      const m = { ...(p.customerRMMappings || {}) };
                      let changed = false;
                      rmCustomers.forEach(cust => {
                        if (m[cust] === id) { delete m[cust]; changed = true; }
                      });
                      return changed ? { ...p, customerRMMappings: m } : p;
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
          {isAdmin && currentView === 'notifications' && <Notifications alerts={adminAlerts} onVerify={verifyAdminAlert} onFlag={flagAdminAlert} />}
          {isAdmin && currentView === 'rm_approvals' && (
            <RMApprovalQueue
              entries={pendingRMEntries}
              parts={parts}
              rawMaterials={rawMaterials}
              isAdmin={isAdmin}
              onApprove={approvePendingRMEntry}
              onUpdate={updatePendingRMEntry}
              onReject={rejectPendingRMEntry}
              cameraEnabled={rmEntryModeSettings.cameraEnabled !== false}
              manualEnabled={rmEntryModeSettings.manualEnabled !== false}
              onSetCameraEnabled={(v: boolean) => setRmEntryModeSettings(prev => ({ ...prev, cameraEnabled: v }))}
              onSetManualEnabled={(v: boolean) => setRmEntryModeSettings(prev => ({ ...prev, manualEnabled: v }))}
            />
          )}
          {isAdmin && currentView === 'user_master' && <UserMaster />}
          {isAdmin && currentView === 'company_master' && <CompanyMaster />}
          {isAdmin && currentView === 'import_legacy' && <ImportLegacyData />}
          {isAdmin && currentView === 'trial_rm_receiving' && <TrialRMReceiving />}
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
              rawMaterials={rawMaterials}
              parts={cDP}
              customers={customersWithItems}
              rmInwardLogs={rmInwardLogs}
              tallyPurchaseVouchers={tallyPurchaseVouchers}
              setManufacturerInvoices={setRmManufacturerInvoices}
              setCrossInvoices={setRmCrossInvoices}
              setMaterialLengths={setRmMaterialLengths}
              isAdmin={isAdmin}
              onCreateAlert={pushAdminAlert}
              onSaveManufacturerInvoiceWithAllotment={(submission, photo) => {
                const fromGateDocumentId = gateDocInProgress?.mode === 'manufacturer_invoice' ? gateDocInProgress.doc.id : undefined;
                const outcome = stageManufacturerInvoiceWithAllotment(submission, photo, fromGateDocumentId);
                if (outcome.entry && gateDocInProgress?.mode === 'manufacturer_invoice') {
                  finalizeGateDocument(gateDocInProgress.doc, outcome.entry);
                }
                return outcome.error;
              }}
              cameraEnabled={rmEntryCameraEnabled}
              manualEnabled={rmEntryManualEnabled}
              gateSeed={gateDocInProgress?.mode === 'manufacturer_invoice' ? gateDocInProgress.doc : null}
              onGateSeedCancelled={cancelGateDocumentInProgress}
            />
          )}
          {canAccessView(role, 'gate_documents') && currentView === 'gate_documents' && (
            <GateDocumentsQueue
              gateDocuments={gateDocuments}
              isAdmin={isAdmin}
              onProcess={pickGateDocumentMode}
              onResetInProgress={isAdmin ? resetGateDocumentInProgress : undefined}
              onReject={isAdmin ? handleRejectGateDocument : undefined}
              unmatchedSlips={unmatchedDharamkantaSlips}
              onAttachSlipUpload={handleAttachSlipUpload}
              onAttachSlipFromUnmatched={handleAttachSlipFromUnmatched}
              onDeleteUnmatchedSlip={isAdmin ? handleDeleteUnmatchedSlip : undefined}
            />
          )}
          {isAdmin && currentView === 'party_name_master' && (
            <PartyNameMaster
              tallySupplierNames={tallySupplierNameOptions}
              approvedNames={gateApprovedSuppliers.selectedNames || []}
              manualNames={gateApprovedSuppliers.manualNames || []}
              updatedAt={gateApprovedSuppliers.updatedAt}
              updatedBy={gateApprovedSuppliers.updatedBy}
              onSave={(names, manualNames) => setGateApprovedSuppliers({ selectedNames: names, manualNames, updatedAt: getLocalISOString(), updatedBy: appUser?.displayName || userName })}
            />
          )}
          {canAccessView(role, currentView) && currentView === 'schedule' && <ScheduleManager parts={cDP} onUpdateSchedule={(id, val, cust, wasFirstEntry) => setParts(prev => prev.map(p => {
            if (p.id !== id) return p;
            const priorRevision = p.scheduleRevisions?.[cust] ?? 0;
            // First-ever entry of a schedule (previously 0/unset) starts at
            // Revision 0; only a genuine change to an existing commitment
            // counts as a revision. See Part.scheduleRevisions in types.ts.
            const nextRevision = wasFirstEntry ? 0 : priorRevision + 1;
            return { ...p, schedules: { ...p.schedules, [cust]: val }, scheduleRevisions: { ...p.scheduleRevisions, [cust]: nextRevision }, revisionCount: p.revisionCount + 1 };
          }))} activeCustomer={activeCustomer} onCustomerChange={setActiveCustomer} customers={customersWithItems} isHistorical={isH} selectedMonthDisplay={sD.toLocaleDateString('en-GB',{month:'long',year:'numeric'})} isAdmin={isAdmin} onBulkUpdateSchedules={handleBulkUpdateSchedules} onCreateAlert={pushAdminAlert} />}
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
          // yieldFactor = pieces this RM unit yields (partsPerRMUnit branches
          // tube/sheet, see services/rmYield.ts). qty/yieldFactor is the
          // RM-unit-equivalent of `qty` pieces either way: bars for Tube,
          // Kg for Sheet (1/yieldFactor === grossWeight Kg/pc there).
          const yieldFactor = partsPerRMUnit(part, rm);
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
                unit: isSheetRM(rm) ? 'kg' : 'pcs',
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
          const yieldFactor = partsPerRMUnit(part, rm);
          if (yieldFactor > 0) {
            const pipesQty = parseFloat((qty / yieldFactor).toFixed(2));
            return { ...rm, stock: rm.stock + pipesQty };
          }
        }
        return rm;
      }));
    }
  }

  function handleAddRMInward(rmId: string, qty: number, sup: string, rem?: string, ts?: string, invNum?: string, unit?: 'pcs' | 'kg', sheetSizeText?: string) {
    const finalTs = ts || getLocalISOString();
    const rm = rawMaterials.find(r => r.id === rmId);
    if (!rm) return;
    setRmInwardLogs(prev => [{ id: Math.random().toString(36).substr(2, 9), rmId, rmSize: rm.size, quantity: qty, supplier: sup, timestamp: finalTs, remarks: rem, invoiceNumber: invNum, unit: unit || (isSheetRM(rm) ? 'kg' : 'pcs'), sheetSizeText }, ...prev]);
    setRawMaterials(prev => prev.map(r => r.id === rmId ? { ...r, stock: r.stock + qty } : r));

    // Find linked parts using RM mappings
    const linkedParts = parts.filter(p => {
      return (p.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === p.id) || (rm.partIds && rm.partIds.includes(p.id));
    });

    if (linkedParts.length > 0) {
      const rmUnitLabel = isSheetRM(rm) ? `${qty} Kg of ${rm.thickness || rm.size}` : `${qty} Pipes of size ${rm.size}`;
      setInwardLogs(prev => {
        let nextLogs = [...prev];
        linkedParts.forEach(p => {
          // yieldFactor = pieces per RM unit (partsPerRMUnit branches
          // tube/sheet). qty*yieldFactor is pieces obtainable from `qty`
          // RM units either way: bars for Tube, Kg for Sheet.
          const yieldFactor = partsPerRMUnit(p, rm);
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
              remarks: rem || `Auto-Converted from RM Inward (${rmUnitLabel})`
            }, ...nextLogs];
          }
        });
        return nextLogs;
      });
    }
  }

  // --- Inventory Correction (added 21-Sep-26) ---
  // A no-invoice stock adjustment for a physical-audit finding (rejection
  // sent to scrap, a shortage/surplus found on count) — see
  // PendingInventoryCorrectionPayload in types.ts. Unlike Material Entry
  // just above, this DOES call handleAddInward/handleAddRMInward directly —
  // there's no multi-line/multi-size allotment to worry about here (always
  // exactly one RM or one Part), so the same mirroring math those two
  // already use for a normal signed correction (Inventory.tsx's older
  // direct-entry modal, still live for sheet-metal/non-Material-Entry
  // items) is exactly what a correction needs too, just reached from a
  // button that's available everywhere, staged through the same
  // PendingRMEntry approval queue as the other 3 entry types. The [x2]
  // tag embedded in remarks is machine-parseable — see InwardLogs.tsx's
  // getCorrectionReason — so the reason is filterable without depending on
  // free-typed wording.
  function buildCorrectionRemarks(reason: PendingInventoryCorrectionPayload['reason'], note?: string): string {
    const label = INVENTORY_CORRECTION_REASON_LABELS[reason];
    return `[INVENTORY_CORRECTION:${reason}] ${label}${note ? ` — ${note}` : ''}`;
  }

  // enteredByRole matters here specifically because this can now run in
  // someone ELSE's browser session (Admin clicking Approve on a Store-
  // staged entry) — unlike every other pushAdminAlert call in this file,
  // which always fires in the actual submitter's own session and can
  // safely rely on pushAdminAlert's default createdBy/role (current
  // signed-in user). Passing both explicitly here keeps the Notifications
  // "Entered By" column showing the person who actually staged the
  // correction (e.g. Gaurav/Store) rather than whoever happened to approve
  // it (Admin) — see 21-Sep-26 fix.
  function handleInventoryCorrection(payload: PendingInventoryCorrectionPayload, enteredBy: string, enteredByRole?: UserRole) {
    const finalTs = `${payload.date}T12:00:00.000`;
    const remarksTag = buildCorrectionRemarks(payload.reason, payload.note);
    const alertRole = enteredByRole || role;

    if (payload.scope === 'rm') {
      const rm = rawMaterials.find(r => r.id === payload.itemId);
      if (!rm || !handleAddRMInward) return;
      handleAddRMInward(rm.id, payload.quantity, enteredBy, remarksTag, finalTs, undefined, isSheetRM(rm) ? 'kg' : 'pcs', undefined);
      pushAdminAlert(
        payload.quantity < 0
          ? { type: 'discrepancy', rmId: rm.id, rmSize: rm.size, timestamp: finalTs, quantity: payload.quantity, remarks: remarksTag, responsibleName: enteredBy, createdBy: enteredBy, role: alertRole }
          : { type: 'rm_inward', rmId: rm.id, rmSize: rm.size, timestamp: finalTs, quantity: payload.quantity, supplier: enteredBy, remarks: remarksTag, createdBy: enteredBy, role: alertRole }
      );
    } else {
      const part = parts.find(p => p.id === payload.itemId);
      if (!part) return;
      handleAddInward(part.id, payload.quantity, enteredBy, remarksTag, finalTs, undefined);
      pushAdminAlert(
        payload.quantity < 0
          ? { type: 'discrepancy', partId: part.id, partName: part.name, sapCode: part.sapCode, timestamp: finalTs, quantity: payload.quantity, remarks: remarksTag, responsibleName: enteredBy, createdBy: enteredBy, role: alertRole }
          : { type: 'item_inward', partId: part.id, partName: part.name, sapCode: part.sapCode, timestamp: finalTs, quantity: payload.quantity, supplier: enteredBy, remarks: remarksTag, createdBy: enteredBy, role: alertRole }
      );
    }
  }

  function stageInventoryCorrection(payload: PendingInventoryCorrectionPayload): PendingRMEntry | null {
    if (!payload.itemId || !payload.quantity) return null;
    const scopeLabel = payload.scope === 'rm' ? 'RM' : 'Part';
    const sign = payload.quantity > 0 ? '+' : '';
    const summary = `Inventory Correction — ${scopeLabel} — ${payload.itemLabel} — ${sign}${payload.quantity} — ${INVENTORY_CORRECTION_REASON_LABELS[payload.reason]}`;

    if (isAdmin) {
      // Admin posts directly. Deliberately NOT the usual create-then-
      // approvePendingRMEntry two-write dance (what finalizeGateDocument's
      // fast path uses) — that pattern only works there because an `await`
      // (Dropbox archival) sits between the two writes, giving the first
      // write's Firestore round-trip time to land before the second one
      // reads `prev`. Here there's no such gap: pushPendingRMEntry's create
      // and a follow-up approvePendingRMEntry status-flip would fire in the
      // very same tick, and the second write's `prev` snapshot can still be
      // from BEFORE the first one lands — so the flip to 'approved' quietly
      // no-ops against an entry not yet in local state, leaving the card
      // stuck showing "Pending Approval" forever (even though the
      // correction itself, below, already posted correctly). Writing
      // status:'approved' in the SAME create call sidesteps the race
      // entirely. Confirmed bug, 21-Sep-26.
      const enteredBy = appUser?.displayName || userName;
      handleInventoryCorrection(payload, enteredBy, role);
      return pushPendingRMEntry({
        entryType: 'inventory_correction',
        status: 'approved',
        inventoryCorrectionPayload: payload,
        summary,
        reviewedAt: getLocalISOString(),
        reviewedBy: enteredBy,
      });
    }

    return pushPendingRMEntry({
      entryType: 'inventory_correction',
      status: 'pending',
      inventoryCorrectionPayload: payload,
      summary,
    });
  }

  // --- Material Entry (RM Receiving) — Longer Pipe / Finished Pieces ---
  // Deliberately does NOT call handleAddInward/handleAddRMInward above: both
  // assume one RM maps to a single yield factor (partsPerRMUnit), which
  // can't represent "one bar becomes several different Part sizes" — using
  // them here would double-count or misassign stock. These two write
  // directly, once, to each collection instead. Validated rules (full
  // allotment before save, no negative entries, an invoice-pulled line
  // can't be removed) live in services/materialEntry.ts and are enforced by
  // components/MaterialEntry.tsx before either of these is ever called.
  // Same threshold/formula as RMCrossBillCheck.tsx's own
  // WEIGHT_VARIANCE_FLAG_KG (kept as a separate local copy there
  // deliberately, same reasoning as services/photo.ts's header comment —
  // not switched to share this one so that already-working screen's
  // behavior can't be disturbed by a change made here).
  // MATERIAL_ENTRY_WEIGHT_VARIANCE_FLAG_KG now lives at module scope above
  // MainApp — see its own comment there for why.

  function handleMaterialEntryFinishedPieces(header: MaterialEntryHeader, lines: FinishedPieceLine[]) {
    const finalTs = `${header.date}T12:00:00.000`;
    const entryId = Math.random().toString(36).substr(2, 9);
    const newLogs = lines
      .map(l => {
        const part = parts.find(p => p.id === l.partId);
        if (!part || l.quantity <= 0) return null;
        return {
          id: Math.random().toString(36).substr(2, 9), partId: l.partId, partName: part.name,
          sapCode: part.sapCode, quantity: l.quantity, supplier: header.supplierName, timestamp: finalTs,
          invoiceNumber: header.invoiceNo, materialEntryId: entryId, invoiceBookedInUnit1: header.invoiceBookedInUnit1,
        };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
    if (newLogs.length === 0) return;

    setInwardLogs(prev => [...newLogs, ...prev]);
    setParts(prev => prev.map(p => {
      const gained = newLogs.filter(l => l.partId === p.id).reduce((s, l) => s + l.quantity, 0);
      return gained !== 0 ? { ...p, stock: p.stock + gained, lastUpdated: finalTs } : p;
    }));
    // Deliberately no RM-side effect at all — Finished Pieces means nothing
    // bar-shaped was received (e.g. a job-work vendor already did the cutting).
    // Item-by-item breakdown (name + qty), same convention as the RM
    // Cross-Bill Manufacturer Invoice alert's materialsSummary — a bare
    // "N item(s) received" gave Admin nothing to actually cross-check.
    const itemsSummary = newLogs.length === 1
      ? `${newLogs[0].partName} (${newLogs[0].quantity} Pcs)`
      : `${newLogs.length} items: ${newLogs.map(l => `${l.partName} (${l.quantity} Pcs)`).join(', ')}`;
    pushAdminAlert({
      type: 'item_inward', supplier: header.supplierName, invoiceNumber: header.invoiceNo,
      timestamp: finalTs, itemCount: newLogs.length,
      details: `Material Entry — Finished Pieces: ${itemsSummary}. Total Weight ${header.totalWeightKg ?? '—'} Kg (Dharamkanta ${header.dharamkantaWeightKg ?? '—'} Kg), Bill Value ₹${header.totalBillValue ?? '—'}.`,
    });

    // Invoice-billed weight vs the dharamkanta (weighbridge) actual —
    // same check/threshold as the RM Cross-Bill Manufacturer Invoice flow,
    // only fired when both weights are actually entered.
    if (header.totalWeightKg != null && header.dharamkantaWeightKg != null) {
      const weightVarianceKg = header.dharamkantaWeightKg - header.totalWeightKg;
      if (Math.abs(weightVarianceKg) >= MATERIAL_ENTRY_WEIGHT_VARIANCE_FLAG_KG) {
        pushAdminAlert({
          type: 'rm_weight_mismatch',
          invoiceNumber: header.invoiceNo, supplier: header.supplierName,
          itemCount: newLogs.length,
          remarks: `Material Entry — Finished Pieces: ${itemsSummary} — Invoice billed ${header.totalWeightKg} Kg, Dharam Kanta actual ${header.dharamkantaWeightKg} Kg — ${weightVarianceKg > 0 ? 'received MORE than billed by' : 'received LESS than billed by'} ${Math.abs(weightVarianceKg).toFixed(1)} Kg. Review for a supplier debit note.`,
        });
      }
    }
  }

  function handleMaterialEntryLongerPipe(header: MaterialEntryHeader, lines: LongerPipeLine[]) {
    const finalTs = `${header.date}T12:00:00.000`;
    const entryId = Math.random().toString(36).substr(2, 9);
    const newInwardLogs: InwardLog[] = [];
    const newRmInwardLogs: RMInwardLog[] = [];
    const rmStockDelta: Record<string, number> = {};
    const partStockDelta: Record<string, number> = {};
    const pulledInvoiceLineIds: string[] = [];
    // Per-line size + bars + allotment breakdown for the Admin notification
    // below — same convention as the RM Cross-Bill Manufacturer Invoice
    // alert's perLineRemarks, so "RM Inward Entry" notifications read the
    // same way whether the Material Entry came in through this screen or
    // was pulled from an invoice.
    const perLineRemarks: string[] = [];
    let totalScrapMm = 0;

    lines.forEach(line => {
      const rm = rawMaterials.find(r => r.id === line.rmId);
      if (!rm) return;
      const sizeLabel = `${rm.size}x${line.barLengthMm}`;

      newRmInwardLogs.push({
        id: Math.random().toString(36).substr(2, 9), rmId: rm.id, rmSize: rm.size,
        quantity: line.barsReceived, supplier: header.supplierName, timestamp: finalTs,
        invoiceNumber: header.invoiceNo, unit: 'pcs', materialEntryId: entryId,
        invoiceBookedInUnit1: header.invoiceBookedInUnit1,
        remarks: line.pulledFromInvoiceLineId
          ? 'Pulled from RM Cross-Bill Invoice'
          : (line.autoAssign ? 'Auto-Assign — added to shared RM stock, not split to specific items' : undefined),
      });
      rmStockDelta[rm.id] = (rmStockDelta[rm.id] || 0) + line.barsReceived;

      // Auto-Assign: nothing to allot to any specific item — the RM-level
      // bump above is the whole effect of this line. Skip the per-item loop
      // (and the scrap tally right after it) entirely rather than relying on
      // `line.allotments` merely being empty, so this stays correct even if
      // that ever stops being guaranteed upstream.
      if (line.autoAssign) {
        perLineRemarks.push(`${sizeLabel} (${line.barsReceived} bars received) — Auto-Assign, added to shared RM stock, not split to specific items.`);
        if (line.pulledFromInvoiceLineId) pulledInvoiceLineIds.push(line.pulledFromInvoiceLineId);
        return;
      }

      const itemLengthById: Record<string, number> = {};
      const itemBreakdown: string[] = [];
      line.allotments.forEach(a => {
        const part = parts.find(p => p.id === a.partId);
        if (!part) return;
        itemLengthById[a.partId] = part.itemLength || 0;
        const pcs = line.subMode === 'whole_bars'
          ? (a.barsAllotted || 0) * pcsPerBar(line.barLengthMm, part.itemLength || 0)
          : (a.piecesAllotted || 0);
        if (pcs > 0) {
          newInwardLogs.push({
            id: Math.random().toString(36).substr(2, 9), partId: a.partId, partName: part.name,
            sapCode: part.sapCode, quantity: pcs, supplier: header.supplierName, timestamp: finalTs,
            invoiceNumber: header.invoiceNo, materialEntryId: entryId,
            invoiceBookedInUnit1: header.invoiceBookedInUnit1,
          });
          partStockDelta[a.partId] = (partStockDelta[a.partId] || 0) + pcs;
        }
        if (line.subMode === 'whole_bars' && (a.barsAllotted || 0) > 0) {
          itemBreakdown.push(`${part.name} — ${a.barsAllotted} bars`);
        } else if (line.subMode === 'split_pieces' && (a.piecesAllotted || 0) > 0) {
          itemBreakdown.push(`${part.name} — ${a.piecesAllotted} pcs`);
        }
      });

      if (line.subMode === 'split_pieces') {
        totalScrapMm += computeUnattributedScrapMm(line, itemLengthById);
      }
      perLineRemarks.push(`${sizeLabel} (${line.barsReceived} bars received). Allotted: ${itemBreakdown.length > 0 ? itemBreakdown.join('; ') : 'nothing yet'}.`);
      if (line.pulledFromInvoiceLineId) pulledInvoiceLineIds.push(line.pulledFromInvoiceLineId);
    });

    if (newRmInwardLogs.length === 0 && newInwardLogs.length === 0) return;

    if (newInwardLogs.length > 0) setInwardLogs(prev => [...newInwardLogs, ...prev]);
    setRmInwardLogs(prev => [...newRmInwardLogs, ...prev]);
    if (Object.keys(partStockDelta).length > 0) {
      setParts(prev => prev.map(p => partStockDelta[p.id] ? { ...p, stock: p.stock + partStockDelta[p.id], lastUpdated: finalTs } : p));
    }
    setRawMaterials(prev => prev.map(r => rmStockDelta[r.id] ? { ...r, stock: r.stock + rmStockDelta[r.id] } : r));

    if (pulledInvoiceLineIds.length > 0) {
      // Every material line under a pulled invoice's invoiceNo is grouped
      // together in the UI and must all be included (no partial pull) — this
      // marks the whole invoice group used, once, and it's irreversible from
      // here: re-entry means Admin deletes and redoes it in RM Cross-Bill Check.
      const usedKeys = new Set(
        rmManufacturerInvoices.filter(inv => pulledInvoiceLineIds.includes(inv.id)).map(inv => `${inv.invoiceNo}__${inv.manufacturerName}`)
      );
      setRmManufacturerInvoices(prev => prev.map(inv =>
        usedKeys.has(`${inv.invoiceNo}__${inv.manufacturerName}`)
          ? { ...inv, usedForMaterialEntry: true, usedForMaterialEntryAt: finalTs }
          : inv
      ));
    }

    pushAdminAlert({
      type: 'rm_inward', supplier: header.supplierName, invoiceNumber: header.invoiceNo,
      timestamp: finalTs, itemCount: lines.length,
      details: `Material Entry — Longer Pipe: ${perLineRemarks.join(' | ')} Total Weight ${header.totalWeightKg ?? '—'} Kg (Dharamkanta ${header.dharamkantaWeightKg ?? '—'} Kg), Bill Value ₹${header.totalBillValue ?? '—'}.`,
    });
    if (totalScrapMm > 0.0001) {
      pushAdminAlert({
        type: 'material_entry_scrap', supplier: header.supplierName, invoiceNumber: header.invoiceNo,
        timestamp: finalTs,
        details: `${totalScrapMm.toFixed(0)} mm unattributed leftover across Split-by-Pieces line(s) in this Material Entry — not credited to any single item.`,
      });
    }

    // Invoice-billed weight vs the dharamkanta (weighbridge) actual — same
    // check/threshold as the RM Cross-Bill Manufacturer Invoice flow, only
    // fired when both weights are actually entered.
    if (header.totalWeightKg != null && header.dharamkantaWeightKg != null) {
      const weightVarianceKg = header.dharamkantaWeightKg - header.totalWeightKg;
      if (Math.abs(weightVarianceKg) >= MATERIAL_ENTRY_WEIGHT_VARIANCE_FLAG_KG) {
        pushAdminAlert({
          type: 'rm_weight_mismatch',
          invoiceNumber: header.invoiceNo, supplier: header.supplierName,
          itemCount: lines.length,
          remarks: `Material Entry — Longer Pipe: ${perLineRemarks.join(' | ')} — Invoice billed ${header.totalWeightKg} Kg, Dharam Kanta actual ${header.dharamkantaWeightKg} Kg — ${weightVarianceKg > 0 ? 'received MORE than billed by' : 'received LESS than billed by'} ${Math.abs(weightVarianceKg).toFixed(1)} Kg. Review for a supplier debit note.`,
        });
      }
    }
  }

  // --- Manufacturer Invoice + Bar Allotment (single-stage RM Cross-Bill
  // Check) ---
  // Per Vipul's sign-off, an RM Cross-Bill Manufacturer Invoice can no
  // longer be saved in two stages ("save now, post to inventory whenever") —
  // RMCrossBillCheck.tsx's wizard now collects the invoice AND allots every
  // material's bars to inventory in one sitting, and this is the single
  // handler that does everything atomically once that wizard's green Save
  // is clicked: creates the RMManufacturerInvoice records (already stamped
  // used), persists any new material length, posts RM + Part stock exactly
  // like handleMaterialEntryLongerPipe above (same "write once, no
  // auto-mirror" reasoning — handleAddInward/handleAddRMInward are never
  // called here either), and raises every alert this invoice needs.
  function handleManufacturerInvoiceWithAllotment(submission: MfgInvoiceSubmission) {
    const {
      manufacturerName, customerName, invoiceNo, date,
      totalWeightKg, actualWeightKg, weightFlagged, weightVarianceKg,
      aiExtracted, lines,
    } = submission;
    if (lines.length === 0) return;
    const createdAt = new Date().toISOString();
    const finalTs = `${date}T12:00:00.000`;
    const entryId = Math.random().toString(36).substr(2, 9);

    // 1. One RMManufacturerInvoice doc per material line — posted straight
    // away, unlike the old two-stage design's usedForMaterialEntry: false.
    const newInvoiceDocs: RMManufacturerInvoice[] = lines.map(line => ({
      id: Math.random().toString(36).substr(2, 9),
      manufacturerName, customerName, invoiceNo, date,
      materialName: line.materialName,
      materialCode: line.materialCode,
      quantityPcs: line.quantityPcs,
      ratePerPc: line.ratePerPc,
      itemValue: line.itemValue,
      totalWeightKg, actualWeightKg, weightFlagged,
      createdAt,
      usedForMaterialEntry: true,
      usedForMaterialEntryAt: createdAt,
    }));
    setRmManufacturerInvoices(prev => [...prev, ...newInvoiceDocs]);

    // 2. Persist a newly-entered piece length for any material that doesn't
    // already have one recorded — identical logic to the old submitMfgInvoice.
    const newLengths = lines.filter(line =>
      line.mfgLengthInput &&
      !rmMaterialLengths.some(m => m.materialCode.toUpperCase() === line.materialCode.toUpperCase().trim())
    );
    if (newLengths.length > 0) {
      setRmMaterialLengths(prev => {
        let next = prev;
        for (const line of newLengths) {
          next = [
            ...next.filter(m => m.materialCode.toUpperCase() !== line.materialCode.toUpperCase().trim()),
            { materialCode: line.materialCode.trim(), materialName: line.materialName, lengthMm: parseFloat(line.mfgLengthInput) || 0, updatedAt: createdAt },
          ];
        }
        return next;
      });
    }

    // 3. Post RM + Part stock from the allotment — same math as
    // handleMaterialEntryLongerPipe, plus a per-line remarks string (size,
    // bars received, per-item breakdown) for the richer rm_inward alert
    // below, per Vipul's explicit ask for "size of tube, total tubes,
    // alloted qty to which part etc" in that notification.
    const newInwardLogs: InwardLog[] = [];
    const newRmInwardLogs: RMInwardLog[] = [];
    const rmStockDelta: Record<string, number> = {};
    const partStockDelta: Record<string, number> = {};
    const perLineRemarks: string[] = [];
    let totalScrapMm = 0;

    lines.forEach(line => {
      const rm = rawMaterials.find(r => r.id === line.rmId);
      if (!rm) return; // shouldn't happen — Step 2 hard-blocks Save while any line is unresolved

      newRmInwardLogs.push({
        id: Math.random().toString(36).substr(2, 9), rmId: rm.id, rmSize: rm.size,
        quantity: line.quantityPcs, supplier: manufacturerName, timestamp: finalTs,
        invoiceNumber: invoiceNo, unit: 'pcs', materialEntryId: entryId,
        remarks: line.autoAssign ? 'Auto-Assign — added to shared RM stock, not split to specific items' : undefined,
      });
      rmStockDelta[rm.id] = (rmStockDelta[rm.id] || 0) + line.quantityPcs;

      const sizeLabel = `${rm.size}x${rm.length}`;
      if (line.autoAssign) {
        perLineRemarks.push(`${sizeLabel} (${line.quantityPcs} bars received) — Auto-Assign, added to shared RM stock, not split to specific items.`);
        return;
      }

      const itemLengthById: Record<string, number> = {};
      const itemBreakdown: string[] = [];
      line.allotments.forEach(a => {
        const part = parts.find(p => p.id === a.partId);
        if (!part) return;
        itemLengthById[a.partId] = part.itemLength || 0;
        const pcs = line.subMode === 'whole_bars'
          ? (a.barsAllotted || 0) * pcsPerBar(line.barLengthMm, part.itemLength || 0)
          : (a.piecesAllotted || 0);
        if (pcs > 0) {
          newInwardLogs.push({
            id: Math.random().toString(36).substr(2, 9), partId: a.partId, partName: part.name,
            sapCode: part.sapCode, quantity: pcs, supplier: manufacturerName, timestamp: finalTs,
            invoiceNumber: invoiceNo, materialEntryId: entryId,
          });
          partStockDelta[a.partId] = (partStockDelta[a.partId] || 0) + pcs;
        }
        if (line.subMode === 'whole_bars' && (a.barsAllotted || 0) > 0) {
          itemBreakdown.push(`${part.name} — ${a.barsAllotted} bars`);
        } else if (line.subMode === 'split_pieces' && (a.piecesAllotted || 0) > 0) {
          itemBreakdown.push(`${part.name} — ${a.piecesAllotted} pcs`);
        }
      });

      if (line.subMode === 'split_pieces') {
        const typedForScrap: LongerPipeLine = {
          key: line.materialCode, rmId: line.rmId, barLengthMm: line.barLengthMm,
          barsReceived: line.quantityPcs, subMode: line.subMode, allotments: line.allotments, autoAssign: line.autoAssign,
        };
        totalScrapMm += computeUnattributedScrapMm(typedForScrap, itemLengthById);
      }

      perLineRemarks.push(`${sizeLabel} (${line.quantityPcs} bars received). Allotted: ${itemBreakdown.join('; ')}.`);
    });

    if (newInwardLogs.length > 0) setInwardLogs(prev => [...newInwardLogs, ...prev]);
    if (newRmInwardLogs.length > 0) setRmInwardLogs(prev => [...newRmInwardLogs, ...prev]);
    if (Object.keys(partStockDelta).length > 0) {
      setParts(prev => prev.map(p => partStockDelta[p.id] ? { ...p, stock: p.stock + partStockDelta[p.id], lastUpdated: finalTs } : p));
    }
    if (Object.keys(rmStockDelta).length > 0) {
      setRawMaterials(prev => prev.map(r => rmStockDelta[r.id] ? { ...r, stock: r.stock + rmStockDelta[r.id] } : r));
    }

    // 4. Alerts — same routine "invoice entered" + weight-mismatch alerts
    // submitMfgInvoice used to raise, plus the rm_inward (posted-to-stock)
    // and material_entry_scrap alerts handleMaterialEntryLongerPipe used to
    // raise separately — all in one call now that both used to be two.
    const totalQty = lines.reduce((sum, l) => sum + (l.quantityPcs || 0), 0);
    const totalBillValue = lines.reduce((sum, l) => sum + (l.itemValue || 0), 0);
    const totalBillValueFormatted = totalBillValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const aiSuffix = aiExtracted
      ? (lines.length > 1 ? ' — first line auto-filled from photo, please verify against the invoice' : ' — auto-filled from photo, please verify against the invoice')
      : ' — entered manually';
    const materialsSummary = lines.length === 1
      ? `${lines[0].materialName || 'material'} (${lines[0].materialCode || 'no code'})`
      : `${lines.length} materials: ${lines.map(l => `${l.materialCode || 'no code'} (${l.quantityPcs} Pcs)`).join(', ')}`;

    pushAdminAlert({
      type: 'rm_cross_bill',
      invoiceNumber: invoiceNo, customer: customerName, supplier: manufacturerName,
      quantity: totalQty, itemCount: lines.length,
      // Total Weight is the invoice's own printed figure; Dharamkanta is the
      // actual weighbridge reading for this vehicle — showing both here
      // matches the Finished Pieces / Longer Pipe notifications, which
      // already show both (Vipul, 14-Sep-26).
      remarks: `Manufacturer Invoice — ${materialsSummary} — Total Weight ${totalWeightKg} Kg (Dharamkanta ${actualWeightKg} Kg) — Total Bill Value ₹${totalBillValueFormatted}${aiSuffix}`,
    });

    if (weightFlagged) {
      pushAdminAlert({
        type: 'rm_weight_mismatch',
        invoiceNumber: invoiceNo, customer: customerName, supplier: manufacturerName,
        quantity: totalQty, itemCount: lines.length,
        remarks: `${materialsSummary} — Invoice billed ${totalWeightKg} Kg, Dharam Kanta actual ${actualWeightKg} Kg — ${weightVarianceKg > 0 ? 'received MORE than billed by' : 'received LESS than billed by'} ${Math.abs(weightVarianceKg).toFixed(1)} Kg. Review for a supplier debit note.`,
      });
    }

    pushAdminAlert({
      type: 'rm_inward', supplier: manufacturerName, invoiceNumber: invoiceNo,
      timestamp: finalTs, itemCount: lines.length,
      details: `Material Entry (from RM Cross-Bill invoice) — ${perLineRemarks.join(' | ')}`,
    });

    if (totalScrapMm > 0.0001) {
      pushAdminAlert({
        type: 'material_entry_scrap', supplier: manufacturerName, invoiceNumber: invoiceNo,
        timestamp: finalTs,
        details: `${totalScrapMm.toFixed(0)} mm unattributed leftover across Split-by-Pieces line(s) in this Manufacturer Invoice — not credited to any single item.`,
      });
    }
  }

  // --- RM Receiving Approval Gate ---
  // Store/PPC no longer post an RM receiving entry straight to inventory
  // from any of the 3 places above — they stage a PendingRMEntry instead.
  // None of the functions below touch parts/rawMaterials/InwardLog/
  // RMInwardLog/RMManufacturerInvoice — they only push a PendingRMEntry. The
  // real posting still happens in handleMaterialEntryFinishedPieces/
  // handleMaterialEntryLongerPipe/handleManufacturerInvoiceWithAllotment
  // above, called only from approvePendingRMEntry below once Admin approves.
  // NOTE: deliberately a hoisted `function` declaration, not `const ... = () =>`.
  // The production minifier (esbuild, via Vite) was found to incorrectly
  // dead-code-eliminate this exact binding when written as a const arrow
  // function inside this enormous component — every call site below survived
  // minification (renamed to a short variable name, e.g. "xn"), but the
  // declaration itself was silently dropped from the bundle, so calling it
  // threw "Uncaught ReferenceError: xn is not defined" the instant Store
  // clicked Post for Approval on ANY of the 3 entry screens. A hoisted
  // function declaration is unaffected by that bug. Do not change this back
  // to a const arrow function.
  function pushPendingRMEntry(entry: Omit<PendingRMEntry, 'id' | 'submittedAt' | 'submittedBy' | 'submittedByRole'>): PendingRMEntry {
    const newEntry: PendingRMEntry = {
      id: Math.random().toString(36).substr(2, 9),
      submittedAt: getLocalISOString(),
      submittedBy: appUser?.displayName || userName,
      submittedByRole: role,
      ...entry,
    };
    setPendingRMEntries(prev => [newEntry, ...prev]);
    return newEntry;
  }

  // --- Duplicate invoice detection (added 24-Sep-26) ---
  // Vipul's ask: if the same supplier+invoice number has already been
  // staged or booked before — today, or any number of days back — Store
  // (or Admin) must be stopped from posting it again, with a clear
  // "Duplicate Invoice — Already booked" message, and Admin gets a record
  // of the blocked attempt. Checked against `pendingRMEntries` — the one
  // collection every entry type (Finished Pieces, Longer Pipe, RM
  // Cross-Bill/Manufacturer Invoice) already lives in for its whole life,
  // 'pending' through 'approved' — so this single scan covers both
  // "already fully booked days ago" (status 'approved') and "someone else
  // already submitted this today, still awaiting Admin" (status
  // 'pending'/'not_matched') in one check. A 'rejected' entry is excluded
  // — Admin explicitly rejecting one clears the way for a genuine
  // resubmission. Independent of, and in addition to, the gate-photo-
  // intake dedup in services/apiHandlers.ts's handleGateUpload — that one
  // only ever sees WhatsApp-sourced photos before a PendingRMEntry even
  // exists; this one also catches a duplicate entered by hand via Camera
  // Upload / manual entry with no gate photo involved at all, and acts as
  // a backstop if a gate photo's invoice number was corrected by hand
  // after intake.
  // 26-Sep-26: same production-only esbuild dead-code-elimination bug as the
  // one documented on pushPendingRMEntry above — this was a `const ... = () =>`
  // arrow function, and the minifier silently dropped its declaration from
  // the bundle while still renaming every call site (e.g. to "Zs"), so Store
  // hit "Uncaught ReferenceError: Zs is not defined" the instant they clicked
  // Post for Approval on ANY of the 3 entry screens — all three call
  // findDuplicateBookedInvoice, which calls this first. Converted to a
  // hoisted `function` declaration, which is immune to that bug, exactly
  // like pushPendingRMEntry was. Do not change this back to a const arrow
  // function.
  function normalizeInvoiceKey(s: string): string {
    return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Fallback matching (added 24-Sep-26): Vipul hit a real case where a gate
  // person resent an A.S.T. Pipes invoice photo and the OCR read the invoice
  // number as blank the second time (it read fine the first time), so the
  // invoice-number match below never fired even though weight (10,000 Kg)
  // and bill value (₹7,08,050) were identical to the already-booked entry.
  // When the incoming invoiceNo can't be used, fall back to supplier + date
  // + weight + bill value together as a fingerprint of one physical
  // invoice — still requires an exact match on all three, so two genuinely
  // different blank-invoice-no. entries won't collide by coincidence.
  function findDuplicateBookedInvoice(supplierName: string, invoiceNo: string, date?: string, weightKg?: number, billValue?: number): PendingRMEntry | null {
    const cleanInvoiceNo = normalizeInvoiceKey(invoiceNo);
    const cleanSupplier = normalizeInvoiceKey(supplierName);
    if (!cleanSupplier) return null; // never dedupe on a blank/illegible supplier name
    if (!cleanInvoiceNo && !(date && weightKg && billValue)) return null; // nothing reliable to match on either way
    return pendingRMEntries.find(e => {
      if (e.status === 'rejected') return false;
      const supplier = e.finishedPiecesPayload?.header.supplierName ?? e.longerPipePayload?.header.supplierName ?? e.manufacturerInvoicePayload?.manufacturerName;
      if (normalizeInvoiceKey(supplier || '') !== cleanSupplier) return false;
      if (cleanInvoiceNo) {
        const invoiceNoOnEntry = e.finishedPiecesPayload?.header.invoiceNo ?? e.longerPipePayload?.header.invoiceNo ?? e.manufacturerInvoicePayload?.invoiceNo;
        return normalizeInvoiceKey(invoiceNoOnEntry || '') === cleanInvoiceNo;
      }
      const entryDate = e.finishedPiecesPayload?.header.date ?? e.longerPipePayload?.header.date ?? e.manufacturerInvoicePayload?.date;
      const entryWeight = e.finishedPiecesPayload?.header.totalWeightKg ?? e.longerPipePayload?.header.totalWeightKg ?? e.manufacturerInvoicePayload?.totalWeightKg;
      const entryValue = e.finishedPiecesPayload?.header.totalBillValue ?? e.longerPipePayload?.header.totalBillValue
        ?? (e.manufacturerInvoicePayload ? e.manufacturerInvoicePayload.lines.reduce((sum, l) => sum + (l.itemValue || 0), 0) : undefined);
      return entryDate === date
        && !!entryWeight && Math.round(entryWeight) === Math.round(weightKg!)
        && !!entryValue && Math.round(entryValue) === Math.round(billValue!);
    }) || null;
  }

  function pushDuplicateInvoiceAlert(supplier: string, invoiceNo: string, duplicate: PendingRMEntry) {
    pushAdminAlert({
      type: 'duplicate_invoice_blocked',
      supplier,
      invoiceNumber: invoiceNo,
      remarks: `Blocked — Invoice ${invoiceNo || '—'} from ${supplier} was already booked ("${duplicate.summary}", status: ${duplicate.status}). This resubmission was not posted.`,
    });
  }

  // Every stage function below now returns { entry } on success or
  // { error } when it refuses to create the entry — a duplicate, or (as
  // before) an empty line list. The error string is a user-facing message
  // meant to be shown right on the entry screen Store/Admin is looking at.
  function stageMaterialEntryFinishedPieces(header: MaterialEntryHeader, lines: FinishedPieceLine[], photo?: { base64: string; mimeType: string }, fromGateDocumentId?: string): { entry?: PendingRMEntry; error?: string } {
    if (lines.length === 0) return {};
    const duplicate = findDuplicateBookedInvoice(header.supplierName, header.invoiceNo, header.date, header.totalWeightKg, header.totalBillValue);
    if (duplicate) {
      pushDuplicateInvoiceAlert(header.supplierName, header.invoiceNo, duplicate);
      return { error: `Duplicate Invoice — Already booked (${duplicate.summary}).` };
    }
    const partNames = lines.map(l => { const p = parts.find(x => x.id === l.partId); return `${p?.name || l.partId} (${l.quantity} Pcs)`; });
    const entry = pushPendingRMEntry({ entryType: 'finished_pieces', status: 'pending', finishedPiecesPayload: { header, lines }, summary: `Finished Pieces — ${header.supplierName} — ${partNames.join(', ')}`, photoImageBase64: photo?.base64, photoMimeType: photo?.mimeType, fromGateDocumentId });
    return { entry };
  }

  function stageMaterialEntryLongerPipe(header: MaterialEntryHeader, lines: LongerPipeLine[], photo?: { base64: string; mimeType: string }, fromGateDocumentId?: string): { entry?: PendingRMEntry; error?: string } {
    if (lines.length === 0) return {};
    const duplicate = findDuplicateBookedInvoice(header.supplierName, header.invoiceNo, header.date, header.totalWeightKg, header.totalBillValue);
    if (duplicate) {
      pushDuplicateInvoiceAlert(header.supplierName, header.invoiceNo, duplicate);
      return { error: `Duplicate Invoice — Already booked (${duplicate.summary}).` };
    }
    const lineSummaries = lines.map(l => { const rm = rawMaterials.find(r => r.id === l.rmId); return `${rm ? rm.size : 'RM'} (${l.barsReceived} bars)`; });
    const entry = pushPendingRMEntry({ entryType: 'longer_pipe', status: 'pending', longerPipePayload: { header, lines }, summary: `Longer Pipe — ${header.supplierName} — ${lineSummaries.join(', ')}`, photoImageBase64: photo?.base64, photoMimeType: photo?.mimeType, fromGateDocumentId });
    return { entry };
  }

  function stageManufacturerInvoiceWithAllotment(submission: MfgInvoiceSubmission, photo?: { base64: string; mimeType: string }, fromGateDocumentId?: string): { entry?: PendingRMEntry; error?: string } {
    if (submission.lines.length === 0) return {};
    const submissionBillValue = submission.lines.reduce((sum, l) => sum + (l.itemValue || 0), 0);
    const duplicate = findDuplicateBookedInvoice(submission.manufacturerName, submission.invoiceNo, submission.date, submission.totalWeightKg, submissionBillValue);
    if (duplicate) {
      pushDuplicateInvoiceAlert(submission.manufacturerName, submission.invoiceNo, duplicate);
      return { error: `Duplicate Invoice — Already booked (${duplicate.summary}).` };
    }
    const unresolvedLines = submission.lines.filter(l => !l.rmId);
    const isNotMatched = unresolvedLines.length > 0;
    const materialsSummary = submission.lines.map(l => `${l.materialCode || l.materialName || 'material'} (${l.quantityPcs} Pcs)`).join(', ');
    const entry = pushPendingRMEntry({
      entryType: 'manufacturer_invoice', status: isNotMatched ? 'not_matched' : 'pending',
      manufacturerInvoicePayload: submission,
      summary: `Manufacturer Invoice — ${submission.manufacturerName} — ${submission.invoiceNo} — ${materialsSummary}`,
      notMatchedReason: isNotMatched ? `${unresolvedLines.length} material(s) have no linked Raw Material yet: ${unresolvedLines.map(l => l.materialCode || l.materialName).join(', ')}. Admin must specify which RM Master size to book against before this can be approved.` : undefined,
      photoImageBase64: photo?.base64,
      photoMimeType: photo?.mimeType,
      fromGateDocumentId,
    });
    return { entry };
  }

  // --- Gate Documents for Approval hand-off ---
  // Fired once the matching entry screen (Material Entry or RM Cross-Bill
  // Check's Manufacturer Invoice wizard) actually submits — the staging
  // call above already created `newEntry`. From here: the photo(s) move
  // from the gate document onto the entry itself as base64 — NOT archived
  // to Dropbox yet. Corrected 24-Sep-26: archiving here (at Post for
  // Approval) meant the photo was already gone by the time Admin opened RM
  // Approvals to review Store's submission — only the Dropbox path text
  // ever showed up there, never the actual photo. Now the base64 rides on
  // the PendingRMEntry while it's pending, and App.tsx's
  // approvePendingRMEntry is the only place that archives it (once Admin
  // actually approves) — see that function's own comment. Mark the gate
  // document 'consumed' and clear its own copy of the photo (ownership
  // moves to the entry), and — only when the person doing this is Admin —
  // immediately approve the staged entry too, reusing approvePendingRMEntry
  // (and therefore the exact same validated posting handlers AND archival
  // logic) rather than any separate code path, per this app's existing
  // "approve exactly once, only through this one function" invariant. For
  // Store, the entry simply stays 'pending' in the normal RM Approvals
  // queue like any other entry, photo and all.
  async function finalizeGateDocument(gateDoc: GateDocumentForApproval, newEntry: PendingRMEntry) {
    const entryWithPhotos: PendingRMEntry = {
      ...newEntry,
      photoImageBase64: gateDoc.imageBase64 || undefined,
      photoMimeType: gateDoc.mimeType || undefined,
      slipPhotoImageBase64: gateDoc.slipImageBase64 || undefined,
      slipPhotoMimeType: gateDoc.slipMimeType || undefined,
    };
    setGateDocuments(prev => prev.map(d => (d.id === gateDoc.id ? { ...d, status: 'consumed', imageBase64: '', slipImageBase64: '', linkedPendingRMEntryId: newEntry.id } : d)));
    updatePendingRMEntry(newEntry.id, e => ({
      ...e,
      photoImageBase64: entryWithPhotos.photoImageBase64,
      photoMimeType: entryWithPhotos.photoMimeType,
      slipPhotoImageBase64: entryWithPhotos.slipPhotoImageBase64,
      slipPhotoMimeType: entryWithPhotos.slipPhotoMimeType,
    }));
    if (isAdmin) {
      await approvePendingRMEntry(entryWithPhotos);
    }
    setGateDocInProgress(null);
  }

  // Store or Admin manually attaches a dharamkanta slip photo directly
  // in-app (upload path) for a pending gate entry — vehicle-number
  // auto-match failed or hasn't happened yet. Runs the same Gemini
  // extraction the WhatsApp path uses server-side, but client-side isn't an
  // option here (no bot.js involved), so this reuses the existing
  // extractMaterialEntryFields-style endpoint pattern via a direct call —
  // see handleAttachSlipFromUnmatched below for the no-extraction pick path.
  async function handleAttachSlipUpload(gateDoc: GateDocumentForApproval, imageBase64: string, mimeType: string, extracted: { vehicleNo: string; netWeightKg: number; slipDate: string }) {
    const now = getLocalISOString();
    setGateDocuments(prev => prev.map(d => (d.id === gateDoc.id ? {
      ...d,
      slipStatus: 'attached',
      slipImageBase64: imageBase64,
      slipMimeType: mimeType,
      slipExtracted: extracted,
      slipAttachedVia: 'manual_upload',
      slipAttachedBy: appUser?.displayName || userName,
      slipAttachedAt: now,
    } : d)));
  }

  // Store or Admin picks a WhatsApp-ingested slip that arrived but wasn't
  // auto-matched (the "Both (Recommended)" fallback Vipul chose) — moves
  // its fields onto the target gate doc and marks the unmatched slip
  // consumed, same shape as the server's own auto-match write.
  function handleAttachSlipFromUnmatched(gateDoc: GateDocumentForApproval, slip: UnmatchedDharamkantaSlip) {
    const now = getLocalISOString();
    const by = appUser?.displayName || userName;
    setGateDocuments(prev => prev.map(d => (d.id === gateDoc.id ? {
      ...d,
      slipStatus: 'attached',
      slipImageBase64: slip.imageBase64,
      slipMimeType: slip.mimeType,
      slipExtracted: slip.extracted,
      slipAttachedVia: 'manual_pick',
      slipAttachedBy: by,
      slipAttachedAt: now,
    } : d)));
    setUnmatchedDharamkantaSlips(prev => prev.map(s => (s.id === slip.id ? { ...s, status: 'attached', imageBase64: '', attachedToGateDocId: gateDoc.id, attachedBy: by, attachedAt: now } : s)));
  }

  // Admin-only, 25-Sep-26: unmatched dharamkanta slips have no expiry or
  // cleanup of any kind — one that never gets picked (wrong photo, an
  // invoice that ended up not needing a slip attach, etc.) sits in
  // Firestore with its full image forever. This is the manual prune Admin
  // asked for, from the new "View Unmatched Photos" list in
  // GateDocumentsQueue. Filtering the slip out of the array and handing it
  // to setUnmatchedDharamkantaSlips is enough — useFirestoreArray (see its
  // own comment) diffs this against the previous array and issues a real
  // Firestore delete for whatever id disappears, same as every other
  // delete in this app; no separate Firestore call needed here.
  function handleDeleteUnmatchedSlip(slip: UnmatchedDharamkantaSlip) {
    setUnmatchedDharamkantaSlips(prev => prev.filter(s => s.id !== slip.id));
  }

  // Store (or Admin) picked a mode on a Gate Documents for Approval card —
  // mark it 'in_progress' (so it's visibly claimed, not silently vanished)
  // and open the matching screen via gateDocInProgress; the Inventory /
  // RMCrossBillCheck render blocks below react to that state.
  function pickGateDocumentMode(gateDoc: GateDocumentForApproval, mode: PendingRMEntryType) {
    // Both photos must be in before the entry can move forward — per
    // Vipul's explicit call: "store can only post gate entry once both the
    // documents lands in system". Absent slipStatus (docs created before
    // this feature shipped) is treated exactly like 'awaiting'.
    if ((gateDoc.slipStatus || 'awaiting') !== 'attached') return;
    setGateDocuments(prev => prev.map(d => (d.id === gateDoc.id ? { ...d, status: 'in_progress', pickedEntryType: mode, pickedAt: getLocalISOString(), pickedBy: appUser?.displayName || userName } : d)));
    setGateDocInProgress({ doc: gateDoc, mode });
    setCurrentView(mode === 'manufacturer_invoice' ? 'rm_crossbill' : 'inventory');
  }

  // Store/Admin closed the entry screen (Cancel / ✕) without submitting —
  // put the card back to 'pending' instead of leaving it stuck 'in_progress'
  // with nobody working it.
  function cancelGateDocumentInProgress() {
    if (!gateDocInProgress) return;
    const { doc: gateDoc } = gateDocInProgress;
    setGateDocuments(prev => prev.map(d => (d.id === gateDoc.id ? { ...d, status: 'pending', pickedEntryType: undefined, pickedAt: undefined, pickedBy: undefined } : d)));
    setGateDocInProgress(null);
  }

  // Admin-only "unstick" action from GateDocumentsQueue itself — for when
  // whoever picked a card closed their browser/tab instead of Cancel/Post
  // for Approval, leaving it 'in_progress' with no screen actually open.
  function resetGateDocumentInProgress(gateDoc: GateDocumentForApproval) {
    setGateDocuments(prev => prev.map(d => (d.id === gateDoc.id ? { ...d, status: 'pending', pickedEntryType: undefined, pickedAt: undefined, pickedBy: undefined } : d)));
    if (gateDocInProgress?.doc.id === gateDoc.id) setGateDocInProgress(null);
  }

  // Admin-only reject — 24-Sep-26, Vipul's ask: for a gate-photo entry that
  // should never be posted (his example: the gate guard resent the exact
  // same invoice photo a second time, creating a genuine duplicate entry
  // still sitting in Gate Documents for Approval). Same "never silently
  // dropped" archive-before-clearing rule as every other photo-lifecycle
  // step in this pipeline — both photos (if present) go to Dropbox's
  // "Unit 2/Rejected" folder, tagged "-rejected"/"-rejected-slip", before
  // being cleared. The doc itself is kept (status 'rejected', never
  // deleted) as the audit record of what was rejected, by whom, and why —
  // GateDocumentsQueue's `active` filter already only shows
  // 'pending'/'in_progress', so a rejected doc simply stops appearing
  // there, same as a 'consumed' one does.
  async function handleRejectGateDocument(gateDoc: GateDocumentForApproval, reason: string) {
    const ex = gateDoc.extracted;
    const baseFileName = buildArchiveFileName(gateDoc.matchedSupplier, ex.invoiceNo, ex.date);
    const monthFolder = buildArchiveMonthFolder(ex.date);
    if (gateDoc.imageBase64 && gateDoc.mimeType) {
      await archivePhotoToDropbox(gateDoc.imageBase64, gateDoc.mimeType, `${baseFileName}-rejected`, monthFolder, 'rejected');
    }
    if (gateDoc.slipImageBase64 && gateDoc.slipMimeType) {
      await archivePhotoToDropbox(gateDoc.slipImageBase64, gateDoc.slipMimeType, `${baseFileName}-rejected-slip`, monthFolder, 'rejected');
    }
    setGateDocuments(prev => prev.map(d => (d.id === gateDoc.id ? {
      ...d,
      status: 'rejected',
      imageBase64: '',
      slipImageBase64: '',
      rejectedAt: getLocalISOString(),
      rejectedBy: appUser?.displayName || userName,
      rejectReason: reason || '',
    } : d)));
    if (gateDocInProgress?.doc.id === gateDoc.id) setGateDocInProgress(null);
  }

  // The only place any of the entryType posting handlers above ever runs —
  // see the "approve exactly once, only through this one function"
  // invariant. Also, as of 24-Sep-26, the ONLY place a pending photo
  // (invoice and/or dharamkanta slip, held as base64 purely so Admin can
  // actually see it while reviewing — see PendingRMEntry.photoImageBase64
  // in types.ts) gets archived to Dropbox. Applies uniformly whether the
  // entry came from a WhatsApp gate photo (finalizeGateDocument transfers
  // the base64 here) or a direct Store/PPC Camera Upload (MaterialEntry.tsx
  // / RMCrossBillCheck.tsx capture it client-side and hand it straight to
  // the relevant stageXXX function above) — neither path archives anything
  // itself anymore, so the photo genuinely stays visible in-app through
  // Admin's whole review and only goes Dropbox-only once actually approved.
  async function approvePendingRMEntry(entry: PendingRMEntry) {
    // See approvingEntryIdsRef's own comment above — this must be the very
    // first thing that runs, synchronously, before any `await` or early
    // return, so a second call for the same entry.id (fired while the first
    // is still archiving/posting) bails out here instead of re-running the
    // whole approval a second time.
    if (approvingEntryIdsRef.current.has(entry.id)) return;
    approvingEntryIdsRef.current.add(entry.id);
    try {
      await approvePendingRMEntryInner(entry);
    } finally {
      approvingEntryIdsRef.current.delete(entry.id);
    }
  }

  async function approvePendingRMEntryInner(entry: PendingRMEntry) {
    if (entry.entryType === 'longer_pipe' && entry.longerPipePayload?.lines.some(l => !l.rmId)) return;
    if (entry.entryType === 'manufacturer_invoice' && entry.manufacturerInvoicePayload?.lines.some(l => !l.rmId)) return;
    if (
      entry.entryType !== 'finished_pieces' && entry.entryType !== 'longer_pipe' &&
      entry.entryType !== 'manufacturer_invoice' && entry.entryType !== 'inventory_correction'
    ) return;

    // Supplier/invoice/date context for the archive filename — whichever of
    // the 3 possible payloads this entry actually carries. Inventory
    // Correction never carries a photo (no camera-upload intake for it).
    const archiveCtx =
      entry.finishedPiecesPayload ? { supplier: entry.finishedPiecesPayload.header.supplierName, invoiceNo: entry.finishedPiecesPayload.header.invoiceNo, date: entry.finishedPiecesPayload.header.date } :
      entry.longerPipePayload ? { supplier: entry.longerPipePayload.header.supplierName, invoiceNo: entry.longerPipePayload.header.invoiceNo, date: entry.longerPipePayload.header.date } :
      entry.manufacturerInvoicePayload ? { supplier: entry.manufacturerInvoicePayload.manufacturerName, invoiceNo: entry.manufacturerInvoicePayload.invoiceNo, date: entry.manufacturerInvoicePayload.date } :
      null;

    let archivedPath: string | undefined;
    if (entry.photoImageBase64 && entry.photoMimeType && archiveCtx) {
      archivedPath = (await archivePhotoToDropbox(
        entry.photoImageBase64, entry.photoMimeType,
        buildArchiveFileName(archiveCtx.supplier, archiveCtx.invoiceNo, archiveCtx.date),
        buildArchiveMonthFolder(archiveCtx.date)
      )) || undefined;
    }
    let slipArchivedPath: string | undefined;
    if (entry.slipPhotoImageBase64 && entry.slipPhotoMimeType && archiveCtx) {
      // Same base name as the invoice photo above (Supplier_InvoiceNo_Date),
      // just with a trailing "_2" — Vipul's 24-Sep ask, so the two files sit
      // together in Dropbox as an obvious pair/series (e.g.
      // "Tube Investments of India Limited_TII-2456_24.09.26.jpg" and
      // "..._24.09.26_2.jpg") rather than the slip getting a differently-
      // shaped name. The trailing "_2" alone is enough to keep the slip's
      // path distinct from the invoice's even when invoiceNo is blank on
      // both (both would fall back to "...Pending_<Date>[.jpg / _2.jpg]") —
      // no separate entry.id fallback needed any more.
      slipArchivedPath = (await archivePhotoToDropbox(
        entry.slipPhotoImageBase64, entry.slipPhotoMimeType,
        `${buildArchiveFileName(archiveCtx.supplier, archiveCtx.invoiceNo, archiveCtx.date)}_2`,
        buildArchiveMonthFolder(archiveCtx.date)
      )) || undefined;
    }

    if (entry.entryType === 'finished_pieces' && entry.finishedPiecesPayload) {
      handleMaterialEntryFinishedPieces(entry.finishedPiecesPayload.header, entry.finishedPiecesPayload.lines as FinishedPieceLine[]);
    } else if (entry.entryType === 'longer_pipe' && entry.longerPipePayload) {
      handleMaterialEntryLongerPipe(entry.longerPipePayload.header, entry.longerPipePayload.lines as LongerPipeLine[]);
    } else if (entry.entryType === 'manufacturer_invoice' && entry.manufacturerInvoicePayload) {
      handleManufacturerInvoiceWithAllotment(entry.manufacturerInvoicePayload as MfgInvoiceSubmission);
    } else if (entry.entryType === 'inventory_correction' && entry.inventoryCorrectionPayload) {
      handleInventoryCorrection(entry.inventoryCorrectionPayload, entry.submittedBy, entry.submittedByRole);
    } else { return; }

    setPendingRMEntries(prev => prev.map(e => e.id === entry.id ? {
      ...e,
      status: 'approved',
      reviewedAt: getLocalISOString(),
      reviewedBy: appUser?.displayName || userName,
      photoDropboxPath: archivedPath || e.photoDropboxPath,
      slipPhotoDropboxPath: slipArchivedPath || e.slipPhotoDropboxPath,
      photoImageBase64: '',
      photoMimeType: '',
      slipPhotoImageBase64: '',
      slipPhotoMimeType: '',
    } : e));
  }

  function updatePendingRMEntry(id: string, updater: (e: PendingRMEntry) => PendingRMEntry) {
    setPendingRMEntries(prev => prev.map(e => e.id === id ? updater(e) : e));
  }

  function rejectPendingRMEntry(id: string, reason: string) {
    setPendingRMEntries(prev => prev.map(e => e.id === id ? { ...e, status: 'rejected', reviewedAt: getLocalISOString(), reviewedBy: appUser?.displayName || userName, rejectionReason: reason } : e));
  }

  // Bulk Item Master upload (Admin only, see components/BulkItemImport.tsx).
  // Writes in chunks of <=450 new parts per setParts() call rather than one
  // call for the whole upload — useFirestoreArray's setData() commits one
  // Firestore writeBatch per call (hooks/useFirestoreArray.ts), and Firestore
  // batches hard-cap at 500 operations; a single-shot >500-row upload would
  // silently fail that commit (a rejected batch is only console.error'd, no
  // user-facing error surfaces). Yielding via setTimeout between chunks lets
  // the hook's internal `dataRef` catch up before the next chunk reads
  // `prev`, so no chunk's new rows get clobbered by an earlier chunk's
  // stale snapshot.
  async function handleBulkAddParts(newPartsData: Partial<Part>[]) {
    if (newPartsData.length === 0) return;
    const CHUNK_SIZE = 450;
    const built: Part[] = newPartsData.map(p => ({
      ...p,
      id: Math.random().toString(36).substr(2, 9),
      stock: 0,
      inward: 0,
      revisionCount: 0,
      lastUpdated: new Date().toISOString(),
      status: 'Out of Stock',
      schedules: {},
      scheduleRevisions: {},
    } as Part));

    for (let i = 0; i < built.length; i += CHUNK_SIZE) {
      const chunk = built.slice(i, i + CHUNK_SIZE);
      setParts(prev => [...prev, ...chunk]);
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Bulk Customer Schedule upload (Admin only, see
  // components/BulkScheduleImport.tsx). A part can appear in multiple
  // customer sheets in one upload, so updates are grouped by partId first —
  // one setParts() pass touching every affected part once, each bump of
  // revisionCount matching the existing single-schedule edit path above
  // (ScheduleManager's onUpdateSchedule) for a consistent audit trail.
  function handleBulkUpdateSchedules(updates: { partId: string; customerName: string; qty: number }[]) {
    if (updates.length === 0) return;
    const byPart = new Map<string, { customerName: string; qty: number }[]>();
    updates.forEach(u => {
      if (!byPart.has(u.partId)) byPart.set(u.partId, []);
      byPart.get(u.partId)!.push({ customerName: u.customerName, qty: u.qty });
    });

    setParts(prev => prev.map(p => {
      const changes = byPart.get(p.id);
      if (!changes) return p;
      const nextSchedules = { ...p.schedules };
      const nextRevisions = { ...p.scheduleRevisions };
      let changed = false;
      changes.forEach(c => {
        const priorVal = nextSchedules[c.customerName] || 0;
        if (priorVal !== c.qty) {
          nextSchedules[c.customerName] = c.qty;
          // Same first-entry-vs-revision rule as the single-schedule edit
          // path above: a customer with no prior (or zero) commitment is
          // getting set for the first time this cycle — Revision 0 — not a
          // revision of something that didn't exist yet.
          const priorRevision = nextRevisions[c.customerName] ?? 0;
          nextRevisions[c.customerName] = priorVal === 0 ? 0 : priorRevision + 1;
          changed = true;
        }
      });
      if (!changed) return p;
      return { ...p, schedules: nextSchedules, scheduleRevisions: nextRevisions, revisionCount: p.revisionCount + 1 };
    }));
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
