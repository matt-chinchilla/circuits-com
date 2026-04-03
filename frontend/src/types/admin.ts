// Auth
export interface AuthResponse {
  access_token: string;
  token_type: string;
}

export interface UserInfo {
  id: string;
  username: string;
  role: 'admin' | 'company';
  supplier_id?: string;
}

// Dashboard
export interface DashboardStats {
  total_suppliers: number;
  total_parts: number;
  total_categories: number;
  total_listings: number;
  total_revenue: number;
  active_sponsors: number;
}

export interface ActivityItem {
  id: string;
  type: 'supplier_added' | 'part_added' | 'part_updated' | 'sponsor_created' | 'import_completed';
  description: string;
  timestamp: string;
  user?: string;
}

export interface RevenueMonth {
  month: string;
  revenue: number;
  listings: number;
}

export interface PopularData {
  top_categories: Array<{ name: string; parts_count: number }>;
  top_suppliers: Array<{ name: string; revenue: number }>;
}

// Parts
export interface PriceBreak {
  min_qty: number;
  max_qty: number | null;
  unit_price: number;
}

export interface PartListing {
  id: string;
  supplier_id: string;
  supplier_name: string;
  price: number;
  stock_qty: number;
  lead_time_days: number | null;
  is_active: boolean;
  price_breaks: PriceBreak[];
}

export interface Part {
  id: string;
  mpn: string;
  manufacturer: string;
  short_description: string;
  category_id: string | null;
  category_name: string | null;
  listings_count: number;
  min_price: number | null;
  created_at: string;
}

export interface PartDetail extends Part {
  full_description: string | null;
  datasheet_url: string | null;
  specs: Record<string, string>;
  listings: PartListing[];
}

// Pagination
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

// Suppliers (extended for admin)
export interface AdminSupplier {
  id: string;
  name: string;
  phone: string | null;
  website: string | null;
  email: string | null;
  description: string | null;
  logo_url: string | null;
  is_featured: boolean;
  rank: number;
  parts_count: number;
  revenue_total: number;
}

// Batch import
export interface BatchImportResult {
  created: number;
  updated: number;
  errors: Array<{ row: number; message: string }>;
  total_processed: number;
}
