/**
 * The customer console's wire shapes — GET /api/account/*.
 *
 * Every one of these is the SAME row the admin console renders, filtered
 * server-side to the caller's own company (`app/services/account_scope.py`).
 * So where a shape is genuinely identical it is REUSED rather than re-typed:
 * `/account/parts` returns `routes.parts.part_to_dict`, the exact serializer
 * behind the admin parts list, and `/account/suppliers` returns
 * `routes.suppliers.supplier_to_dict`. A second declaration of a shape that is
 * already declared is how a field ends up rendered on one page and missing on
 * another.
 *
 * Nullability is transcribed from the routes, not guessed: Python `None`
 * arrives as JSON `null`, which `?:` alone does not catch.
 *
 * Capability is TWO LINKS, never a type (spec §1). `users.supplier_id` set
 * means distributor, `users.manufacturer_id` set means manufacturer, and both
 * set is the normal case for the largest players — so nothing here, and
 * nothing reading it, may branch as `if supplier … else if manufacturer`.
 */

import type { AdminSupplier, PaginatedResponse, Part } from '@admin/types/admin';

/**
 * The account's tier, DERIVED from the highest ACTIVE sponsorship its linked
 * supplier holds (`app/services/account_tier.py`). There is no tier column, so
 * this cannot drift; everyone with no placement is `free`.
 */
export type AccountTier = 'free' | 'silver' | 'gold' | 'platinum';

/** GET /api/account/dashboard — the console's tiles, all five scoped. */
export interface AccountDashboard {
  total_parts: number;
  active_sponsorships: number;
  /** Sum of the caller's ACTIVE sponsorship amounts, already a float. */
  monthly_spend: number;
  unread_messages: number;
  tier: AccountTier;
}

/** Query for GET /api/account/parts. `per_page` is capped at 100 server-side. */
export interface AccountPartsQuery {
  page?: number;
  per_page?: number;
  /** Matched against sku OR description, and it can only ever REMOVE rows. */
  search?: string;
  category_id?: string;
}

/**
 * GET /api/account/parts — a drop-in for the admin parts list's page shape.
 * A distributor gets the parts they carry, a maker the parts they make, an
 * account holding both links the union (each part once), and a free account an
 * empty page rather than the public catalog.
 */
export type AccountPartsPage = PaginatedResponse<Part>;

/**
 * One row of GET /api/account/categories.
 *
 * `parts_count` is the caller's SLICE of that category, never the category's
 * own total — a distributor carrying three of a subcategory's four parts sees
 * 3. Categories holding none of their parts are absent, not listed at zero.
 */
export interface AccountCategory {
  id: string;
  name: string;
  slug: string;
  /** `categories.icon` is nullable in the schema despite its seed default. */
  icon: string | null;
  parent_id: string | null;
  parent_name: string | null;
  parent_slug: string | null;
  parts_count: number;
}

export interface AccountCategoriesResponse {
  /** Sorted count DESC, then name. */
  categories: AccountCategory[];
  total: number;
}

/**
 * A maker, as GET /api/account/manufacturers and /my-manufacturing send it.
 *
 * Deliberately narrow: `manufacturers` is also the Leads CRM's universe, so
 * every field here is one the public site would show plus the caller's own
 * count. Growing it is a privacy decision.
 */
export interface AccountManufacturer {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  logo_url: string | null;
  parts_count: number;
}

export interface AccountManufacturersResponse {
  /** The makers whose products this DISTRIBUTOR sells. Empty without a
   *  supplier link — a maker's own company is /my-manufacturing. */
  manufacturers: AccountManufacturer[];
  total: number;
}

/**
 * A distributor, as GET /api/account/suppliers and /my-supply send it.
 *
 * `supplier_to_dict` plus a count, so the admin supplier shape is reused —
 * minus the three fields that serializer does not carry, which would type a
 * key that never arrives.
 */
