export type StockStatus = 'In Stock' | 'Low Stock' | 'Out of Stock';

// --- Auth / Roles ---
export type UserRole = 'admin' | 'store' | 'accounts' | 'ppc';

export interface PendingDevice {
  token: string;
  requestedAt: string;
  userAgent: string;
}

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  companyId: string;
  active: boolean;
  createdAt: string;
  authorizedDevices?: string[]; // device tokens approved to log in as this user
  pendingDevices?: PendingDevice[]; // device tokens awaiting Admin approval
  // Single-active-session lock (Store/Accounts/PPC only — Admin is exempt).
  // Set to the device token that currently "owns" the login the moment
  // that device signs in; a login from any OTHER device is refused while
  // this is set. Cleared automatically on a clean Log Out, or manually by
  // an Admin in User Master (Release Session) if the old device wasn't
  // logged out cleanly (closed laptop, crashed browser, etc).
  activeDeviceToken?: string;
  activeSessionAt?: string; // when activeDeviceToken was last claimed, for Admin's info only
}

export interface Company {
  id: string;
  name: string;
  brandingName?: string; // shown across app UI (header, tab title, login, AI assistant). Falls back to `name` if blank.
  address: string;
  gstNumber?: string;
  plantCode?: string; // e.g. "PALWAL", useful once a second plant is added
  isActive?: boolean; // the one company/plant whose branding shows in the app
}

// Which views each role may access. 'admin' implicitly gets everything.
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ['*'],
  store: ['dashboard', 'inventory', 'inward_logs', 'sales', 'dispatch_daily', 'schedule', 'analytics', 'rm_crossbill'],
  accounts: ['dashboard', 'sales', 'data_mgmt', 'rm_crossbill', 'inventory'],
  ppc: ['dashboard', 'schedule', 'sales', 'inventory', 'analytics'],
};

export const canAccessView = (role: UserRole, viewId: string): boolean => {
  const allowed = ROLE_PERMISSIONS[role] || [];
  return allowed.includes('*') || allowed.includes(viewId);
};

export interface Customer {
  id: string;
  name: string;
  matchKeywords: string; // e.g. "PRITHLA, SKH-P"
  autoCreated?: boolean; // created automatically by the Tally connector script, not yet reviewed
  autoCreatedAt?: string;
  sortOrder?: number; // Admin-controlled manual display order
}

// Tubular = the app's original/default part shape (pipes cut to length from
// a tube RM bar). Sheet Metal = new part shape (stamped/cut from a flat
// sheet RM) — no item length, instead defined by Net/Gross weight per piece.
export type PartType = 'tubular' | 'sheet_metal';

