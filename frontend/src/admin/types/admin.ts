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
  sku: string;
  slug?: string | null;
  manufacturer_name: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  category_slug?: string | null;
  category_icon: string | null;
  parent_category_name: string | null;
  parent_category_slug?: string | null;
  parent_category_icon: string | null;
  // Denormalized pointer at the parent category's subs[].slug — null when
  // the part is classified at top-level only (no subcategory).
  sub_slug?: string | null;
  best_price: number | null;
  total_stock: number | null;
  datasheet_url: string | null;
  lifecycle_status: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface PartDetail extends Part {
  listings: PartListing[];
}

// Analytics
export interface AnalyticsData {
  period_days: number;
  total_views: number;
  unique_visitors: number;
  avg_pages_per_visit: number;
  daily_traffic: Array<{ day: string; views: number; visitors: number }>;
  top_pages: Array<{ path: string; views: number; visitors: number }>;
  referrers: Array<{ source: string; views: number }>;
  devices: Array<{ type: string; count: number }>;
  browsers: Array<{ name: string; count: number }>;
  top_parts: Array<{ path: string; views: number }>;
  top_categories: Array<{ path: string; views: number }>;
  daily_devices: Array<{ day: string; desktop: number; mobile: number; tablet: number }>;
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
  contact_name: string | null;
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

// A Featured supplier on a category — id + name. The id lets the admin
// "Unfeature" button target the exact CategorySupplier row (names alone
// collide: Supplier.name has no unique constraint).
export interface FeaturedSupplier {
  id: string;
  name: string;
}

// Categories (from public API)
export interface AdminCategory {
  id: string;
  name: string;
  slug: string;
  icon: string;
  parts_count: number;
  featured_supplier_name?: string | null;
  // All Featured CategorySuppliers for this category, ordered by rank ASC
  // (lowest rank first). 2026-06-02: the admin tree renders the full list;
  // `featured_supplier_name` is kept for back-compat and mirrors [0].name.
  featured_suppliers?: FeaturedSupplier[];
  children: Array<{
    id: string;
    name: string;
    slug: string;
    icon: string;
    parts_count: number;
    featured_supplier_name?: string | null;
    featured_suppliers?: FeaturedSupplier[];
  }>;
}

// Sponsors (admin) — API-backed via adminApi (`/admin/sponsors/...`).
// XOR constraint: exactly one of category_id or keyword must be set.
//
// `tier`/`status` are typed as string-literal unions for exhaustive badge
// styling on the list page; the backend sends exactly these values. The
// backend contract types them as plain strings, so the unions are a stricter
// client-side narrowing — `status` is nullable to match the contract.
export type SponsorTier = 'Featured' | 'Platinum' | 'Gold' | 'Silver';
export type SponsorStatus = 'Active' | 'Paused' | 'Expired';

export interface AdminSponsor {
  id: string;
  supplier_id: string;
  supplier_name: string;
  tier: SponsorTier;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  keyword: string | null;
  start_date: string | null;
  end_date: string | null;
  amount: number | null;
  status: SponsorStatus | null;
  description: string | null;
  image_url: string | null;
}
