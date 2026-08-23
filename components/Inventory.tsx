import React, { useState, useMemo, useEffect } from 'react';
import { Part, Sale, InwardLog, RawMaterial, RMInwardLog, Customer, AdminAlert } from '../types';
import { CATEGORIES } from '../constants';

const getCustomerSchedule = (p: Part, customerName: string) => {
  if (!p.schedules) return 0;
  const key = Object.keys(p.schedules).find(k => k.toUpperCase().trim() === customerName.toUpperCase().trim());
  return key ? p.schedules[key] || 0 : 0;
};

interface InventoryProps {
  parts: Part[];
  sales: Sale[];
  inwardLogs: InwardLog[];
  onAddInward: (partId: string, quantity: number, supplier: string, remarks?: string, timestamp?: string, invoiceNumber?: string) => void;
  readOnly?: boolean;
  isHistorical?: boolean;
  selectedDate: Date;
  selectedDateDisplay?: string;
  isAdmin?: boolean;
  rawMaterials?: RawMaterial[];
  rmInwardLogs?: RMInwardLog[];
  customers?: Customer[];
  onAddRMInward?: (rmId: string, quantity: number, supplier: string, remarks?: string, timestamp?: string, invoiceNumber?: string) => void;
  localRMOpeningBalances?: Record<string, string>;
  setLocalRMOpeningBalances?: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  localPartOpeningBalances?: Record<string, string>;
  setLocalPartOpeningBalances?: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setRawMaterials?: (update: RawMaterial[] | ((prev: RawMaterial[]) => RawMaterial[])) => void;
  setParts?: (update: Part[] | ((prev: Part[]) => Part[])) => void;
  // Pushes an entry into the Admin-only Notifications feed. Fired for every
  // negative-quantity Discrepancy Control Entry (Item or RM) and for every
  // RM Inward entry, so Admin can cross-check who entered what.
  onCreateAlert?: (alert: Partial<AdminAlert> & Pick<AdminAlert, 'type'>) => void;
}

// An inwardLogs entry tagged this way is a SYNTHETIC quantity delta injected
// purely to nudge a stored Opening Balance during an audit correction —
// never a real physical receipt. Excluded from "how much actually came in
// this month" totals so an audit correction is never double-counted as if
// goods had arrived. (Legacy entries only — the current Opening Balance
// audit flow no longer writes these at all; see commitOpeningBalance below.)
const isAuditDeltaRemark = (remarks?: string) =>
  !!remarks && (remarks.startsWith('[OPENING_BALANCE_SET:') || remarks.startsWith('[RM_OPENING_BALANCE_SET:') || remarks === '[OPENING_BALANCE_ADJUSTMENT]');