export interface Part {
  id: string;
  name: string;
  sku: string;
  sapCode: string;
  category: string;
  rate: number; // Base rate for valuation
  customerRates: Record<string, number>; // Mapping: { 'Customer Name': 1200.50 }
  customerModels?: Record<string, string>; // Mapping: { 'Customer Name': '2DX' } — which vehicle model/platform this part belongs to, for that customer
  size: string;
  stock: number;
  inward: number;
  schedules: Record<string, number>; // Mapping: { 'SKH-PRITHLA': 500, 'SKH-JAIPUR': 300 }
  mappedCustomers: string[]; // List of customer names this part belongs to
  revisionCount: number;
  // Per-customer Monthly Schedule revision counter (Revision Level shown on
  // the Monthly Schedule screen). Keyed like `schedules` — one entry per
  // customer this part is scheduled for. A customer with no key yet (or a
  // part with no scheduleRevisions object at all) is treated as Revision 0 —
  // i.e. the schedule has never been revised since it was first set this
  // month. Reset to {} alongside `schedules` at month rollover, since a new
  // month's targets are a fresh commitment cycle, not a revision of last
  // month's. Superseded `revisionCount` (below) for this purpose — that
  // field bumped on every save including the very first entry of a new
  // cycle, which is why Revision Level used to start at 1, 3, 5, etc.
  // instead of 0. `revisionCount` is left in place, untouched, since old
  // archived months already carry it and nothing else reads it.
  scheduleRevisions?: Record<string, number>;
  minThreshold: number;
  status: StockStatus;
  lastUpdated: string;
  lastSupplier?: string;
  itemWeight?: number; // Weight in Kg
  itemLength?: number; // Length in mm
  customerRMMappings?: Record<string, string>; // Mapping of: { "Customer Name": "RM ID" }
  hasCustomScrap?: boolean; // toggle for custom end-piece scrap override
  customScrapMm?: number; // custom scrap value in mm
  sortOrder?: number; // Admin-controlled manual display order
  excludeFromBTDispatch?: boolean; // job-work exception: BT challans for this part are NOT dispatch — the real Sales Invoice after it returns from Unit 1 is what counts
  // undefined/missing = 'tubular' (every part created before this field
  // existed). See services/rmYield.ts for how this drives RM stock math.
  partType?: PartType;
  netWeight?: number; // Kg per piece — Sheet Metal only
  grossWeight?: number; // Kg per piece — Sheet Metal only (netWeight + scrap).
  // Scrap per piece is NEVER stored directly — always derive it as
  // (grossWeight - netWeight) wherever it's needed, so it can't drift out
  // of sync with the two weights it's defined from.
  // Sibling parts (e.g. an LH/RH mirror pair) that Material Entry treats as
  // one RM-cutting group — pre-checking them together and letting stock be
  // allotted across whichever of them the physical pieces actually became.
  // ALWAYS symmetric: if A lists B here, B must list A — kept in sync by
  // App.tsx's part onAdd/onEdit/onDelete handlers, never edited one-sided.
  siblingIds?: string[];
}

export interface RMManufacturerInvoice {
  id: string;
  manufacturerName: string; // e.g. "Tube Investments of India Ltd"
  customerName: string; // the reselling customer expected to cross-invoice you, e.g. "SIAC-SKH..."
  invoiceNo: string;
  date: string; // ISO
  materialName: string;
  materialCode: string;
  quantityPcs: number;
  ratePerPc: number;
  itemValue: number;
  // The next 5 fields describe the WHOLE physical shipment (one vehicle,
  // one Dharam Kanta weighment), not this one material line — every
  // RMManufacturerInvoice row saved together under the same invoice no.
  // carries the SAME values here, same as manufacturerName/invoiceNo/date
  // already do. totalWeightKg — mandatory on the Add Manufacturer Invoice
  // form going forward; optional here only so invoices saved before this
  // field existed still type-check.
  totalWeightKg?: number; // Kg — the invoice's own billed/printed weight
  actualWeightKg?: number; // Kg — the Dharam Kanta (weighbridge) actual net weight for this vehicle, entered once received
  // Set automatically when |actualWeightKg - totalWeightKg| >= the flag
  // threshold (see WEIGHT_VARIANCE_FLAG_KG in RMCrossBillCheck.tsx) at the
  // moment actualWeightKg is saved. A manually-recorded debit note (below)
  // can exist independently of this — e.g. if Admin decides not to debit
  // a small flagged variance, or debits one that didn't auto-flag.
  weightFlagged?: boolean;
  debitNoteAmount?: number; // ₹ agreed with the supplier for a short/over-weight delivery
  debitNoteRemark?: string;
  debitNoteAt?: string;
  debitNoteBy?: string;
  // Simple accounts checklist — whether this invoice has been entered in
  // Tally yet, so Admin can see at a glance what's still pending, and spot
  // anything booked while a weight flag is still unresolved.
  tallyBooked?: boolean;
  tallyVoucherNo?: string;
  tallyBookedAt?: string;
  matchedCrossInvoiceId?: string; // set once a corresponding customer invoice is entered
  createdAt: string;
  // Set true the moment this record is created — every Manufacturer
  // Invoice going forward is posted to inventory atomically, in the same
  // save, as part of RMCrossBillCheck.tsx's Manufacturer Invoice wizard
  // (see App.tsx's handleManufacturerInvoiceWithAllotment). A FALSE here
  // only ever means a legacy invoice entered under the old two-stage design
  // before that redesign shipped — there is deliberately no bridge left to
  // post one of those; the fix is deleting and re-entering it here.
  usedForMaterialEntry?: boolean;
  usedForMaterialEntryAt?: string;
}

