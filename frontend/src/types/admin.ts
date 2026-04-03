// Auth
export interface AuthResponse {
  token: string;
  user: UserInfo;
}

export interface UserInfo {
  id: string;
  username: string;
  role: 'admin' | 'company';
  supplier_id?: string;
}

// Dashboard
export interface DashboardStats {
  parts_count: number;
  suppliers_count: number;
  revenue_total: number;
  sponsors_count: number;
}

export interface ActivityItem {
  type: string;
  description: string;
  created_at: string | null;
}

export interface RevenueDataPoint {
  month: string;
  total: number;
  sponsorship: number;
  listing_fee: number;
  featured: number;
}

export interface PopularData {
  top_categories: Array<{ name: string; parts_count: number }>;
  top_suppliers: Array<{ name: string; listings_count: number }>;
}

// Parts
export interface PriceBreak {
  id: string;
  min_quantity: number;
  unit_price: number;
}

export interface PartListing {
  id: string;
  supplier_id: string;
  supplier_name: string | null;
  sku: string | null;
  stock_quantity: number;
  lead_time_days: number | null;
  unit_price: number;
  currency: string;
  price_breaks: PriceBreak[];
}

export interface Part {
  id: string;
  mpn: string;
  manufacturer_name: string;
  description: string | null;
  category_id: string | null;
  datasheet_url: string | null;
  lifecycle_status: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface PartDetail extends Part {
  listings: PartListing[];
}

// Pagination
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
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
  parts_count?: number;
  revenue_total?: number;
  categories?: string[];
}

// Batch import
export interface BatchImportResult {
  created: number;
  errors: Array<{ row: number; error: string }>;
}

// Categories (from public API)
export interface AdminCategory {
  id: string;
  name: string;
  slug: string;
  icon: string;
  children: Array<{
    id: string;
    name: string;
    slug: string;
    icon: string;
  }>;
}
