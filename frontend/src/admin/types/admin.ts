// Auth
// The one login-shaped payload: /auth/login and /auth/change-password both
// answer with this, so the client stores a token exactly one way. (/auth/demo
// was the third; the demo account is retired.)
export interface AuthResponse {
  token: string;
  user: UserInfo;
  /**
   * True while the account owes a forced password reset. The server's 403
   * `password_change_required` gate is the real enforcement; this flag is the
   * front door that shows the screen without waiting for a rejected request.
   */
  must_change_password?: boolean;
}

export interface UserInfo {
  id: string;
  username: string;
  // Exactly the `user_role` enum in api/app/models/user.py. 'owner' arrived
  // with alembic 022 (matthew); 'company' became 'user' in alembic 043, when
  // customers got a front door. The console DOES branch on this:
  // `@admin/services/permissions.canDeleteMessages` gates the message inbox's
  // delete affordances on `owner`, and ProtectedRoute routes 'user' to the
  // /account mount (the server's 403s are the real enforcement in both cases),
  // so the union must not lie about what can arrive.
  // 'viewer' (alembic 051) is read-only staff: the /admin mount opens, every
  // write is a 403 read_only from the server. `isReadOnly` on AuthContext is
  // the client-side mirror.
  role: 'admin' | 'user' | 'owner' | 'viewer';
  supplier_id?: string;
  /**
   * Present on GET /auth/me only; the nested `user` of a login response omits
   * it (the flag rides at the top level there). `?:` catches the missing key,
   * so read it with `Boolean(...)` rather than trusting the shape.
   */
  must_change_password?: boolean;
  /**
   * The account's real address — the login key since alembic 022. Present on
   * GET /auth/me only. The Settings screen used to print a hardcoded
   * `matt@circuitcenter.ai` here that matched neither an account nor a mailbox.
   */
  email?: string;
  /**
   * The sign-in BEFORE the current session, and the address it came from
   * (alembic 024). Deliberately the previous one, not this one: "you signed in
   * four seconds ago" is not information, whereas the session before this is
   * how somebody notices access that was not theirs.
   *
   * `null` means never recorded — a first-ever sign-in, or an account that
   * predates 024. `?: T | null` because Python's None arrives as JSON null,
   * which a bare `?:` would let through; read it with `!= null`.
   *
   * The address is canonicalized by the same helper the rate limiter buckets
   * on, so an IPv6 client shows as its /64 network rather than a bare host.
   */
  previous_login_at?: string | null;
  previous_login_ip?: string | null;
}

// Dashboard
export interface DashboardStats {
  parts_count: number;
  suppliers_count: number;
  manufacturers_count?: number;
  revenue_total: number;
  sponsors_count: number;
  // Sum of Revenue.amount whose period covers the CURRENT calendar month in
  // America/New_York. Server float()-casts it — a Postgres NUMERIC would
  // otherwise arrive as a JSON string despite this `number` type.
  monthly_revenue: number;
}