// Mirrored automatically every hour from Tally's own Purchase vouchers by
// the Tally Connector script running on the 24x7 server (import-tally.js)
// — never written by the app itself. Lets RM Cross-Bill Check show, for
// each Manufacturer Invoice Store typed in from the paper invoice/photo,
// whether it has actually been booked in Tally yet and for how much —
// without Admin having to check and tick a box by hand.
export interface RMPurchaseVoucherItem {
  stockItemName: string; // Tally's own item/description text for this line
  quantity: number;
  rate: number;
  value: number; // quantity * rate, rounded to paise
}

export interface RMPurchaseVoucher {
  id: string;
  supplierName: string; // Tally's party ledger name for this voucher
  invoiceNumber: string; // the supplier's own invoice no. (Tally's REFERENCE / "Supplier Invoice No." field) — falls back to Tally's internal voucher number if that was left blank
  tallyVoucherNumber?: string; // Tally's own internal voucher number, kept for display
  date: string; // ISO
  items: RMPurchaseVoucherItem[];
  totalValue: number;
  isDeleted?: boolean; // cancelled in Tally after having been synced once
  lastSyncedAt: string;
}

export interface RMCustomerCrossInvoice {
  id: string;
  customerName: string;
  invoiceNo: string;
  date: string;
  refManufacturerInvoiceId: string; // links back to RMManufacturerInvoice.id
  materialName: string;
  materialCode: string;
  quantityMtr: number;
  rate: number;
  itemValue: number;
  createdAt: string;
}

// One doc per material code (doc id = materialCode) — the piece length (mm)
// entered once, reused automatically on every future invoice for that code,
// so the Pcs -> Meter conversion can be checked without re-asking each time.
export interface RMMaterialLength {
  materialCode: string;
  materialName: string;
  lengthMm: number;
  updatedAt: string;
  // Bridges this manufacturer material code to a real RawMaterial record in
  // Inventory (RM Master), so Step 2 of RM Cross-Bill Check's Manufacturer
  // Invoice wizard knows which RM's stock to bump and which Parts
  // (rm.partId/rm.partIds) are eligible to be cut from it — a material with
  // no link here hard-blocks that invoice's Save (see
  // RMCrossBillCheck.tsx). Admin sets this once per material code, the
  // same "catalog, first-entry-wins" idiom already used for lengthMm above.
  linkedRMId?: string;
}

// One admin-editable tolerance rule: a manufacturer's invoice/tag often
// states a measured dimension slightly under the RM's own nominal spec
// (normal manufacturing tolerance, e.g. a "45mm OD" tube's invoice reads
// "44.45"), and Material Entry's photo auto-fill needs to still recognise
// that as the same Raw Material rather than missing the match entirely.
// `field` says which dimension this rule is for — OD (round tube only) or
// Thickness (round or square/rectangular) — since the two are read from
// different positions in an RM's free-text `size` string. `acceptedValues`
// is an explicit list, not a formula/percentage: real tolerance bands
// aren't uniform across sizes (see services/dimensionTolerance.ts), so
// each nominal size's accepted alternates are spelled out by Admin rather
// than guessed from a general rule.
// Admin-only global settings.rmEntryMode doc — the Camera Upload / Manual
// Entry switch Admin controls from the top of the RM Approvals screen. One
// universal setting, not per-screen: it governs RM Cross-Bill Check's
// Manufacturer Invoice wizard AND Material Entry's Finished Pieces / Longer
// Pipe all at once — whatever Admin sets applies to all 3. When cameraEnabled
// is true and manualEnabled is false ("camera upload only"), Invoice No. and
// Supplier/Manufacturer Name lock to whatever the photo read — Store/PPC
// can't hand-edit them; only Admin can correct them, in the RM Approvals
// screen, before approving.
export interface RMEntryModeSettings {
  cameraEnabled: boolean;
  manualEnabled: boolean;
}

