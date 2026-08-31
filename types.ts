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
  totalWeightKg?: number; // Kg — mandatory on the Add Manufacturer Invoice form going forward; optional here only so invoices saved before this field existed still type-check
  matchedCrossInvoiceId?: string; // set once a corresponding customer invoice is entered
  createdAt: string;
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
}

// Admin-only "Notifications" feed. Every entry is created by a human-
// initiated action (never the fully-automatic Tally sync) so Admin can
// cross-check/cross-question it: a negative-quantity Discrepancy Control
// Entry, a plain RM Inward entry (any quantity, any role), a manual
// Dispatch Slip posting, or a Tally Excel/XML import. Persisted in
// Firestore (see useFirestoreArray('adminAlerts') in App.tsx) so an alert
// raised from one login is visible to Admin on any other device/session.
export type AdminAlertType = 'discrepancy' | 'rm_inward' | 'item_inward' | 'dispatch_manual' | 'tally_import' | 'schedule_bulk_import' | 'rm_cross_bill';

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