const Inventory: React.FC<InventoryProps> = ({ 
  parts, 
  sales, 
  inwardLogs,
  onAddInward, 
  readOnly = false, 
  isHistorical = false,
  selectedDate,
  selectedDateDisplay = '',
  isAdmin = false,
  rawMaterials = [],
  rmInwardLogs = [],
  customers = [],
  onAddRMInward,
  localRMOpeningBalances: propRMOpeningBalances,
  setLocalRMOpeningBalances: propSetRMOpeningBalances,
  localPartOpeningBalances: propPartOpeningBalances,
  setLocalPartOpeningBalances: propSetPartOpeningBalances,
  setRawMaterials,
  setParts,
  onCreateAlert,
}) => {
  // Dropdown 1: Inventory Mode (Item Inventory vs RM Inventory)
  const [inventoryMode, setInventoryMode] = useState<'item' | 'rm'>('item');
  // Dropdown 2: Customer Filter
  const [selectedCustomer, setSelectedCustomer] = useState<string>('All');
  // Dropdown 3: Visual Layout Template
  const [layoutTemplate, setLayoutTemplate] = useState<'detailed' | 'compact' | 'cards'>('detailed');

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  // --- Admin RM reorder mode ---
  const [rmReorderMode, setRmReorderMode] = useState(false);
  const [rmDraftOrder, setRmDraftOrder] = useState<RawMaterial[]>([]);

  const enterRmReorderMode = () => {
    const sorted = [...rawMaterials].sort((a, b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999));
    setRmDraftOrder(sorted);
    setRmReorderMode(true);
  };

  const moveRmDraftItem = (index: number, direction: -1 | 1) => {
    setRmDraftOrder((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const saveRmOrder = () => {
    if (!setRawMaterials) return;
    const withOrder = rmDraftOrder.map((rm, i) => ({ ...rm, sortOrder: i }));
    setRawMaterials((prev) => prev.map((rm) => {
      const updated = withOrder.find((w) => w.id === rm.id);
      return updated ? updated : rm;
    }));
    setRmReorderMode(false);
  };
  
  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  
  // Selection
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [selectedRM, setSelectedRM] = useState<RawMaterial | null>(null);
  
  // Controlled states for Material Entry
  const [addQty, setAddQty] = useState<string>(''); 
  const [supplier, setSupplier] = useState('');
  const [remarks, setRemarks] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');

  // Local state to track changes in opening balances before saving
  const [localOpeningBalances, setLocalOpeningBalances] = useState<Record<string, string>>({});
  const [internalRMOpeningBalances, setInternalRMOpeningBalances] = useState<Record<string, string>>(() => {
    return JSON.parse(localStorage.getItem('autopart_local_rm_opening_balances') || '{}');
  });

  const localRMOpeningBalances = propRMOpeningBalances || internalRMOpeningBalances;
  const setLocalRMOpeningBalances = propSetRMOpeningBalances || setInternalRMOpeningBalances;

  useEffect(() => {
    if (!propRMOpeningBalances) {
      localStorage.setItem('autopart_local_rm_opening_balances', JSON.stringify(internalRMOpeningBalances));
    }
  }, [internalRMOpeningBalances, propRMOpeningBalances]);

  // Item-wise (Part) Opening Balances — stored, month-anchored values
  // (see resolvedPartOpeningBalances in App.tsx). No localStorage fallback
  // needed here since this is always Firestore-backed via props in the
  // live app; the internal state is just a safety net if the prop is ever
  // absent (e.g. isolated testing).
  const [internalPartOpeningBalances, setInternalPartOpeningBalances] = useState<Record<string, string>>({});
  const localPartOpeningBalances = propPartOpeningBalances || internalPartOpeningBalances;
  const setLocalPartOpeningBalances = propSetPartOpeningBalances || setInternalPartOpeningBalances;

  // Header Date Strings
  const headerDates = useMemo(() => {
    const firstDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    const format = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '.');
    const monthYear = selectedDate.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    return {
      opening: format(firstDay),
      closing: format(selectedDate),
      monthYear: monthYear
    };
  }, [selectedDate]);

  const formattedToday = useMemo(() => {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yy = String(today.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
  }, []);

  const formattedNextMonth = useMemo(() => {
    const nextMonthDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1);
    const month = nextMonthDate.toLocaleDateString('en-GB', { month: 'long' });
    const year = nextMonthDate.toLocaleDateString('en-GB', { year: '2-digit' });
    return `${month} ${year}`;
  }, [selectedDate]);

  // Selected Part's converted Raw Material Equivalents (for confirmation modal)
  const selectedPartRMInfo = useMemo(() => {
    if (inventoryMode !== 'item' || !selectedPart) return [];
    
    const qtyValue = parseFloat(addQty) || 0;
    if (qtyValue === 0) return [];

    return (rawMaterials || []).filter(rm => {
      return (selectedPart.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === selectedPart.id) || (rm.partIds && rm.partIds.includes(selectedPart.id));
    }).map(rm => {
      const rmLength = rm.length || 6000;
      const partLength = selectedPart.itemLength || 0;
      let yieldFactor = 0;
      if (partLength > 0) {
        yieldFactor = Math.floor(rmLength / partLength);
      } else {
        const rmWeight = rmLength * (rm.weightPer1000 / 1000);
        const partWeight = selectedPart.itemWeight || 0;
        if (partWeight > 0 && rmWeight > 0) {
          yieldFactor = Math.floor(rmWeight / partWeight);
        }
      }

      const pipesQty = yieldFactor > 0 ? parseFloat((qtyValue / yieldFactor).toFixed(2)) : 0;
      const pipeWeight = (rmLength * (rm.weightPer1000 || 0)) / 1000;
      const kgQty = parseFloat((pipesQty * pipeWeight).toFixed(2));

      return {
        rmSize: rm.size,
        pipesQty,
        kgQty,
        yieldFactor,
        customerName: rm.customerName
      };
    });
  }, [inventoryMode, selectedPart, addQty, rawMaterials]);

  // Combined Filters for Item Inventory
  const filteredParts = useMemo(() => {
    return parts.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            p.sapCode.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = selectedCategory === 'All' || p.category === selectedCategory;
      const matchesCustomer = selectedCustomer === 'All' || p.mappedCustomers?.some(c => c.toUpperCase().trim() === selectedCustomer.toUpperCase().trim());
      return matchesSearch && matchesCategory && matchesCustomer;
    });
  }, [parts, searchTerm, selectedCategory, selectedCustomer]);

  // Combined Filters for RM Inventory
  const filteredRawMaterials = useMemo(() => {
    const sorted = [...rawMaterials].sort((a, b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999));
    return sorted.filter(rm => {
      const matchesSearch = rm.size.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            rm.partName.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCustomer = selectedCustomer === 'All' || rm.customerName.toUpperCase().trim() === selectedCustomer.toUpperCase().trim();
      return matchesSearch && matchesCustomer;
    });
  }, [rawMaterials, searchTerm, selectedCustomer]);



  const handlePreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    
    const qty = parseInt(addQty);
    if ((inventoryMode === 'item' && !selectedPart) || (inventoryMode === 'rm' && !selectedRM) || isNaN(qty) || qty === 0 || !supplier.trim()) return;
    
    // Mandatory remarks for negative adjustments
    if (qty < 0 && !remarks.trim()) {
      alert("Remarks are required for stock adjustments (negative values).");
      return;
    }
    
    setShowConfirmModal(true);
  };

  const handleFinalConfirm = () => {
    if (readOnly) return;

    if (inventoryMode === 'item' && selectedPart) {
      const qty = parseInt(addQty);
      onAddInward(selectedPart.id, qty, supplier.trim(), qty < 0 ? remarks.trim() : undefined, undefined, invoiceNumber.trim() || undefined);
      // Discrepancy Control Entry (negative value) — alert Admin with full
      // detail so they can cross-check/cross-question it. Positive Item
      // Material Entries are routine and do not alert.
      if (qty < 0 && onCreateAlert) {
        onCreateAlert({
          type: 'discrepancy',
          partId: selectedPart.id,
          partName: selectedPart.name,
          sapCode: selectedPart.sapCode,
          quantity: qty,
          remarks: remarks.trim(),
          responsibleName: supplier.trim(),
        });
      }
    } else if (inventoryMode === 'rm' && selectedRM && onAddRMInward) {
      const qty = parseInt(addQty);
      onAddRMInward(selectedRM.id, qty, supplier.trim(), qty < 0 ? remarks.trim() : undefined, undefined, invoiceNumber.trim() || undefined);
      if (onCreateAlert) {
        if (qty < 0) {
          // Discrepancy Control Entry (negative value) on the RM side.
          onCreateAlert({
            type: 'discrepancy',
            rmId: selectedRM.id,
            rmSize: selectedRM.size,
            quantity: qty,
            remarks: remarks.trim(),
            responsibleName: supplier.trim(),
          });
        } else {
          // Every RM Inward entry — regardless of role — is logged for Admin.
          onCreateAlert({
            type: 'rm_inward',
            rmId: selectedRM.id,
            rmSize: selectedRM.size,
            quantity: qty,
            supplier: supplier.trim(),
            invoiceNumber: invoiceNumber.trim() || undefined,
          });
        }
      }
    }

    setShowConfirmModal(false);
    setShowAddModal(false);
    setSelectedPart(null);
    setSelectedRM(null);
    setAddQty('');
    setSupplier('');
    setRemarks('');
    setInvoiceNumber('');
  };

  // Item-wise Opening Balance is now a STORED, month-anchored value — the
  // same mechanism as commitRMOpeningBalance below, not a synthetic
  // inwardLogs entry. Locking a value here writes a month-keyed override
  // into localPartOpeningBalances; App.tsx's resolvedPartOpeningBalances
  // then carries it forward automatically to later months until it's
  // audited again. This deliberately does NOT call onAddInward — the old
  // design hid the override inside an inwardLogs entry's remarks text,
  // which meant a legacy-data restore could silently reintroduce a stale
  // one and corrupt the current month's Opening Balance.
  const commitOpeningBalance = (partId: string, currentOpening: number) => {
    const newValStr = localOpeningBalances[partId];
    if (newValStr === undefined) return;

    const newVal = parseInt(newValStr);
    if (isNaN(newVal)) return;

    const delta = newVal - currentOpening;
    if (delta === 0) {
        const next = {...localOpeningBalances};
        delete next[partId];
        setLocalOpeningBalances(next);
        return;
    };

    const mK = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}`;
    const overrideKey = `${mK}_${partId}`;
    const part = parts.find(p => p.id === partId);
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    const monthDisplay = selectedDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

    if (window.confirm(`Audit Action: Adjust Item Opening Balance for ${monthDisplay}?\n\nItem: ${part?.name || 'Item'}\nTarget Balance: ${newVal} Pcs\nPrevious Balance: ${currentOpening} Pcs\nCorrection: ${deltaStr} Pcs\n\nThis locks Opening Balance at ${newVal} Pcs for ${monthDisplay}. It will carry forward automatically to future months unless audited again.`)) {
      if (propSetPartOpeningBalances) {
        propSetPartOpeningBalances(prev => {
          const updated = { ...prev, [overrideKey]: newVal.toString() };
          if (mK === '2026-06') {
            updated[partId] = newVal.toString();
          }
          return updated;
        });
      }

      const next = {...localOpeningBalances};
      delete next[partId];
      setLocalOpeningBalances(next);
    }
  };

  const commitRMOpeningBalance = (rmId: string, currentOpeningPipes: number) => {
    const newValStr = localOpeningBalances[rmId];
    if (newValStr === undefined) return;
    
    const newVal = parseFloat(newValStr);
    if (isNaN(newVal)) return;

    const mK = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}`;
    const overrideKey = `${mK}_${rmId}`;
    const monthDisplay = selectedDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    const delta = newVal - currentOpeningPipes;
    const actionTimestamp = new Date().toISOString();
    const rm = rawMaterials.find(r => r.id === rmId);
    const targetPartId = rm?.partId || parts.find(p => p.id === rm?.partId || (rm?.customerName && p.customerRMMappings?.[rm.customerName] === rmId))?.id || parts[0]?.id;

    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    const remark = `[RM_OPENING_BALANCE_SET:${newVal}|PREV:${currentOpeningPipes}] RM Opening Balance set to ${newVal} Pipes from Previous ${currentOpeningPipes} Pipes (${deltaStr} Pipes) for ${rm?.customerName || 'Customer'} (${rm?.size || 'RM'}) [${monthDisplay}]`;

    if (window.confirm(`Audit Action: Adjust Raw Material Opening Balance for ${monthDisplay}?\n\nTarget Balance: ${newVal} Pipes\nPrevious Balance: ${currentOpeningPipes} Pipes\nCorrection: ${deltaStr} Pipes`)) {
      if (propSetRMOpeningBalances) {
        propSetRMOpeningBalances(prev => {
          const updated = { ...prev, [overrideKey]: newVal.toString() };
          if (mK === '2026-06') {
            updated[rmId] = newVal.toString();
          }
          return updated;
        });
      }
      if (targetPartId && onAddInward) {
        onAddInward(
          targetPartId,
          delta,
          "ADMIN_AUDIT",
          remark,
          actionTimestamp
        );
      }
      const next = {...localOpeningBalances};
      delete next[rmId];
      setLocalOpeningBalances(next);
    }
  };

  // One-time admin migration: bulk-seeds this month's stored Opening
  // Balance for every part that doesn't already have one, using the same
  // "back it out from current live stock" formula the old live-computed
  // display used to use every render. After this, Opening Balance is
  // stored (see commitOpeningBalance above) and stops being recomputed —
  // the admin only needs to hand-correct the handful of items they know
  // are wrong, using the per-item input already on this screen.
  const [freezing, setFreezing] = useState(false);
  const freezeCurrentOpeningBalances = () => {
    if (!propSetPartOpeningBalances) return;
    const mK = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}`;
    const monthDisplay = selectedDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    if (!window.confirm(
      `Freeze Opening Balances for ${monthDisplay}?\n\n` +
      `This bulk-seeds a stored Opening Balance for every item that doesn't already have one for ${monthDisplay}, computed from current live stock minus this month's receipts plus this month's sales. Items that already have a stored value for ${monthDisplay} are left untouched.\n\n` +
      `Run this once after upgrading, then correct any item you know is wrong using its Opening Balance box above.`
    )) return;

    setFreezing(true);
    propSetPartOpeningBalances(prev => {
      const updated = { ...prev };
      parts.forEach(p => {
        const overrideKey = `${mK}_${p.id}`;
        if (updated[overrideKey] !== undefined) return;
        const monthLogs = inwardLogs.filter(l => l.partId === p.id && !isAuditDeltaRemark(l.remarks));
        const receipts = monthLogs.reduce((sum, l) => sum + l.quantity, 0);
        const monthSales = sales.filter(s => s.partId === p.id).reduce((sum, s) => sum + s.quantity, 0);
        const seedValue = Math.round(p.stock - receipts + monthSales);
        updated[overrideKey] = seedValue.toString();
        if (mK === '2026-06') updated[p.id] = seedValue.toString();
      });
      return updated;
    });
    setFreezing(false);
  };

  // Consolidated per-part computation, shared by all three layout
  // templates below (detailed / compact / cards) — previously duplicated
  // three times, which is exactly how the Opening Balance bug's fix could
  // easily have been applied to only one or two of the three and left the
  // others silently wrong.
  const partComputations = useMemo(() => {
    const map = new Map<string, {
      receiptsSinceStartOfMonth: number;
      totalSalesSinceStartOfMonth: number;
      salesSinceStartOfMonth: number;
      mappedRMs: RawMaterial[];
      hasCommonRM: boolean;
      openingBalValue: number;
      plantBalanceValue: number;
    }>();

    parts.forEach(p => {
      const monthLogs = inwardLogs.filter(l => l.partId === p.id);
      const receiptsSinceStartOfMonth = monthLogs
        .filter(l => !isAuditDeltaRemark(l.remarks))
        .reduce((sum, l) => sum + l.quantity, 0);

      const totalSalesSinceStartOfMonth = sales
        .filter(s => s.partId === p.id)
        .reduce((sum, s) => sum + s.quantity, 0);

      const salesSinceStartOfMonth = sales
        .filter(s => s.partId === p.id && (selectedCustomer === 'All' || s.customer.toUpperCase().trim() === selectedCustomer.toUpperCase().trim()))
        .reduce((sum, s) => sum + s.quantity, 0);

      const mappedRMs = rawMaterials.filter(rm => {
        const matchesCustomer = selectedCustomer === 'All' || rm.customerName.toUpperCase().trim() === selectedCustomer.toUpperCase().trim();
        const isLinked = Object.keys(p.customerRMMappings || {}).some(k => k.toUpperCase().trim() === rm.customerName.toUpperCase().trim() && p.customerRMMappings?.[k] === rm.id) || (rm.partId === p.id) || (rm.partIds && rm.partIds.includes(p.id));
        return matchesCustomer && isLinked;
      });

      const allMappedRMsForPart = rawMaterials.filter(rm => {
        return (p.customerRMMappings?.[rm.customerName] === rm.id) || (rm.partId === p.id) || (rm.partIds && rm.partIds.includes(p.id));
      });

      const hasCommonRM = allMappedRMsForPart.some(rm => {
        const partsLinkedToRM = parts.filter(otherPart => {
          return (otherPart.customerRMMappings?.[rm.customerName] === rm.id) ||
                 (rm.partId === otherPart.id) ||
                 (rm.partIds && rm.partIds.includes(otherPart.id));
        });
        return partsLinkedToRM.length > 1;
      });

      let openingBalValue = 0;
      if (mappedRMs.length > 0) {
        // RM-yield-based parts: Opening Balance is derived from the mapped
        // RM's own (correct, already-stored) opening balance, not tracked
        // independently for the part. Unrelated to the Opening Balance bug.
        openingBalValue = mappedRMs.reduce((sum, rm) => {
          const opBalancePipesStr = localRMOpeningBalances[rm.id] || '0';
          const openingBalancePipes = parseFloat(opBalancePipesStr);
          const rmLength = rm.length || 6000;
          const partLength = p.itemLength || 0;
          let yieldFactor = 0;
          if (partLength > 0) {
            yieldFactor = Math.floor(rmLength / partLength);
          } else {
            const rmWeight = rmLength * (rm.weightPer1000 / 1000);
            const partWeight = p.itemWeight || 0;
            if (partWeight > 0 && rmWeight > 0) yieldFactor = Math.floor(rmWeight / partWeight);
          }
          return sum + Math.round(openingBalancePipes * yieldFactor);
        }, 0);
      } else {
        // Stored, month-anchored value — see resolvedPartOpeningBalances in
        // App.tsx and commitOpeningBalance above. NOT recomputed from
        // p.stock, and NOT sourced from any inwardLogs remarks text.
        const stored = localPartOpeningBalances[p.id];
        const parsed = stored !== undefined ? parseFloat(stored) : 0;
        openingBalValue = isNaN(parsed) ? 0 : Math.round(parsed);
      }

      if (openingBalValue < 0 && !isAdmin) openingBalValue = 0;
      const plantBalanceValue = Math.round(openingBalValue + receiptsSinceStartOfMonth - totalSalesSinceStartOfMonth);

      map.set(p.id, { receiptsSinceStartOfMonth, totalSalesSinceStartOfMonth, salesSinceStartOfMonth, mappedRMs, hasCommonRM, openingBalValue, plantBalanceValue });
    });

    return map;
  }, [parts, inwardLogs, sales, rawMaterials, selectedCustomer, localRMOpeningBalances, localPartOpeningBalances, isAdmin]);

  // One-time correction: parts.stock is a running total, incremented and
  // decremented over time by every inward entry and every Tally-synced
  // sale — including, historically, the old Opening Balance audit flow's
  // fake delta entries (removed by the fix above, but their effect on
  // parts.stock was permanent and never undone). That's why Dashboard,
  // Item Master, and valuation — everything that reads p.stock directly —
  // can still disagree with this screen's Plant Balance even after the
  // Opening Balance fix: Plant Balance is now derived fresh each month
  // from a verified anchor, but parts.stock itself was never corrected.
  // This resets parts.stock to match the Plant Balance already verified
  // correct above, for every part NOT deferred to RM Inventory (those
  // aren't tracked via their own stock field at all).
  const [syncingStock, setSyncingStock] = useState(false);
  const isViewingCurrentMonth = (() => {
    const now = new Date();
    return selectedDate.getFullYear() === now.getFullYear() && selectedDate.getMonth() === now.getMonth();
  })();
  const syncAvailableStockToPlantBalance = () => {
    if (!setParts) return;
    // parts.stock is a single live "right now" field, not month-scoped —
    // only ever safe to overwrite while viewing the CURRENT month. Plant
    // Balance for a past month is a historical figure, not today's stock.
    if (!isViewingCurrentMonth) {
      alert('Switch to the current month before syncing — Available Stock is a single live value and syncing it from a past month\'s Plant Balance would overwrite today\'s real stock with a historical number.');
      return;
    }
    const eligible = parts.filter(p => (partComputations.get(p.id)?.mappedRMs.length || 0) === 0);
    const monthDisplay = selectedDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    if (!window.confirm(
      `Sync Available Stock to Plant Balance?\n\n` +
      `This resets the live "stock" value for ${eligible.length} item(s) (everything except RM-linked items, which are tracked via RM Inventory instead) to match the Plant Balance already shown on this screen for ${monthDisplay}.\n\n` +
      `This is what Dashboard, Item Master, and stock valuation read — if those still look wrong even though this screen is now correct, this is the fix. Run it once after correcting Opening Balance.`
    )) return;

    setSyncingStock(true);
    setParts(prev => prev.map(p => {
      const calc = partComputations.get(p.id);
      if (!calc || calc.mappedRMs.length > 0) return p;
      return { ...p, stock: calc.plantBalanceValue, lastUpdated: new Date().toISOString() };
    }));
    setSyncingStock(false);
  };

  const isAdjustment = parseInt(addQty) < 0 || addQty.startsWith('-');

  return (
    <div className="space-y-8 text-left">
      <header className="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            {isAdmin && inventoryMode === 'rm' && !rmReorderMode && (
              <button
                onClick={enterRmReorderMode}
                title="Reorder RM items"
                className="w-9 h-9 flex items-center justify-center rounded-xl border-2 border-slate-200 text-slate-500 hover:border-indigo-500 hover:text-indigo-600 transition-all"
              >
                ✏️
              </button>
            )}
            {isAdmin && inventoryMode === 'item' && (
              <button
                onClick={freezeCurrentOpeningBalances}
                disabled={freezing}
                title="One-time: seed stored Opening Balance for this month from current live stock, for any item that doesn't already have one"
                className="px-4 py-2 bg-white border-2 border-slate-200 text-slate-600 hover:border-amber-500 hover:text-amber-700 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-50"
              >
                {freezing ? 'Freezing…' : '❄️ Freeze Opening Balances'}
              </button>
            )}
            {isAdmin && inventoryMode === 'item' && (
              <button
                onClick={syncAvailableStockToPlantBalance}
                disabled={syncingStock || !isViewingCurrentMonth}
                title={isViewingCurrentMonth
                  ? "One-time: reset each item's live stock value to match the Plant Balance shown here — fixes Dashboard, Item Master, and valuation if they still disagree with this screen"
                  : "Switch to the current month first — this writes to today's live stock value"}
                className="px-4 py-2 bg-white border-2 border-slate-200 text-slate-600 hover:border-indigo-500 hover:text-indigo-700 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-50"
              >
                {syncingStock ? 'Syncing…' : '🔄 Sync Available Stock'}
              </button>
            )}
            {rmReorderMode && (
              <div className="flex items-center gap-2">
                <button
                  onClick={saveRmOrder}
                  className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-black uppercase tracking-widest"
                >
                  Save Order
                </button>
                <button
                  onClick={() => setRmReorderMode(false)}
                  className="px-4 py-2 border-2 border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-widest"
                >
                  Cancel
                </button>
              </div>
            )}
            <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none">Inventory Ledger</h2>
            {isAdmin && <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-amber-200 shadow-sm">Owner Management Active</span>}
          </div>
          <p className="text-slate-500 font-medium text-left">
            {inventoryMode === 'item' ? 'Real-time plant balance & monthly ledger (Part-wise)' : 'Material factor equivalents & consumption charts (RM-wise)'}
          </p>
        </div>
        
        {/* DROPDOWNS: Mode Selector & Customer Selector */}
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col">
            <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Inventory Category</label>
            <select 
              className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-emerald-500/10 outline-none text-sm font-bold bg-white text-slate-900 shadow-sm"
              value={inventoryMode}
              onChange={(e) => {
                setInventoryMode(e.target.value as 'item' | 'rm');
                setSearchTerm('');
              }}
            >
              <option value="item">📦 Item Inventory (Part-wise)</option>
              <option value="rm">🪵 RM Inventory (RM-wise)</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Customer / Consignee</label>
            <select 
              className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-emerald-500/10 outline-none text-sm font-bold bg-emerald-50 border-emerald-200 text-emerald-800 shadow-sm"
              value={selectedCustomer}
              onChange={(e) => setSelectedCustomer(e.target.value)}
            >
              <option value="All">All Customers</option>
              {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>

          {inventoryMode === 'item' && (
            <div className="flex flex-col">
              <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Item Category/Tier</label>
              <select 
                className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-emerald-500/10 outline-none text-sm font-bold bg-white text-slate-700 shadow-sm"
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
              >
                <option value="All">All Tiers</option>
                {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
          )}

          <div className="flex flex-col">
            <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Search Keywords</label>
            <input 
              type="text" 
              placeholder="Search..." 
              className="px-5 py-3 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-emerald-500/10 focus:border-emerald-500 outline-none bg-white text-slate-900 font-bold shadow-sm md:w-48"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
      </header>

      {/* VISUAL LAYOUT TEMPLATE SWITCHER TOOLBAR */}
      <div className="flex flex-wrap items-center justify-between bg-slate-900 text-white p-2.5 rounded-2xl shadow-md border border-slate-800 gap-3">
        <div className="flex items-center gap-2.5 pl-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Layout Template:</span>
          <span className="text-xs font-black text-emerald-400 flex items-center gap-1.5">
            {layoutTemplate === 'detailed' && '📊 Standard Detailed Table'}
            {layoutTemplate === 'compact' && '⚡ Crisp Compact Matrix'}
            {layoutTemplate === 'cards' && '🃏 Executive Summary Cards'}
          </span>
        </div>
        <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-xl">
          <button
            onClick={() => setLayoutTemplate('detailed')}
            className={`px-3.5 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all ${
              layoutTemplate === 'detailed' ? 'bg-emerald-500 text-slate-950 shadow-md font-black' : 'text-slate-400 hover:text-white'
            }`}
          >
            Detailed
          </button>
          <button
            onClick={() => setLayoutTemplate('compact')}
            className={`px-3.5 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all ${
              layoutTemplate === 'compact' ? 'bg-emerald-500 text-slate-950 shadow-md font-black' : 'text-slate-400 hover:text-white'
            }`}
          >
            Compact
          </button>
          <button
            onClick={() => setLayoutTemplate('cards')}
            className={`px-3.5 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all ${
              layoutTemplate === 'cards' ? 'bg-emerald-500 text-slate-950 shadow-md font-black' : 'text-slate-400 hover:text-white'
            }`}
          >
            Cards
          </button>
        </div>
      </div>

      {/* RENDER ITEM-WISE INVENTORY */}
      {inventoryMode === 'item' && (
        <>
          {/* TEMPLATE 1: DETAILED TABLE */}
          {layoutTemplate === 'detailed' && (
            <div className={`bg-white rounded-[2.5rem] shadow-sm border overflow-hidden transition-all duration-500 ${isAdmin ? 'border-amber-500 shadow-amber-500/10' : 'border-slate-100'}`}>
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
                  <tr>
                    <th className="px-8 py-6 border-r border-slate-200/40">Part Identity</th>
                    <th className="px-8 py-6 text-center border-r border-slate-200/40">Opening bal {headerDates.opening}</th>
                    <th className="px-8 py-6 text-center border-r border-slate-200/40">INWARD {headerDates.monthYear}</th>
                    <th className="px-8 py-6 text-center border-r border-slate-200/40">SALES {headerDates.monthYear}</th>
                    <th className="px-8 py-6 text-center border-r border-slate-200/40">Plant balance {headerDates.closing}</th>
                    <th className="px-8 py-6 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredParts.map(p => {
                    const { receiptsSinceStartOfMonth, totalSalesSinceStartOfMonth, salesSinceStartOfMonth, hasCommonRM, openingBalValue, plantBalanceValue } = partComputations.get(p.id)!;

                    const localVal = localOpeningBalances[p.id];
                    const isDirty = localVal !== undefined && parseInt(localVal) !== openingBalValue;
                    const isNegative = plantBalanceValue < 0;

                    return (
                      <tr key={p.id} className={`hover:bg-emerald-50/20 transition-all group ${isNegative ? 'bg-rose-50/50' : ''}`}>
                        <td className="px-8 py-6">
                          <div className="text-[9px] text-slate-400 font-mono tracking-tighter uppercase mb-0.5">{p.sapCode}</div>
                          <div className="font-bold text-slate-800 text-sm leading-tight uppercase">{p.name}</div>
                          <div className="mt-1 text-[9px] text-indigo-500 font-black tracking-tight">{p.size}</div>
                        </td>
                        <td className="px-8 py-6 text-center">
                          {isAdmin && !readOnly ? (
                            <div className="flex items-center justify-center gap-2">
                              <input 
                                type="number"
                                className={`w-24 text-center border-2 rounded-xl font-black py-2 outline-none transition-all shadow-sm text-slate-900 ${
                                  isDirty ? 'bg-amber-100 border-amber-500' : 'bg-amber-50 border-slate-200'
                                }`}
                                value={localVal !== undefined ? localVal : openingBalValue}
                                onChange={(e) => setLocalOpeningBalances({...localOpeningBalances, [p.id]: e.target.value})}
                              />
                              {isDirty && (
                                <button 
                                  onClick={() => commitOpeningBalance(p.id, openingBalValue)}
                                  className="w-10 h-10 bg-amber-500 text-white rounded-xl shadow-lg hover:bg-amber-600 active:scale-90 transition-all flex items-center justify-center text-sm"
                                >
                                  💾
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="font-black text-slate-800 text-base">{openingBalValue}</span>
                          )}
                        </td>
                        <td className={`px-8 py-6 text-center font-black text-sm ${receiptsSinceStartOfMonth > 0 ? 'text-indigo-600' : 'text-slate-400'}`}>
                          {receiptsSinceStartOfMonth > 0 ? `+${receiptsSinceStartOfMonth}` : '0'}
                        </td>
                        <td className={`px-8 py-6 text-center font-black text-sm ${salesSinceStartOfMonth > 0 ? 'text-rose-500' : 'text-slate-400'}`}>
                          {salesSinceStartOfMonth > 0 ? `-${salesSinceStartOfMonth}` : '0'}
                        </td>
                        <td className="px-8 py-6 text-center">
                          <div className="flex flex-col items-center">
                            {hasCommonRM ? (
                              <span className="text-[11px] font-black px-3.5 py-2 bg-indigo-50 text-indigo-700 rounded-xl border border-indigo-100/80 uppercase tracking-wide shadow-sm text-center">
                                Refer RM Inventory
                              </span>
                            ) : (
                              <>
                                <div className={`px-4 py-1.5 rounded-full transition-all duration-300 flex flex-col items-center ${isNegative ? 'bg-rose-600 text-white shadow-lg shadow-rose-200 scale-110' : ''}`}>
                                   <span className={`font-black text-lg ${isNegative ? 'text-white' : p.status === 'Low Stock' ? 'text-amber-600' : p.status === 'Out of Stock' ? 'text-rose-600' : 'text-slate-800'}`}>
                                     {plantBalanceValue}
                                   </span>
                                </div>
                                <span className={`text-[8px] font-black uppercase tracking-tighter mt-2 px-2 py-0.5 rounded transition-all ${
                                  isNegative ? 'bg-rose-100 text-rose-700 animate-pulse ring-2 ring-rose-400' : p.status === 'In Stock' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                                }`}>
                                  {isNegative ? 'Audit Required' : p.status}
                                </span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="px-8 py-6 text-center">
                          {!readOnly && (
                            <button 
                              onClick={() => { 
                                setSelectedPart(p); 
                                setShowAddModal(true); 
                                setAddQty('');
                                setSupplier('');
                                setRemarks('');
                              }}
                              className={`text-[10px] text-white px-5 py-2.5 rounded-xl font-black uppercase tracking-widest transition-all shadow-md active:scale-95 ${isAdmin ? 'bg-amber-500 hover:bg-amber-600' : 'bg-slate-900 hover:bg-emerald-600'}`}
                            >
                              Material Entry
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredParts.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-8 py-12 text-center text-slate-400 font-bold uppercase text-xs tracking-wide">
                        No items found matching the selected filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* TEMPLATE 2: COMPACT DENSITY MATRIX (SPREADSHEET MODE) */}
          {layoutTemplate === 'compact' && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse font-sans text-xs">
                  <thead className="bg-slate-900 text-slate-100 text-[10px] uppercase font-mono tracking-wider sticky top-0 z-10">
                    <tr>
                      <th className="py-2.5 px-4 font-bold border-r border-slate-800">SAP Code</th>
                      <th className="py-2.5 px-4 font-bold border-r border-slate-800">Part Description</th>
                      <th className="py-2.5 px-4 text-right font-bold border-r border-slate-800">Opening</th>
                      <th className="py-2.5 px-4 text-right font-bold border-r border-slate-800 text-indigo-300">Inward</th>
                      <th className="py-2.5 px-4 text-right font-bold border-r border-slate-800 text-rose-300">Sales</th>
                      <th className="py-2.5 px-4 text-right font-bold border-r border-slate-800 text-emerald-300">Plant Stock</th>
                      <th className="py-2.5 px-4 text-center font-bold border-r border-slate-800">Status</th>
                      <th className="py-2.5 px-4 text-center font-bold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredParts.map(p => {
                      const { receiptsSinceStartOfMonth, salesSinceStartOfMonth, openingBalValue, plantBalanceValue } = partComputations.get(p.id)!;

                      return (
                        <tr key={p.id} className="hover:bg-slate-100/80 transition-colors even:bg-slate-50/50">
                          <td className="py-2.5 px-4 font-mono font-bold text-slate-600 text-[11px]">{p.sapCode}</td>
                          <td className="py-2.5 px-4 font-bold text-slate-800">
                            {p.name}
                            <span className="ml-2 text-[10px] text-slate-400 font-mono">({p.size})</span>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono font-semibold text-slate-700">{openingBalValue}</td>
                          <td className="py-2.5 px-4 text-right font-mono font-bold text-indigo-600">
                            {receiptsSinceStartOfMonth > 0 ? `+${receiptsSinceStartOfMonth}` : '0'}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono font-bold text-rose-600">
                            {salesSinceStartOfMonth > 0 ? `-${salesSinceStartOfMonth}` : '0'}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono font-black text-slate-900 text-sm">
                            <span className={`px-2 py-0.5 rounded ${plantBalanceValue < 0 ? 'bg-rose-600 text-white font-bold' : 'bg-emerald-50 text-emerald-950 font-black'}`}>
                              {plantBalanceValue}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                              plantBalanceValue < 0 ? 'bg-rose-100 text-rose-700' : p.status === 'In Stock' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                            }`}>
                              {plantBalanceValue < 0 ? 'Audit' : p.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            {!readOnly && (
                              <button
                                onClick={() => { 
                                  setSelectedPart(p); 
                                  setShowAddModal(true); 
                                  setAddQty('');
                                  setSupplier('');
                                  setRemarks('');
                                }}
                                className="text-[10px] bg-slate-900 text-white hover:bg-emerald-600 px-3 py-1 rounded-md font-bold transition-all shadow-sm active:scale-95"
                              >
                                + Entry
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TEMPLATE 3: EXECUTIVE CARDS GRID */}
          {layoutTemplate === 'cards' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredParts.map(p => {
                const { receiptsSinceStartOfMonth, salesSinceStartOfMonth, openingBalValue, plantBalanceValue } = partComputations.get(p.id)!;
                const scheduleNeeded = selectedCustomer !== 'All' ? getCustomerSchedule(p, selectedCustomer) : 0;

                return (
                  <div key={p.id} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-all flex flex-col justify-between space-y-4">
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[10px] font-mono font-bold text-slate-400 uppercase">{p.sapCode}</span>
                        <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                          plantBalanceValue < 0 ? 'bg-rose-100 text-rose-700' : p.status === 'In Stock' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                        }`}>
                          {p.status}
                        </span>
                      </div>
                      <h4 className="font-extrabold text-slate-900 text-sm leading-tight uppercase line-clamp-2">{p.name}</h4>
                      <p className="text-[10px] font-bold text-indigo-600 mt-0.5">{p.size}</p>
                    </div>

                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 text-center">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Total Plant Stock</p>
                      <p className={`text-3xl font-black ${plantBalanceValue < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                        {plantBalanceValue} <span className="text-xs text-slate-400 font-bold">Pcs</span>
                      </p>
                      {scheduleNeeded > 0 && (
                        <p className="text-[10px] font-bold text-slate-500 mt-1">
                          Schedule: <span className="font-black text-slate-800">{scheduleNeeded}</span> | Shortage: <span className={`font-black ${plantBalanceValue < scheduleNeeded ? 'text-rose-600' : 'text-emerald-600'}`}>{Math.max(0, scheduleNeeded - plantBalanceValue)}</span>
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 text-center text-[10px] bg-slate-100/60 p-2 rounded-xl">
                      <div>
                        <span className="text-slate-400 block text-[8px] font-bold uppercase">Opening</span>
                        <span className="font-mono font-bold text-slate-800">{openingBalValue}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[8px] font-bold uppercase">Inward</span>
                        <span className="font-mono font-bold text-indigo-600">+{receiptsSinceStartOfMonth}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[8px] font-bold uppercase">Sales</span>
                        <span className="font-mono font-bold text-rose-600">-{salesSinceStartOfMonth}</span>
                      </div>
                    </div>

                    {!readOnly && (
                      <button
                        onClick={() => { 
                          setSelectedPart(p); 
                          setShowAddModal(true); 
                          setAddQty('');
                          setSupplier('');
                          setRemarks('');
                        }}
                        className="w-full py-2.5 bg-slate-900 hover:bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all shadow-sm active:scale-95"
                      >
                        Material Entry
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* RENDER RM-WISE INVENTORY */}
      {rmReorderMode && (
        <div className="bg-white rounded-[2rem] shadow-sm border border-indigo-200 p-6">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-4">
            Reorder RM items — use the arrows, then click Save Order above
          </p>
          <div className="space-y-2">
            {rmDraftOrder.map((rm, i) => (
              <div key={rm.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3">
                <div>
                  <p className="font-bold text-slate-900 text-sm">{rm.size}</p>
                  <p className="text-xs text-slate-500">{rm.partName} • {rm.customerName}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => moveRmDraftItem(i, -1)}
                    disabled={i === 0}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-indigo-500 hover:text-indigo-600"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveRmDraftItem(i, 1)}
                    disabled={i === rmDraftOrder.length - 1}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-indigo-500 hover:text-indigo-600"
                  >
                    ↓
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {inventoryMode === 'rm' && !rmReorderMode && (
        <div className={`bg-white rounded-[2.5rem] shadow-sm border overflow-hidden transition-all duration-500 border-indigo-500 shadow-indigo-500/5`}>
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-900 text-[10px] uppercase font-black tracking-widest">
              <tr>
                <th className="px-8 py-6 border-r border-slate-200/40">Raw Material Size & Item</th>
                <th className="px-8 py-6 text-center border-r border-slate-200/40">Opening balance</th>
                <th className="px-8 py-6 text-center border-r border-slate-200/40">RM Inward Log</th>
                <th className="px-8 py-6 text-center border-r border-slate-200/40 bg-rose-50/20 text-rose-950 font-black">Dispatches</th>
                <th className="px-8 py-6 text-center border-r border-slate-200/40 bg-amber-50/25 text-amber-950 font-black">End-Piece Scrap</th>
                <th className="px-8 py-6 text-center border-r border-slate-200/40 bg-indigo-50/20 text-indigo-950 font-black">Stock as on date {formattedToday}</th>
                <th className="px-8 py-6 text-center border-r border-slate-200/40 bg-emerald-50/20 text-emerald-950 font-black">Tentative Opening Inventory {formattedNextMonth}</th>
                <th className="px-8 py-6 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/60 bg-white">
              {filteredRawMaterials.map(rm => {
                const startOfMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
                const endOfSelectedPeriod = new Date(selectedDate);
                endOfSelectedPeriod.setHours(23, 59, 59, 999);

                // Standard RM pipe details (default standard size 6000 mm if not specified)
                const rmLength = rm.length || 6000;
                const rmStandardMeters = rmLength / 1000;
                const pipeWeight = rmLength && rm.weightPer1000 ? (rmLength * rm.weightPer1000) / 1000 : 0;

                // 1. RM Inward matching this month
                const monthRMInwardPipes = rmInwardLogs
                  .filter(l => l.rmId === rm.id)
                  .reduce((sum, l) => sum + l.quantity, 0);
                const monthRMInwardKg = parseFloat((monthRMInwardPipes * pipeWeight).toFixed(2));
                const monthRMInwardMeters = monthRMInwardPipes * rmStandardMeters;

                // 2. Map RM to Part / Finished Item
                const mappedItems = parts.filter(p => p.id === rm.partId || (rm.partIds && rm.partIds.includes(p.id)));
                const mappedItem = mappedItems[0]; // For fallback calculations

                let rmConsumedDispatch = 0;
                let rmConsumedProduction = 0;
                let materialFactor = 0; // Legacy / first item factor for config display
                let totalConsumedMeters = 0;
                let totalScrapMeters = 0;
                let totalScrapKg = 0;

                const itemConsumptionBreakdown: { 
                  name: string; 
                  qty: number; 
                  length: number; 
                  meters: number;
                  pipesUsed: number;
                  scrapMeters: number;
                  scrapMmPerPipe: number;
                }[] = [];

                if (mappedItem) {
                  if (mappedItem.itemWeight && mappedItem.itemWeight > 0) {
                    materialFactor = mappedItem.itemWeight;
                  } else if (mappedItem.itemLength && mappedItem.itemLength > 0 && rm.weightPer1000 > 0) {
                    materialFactor = mappedItem.itemLength * (rm.weightPer1000 / 1000);
                  }
                }

                let totalSalesQty = 0;
                let totalProdQty = 0;

                mappedItems.forEach(item => {
                  let factor = 0;
                  let lengthFactorMeters = 0;
                  if (item.itemLength && item.itemLength > 0) {
                    lengthFactorMeters = item.itemLength / 1000;
                    if (rm.weightPer1000 > 0) {
                      factor = item.itemLength * (rm.weightPer1000 / 1000);
                    } else if (item.itemWeight && item.itemWeight > 0) {
                      factor = item.itemWeight;
                    }
                  } else if (item.itemWeight && item.itemWeight > 0) {
                    factor = item.itemWeight;
                    if (rm.weightPer1000 > 0) {
                      lengthFactorMeters = (item.itemWeight / (rm.weightPer1000 / 1000)) / 1000;
                    }
                  }

                  // RM Consumed via Dispatch (Sales) this month for this mapped item
                  const salesQty = sales
                    .filter(s => s.partId === item.id && s.customer.toUpperCase().trim() === rm.customerName.toUpperCase().trim())
                    .reduce((sum, s) => sum + s.quantity, 0);

                  const itemMeters = salesQty * lengthFactorMeters;
                  rmConsumedDispatch += salesQty * factor;
                  totalSalesQty += salesQty;
                  totalConsumedMeters += itemMeters;

                  // Scrap Calculation: Find number of pipes actually cut & remaining end piece scrap
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
                  const itemScrapKg = itemScrapMeters * (rm.weightPer1000 || 0);

                  totalScrapMeters += itemScrapMeters;
                  totalScrapKg += itemScrapKg;

                  if (salesQty > 0) {
                    itemConsumptionBreakdown.push({
                      name: item.name,
                      qty: salesQty,
                      length: itemLengthMm,
                      meters: itemMeters,
                      pipesUsed: pipesUsed,
                      scrapMeters: itemScrapMeters,
                      scrapMmPerPipe: scrapMmPerPipe
                    });
                  }

                  // RM Consumed via Production (Inward logs) this month for this mapped item
                  const prodQty = inwardLogs
                    .filter(l => l.partId === item.id && !l.remarks?.startsWith("[OPENING_BALANCE_SET:"))
                    .reduce((sum, l) => sum + l.quantity, 0);
                  rmConsumedProduction += prodQty * factor;
                  totalProdQty += prodQty;
                });

                rmConsumedDispatch = parseFloat(rmConsumedDispatch.toFixed(2));
                rmConsumedProduction = parseFloat(rmConsumedProduction.toFixed(2));
                totalConsumedMeters = parseFloat(totalConsumedMeters.toFixed(2));
                totalScrapMeters = parseFloat(totalScrapMeters.toFixed(2));
                totalScrapKg = parseFloat(totalScrapKg.toFixed(2));

                // Opening Stock from localRMOpeningBalances, defaulting to 150 Pipes or 0 if not set
                const opBalancePipesStr = localRMOpeningBalances[rm.id] || '0';
                const openingBalancePipes = parseFloat(opBalancePipesStr);
                const openingBalanceKg = parseFloat((openingBalancePipes * pipeWeight).toFixed(2));
                const openingBalanceMeters = openingBalancePipes * rmStandardMeters;

                // Closing RM Stock calculation based on length (Metres/mm subtraction, subtracting dispatches AND scrap)
                const closingBalanceMeters = parseFloat((openingBalanceMeters + monthRMInwardMeters - totalConsumedMeters - totalScrapMeters).toFixed(2));
                const closingBalancePipes = rmStandardMeters > 0 ? parseFloat((closingBalanceMeters / rmStandardMeters).toFixed(1)) : 0;
                const closingBalanceKg = parseFloat((openingBalanceKg + monthRMInwardKg - rmConsumedDispatch - totalScrapKg).toFixed(2));

                let totalScheduleMetersNeeded = 0;
                let totalScheduleScrapMetersNeeded = 0;
                let totalSchedulePartWeightNeeded = 0;
                let totalScheduleScrapKgNeeded = 0;

                mappedItems.forEach(item => {
                  const target = getCustomerSchedule(item, rm.customerName);
                  const salesQty = sales
                    .filter(s => s.partId === item.id && s.customer.toUpperCase().trim() === rm.customerName.toUpperCase().trim())
                    .reduce((sum, s) => sum + s.quantity, 0);

                  const rmBalanceQtyNeeded = Math.max(0, target - salesQty);

                  let lengthFactorMeters = 0;
                  let factor = 0;
                  if (item.itemLength && item.itemLength > 0) {
                    lengthFactorMeters = item.itemLength / 1000;
                    if (rm.weightPer1000 > 0) {
                      factor = item.itemLength * (rm.weightPer1000 / 1000);
                    } else if (item.itemWeight && item.itemWeight > 0) {
                      factor = item.itemWeight;
                    }
                  } else if (item.itemWeight && item.itemWeight > 0) {
                    factor = item.itemWeight;
                    if (rm.weightPer1000 > 0) {
                      lengthFactorMeters = (item.itemWeight / (rm.weightPer1000 / 1000)) / 1000;
                    }
                  }

                  const itemLengthMm = item.itemLength || (lengthFactorMeters * 1000);
                  const balanceMetersCurrentMonth = rmBalanceQtyNeeded * lengthFactorMeters;

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

                  let pipesNeededForSchedule = 0;
                  if (yieldFactor > 0) {
                    pipesNeededForSchedule = Math.ceil(rmBalanceQtyNeeded / yieldFactor);
                  } else if (rmStandardMeters > 0 && rmBalanceQtyNeeded > 0) {
                    pipesNeededForSchedule = Math.ceil(balanceMetersCurrentMonth / rmStandardMeters);
                  }

                  const scheduleScrapMeters = pipesNeededForSchedule * (scrapMmPerPipe / 1000);
                  const scheduleScrapKg = scheduleScrapMeters * (rm.weightPer1000 || 0);

                  totalScheduleMetersNeeded += balanceMetersCurrentMonth;
                  totalScheduleScrapMetersNeeded += scheduleScrapMeters;
                  totalSchedulePartWeightNeeded += rmBalanceQtyNeeded * factor;
                  totalScheduleScrapKgNeeded += scheduleScrapKg;
                });

                const tentativeMeters = Math.max(0, parseFloat((closingBalanceMeters - (totalScheduleMetersNeeded + totalScheduleScrapMetersNeeded)).toFixed(2)));
                const tentativePipes = rmStandardMeters > 0 ? parseFloat((tentativeMeters / rmStandardMeters).toFixed(1)) : 0;
                const tentativeKg = Math.max(0, parseFloat((closingBalanceKg - totalSchedulePartWeightNeeded - totalScheduleScrapKgNeeded).toFixed(2)));

                const isRMNegative = closingBalanceKg < 0 || closingBalancePipes < 0 || closingBalanceMeters < 0;

                const localRMVal = localOpeningBalances[rm.id];
                const isRMDirty = localRMVal !== undefined && parseFloat(localRMVal) !== openingBalancePipes;

                return (
                  <tr key={rm.id} className={`hover:bg-indigo-50/10 transition-all ${isRMNegative ? 'bg-rose-50/50' : ''}`}>
                    <td className="px-8 py-6">
                      <div className="text-[9px] text-indigo-500 font-black tracking-tight uppercase mb-0.5">{rm.customerName}</div>
                      <div className="font-extrabold text-slate-900 text-sm leading-tight uppercase">{rm.size}</div>
                      <div className="mt-1 text-[10px] text-slate-500 font-medium">
                        Standard Length: <span className="font-bold text-indigo-650">{rmLength} mm</span> ({rmStandardMeters.toFixed(1)} metres)
                      </div>
                      <div className="mt-1 text-[10px] text-slate-500 font-medium">
                        Mapped to: <span className="font-bold text-slate-700">{mappedItems.length > 0 ? mappedItems.map(p => p.name).join(', ') : rm.partName || 'Unmapped'}</span>
                      </div>
                      {materialFactor > 0 ? (
                        <div className="mt-1.5 text-[8px] uppercase tracking-wider font-extrabold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full w-max">
                          Config factor: {materialFactor.toFixed(3)} Kg/Pc
                        </div>
                      ) : (
                        <div className="mt-1.5 text-[8px] uppercase tracking-wider font-extrabold text-rose-500 bg-rose-50 px-2 py-0.5 rounded-full w-max">
                          No Weight Factor Configured
                        </div>
                      )}
                    </td>
                    <td className="px-8 py-6 text-center">
                      {isAdmin && !readOnly ? (
                        <div className="flex flex-col items-center gap-1">
                          <input 
                            type="number"
                            step="1"
                            className={`w-28 text-center border-2 rounded-xl font-black py-2 outline-none transition-all shadow-sm text-slate-900 ${
                              isRMDirty ? 'bg-amber-100 border-amber-500' : 'bg-amber-50 border-slate-200'
                            }`}
                            value={localRMVal !== undefined ? localRMVal : openingBalancePipes}
                            onChange={(e) => setLocalOpeningBalances({...localOpeningBalances, [rm.id]: e.target.value})}
                          />
                          <span className="text-[10px] text-indigo-600 font-bold block">
                            = {((localRMVal !== undefined ? parseFloat(localRMVal) || 0 : openingBalancePipes) * rmStandardMeters).toFixed(1)} m
                          </span>
                          <span className="text-[9px] text-slate-400 font-medium">
                            ({((localRMVal !== undefined ? parseFloat(localRMVal) || 0 : openingBalancePipes) * pipeWeight).toFixed(2)} Kg)
                          </span>
                          {isRMDirty && (
                            <button 
                              onClick={() => commitRMOpeningBalance(rm.id, openingBalancePipes)}
                              className="w-20 py-1.5 bg-indigo-600 text-white rounded-lg shadow-md hover:bg-indigo-700 active:scale-95 transition-all text-xs font-bold mt-1"
                            >
                              Save 💾
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center">
                          <span className="font-black text-slate-800 text-sm">{openingBalancePipes} Pipes</span>
                          <span className="text-[10px] text-indigo-600 font-bold block">{openingBalanceMeters.toFixed(1)} m</span>
                          <span className="text-[9px] text-slate-400 font-medium">({openingBalanceKg.toFixed(2)} Kg)</span>
                        </div>
                      )}
                    </td>
                    <td className="px-8 py-6 text-center">
                      <div className="flex flex-col items-center">
                        <span className={`font-black text-sm ${monthRMInwardPipes > 0 ? 'text-indigo-600' : 'text-slate-400'}`}>
                          {monthRMInwardPipes > 0 ? `+${monthRMInwardPipes} Pipes` : '0 Pipes'}
                        </span>
                        {monthRMInwardPipes > 0 && (
                          <>
                            <span className="text-[10px] text-indigo-600 font-bold">
                              = +{monthRMInwardMeters.toFixed(1)} m
                            </span>
                            <span className="text-[9px] text-slate-400 font-medium">
                              (+{monthRMInwardKg.toFixed(2)} Kg)
                            </span>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-8 py-6 bg-rose-50/5 text-center border-r border-slate-200/20">
                      <div className="flex flex-col items-center">
                        <span className={`font-black text-sm ${totalConsumedMeters > 0 ? 'text-rose-600 font-black' : 'text-slate-400 font-bold'}`}>
                          {totalConsumedMeters > 0 ? `-${totalConsumedMeters.toFixed(1)} m` : '0 m'}
                        </span>
                        {totalConsumedMeters > 0 && (
                          <>
                            <span className="text-[10px] text-rose-500 font-bold">
                              = -{(totalConsumedMeters / rmStandardMeters).toFixed(1)} Pipes
                            </span>
                            <span className="text-[9px] text-slate-400 font-medium">
                              (-{rmConsumedDispatch.toFixed(2)} Kg)
                            </span>
                          </>
                        )}
                        {itemConsumptionBreakdown.length > 0 && (
                          <div className="mt-2.5 space-y-1 w-full max-w-[13rem] bg-slate-50/70 shadow-inner rounded-xl p-2 border border-slate-100 text-left">
                            <div className="text-[8px] font-black uppercase text-slate-400 tracking-wider mb-1">Consumption Specs</div>
                            {itemConsumptionBreakdown.map((item, idx) => (
                              <div key={idx} className="text-[9px] text-slate-600 flex flex-col border-b border-dashed border-slate-100 pb-1.5 last:border-0 last:pb-0">
                                <span className="font-extrabold truncate text-slate-700">{item.name}</span>
                                <span className="font-mono text-[8.5px] mt-0.5 text-slate-500 flex justify-between">
                                  <span>{item.qty} Pcs × {item.length}mm</span>
                                  <span className="font-bold text-rose-600">-{item.meters.toFixed(1)} m</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-8 py-6 bg-amber-50/10 text-center border-r border-slate-200/20 text-slate-800">
                      <div className="flex flex-col items-center">
                        <span className={`font-black text-sm ${totalScrapMeters > 0 ? 'text-amber-600 font-black' : 'text-slate-400 font-semibold'}`}>
                          {totalScrapMeters > 0 ? `-${totalScrapMeters.toFixed(2)} m` : '0 m'}
                        </span>
                        {totalScrapMeters > 0 && (
                          <>
                            <span className="text-[9px] text-amber-600 font-bold block">
                              ({totalScrapKg.toFixed(2)} Kg)
                            </span>
                            <div className="mt-2.5 space-y-1 w-full max-w-[13rem] bg-amber-50/30 shadow-inner rounded-xl p-2 border border-amber-100/40 text-left">
                              <div className="text-[8px] font-black uppercase text-amber-500 tracking-wider mb-1">Scrap Breakdown</div>
                              {itemConsumptionBreakdown.map((item, idx) => item.pipesUsed > 0 && (
                                <div key={idx} className="text-[8.5px] text-slate-600 flex flex-col border-b border-dashed border-amber-100 pb-1 last:border-0 last:pb-0">
                                  <span className="font-extrabold truncate text-slate-700">{item.name}</span>
                                  <span className="font-mono text-[8.5px] mt-0.5 text-amber-700 flex justify-between">
                                    <span>{item.pipesUsed} Cuts × {item.scrapMmPerPipe}mm</span>
                                    <span className="font-bold">-{item.scrapMeters.toFixed(2)} m</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-8 py-6 bg-indigo-50/10 text-center border-r border-slate-200/20">
                      <div className="flex flex-col items-center">
                        <div className={`px-4 py-1.5 rounded-full transition-all duration-300 flex flex-col items-center ${isRMNegative ? 'bg-rose-600 text-white shadow-lg shadow-rose-200 scale-110 font-bold' : ''}`}>
                          <span className={`font-black text-sm ${isRMNegative ? 'text-white' : 'text-slate-800'}`}>{closingBalancePipes} Pipes</span>
                          <span className={`text-[10px] font-bold ${isRMNegative ? 'text-rose-100' : 'text-indigo-600'}`}>{closingBalanceMeters.toFixed(1)} m</span>
                          <span className={`text-[9px] font-medium ${isRMNegative ? 'text-rose-100' : 'text-slate-400'}`}>({closingBalanceKg.toFixed(2)} Kg)</span>
                        </div>
                        {isRMNegative && (
                          <span className="text-[8px] font-black uppercase tracking-tighter mt-2 px-2 py-0.5 rounded bg-rose-100 text-rose-700 animate-pulse ring-2 ring-rose-400">
                            Audit Required
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-8 py-6 bg-emerald-50/10 text-center border-r border-slate-200/20">
                      <div className="flex flex-col items-center">
                        <div className="px-4 py-1.5 rounded-full flex flex-col items-center bg-emerald-50 text-slate-800">
                          <span className="font-black text-sm text-slate-800">{tentativePipes} Pipes</span>
                          <span className="text-[10px] font-bold text-emerald-650">{tentativeMeters.toFixed(1)} m</span>
                          <span className="text-[9px] font-medium text-slate-500">({tentativeKg.toFixed(2)} Kg)</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-8 py-6 text-center">
                      {!readOnly && (
                        <button 
                          onClick={() => { 
                            setSelectedRM(rm); 
                            setShowAddModal(true); 
                            setAddQty('');
                            setSupplier('');
                            setRemarks('');
                          }}
                          className={`text-[10px] text-white px-5 py-2.5 rounded-xl font-black uppercase tracking-widest transition-all shadow-md bg-indigo-600 hover:bg-emerald-600 active:scale-95`}
                        >
                          RM Inward Receipt +
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredRawMaterials.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-8 py-12 text-center text-slate-400 font-bold uppercase text-xs tracking-wide">
                    {rawMaterials.length === 0 
                      ? 'No Raw Materials defined. Establish RM specs in "RM Master (Admin)" first to track RM Inventory.'
                      : 'No raw materials found matching the selected customer filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* SHARED MODALS FOR ADDING INWARD (ITEM OR RM) */}
      {showAddModal && (selectedPart || selectedRM) && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-[100] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-10 border border-slate-100 animate-in zoom-in-95 max-h-[92vh] overflow-y-auto">
            <h3 className={`text-2xl font-black mb-1 text-left ${isAdjustment ? 'text-rose-600' : 'text-slate-900'}`}>
              {isAdjustment ? 'Discrepancy Control Entry (Negative Value)' : inventoryMode === 'item' ? 'Material Entry (Part)' : 'Material Entry (RM)'}
            </h3>
            <p className="text-xs text-slate-500 mb-6 font-medium text-left">
              {isAdjustment ? 'Correcting a mismatch or rejection quantity for: ' : 'Posting event log for: '}
              <span className="text-indigo-600 font-extrabold">
                {inventoryMode === 'item' ? selectedPart?.name : selectedRM?.size}
              </span>
            </p>

            <form onSubmit={handlePreSubmit} className="space-y-5 text-left">
              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">
                  Quantity ({inventoryMode === 'item' ? 'Pcs' : 'No of Pipes'})
                </label>
                <input 
                  autoFocus 
                  type="text" 
                  required 
                  placeholder={inventoryMode === 'item' ? "0" : "0 Pipes"}
                  className={`w-full px-6 py-5 bg-white border-2 rounded-2xl outline-none font-black text-3xl transition-all shadow-inner text-slate-900 ${isAdjustment ? 'border-rose-300 text-rose-600' : 'border-slate-200 focus:border-indigo-600'}`} 
                  value={addQty} 
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '' || val === '-' || /^-?\d*$/.test(val)) {
                      setAddQty(val);
                    }
                  }} 
                />
              </div>

              {isAdjustment && (
                <div>
                  <label className="block text-[10px] font-black text-rose-500 uppercase tracking-widest mb-3 text-left">Remarks — Reason for Mismatch/Rejection (Mandatory)</label>
                  <textarea
                    required
                    placeholder="e.g. Scrap discard, damage, scale adjustment, rejection qty..."
                    className="w-full px-6 py-4 bg-rose-50/30 border-2 border-rose-100 rounded-2xl focus:border-rose-500 outline-none font-bold text-slate-900 min-h-[90px] shadow-inner" 
                    value={remarks} 
                    onChange={(e) => setRemarks(e.target.value)} 
                  />
                </div>
              )}

              <div>
                <label className={`block text-[10px] font-black uppercase tracking-widest mb-3 text-left ${isAdjustment ? 'text-rose-500' : 'text-slate-400'}`}>
                  {isAdjustment ? 'Responsible Name (Mandatory)' : 'Supplier / Mill Name'}
                </label>
                <input
                  type="text"
                  placeholder={isAdjustment ? "Name of person responsible..." : "Vendor/Supplier name..."}
                  required
                  className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900 transition-all shadow-inner" 
                  value={supplier} 
                  onChange={(e) => setSupplier(e.target.value)} 
                />
              </div>

              {!isAdjustment && (
                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 text-left">Invoice Number</label>
                  <input 
                    type="text" 
                    placeholder="Enter Invoice Number..." 
                    className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-600 outline-none font-bold text-slate-900 transition-all shadow-inner" 
                    value={invoiceNumber} 
                    onChange={(e) => setInvoiceNumber(e.target.value)} 
                  />
                </div>
              )}

              <div className="pt-4 flex gap-4">
                <button type="button" onClick={() => setShowAddModal(false)} className="flex-1 py-4 border border-slate-200 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest hover:bg-slate-50 transition-all">Cancel</button>
                <button 
                  type="submit" 
                  className={`flex-1 py-4 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl transition-all active:scale-95 disabled:bg-slate-200 disabled:shadow-none disabled:text-slate-400 ${isAdjustment ? 'bg-rose-600 shadow-rose-100 hover:bg-rose-700' : 'bg-indigo-600 shadow-indigo-100 hover:bg-indigo-700'}`}
                >
                  Review Entry
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showConfirmModal && (selectedPart || selectedRM) && (
        <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-xl flex items-center justify-center z-[110] p-4 text-left">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full overflow-hidden animate-in slide-in-from-bottom-8">
            <div className={`p-8 text-white text-left ${isAdjustment ? 'bg-rose-600' : 'bg-indigo-600'}`}>
              <h3 className="text-2xl font-black uppercase tracking-tight leading-none text-left">
                {isAdjustment ? 'Confirm Discrepancy Control Entry' : 'Confirm Receipt'}
              </h3>
              <p className="text-[10px] font-black uppercase tracking-widest opacity-70 mt-1 text-left">Database Audit Trail Log Event</p>
            </div>
            <div className="p-8 space-y-6 text-left">
              <div className="grid grid-cols-2 gap-4 text-left">
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 text-left">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 text-left">Quantity</p>
                  <p className={`text-2xl font-black ${isAdjustment ? 'text-rose-600' : 'text-indigo-600'}`}>
                    {addQty} {inventoryMode === 'item' ? 'Pcs' : 'Pipes'}
                  </p>
                  {inventoryMode === 'rm' && selectedRM && (
                    <p className="text-xs text-slate-500 font-bold mt-1">
                      = {((parseFloat(addQty) || 0) * ((selectedRM.length * selectedRM.weightPer1000) / 1000)).toFixed(2)} Kg
                    </p>
                  )}
                </div>
                
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 text-left">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 text-left">
                    {isAdjustment ? 'Responsible Name' : 'Supplier'}
                  </p>
                  <p className="text-sm font-black text-slate-800 uppercase truncate">{supplier}</p>
                  {!isAdjustment && invoiceNumber && (
                    <div className="mt-2 pt-2 border-t border-slate-100">
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Invoice Number</p>
                      <p className="text-xs font-black text-indigo-600 uppercase tracking-tight">{invoiceNumber}</p>
                    </div>
                  )}
                </div>
              </div>

              {selectedPartRMInfo && selectedPartRMInfo.length > 0 && (
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 text-left space-y-3">
                  <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-0.5">Auto-Converted RM Equivalent (Logs & Balance)</p>
                  <div className="space-y-4">
                    {selectedPartRMInfo.map((info, idx) => (
                      <div key={idx} className="border-l-4 border-indigo-500 pl-4 py-1.5 space-y-1">
                        <div className="flex justify-between items-baseline">
                          <span className="text-sm font-black text-slate-800 capitalize">{info.rmSize} <span className="opacity-60 text-[9px] font-bold">({info.customerName})</span></span>
                          <span className="text-sm font-black text-indigo-600">
                            {info.pipesQty > 0 ? '+' : ''}{info.pipesQty} Pipes
                          </span>
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400 font-bold">
                          <span>Yield Factor: {info.yieldFactor} Pcs/Pipe</span>
                          <span className="text-emerald-600 font-extrabold">({info.kgQty > 0 ? '+' : ''}{info.kgQty} Kg)</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {isAdjustment && (
                <div className="p-4 bg-rose-50/50 rounded-2xl border border-rose-100 text-left">
                  <p className="text-[10px] font-black text-rose-600 uppercase tracking-widest mb-1 text-left">Remarks & Justification</p>
                  <p className="text-sm font-bold text-slate-800 italic leading-tight">"{remarks}"</p>
                </div>
              )}
            </div>
            <div className="p-8 bg-slate-50 border-t border-slate-100 flex gap-4">
              <button onClick={() => setShowConfirmModal(false)} className="flex-1 py-5 border-2 border-slate-100 rounded-2xl font-black text-slate-500 uppercase text-[11px] tracking-widest hover:bg-white">Modify</button>
              <button onClick={handleFinalConfirm} className={`flex-[2] py-5 text-white rounded-2xl font-black uppercase text-[11px] tracking-widest shadow-xl active:scale-95 ${isAdjustment ? 'bg-rose-600' : 'bg-slate-900'}`}>Post to Database</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Inventory;