export interface DimensionTolerance {
  id: string;
  field: 'OD' | 'Thickness';
  nominal: number;
  acceptedValues: number[];
  updatedAt: string;
}

// 'tube' = the original RM shape (a fixed-length bar, tracked by
// length + weight/1000mm). 'sheet' = new RM shape for sheet metal, where
// the delivered sheet size varies every time (2500x1250, 1500x3000,
// 3000x6300, etc.) so there is no fixed "bar length" — instead identified
// by Thickness + Grade, with weight entered directly at each inward.
export type RMCategory = 'tube' | 'sheet';

export interface RawMaterial {
  id: string;
  size: string;
  length: number; // in mm
  weightPer1000: number; // Kg per 1000 mm
  customerName: string; // Mapped customer
  model?: string; // vehicle model/platform this RM belongs to, for that customer
  partId: string; // Mapped Item/part ID from item master
  partName: string; // Mapped Item/part Name
  stock: number; // Current stock (can be in Kg or number of bars. We will represent as total weight in Kg, or tracked as starting/current bars)
  partIds?: string[]; // Mapped Item/Part IDs from item master
  sortOrder?: number; // Admin-controlled manual display order
  // undefined/missing = 'tube' (every RM created before this field existed).
  category?: RMCategory;
  thickness?: string; // Sheet only, e.g. "1.6mm" — deliberately a separate
  // field from `size` rather than reusing it: `size` is shown throughout
  // the app with tube-oriented labels ("RM SIZE"), and a sheet's thickness
  // isn't the same concept as a tube's cross-section spec.
  grade?: string; // Sheet only, e.g. "IS 513 CR2"
  // `length`/`weightPer1000` above are meaningless for category==='sheet'
  // — every place that reads them must branch on category first (see
  // services/rmYield.ts), never assume a fallback like `rm.length || 6000`
  // is safe for a Sheet RM.

  // Additional customers this SAME physical RM stock is ALSO used for,
  // besides the primary `customerName` above — e.g. one bar bought once but
  // cut into parts sold onward to two plants of the same customer group
  // (SIAC Palwal + SIAC Jaipur). There is still only ONE stock number
  // (`stock` above) shared by all of them — this is NOT a second stock pool.
  // Every place that filters/attributes RM activity by customer must check
  // membership in [customerName, ...customerNames] (see rmYield.ts's
  // rmMatchesCustomer/rmAllCustomers), not just equality to `customerName`.
  customerNames?: string[];
}

export interface RMInwardLog {
  id: string;
  rmId: string;
  rmSize: string;
  quantity: number; // inward quantity (number of pieces/bars or weight in Kg)
  supplier: string;
  timestamp: string;
  remarks?: string;
  invoiceNumber?: string;
  // undefined/missing = 'pcs' (every log created before this field existed
  // — all of them are tube pipe/bar counts). Sheet Metal RM inward logs
  // set this to 'kg' since the admin types total Kg received directly.
  unit?: 'pcs' | 'kg';
  sheetSizeText?: string; // Sheet only — free text e.g. "2500x1250",
  // record-only for traceability, NEVER used in any weight/stock calc.
  // Groups every InwardLog/RMInwardLog row one Material Entry save produced
  // (Finished Pieces or Longer Pipe), so a future "view this whole receipt"
  // screen is possible without a new collection. Purely additive.
  materialEntryId?: string;
  invoiceBookedInUnit1?: boolean; // carried from the Material Entry invoice header
}