export interface AccountSupplier
  extends Omit<AdminSupplier, 'parts_count' | 'revenue_total' | 'categories'> {
  /**
   * On /account/suppliers this is how many of the CALLER'S parts that
   * distributor lists, not the size of their shelf. On /my-supply it is the
   * caller's own shelf.
   */
  parts_count: number;
}

export interface AccountSuppliersResponse {
  /** The distributors selling this MANUFACTURER's products. Empty without a
   *  manufacturer link, however much the account carries as a distributor. */
  suppliers: AccountSupplier[];
  total: number;
}

/** Which side of the sponsor XOR a placement sits on — null when neither is
 *  set (the XOR is a Postgres CHECK that SQLite skips; never guess). */
export type AccountPlacementType = 'category' | 'keyword';

/**
 * One row of GET /api/account/sponsors — every placement the company holds,
 * live AND lapsed. Not filtered to active on purpose: the expired one is
 * usually why they came to the page.
 */
export interface AccountSponsorship {
  id: string;
  /**
   * Normalized lowercase server-side, but a FREE STRING with no enum behind
   * it — compare case-insensitively rather than against a literal union.
   */
  tier: string;
  /** The category name, or the keyword. Null when the row has neither. */
  placement: string | null;
  placement_type: AccountPlacementType | null;
  /** 'Active' | 'Paused' | 'Expired' in practice; NULL in the DB reads as
   *  Active, and the server has already applied that default. */
  status: string;
  is_active: boolean;
  amount: number | null;
  /** ISO dates (YYYY-MM-DD). */
  start_date: string | null;
  end_date: string | null;
  description: string | null;
}

/**
 * One row of the customer's own inbox.
 *
 * `type` is a plain string and `payload` is untyped JSON, deliberately: this
 * is NOT the staff `Message` union. The console's staff types enumerate the
 * six kinds the public forms write, while this inbox is specified to carry
 * updates, receipts and payment confirmations that do not exist yet — typing
 * it as the closed union would declare a future row impossible while it sat
 * there on screen. Narrow at the render site.
 *
 * It also omits `seq`, which is a GLOBAL counter across every message in the
 * table: handing it to a customer would publish the company's total inbound
 * volume and, across two logins, its rate.
 */
export interface AccountMessage {
  id: string;
  type: string;
  read: boolean;
  /** ISO timestamp. */
  created_at: string;
  payload: Record<string, unknown>;
}

/**
 * PATCH /api/account/messages/{id} body. EXACTLY this — the endpoint is
 * `extra="forbid"`, so naming a staff field (`status`, `assigned_to`) is a
 * 422 rather than a silently dropped key.
 */
export interface AccountMessageUpdate {
  read: boolean;
}

// ─── The customer dashboard board ───────────────────────────────────────────
//
// Ten scoped panels, all under /api/account and all gated by
// `require_account_user`. Every money field is a JSON NUMBER — the routes
// `float()` their NUMERIC columns server-side, so nothing here repeats the
// `AdminSponsor.amount` trap of a `number` that is really a string.
//
// An UNLINKED account is a 200 with zeros and empty arrays, never a 404 and
// never an error: it has bought nothing and sells nothing, which is a state.

/**
 * One entry of the KPI registry (`app/services/account_kpis.py`), as the
 * server offers it.
 *
 * `key` is a plain string, NOT a union of today's five. The registry is
 * SERVER-owned and capability-filtered — `available` is what this caller may
 * pick, and a v2 key added on the backend must render from its own `label`
 * rather than fail a client-side exhaustiveness check that no longer knows the
 * whole set. The panel therefore labels from the payload and never from a
 * table of its own.
 */
export interface AccountKpiOption {
  key: string;
  label: string;
}

/** One bar of the KPI chart. `label` is a category / company name from the
 *  catalog, so it is rendered as text and escaped in any tooltip. */
export interface AccountKpiPoint {
  label: string;
  value: number;
}

/**
 * GET /api/account/kpi, and the identical body PUT returns.
 *
 * `selected` is the persisted `users.dashboard_kpi` (or the registry default
 * for an account that has never chosen), and it is not guaranteed to appear in
 * `available` — a distributor link removed after the pick leaves the stored key
 * uncapable. The selector treats `available` as the source of options and
 * `selected` only as the current value.
 */