export interface ActivityItem {
  type: string;
  description: string;
  created_at: string | null;
  // Set only on supplier-sync rows (`part_synced` carries the feed's part
  // photo); the part/revenue sources always send null. `| null` is required —
  // `?:` alone would let Python's None through untyped.
  image_url?: string | null;
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

// ── Dashboard overhaul (2026-07-30) ────────────────────────────────────────
// Every dollar field below is float()-cast server-side. Every "today" /
// "current month" / day bucket is America/New_York (zoneinfo), NOT UTC — a
// UTC-bucketed chart shifts the last point by a day for five hours each night.

/** One day bucket. `day` is `YYYY-MM-DD` in EST. */
export interface TrendPoint {
  day: string;
  value: number;
}

/**
 * GET /api/dashboard/trends?days=30
 *
 * parts / suppliers / sponsors are CUMULATIVE counts (rows with
 * `created_at <= day`, forward-filled). revenue is the daily sum, traffic the
 * daily PageView count — both 0-filled. EVERY series has exactly `days`
 * points ending today (EST), with no gaps, so the arrays are index-aligned and
 * a chart can zip them without a date join.
 */
export interface DashboardTrends {
  days: number;
  series: {
    parts: TrendPoint[];
    suppliers: TrendPoint[];
    sponsors: TrendPoint[];
    revenue: TrendPoint[];
    traffic: TrendPoint[];
  };
}

export type TrendSeriesKey = keyof DashboardTrends['series'];

/** Day-of-month bucket inside a MonthlyCompareMonth. `day` is 1..days_in_month. */
export interface MonthlyDailyPoint {
  day: number;
  value: number;
}

export interface MonthlyCompareMonth {
  /** `YYYY-MM`. */
  key: string;
  /** Display label, e.g. "July". */
  label: string;
  /** One entry per day of that month; 0 for future/absent days. */
  daily: MonthlyDailyPoint[];
}

/**
 * GET /api/dashboard/revenue-compare?months=3  AND
 * GET /api/dashboard/expenses?months=3  — identical wire shape, hence one type.
 * NEWEST MONTH FIRST.
 */
export interface MonthlyCompare {
  months: MonthlyCompareMonth[];
}

export interface SalesRepCustomer {
  company: string;
  /** Server normalizes casing (`initcap`) before sending. An unrecognized
   *  value still renders — `tierColor()` falls back to the neutral slate. */
  tier: SponsorTier;
  /** Sponsor.amount when set, else a TIER DEFAULT (Platinum 2500 / Gold 900 /
   *  Silver 300). Those defaults are PLACEHOLDER constants living server-side —
   *  revisit with real pricing before this drives anything but a demo chart. */
  amount: number;
}

export interface SalesRep {
  name: string;
  total: number;
  customers: SalesRepCustomer[];
}

/** GET /api/dashboard/sales-reps — ACTIVE sponsors (status Active OR NULL) that
 *  carry `sold_by`, grouped by `sold_by`. */
export interface SalesRepsResponse {
  reps: SalesRep[];
}

/** GET /api/admin/sales-reps — usernames of admin-role Users; the `sold_by`
 *  options for the sponsor form. */
export interface SalesRepOptions {
  reps: string[];
}

export type ExpenseCategory =
  | 'infrastructure'
  | 'ai'
  | 'email'
  | 'domain'
  | 'payment'
  | 'other';

/** One vendor line inside a breakdown category — the itemization behind the
 *  comma-joined `vendor` string.
 *
 *  GOTCHA: `vendor` is serialized as NULL (never omitted) for an unattributed
 *  row, and a `vendor?: string` would let that null past `?:`, which only
 *  catches `undefined`. */
export interface ExpenseBreakdownVendor {
  vendor: string | null;
  amount: number;
  /** Where the row came from — `manual` | `estimate` | `aws` | `stripe` |
   *  `anthropic`. A free string: the nightly cost sync may add sources this
   *  build has never heard of, and an unknown one must not fail a render. */
  source: string;
}

export interface ExpenseBreakdownRow {
  category: string;
  label: string;
  amount: number;
  /** Vendors sharing this category, comma-joined by the server. May be "". */
  vendor: string;
  /** True only when EVERY backing row is the list-price estimate — a category
   *  with one real synced invoice in it is NOT an estimate.
   *
   *  Optional because it post-dates the endpoint: a payload without it (demo
   *  data, a cached older response) falls back to the static
   *  `EXPENSE_CATEGORY_META.estimated` flag. */
  estimated?: boolean;
  vendors?: ExpenseBreakdownVendor[];
}

/** GET /api/dashboard/expenses/breakdown[?month=YYYY-MM] — ONE month, grouped
 *  by category (one entry per category, sorted by amount desc). */
export interface ExpensesBreakdown {
  /** `YYYY-MM`. */
  month: string;
  /** `August 2026`, rendered server-side. Optional: pre-pager payloads and the
   *  demo generator omit it. */
  label?: string;
  total: number;
  categories: ExpenseBreakdownRow[];
  /** Every month that actually HOLDS rows — desc, distinct, capped at 24, and
   *  independent of the month being served, so the pager can be built from any
   *  response. Optional for the same reason as `label`. */
  available_months?: string[];
}

/**
 * GET /api/admin/expenses — a monthly recurring cost row.
 *
 * GOTCHA: `amount` is a Postgres NUMERIC, so it arrives as a JSON STRING
 * ("42.00") at runtime despite this `number` type — exactly like
 * `AdminSponsor.amount`. Coerce with `Number()` before ANY compare / sum /
 * bucket / sort, or it string-compares ("9" > "10").
 */
export interface AdminExpense {
  id: string;
  category: ExpenseCategory;
  vendor: string | null;
  amount: number;
  description: string | null;
  /** `YYYY-MM-DD`. Both required server-side (a `date`, not nullable). */
  period_start: string;
  period_end: string;
  created_at: string | null;
  /** Row provenance: 'manual' (typed by a person) | 'estimate' (seeded
   *  stand-in) | 'aws' | 'stripe' | 'anthropic' (machine-synced). Synced
   *  rows are re-written by the hourly job: editing one promotes it to
   *  'manual' (the human takes ownership), deleting one is refused (409). */
  source: string;
}

/** POST /api/admin/expenses/ body. `vendor`/`description` are optional
 *  server-side; the period bounds and the amount are not. */
export interface ExpenseCreate {
  category: ExpenseCategory;
  vendor?: string | null;
  amount: number;
  description?: string | null;
  period_start: string;
  period_end: string;
}

/** PATCH /api/admin/expenses/{id} body — any partial subset. An OMITTED field
 *  is left untouched (the router uses `exclude_unset`); an explicit `null`
 *  clears it. */
export type ExpenseUpdate = Partial<ExpenseCreate>;

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
  image_url: string | null;
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
  // ── Segment + geo additions (migration 040, 2026-08-21) ──────────────────
  /** The segment this response was aggregated for. Server default: humans. */
  segment: 'humans' | 'bots' | 'all';
  /** Window totals INDEPENDENT of the chosen segment (toggle badges). */
  human_views: number;
  bot_views: number;
  /** Named crawler families in the window — always the bots, whatever the
   *  segment toggle shows elsewhere. */
  crawlers: Array<{ family: string; views: number; sessions: number; last_seen: string | null }>;
  /** Segment-filtered visitors by ISO alpha-2 country. Forward-only data:
   *  rows older than migration 040 have no country. */
  countries: Array<{ code: string; views: number; visitors: number }>;
  geo_unknown_views: number;
  geo_tracked_since: string | null;
  // ── The drill-down layers (region capture, 2026-08-30) ───────────────────
  // Windowed and segmented exactly like `countries`, and OPTIONAL: an API
  // that predates region capture omits them entirely, and the panel has to
  // render its collecting state rather than an empty country.
  //
  // The United States ships INLINE here because it is the map's landing
  // drill-down and the panel opens it without a second round trip. Every
  // OTHER country comes from GET /dashboard/geo/{code}, built by the same
  // two server-side helpers — see `CountryGeo` in adminApi.ts.
  /** Segment-filtered US views by state NAME ("New York"), views desc. */
  us_states?: GeoRegionRow[];
  /** Top 60 US cities with 2-decimal centroid lat/lng. */
  us_cities?: GeoCityRow[];
  /** ISO alpha-2 of every country with at least one region-stamped view in
   *  this window and segment — the set the map may offer a drill-down into.
   *  Without it the panel would have to CLICK to find out, and a country
   *  whose every view is country-lite would open onto an empty choropleth: a
   *  dead door a reader cannot tell from a slow one. Optional, and an API
   *  that omits it degrades to offering the United States alone, which is
   *  what the panel did before every country drilled in. */
  region_countries?: string[];
  /** First day a page view could carry a state. Null while none has. */
  region_tracked_since?: string | null;
  // ── Density heat layer (2026-08-30) ──────────────────────────────────────
  /** How many identified towns the density map would draw — a COUNT, not the
   *  rows. The density view is behind a pill and its Leaflet chunk is already
   *  fetched on demand, so its data is too (GET /dashboard/towns); this
   *  number exists only so the panel knows whether to offer the entrance,
   *  the same job `region_countries` does for the drill-down.
   *
   *  It replaced a `heat_points` array of bare [lat, lng, views] triples when
   *  the density layer gained identity — the payload got smaller, and a click
   *  on the map can now say which town it hit.
   *
   *  Optional like the fields above: an API that predates it omits the field,
   *  and the panel simply does not offer the view. */
  located_towns?: number;
}