export interface Sale {
  id: string;
  partId: string;
  partName: string;
  sapCode: string;
  quantity: number;
  totalPrice: number;
  timestamp: string;
  customer: string;
  invoiceNumber?: string; // New field for duplicate prevention
}

export interface InwardLog {
  id: string;
  partId: string;
  partName: string;
  sapCode: string;
  quantity: number;
  supplier: string;
  timestamp: string;
  remarks?: string; // New field for adjustments
  invoiceNumber?: string;
  materialEntryId?: string; // groups rows from one Material Entry save — see RMInwardLog
  invoiceBookedInUnit1?: boolean;
}

// Admin-only "Notifications" feed. Every entry is created by a human-
// initiated action (never the fully-automatic Tally sync) so Admin can
// cross-check/cross-question it: a negative-quantity Discrepancy Control
// Entry, a plain RM Inward entry (any quantity, any role), a manual
// Dispatch Slip posting, or a Tally Excel/XML import. Persisted in
// Firestore (see useFirestoreArray('adminAlerts') in App.tsx) so an alert
// raised from one login is visible to Admin on any other device/session.
export type AdminAlertType = 'discrepancy' | 'rm_inward' | 'item_inward' | 'dispatch_manual' | 'tally_import' | 'schedule_bulk_import' | 'rm_cross_bill' | 'rm_weight_mismatch' | 'material_entry_scrap' | 'sibling_stock_borrow';

export interface AdminAlert {
  id: string;
  type: AdminAlertType;
  timestamp: string; // when the underlying entry was posted
  createdBy: string; // display name / station name of the user who made the entry
  role: UserRole;
  partId?: string;
  partName?: string;
  sapCode?: string;
  rmId?: string;
  rmSize?: string;
  quantity?: number;
  supplier?: string;
  remarks?: string;
  responsibleName?: string; // Discrepancy Control Entry: who is responsible for the mismatch/rejection
  invoiceNumber?: string;
  customer?: string;
  itemCount?: number; // for dispatch/import batches covering multiple parts
  details?: string; // free-text summary, e.g. a line-item breakdown for a multi-part dispatch/import
  verified?: boolean; // Admin has reviewed and confirmed this entry is correct
  verifiedAt?: string;
  verifiedBy?: string;
  flagged?: boolean; // Admin has dismissed/set this alert aside (e.g. a known duplicate, or nothing to act on) — a resolution distinct from Verify, which implies the underlying data was checked and is correct
  flaggedAt?: string;
  flaggedBy?: string;
  flagRemark?: string; // why it was flagged, e.g. "duplicate of invoice already saved"
}

export interface InventoryStats {
  totalValue: number;
  lowStockItems: number;
  outOfStockItems: number;
  totalSalesToday: number;
  overallAchievement: number;
}

export interface MonthlyArchive {
  monthKey: string; // e.g., "2024-11"
  displayName: string; // e.g., "Nov 2024"
  parts: Part[];
}

// --- RM Receiving Approval Gate ---
// Store/PPC can no longer post an RM receiving entry straight to inventory
// from any of the 3 places that used to write directly (RM Cross-Bill
// Check's Manufacturer Invoice wizard, and Material Entry's Longer Pipe /
// Finished Pieces modes) — every one of them now stages a PendingRMEntry
// instead. The real posting logic (App.tsx's handleMaterialEntryFinishedPieces
// / handleMaterialEntryLongerPipe / handleManufacturerInvoiceWithAllotment)
// is UNCHANGED and still does the actual writes to parts/rawMaterials/
// InwardLog/RMInwardLog/RMManufacturerInvoice — it just now only runs once,
// when Admin approves a pending entry, instead of the moment Store/PPC
// clicks Save. This is deliberate reuse, not a rewrite: the same
// already-validated math and alerts fire either way, just later.
export type PendingRMEntryType = 'finished_pieces' | 'longer_pipe' | 'manufacturer_invoice';