export interface AccountKpi {
  selected: string;
  available: AccountKpiOption[];
  points: AccountKpiPoint[];
}

/** PUT /api/account/kpi body. EXACTLY this — an unknown or uncapable key is a
 *  422 `unknown_kpi`, not a silently ignored field. */
export interface AccountKpiSelection {
  key: string;
}

/** One month of referral clicks. `month` is `YYYY-MM`. */
export interface AccountReferralMonth {
  month: string;
  clicks: number;
}

/** One day of referral clicks. `date` is `YYYY-MM-DD`, ET, zero-filled. */
export interface AccountReferralDay {
  date: string;
  clicks: number;
}

/**
 * GET /api/account/referral-clicks — buyers who left a Circuit Center part
 * page for this company's own site.
 *
 * CLICKS, not dollars. The tile these feed used to be labelled Monthly Revenue
 * on the design it inherits from; a click count captioned as money is a claim
 * nobody can stand behind, so the word Revenue never appears on this payload's
 * surfaces (spec 2026-08-25 §3).
 */
export interface AccountReferralClicks {
  /** 12 months, OLDEST first. */
  monthly: AccountReferralMonth[];
  /** 30 days, oldest first. */
  daily: AccountReferralDay[];
  total_30d: number;
}

/** One month of the caller's own revenue rows. `month` is `YYYY-MM`. */
export interface AccountRevenueMonth {
  month: string;
  amount: number;
}

/** GET /api/account/revenue — the staff Revenue chart, scoped to this
 *  supplier's `revenue` rows. 12 months, oldest first. */
export interface AccountRevenue {
  months: AccountRevenueMonth[];
  total: number;
}

/**
 * GET /api/account/sponsor-mix — an ECharts Sankey, NAME-keyed.
 *
 * Links address nodes by `name`, which is the shape ECharts wants and the
 * reason names must be unique within one payload; the server builds them that
 * way. A manufacturer-only account is legitimately empty — `sponsors.supplier_id`
 * is NOT NULL, so a maker cannot hold a placement at all — and that is a
 * sentence the panel says out loud rather than an error.
 */
export interface AccountSankeyNode {
  name: string;
}

export interface AccountSankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface AccountSponsorMix {
  nodes: AccountSankeyNode[];
  links: AccountSankeyLink[];
}

/** Which side of the catalog join a counterparty sits on. A distributor's
 *  counterparties are the makers on its shelf; a maker's are the distributors
 *  stocking it. An account holding BOTH links gets both kinds in one payload. */
export type AccountCounterpartyKind = 'manufacturer' | 'supplier';

export interface AccountBookNode {
  id: string;
  name: string;
  kind: AccountCounterpartyKind;
  parts_count: number;
}

/** Every link runs from the literal id `'center'` — the caller's own company,
 *  which is a node of the graph but not a row of `nodes`. */
export interface AccountBookLink {
  source: 'center';
  target: string;
  value: number;
}

/** GET /api/account/book-of-business — the counterparty graph, derived from the
 *  catalog joins rather than any CRM table. */
export interface AccountBookOfBusiness {
  center: { name: string };
  nodes: AccountBookNode[];
  links: AccountBookLink[];
}

/**
 * One row of GET /api/account/activity — `activity_events` scoped to the
 * caller's supplier.
 *
 * `kind` is the stored event kind (`part_imported`, `part_synced`, …), a free
 * string with no client-side union behind it; `label` is the sentence the
 * server already rendered, so the panel prints it rather than re-deriving one.
 */
export interface AccountActivityEvent {
  id: string;
  kind: string;
  label: string;
  /** ISO timestamp. */
  created_at: string;
}

export interface AccountActivityResponse {
  /** Newest first, capped at 20. */
  events: AccountActivityEvent[];
}