/** One first-level subdivision — a US state, a Canadian province, a Japanese
 *  prefecture — named exactly as DB-IP wrote it. Shared by the inline US
 *  layer and the per-country route, because the server builds both from one
 *  helper and a type that let them drift would hide it. */
export interface GeoRegionRow {
  name: string;
  views: number;
  visitors: number;
}

/** One town bubble: a 2-decimal centroid plus the visitor intel the map's
 *  city card reads.
 *
 *  Everything after `views` is OPTIONAL on two counts: an API that predates
 *  the intel fields omits them, and the card simply draws fewer sections.
 *  Typed `?: T | null` rather than bare `?:` on purpose — `?:` catches only
 *  `undefined`, and Python `None` arrives as JSON `null` (CLAUDE.md), so
 *  every read guards with `!= null` / a length check. */
export interface GeoCityRow {
  city: string;
  region: string | null;
  /** ISO alpha-2. Constant inside a country drill-down and load-bearing in the
   *  GLOBAL town list, where (city, region) alone would fold London Ontario
   *  into London England. Optional because it post-dates the field set. */
  country?: string | null;
  lat: number;
  lng: number;
  views: number;
  visitors?: number | null;
  /** Last page view from this city, UTC. */
  last_seen?: string | null;
  networks?: Array<{ name: string; views: number }> | null;
  devices?: Array<{ type: string; views: number }> | null;
  /** Busiest literal client addresses (migration 050) — forward-only, so a
   *  town whose views all predate capture carries an empty list or nothing. */
  addresses?: Array<{ ip: string; views: number }> | null;
}