// 'pending' = normal, everything resolved to a real RM/Item, orange "Post
// for Approval" in the UI. 'not_matched' = at least one line/material
// couldn't be resolved automatically (camera couldn't match a photographed
// size, or a material code has no linkedRMId yet) — red in the UI, and
// Admin must specify which RM Master size (Longer Pipe/Manufacturer
// Invoice) or Item Master size (Finished Pieces / CTL cut pieces) it's
// actually for before it can be approved. 'approved'/'rejected' are
// terminal — an approved entry has already been posted for real by the
// handler above; a rejected one never will be.
export type PendingRMEntryStatus = 'pending' | 'not_matched' | 'approved' | 'rejected';

// Kept intentionally loose/duplicated rather than importing component-level
// line/submission shapes into this file (RMCrossBillCheck.tsx already
// imports FROM types.ts — importing back from it here would be a real
// circular import). These fields are structurally compatible with
// services/materialEntry.ts's MaterialEntryHeader/FinishedPieceLine/
// LongerPipeLine and RMCrossBillCheck.tsx's MfgInvoiceSubmission — any
// object built to match those types also satisfies these, so App.tsx's
// staging handlers can pass them straight through without a cast.
export interface PendingMaterialEntryHeader {
  supplierName: string;
  invoiceNo: string;
  date: string;
  totalWeightKg?: number;
  totalBillValue?: number;
  dharamkantaWeightKg?: number;
  invoiceBookedInUnit1: boolean;
}
export interface PendingFinishedPieceLine {
  key: string;
  partId: string;
  quantity: number;
}
export interface PendingAllottedItem {
  partId: string;
  barsAllotted?: number;
  piecesAllotted?: number;
}
export interface PendingLongerPipeLine {
  key: string;
  rmId: string; // '' when Not Matched — Admin must fill this in before approving
  barLengthMm: number;
  barsReceived: number;
  subMode: 'whole_bars' | 'split_pieces';
  allotments: PendingAllottedItem[];
  pulledFromInvoiceLineId?: string;
  autoAssign?: boolean;
}
export interface PendingMfgInvoiceLine {
  materialName: string;
  materialCode: string;
  quantityPcs: number;
  ratePerPc: number;
  itemValue: number;
  mfgLengthInput: string;
  rmId: string; // '' when Not Matched
  barLengthMm: number;
  subMode: 'whole_bars' | 'split_pieces';
  allotments: PendingAllottedItem[];
  autoAssign: boolean;
}
export interface PendingMfgInvoiceSubmission {
  manufacturerName: string;
  customerName: string;
  invoiceNo: string;
  date: string;
  totalWeightKg: number;
  actualWeightKg: number;
  weightFlagged: boolean;
  weightVarianceKg: number;
  aiExtracted: boolean;
  lines: PendingMfgInvoiceLine[];
}

export interface PendingRMEntry {
  id: string;
  entryType: PendingRMEntryType;
  status: PendingRMEntryStatus;
  submittedAt: string;
  submittedBy: string; // display name
  submittedByRole: UserRole;
  // Exactly one of these is set, matching entryType.
  finishedPiecesPayload?: { header: PendingMaterialEntryHeader; lines: PendingFinishedPieceLine[] };
  longerPipePayload?: { header: PendingMaterialEntryHeader; lines: PendingLongerPipeLine[] };
  manufacturerInvoicePayload?: PendingMfgInvoiceSubmission;
  // Free-text summary for the queue list — part/RM names, quantities — so
  // Admin doesn't have to expand every card to see what's in it.
  summary: string;
  notMatchedReason?: string; // set when status === 'not_matched'
  // Photo of the source invoice, once Dropbox archival exists — the path it
  // was saved to (Apps/Flowcon-Schedule-Export/Unit 2/Inwards/<MMM YY>/<Supplier>/...).
  // Not populated by this phase of the feature yet.
  photoDropboxPath?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
}