/**
 * The caller's `supplier_feeds` row, reduced to the two facts a customer may
 * see. Provider slugs, API keys and cursor state are deliberately absent —
 * this is a STATUS readout, and the console offers no control that could
 * change it.
 */
export interface AccountFeedState {
  auto_import_enabled: boolean;
  /** ISO timestamp, or null when the feed has never run. */
  last_synced_at: string | null;
}

/** GET /api/account/import-queue. `feed` is null for an account with no feed
 *  configured at all, which is every manufacturer and most distributors. */
export interface AccountImportQueue {
  feed: AccountFeedState | null;
}

/**
 * One line of the caller's monthly cost breakdown.
 *
 * `kind` separates the two sources that share the panel: a `subscription` is a
 * Silver/Gold/Platinum line derived from an ACTIVE sponsorship (its `category`
 * is the tier, so the row can be badged), an `expense` is one of their own
 * expense rows.
 */
export type AccountCostKind = 'subscription' | 'expense';

export interface AccountCostLine {
  category: string;
  vendor: string;
  amount: number;
  kind: AccountCostKind;
}

/** GET /api/account/operating-costs[?month=YYYY-MM]. `available_months` is
 *  DESC and lists only months that hold rows — the pager steps that list, never
 *  the calendar. */
export interface AccountOperatingCosts {
  month: string;
  available_months: string[];
  lines: AccountCostLine[];
  total: number;
}

/** One row of the leads preview. `status` is a free string the CRM owns, and
 *  null for a lead nobody has worked yet. */
export interface AccountLeadSummaryRow {
  name: string;
  status: string | null;
}

/** GET /api/account/leads-summary — the businesses THIS company wants to sell
 *  to. Empty for everyone at first; that is the normal state, not a failure. */
export interface AccountLeadsSummary {
  total: number;
  /** Newest first, at most 5. */
  recent: AccountLeadSummaryRow[];
}

// ── The customer's own expense book ─────────────────────────────────────────
//
// The SAME `expenses` table the staff book reads, split by `user_id`: the
// company's rows carry NULL, a customer's rows carry theirs (migration 045).
// That is why the two never see each other's lines, and why a row belonging to
// somebody else — the company's included — answers 404 rather than 403. A 403
// would confirm the id names something real.

/**
 * One line of the caller's own cost book.
 *
 * `amount` is a JSON number on this contract, and it is still read through
 * `Number()` at every render site: the column is Postgres NUMERIC, whose staff
 * twin arrives as a STRING for exactly that reason (CLAUDE.md). The coercion
 * costs nothing and is what stops a string comparison the day the two
 * serializations disagree.
 */
export interface AccountExpense {
  id: string;
  /** Free text — trimmed and lowercased server-side, 1–30 chars. Rendered
   *  through `expenseCategoryLabel`, which title-cases anything outside the six
   *  the staff book happens to use, so a customer's own label reads properly
   *  without being one of ours. */
  category: string;
  vendor: string | null;
  amount: number;
  /** `YYYY-MM-DD` — the month this line is filed under. */
  period_start: string;
  /** `YYYY-MM-DD`. The server defaults it to `period_start`. */
  period_end: string | null;
  description: string | null;
}

/** GET /api/account/expenses — newest `period_start` first. */
export interface AccountExpensesResponse {
  items: AccountExpense[];
  total_count: number;
}

/**
 * POST /api/account/expenses body.
 *
 * `user_id` and `source` are the SERVER's to set and are absent here on
 * purpose: 'manual' is the one source the cost sync's `reconcile_source` never
 * deletes, so a client able to name the source could have its own row swept
 * away by the next hourly pass.
 *
 * The endpoint forbids extra keys, so a stray field is a 422 rather than
 * something quietly dropped.
 */
export interface AccountExpenseCreate {
  category: string;
  amount: number;
  period_start: string;
  vendor?: string | null;
  description?: string | null;
  period_end?: string | null;
}

/** PATCH body — every field optional, same forbidden extras. An omitted field
 *  is left untouched. */
export type AccountExpenseUpdate = Partial<AccountExpenseCreate>;
