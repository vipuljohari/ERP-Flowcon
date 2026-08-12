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
  store: ['dashboard', 'inventory', 'inward_logs', 'item_master'],
  accounts: ['dashboard', 'sales', 'data_mgmt', 'customer_master', 'import_issues'],
  ppc: ['dashboard', 'schedule', 'dispatch_daily', 'sales', 'inventory', 'analytics'],
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

export interface Part {
  id: string;
  name: string;
  sku: string;
  sapCode: string;
  category: string;
  rate: number; // Base rate for valuation
  customerRates: Record<string, number>; // Mapping: { 'Customer Name': 1200.50 }
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
}

export interface RawMaterial {
  id: string;
  size: string;
  length: number; // in mm
  weightPer1000: number; // Kg per 1000 mm
  customerName: string; // Mapped customer
  partId: string; // Mapped Item/part ID from item master
  partName: string; // Mapped Item/part Name
  stock: number; // Current stock (can be in Kg or number of bars. We will represent as total weight in Kg, or tracked as starting/current bars)
  partIds?: string[]; // Mapped Item/Part IDs from item master
  sortOrder?: number; // Admin-controlled manual display order
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