export type AnalyticsSegment = AnalyticsData['segment'];

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
  contact_role: string | null;
  coverage_hours: string | null;
  description: string | null;
  logo_url: string | null;
  brand_primary: string | null;
  brand_secondary: string | null;
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

// Sponsors (admin) — API-backed via adminApi's sponsor routes.
// XOR constraint: exactly one of category_id or keyword must be set.
//
// `tier`/`status` are typed as string-literal unions for exhaustive badge
// styling on the list page; the backend sends exactly these values. The
// backend contract types them as plain strings, so the unions are a stricter
// client-side narrowing — `status` is nullable to match the contract.
export type SponsorTier = 'Platinum' | 'Gold' | 'Silver';
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
  brand_primary: string | null;
  brand_secondary: string | null;
  // ADMIN-ONLY. Present on AdminSponsorCreate/Update/Response, and DELIBERATELY
  // absent from the public `SponsorResponse` in schemas/sponsor.py that
  // routes/sponsors.py serves unauthenticated — who sold a placement is not
  // public. Optional here (`?: string | null`) so existing sponsor-object
  // literals keep compiling; `?:` alone would miss a JSON `null`, hence the
  // explicit `| null` per the repo's `?: T | null` rule.
  sold_by?: string | null;
}

// ── Distributor feed credentials (GET/PUT/DELETE /api/admin/feed-credentials) ─
// The status shape carries NO key: the stored value never leaves the server.
// `source` says which one a sync would actually use, and `last4` is filled ONLY
// for a database-stored key — four characters of the server's own environment
// secret would be a leak the admin cannot even rotate from this screen.

export type FeedCredentialSource = 'database' | 'environment';

/**
 * `GET/PATCH /api/suppliers/{id}/feed-settings` — what the nightly-import
 * switch renders from, and nothing else (no key ever rides in this payload).
 *
 * `provider` is the feed that covers this supplier, or `null` when none does —
 * spelled `| null` because Python's `None` arrives as JSON `null`, which a bare
 * `?:` would wave through. `key_configured` is about THAT provider's key, so a
 * supplier can have a provider and still be unrunnable. `auto_import_enabled`
 * is reported as STORED even when the run could not happen right now: a key
 * removed after the fact must not silently flip the operator's switch.
 */
export interface FeedSettings {
  provider: string | null;
  key_configured: boolean;
  auto_import_enabled: boolean;
}

export interface FeedCredentialStatus {
  provider: string;
  label: string;
  configured: boolean;
  // `?: T | null` per the repo rule — Python `None` arrives as JSON `null`,
  // which a bare `?:` would let through untyped.
  source?: FeedCredentialSource | null;
  last4?: string | null;
  updated_at?: string | null;
}

// ── Social / ad engagement (frontend-only contract; no backend yet) ─────────
// Re-exported TYPE-ONLY so `@admin/types/admin` stays the one import site for
// admin wire types while the values (SOCIAL_PLATFORMS, PLATFORM_META,
// isSocialPlatform) keep their own module — a value re-export here would give
// this otherwise type-only file a runtime footprint in every bundle that
// touches it. Import the values from '@admin/types/engagement' directly.
export type {
  SocialPlatform,
  PlatformMeta,
  PlatformEngagementPoint,
  PlatformEngagementSeries,
} from '@admin/types/engagement';
