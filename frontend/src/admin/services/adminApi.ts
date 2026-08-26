import axios from 'axios';
import { API_BASE_URL } from '@shared/services/constants';
import type { AccountMe } from '@admin/services/accountActivation';
import type {
  AnalyticsData,
  AuthResponse,
  UserInfo,
  DashboardStats,
  ActivityItem,
  RevenueDataPoint,
  PopularData,
  Part,
  PartDetail,
  PartListing,
  PaginatedResponse,
  AdminSupplier,
  BatchImportResult,
  AdminCategory,
  AdminSponsor,
  AdminExpense,
  DashboardTrends,
  ExpenseCreate,
  ExpenseUpdate,
  ExpensesBreakdown,
  MonthlyCompare,
  SalesRepOptions,
  SalesRepsResponse,
  FeedCredentialStatus,
  FeedSettings,
} from '@admin/types/admin';
import type {
  Message,
  MessageStatus,
  AssignedTo,
  BulkDeleteResult,
} from '@admin/types/messages';
import type { PlatformEngagementSeries } from '@admin/types/engagement';
import type { AdminUser } from '@admin/types/users';
import { bustSponsorCaches } from '@admin/services/swCache';
import { isPasswordChangeRequired, passwordGate } from '@admin/services/passwordGate';
import { isReauthChallenge } from '@admin/services/reauthChallenge';

// PATCH /api/admin/messages/{id} body — subset of MessageBase the admin UI can
// mutate. Mirrors the contract Agent A is building in the backend.
export interface MessageUpdate {
  status?: MessageStatus;
  assigned_to?: AssignedTo;
  last_reply_body?: string;
}

// POST /api/admin/sponsors/ body — an AdminSponsor without the server-assigned
// id. PATCH accepts any partial subset of these fields.
export type SponsorCreate = Omit<AdminSponsor, 'id'>;

// One entry of the POST /api/admin/presence/ping roster — an admin who has
// heartbeated within the backend's 75s TTL. The CALLER is included in the
// response (PresenceBubbles filters itself out). `name` is null until the User
// model grows a display name; the UI falls back to `username`.
export interface PresenceUser {
  user_id: string;
  username: string;
  name?: string | null;
  role: string;
}

// POST /api/parts/{part_id}/listings body. Only supplier_id is required; the
// backend defaults stock to 0, price to 0, and currency to USD.
export interface PartListingCreate {
  supplier_id: string;
  stock_quantity?: number;
  unit_price?: number;
  listing_sku?: string | null;
  lead_time_days?: number | null;
  currency?: string;
}

// GET /api/admin/quote-ladder — the fixed all-in price ladder (tax-inclusive
// monthly totals in whole DOLLARS; first step is the list price). Single home
// is the backend's QUOTE_LADDER; the UI never hardcodes a step.
export interface QuoteLadderResponse {
  tiers: Record<string, { list: number; steps: number[] }>;
}

// One row of GET /api/admin/sponsors/{id}/quotes. `amount_total` is CENTS.
export interface SponsorQuote {
  quote_id: string;
  number: string | null;
  status: string;
  amount_total: number;
  created?: number | null;
}

// No email field ON PURPOSE: quotes bill to the supplier's email on file —
// a per-quote override would create quotes the sponsor's list view (keyed on
// that same email) could never find or accept. Fix the supplier record.
export interface QuoteCreateBody {
  monthly_total: number;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postal_code: string;
  };
}

export interface QuoteCreateResult {
  quote_id: string;
  number: string | null;
  amount_total: number;
  customer_id: string;
  status: string;
}

const adminClient = axios.create({ baseURL: API_BASE_URL });

/** The Bearer header for the admin session — the ONE reader of the token
 * storage key. Non-axios transports (syncStream's streaming fetch) consume
 * this too, so a change to where the token lives cannot silently miss one. */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('admin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Retire the session token (expired/revoked 401) — shared with streaming
 * transports for the same single-owner reason as `authHeaders`. */
export function onUnauthorized(): void {
  localStorage.removeItem('admin_token');
}

adminClient.interceptors.request.use((config) => {
  const auth = authHeaders();
  if (auth.Authorization) {
    config.headers.Authorization = auth.Authorization;
  }
  return config;
});

adminClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    // Every 401 retires the session EXCEPT the Danger Zone's re-auth, whose
    // 401 says "that is not your password", not "your session is over".
    // Dropping the token there would sign a customer out of a still-valid
    // session for a typo, and strand the SPA (AuthContext keeps its `user`, so
    // nothing routes back to sign-in). See @admin/services/reauthChallenge.
    const sessionExpired =
      status === 401 && !isReauthChallenge(error.config?.method, error.config?.url);
    if (sessionExpired) {
      // Unchanged behavior: an expired/retired token is dropped so the next
      // render bounces to the sign-in screen.
      onUnauthorized();
    } else if (isPasswordChangeRequired(status, error.response?.data?.detail)) {
      // The forced-reset gate. The token is still VALID — do not clear it, or
      // the user would be signed out of the only session that can clear the
      // flag. Raising the gate routes the SPA to /admin/change-password.
      passwordGate.set(true);
    }
    return Promise.reject(error);
  }
);

// Run a mutation, then purge the public sponsor SW caches before resolving, so
// the public Preferred Partners banner + keyword pages reflect the change on the
// next navigation. Applied to every mutation that can alter sponsor-derived
// public data: sponsor create/update/delete, and supplier update/delete (delete
// cascades to the sponsor row server-side; update changes the company
// name/contact rendered in the banner). Centralizing here means no call site —
// sponsorStore, the supplier pages, or the wizard's featureSupplierInCategory —
// can forget to invalidate.
async function bustingAfter<T>(mutation: Promise<T>): Promise<T> {
  const value = await mutation;
  await bustSponsorCaches();
  return value;
}

export const adminApi = {
  // Sign-in is EMAIL-keyed (P1 auth overhaul) — there is no username fallback
  // for any account, the public demo included. The response carries
  // `must_change_password`, which AuthContext feeds to the passwordGate.
  login: (email: string, password: string, remember = false) =>
    adminClient
      .post<AuthResponse>('/auth/login', { email, password, remember })
      .then((r) => r.data),

  /**
   * POST /auth/signup — the customer front door.
   *
   * Answers 202 with `{ status: "ok" }` and NO token: there is no session
   * until the address is verified, so the caller must show a "check your
   * email" state rather than treating success as a sign-in.
   *
   * The body is `extra="forbid"` server-side — do NOT add confirm_password
   * here, the match is a client-side check only and an extra key is a 422.
   *
   * Errors worth handling at the call site: 409 with the STRING detail
   * `email_taken` (an explicit carve-out from the anti-enumeration rule, so
   * `apiErrorDetail` surfaces it), 429 `too_many_requests`, and 422 with the
   * same STRUCTURED policy detail as /change-password —
   * `{ code, message, unmet: [...] }`, read it with `unmetKeysFromDetail`.
   */
  signup: (firstName: string, lastName: string, email: string, password: string) =>
    adminClient
      .post<{ status: string }>('/auth/signup', {
        first_name: firstName,
        last_name: lastName,
        email,
        password,
      })
      .then((r) => r.data),

  /**
   * POST /auth/verify — spend a verification token from the emailed link.
   *
   * Every unusable token (malformed, expired, wrong purpose, wrong address)
   * answers one indistinguishable 400 `invalid_or_expired_token`.
   */
  verifyEmail: (token: string) =>
    adminClient.post<{ status: string }>('/auth/verify', { token }).then((r) => r.data),

  /**
   * POST /auth/resend-verification — mint a fresh link for an unverified
   * address. Anti-enumeration (unlike /signup): always a generic
   * `{ status: "ok" }`, whether or not that address has an account.
   */
  resendVerification: (email: string) =>
    adminClient
      .post<{ status: string }>('/auth/resend-verification', { email })
      .then((r) => r.data),

  /**
   * POST /auth/change-password — self-service change, and the ONLY way out of
   * the forced-reset gate.
   *
   * Returns a FRESH token: the server stamps `password_changed_at`, which
   * retires every token minted before the change, so the caller MUST store the
   * new one or it logs itself out by succeeding.
   *
   * Errors worth handling at the call site: 400 (wrong current password / same
   * password as before) and 422 with a STRUCTURED detail
   * `{ code, message, unmet: [...] }` — read it with `unmetKeysFromDetail`,
   * since `apiErrorDetail` only surfaces string details.
   */
  changePassword: (currentPassword: string, newPassword: string) =>
    adminClient
      .post<AuthResponse>('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      })
      .then((r) => r.data),

  getMe: () =>
    adminClient.get<UserInfo>('/auth/me').then((r) => r.data),

  // Server-side logo fetch (GET /api/admin/image-proxy) — returns the image
  // bytes SAME-ORIGIN so the cropper + brand-color extraction can run on a
  // pasted URL (a direct cross-origin <img> taints the canvas and kills both).
  fetchImageForCrop: (url: string) =>
    adminClient
      .get<Blob>('/admin/image-proxy', { params: { url }, responseType: 'blob' })
      .then((r) => r.data),

  // POST /api/admin/presence/ping — heartbeat + the current "who else is in the
  // admin" roster (self included; the caller filters itself out). In-memory and
  // best-effort: a failure just means no bubbles render.
  pingPresence: () =>
    adminClient.post<PresenceUser[]>('/admin/presence/ping').then((r) => r.data),

  // Account recovery. Both return a generic { status: "ok" } regardless of
  // whether an account matched (the backend is anti-enumeration), so the UI
  // shows the same "check your inbox" success either way.
  //
  // There is no username recovery any more: the login identifier IS the email
  // address, so `POST /auth/forgot-username` is retired server-side (410).
  forgotPassword: (identifier: string) =>
    adminClient
      .post<{ status: string }>('/auth/forgot-password', { identifier })
      .then((r) => r.data),

  resetPassword: (token: string, newPassword: string) =>
    adminClient
      .post<{ status: string }>('/auth/reset-password', { token, new_password: newPassword })
      .then((r) => r.data),

  getStats: () =>
    adminClient.get<DashboardStats>('/dashboard/stats').then((r) => r.data),

  getActivity: () =>
    adminClient.get<ActivityItem[]>('/dashboard/activity').then((r) => r.data),

  getRevenue: () =>
    adminClient.get<RevenueDataPoint[]>('/dashboard/revenue').then((r) => r.data),

  getPopular: () =>
    adminClient.get<PopularData>('/dashboard/popular').then((r) => r.data),

  // Server defaults segment=humans — crawler floods must not read as
  // visitors. Pass 'bots' | 'all' only when the UI explicitly asks.
  getAnalytics: (days = 30, segment: 'humans' | 'bots' | 'all' = 'humans') =>
    adminClient
      .get<AnalyticsData>('/dashboard/analytics', { params: { days, segment } })
      .then((r) => r.data),

  // ── Dashboard overhaul (2026-07-30) ──────────────────────────────────────
  // All of these bucket by America/New_York server-side and float()-cast their
  // dollar fields, so the numbers arrive as JSON numbers, not NUMERIC strings.

  /** GET /dashboard/trends?days=30 — 5 index-aligned, gap-free day series. */
  getTrends: (days = 30) =>
    adminClient.get<DashboardTrends>('/dashboard/trends', { params: { days } }).then((r) => r.data),

  /** GET /dashboard/revenue-compare?months=3 — day-of-month overlay, newest first. */
  getRevenueCompare: (months = 3) =>
    adminClient
      .get<MonthlyCompare>('/dashboard/revenue-compare', { params: { months } })
      .then((r) => r.data),

  /** GET /dashboard/sales-reps — active sponsorships grouped by `sold_by`. */
  getSalesReps: () =>
    adminClient.get<SalesRepsResponse>('/dashboard/sales-reps').then((r) => r.data),

  /** GET /dashboard/expenses?months=3 — same wire shape as revenue-compare. */
  getExpenses: (months = 3) =>
    adminClient
      .get<MonthlyCompare>('/dashboard/expenses', { params: { months } })
      .then((r) => r.data),

  /** GET /dashboard/expenses/breakdown[?month=YYYY-MM] — one month, by
   *  category. Omit `month` for the current one; the reply's
   *  `available_months` lists the months that actually hold rows, which is what
   *  the dashboard pager steps through.
   *
   *  The param is only sent when set — the server pattern-validates `month`,
   *  so shipping `?month=` (empty) would be a 422 rather than "default". */
  getExpensesBreakdown: (month?: string) =>
    adminClient
      .get<ExpensesBreakdown>(
        '/dashboard/expenses/breakdown',
        month ? { params: { month } } : undefined,
      )
      .then((r) => r.data),

  // ── Expense CRUD ─────────────────────────────────────────────────────────
  // No `bustingAfter` here on purpose: expenses are admin-internal and feed no
  // public/SW-cached surface, unlike sponsor + supplier mutations.
  // Reminder: `AdminExpense.amount` is a NUMERIC → runtime STRING. Coerce.

  // Trailing slash on list/create matches the router's `@router.get("/")` (same
  // shape as /admin/sponsors/) — without it FastAPI 307-redirects and every
  // call pays an extra round-trip.
  listExpenses: () => adminClient.get<AdminExpense[]>('/admin/expenses/').then((r) => r.data),

  createExpense: (data: ExpenseCreate) =>
    adminClient.post<AdminExpense>('/admin/expenses/', data).then((r) => r.data),

  updateExpense: (id: string, data: ExpenseUpdate) =>
    adminClient.patch<AdminExpense>(`/admin/expenses/${id}`, data).then((r) => r.data),

  deleteExpense: (id: string) =>
    adminClient.delete(`/admin/expenses/${id}`).then(() => undefined),

  /** GET /admin/sales-reps — admin-role usernames; the sponsor form's `sold_by`
   *  options (e.g. Anthony, Daniel, Ronald). */
  getSalesRepOptions: () =>
    adminClient.get<SalesRepOptions>('/admin/sales-reps').then((r) => r.data),

  /**
   * GET /api/dashboard/engagement?days=30 -> PlatformEngagementSeries[]
   *
   * STUB -- backend not built. Resolves [] so the panel renders its
   * "no platforms connected" empty state instead of throwing. Callers must
   * already handle an empty array; nothing else changes on cutover.
   *
   * Real implementation is a one-line swap:
   *   adminClient
   *     .get<PlatformEngagementSeries[]>('/dashboard/engagement', { params: { days } })
   *     .then((r) => r.data)
   *
   * `days` is kept in the signature so call sites are written against the final
   * shape. `void days` is what satisfies tsconfig `noUnusedParameters` — a
   * `_days` rename is forbidden by CLAUDE.md — and it disappears with the real
   * body. Response contract + the OAuth upstream feeding each platform (Meta
   * Graph API for instagram + meta_ads, TikTok Business API, Google Ads API,
   * Snapchat Marketing API, LinkedIn Marketing API, X API v2) are documented on
   * PlatformEngagementSeries in @admin/types/engagement.
   */
  getEngagement: (days = 30): Promise<PlatformEngagementSeries[]> => {
    void days;
    return Promise.resolve([]);
  },

  getParts: (params: {
    page?: number;
    search?: string;
    category_id?: string;
    supplier_id?: string;
  }) =>
    adminClient
      .get<PaginatedResponse<Part>>('/parts/', { params })
      .then((r) => r.data),

  getPart: (id: string) =>
    adminClient.get<PartDetail>(`/parts/${id}`).then((r) => r.data),

  createPart: (data: Partial<PartDetail>) =>
    bustingAfter(adminClient.post<Part>('/parts/', data).then((r) => r.data)),

  updatePart: (id: string, data: Partial<PartDetail>) =>
    bustingAfter(adminClient.put<Part>(`/parts/${id}`, data).then((r) => r.data)),

  deletePart: (id: string) =>
    bustingAfter(adminClient.delete(`/parts/${id}`).then((r) => r.data)),

  // Attach an existing part to a supplier's catalog / detach it again. Both
  // bust the sponsor caches: a listing changes the part's public best_price +
  // total_stock and the supplier's parts_count.
  addPartListing: (partId: string, data: PartListingCreate) =>
    bustingAfter(
      adminClient.post<PartListing>(`/parts/${partId}/listings`, data).then((r) => r.data),
    ),

  deletePartListing: (partId: string, listingId: string) =>
    bustingAfter(
      adminClient
        .delete(`/parts/${partId}/listings/${listingId}`)
        .then(() => undefined),
    ),

  batchImportParts: (supplierId: string, data: Record<string, unknown>[]) =>
    bustingAfter(
      adminClient
        .post<BatchImportResult>('/parts/batch', { supplier_id: supplierId, parts: data })
        .then((r) => r.data),
    ),

  getSuppliers: () =>
    adminClient.get<AdminSupplier[]>('/suppliers/').then((r) => r.data),

  getSupplier: (id: string) =>
    adminClient.get<AdminSupplier>(`/suppliers/${id}`).then((r) => r.data),

  createSupplier: (data: Partial<AdminSupplier>) =>
    adminClient.post<AdminSupplier>('/suppliers/', data).then((r) => r.data),

  // update/delete supplier bust the sponsor caches: a sponsor-supplier's
  // name/contact shows in the banner (update), and delete cascades to its
  // sponsor row server-side (suppliers.py) — both change the public banner.
  updateSupplier: (id: string, data: Partial<AdminSupplier>) =>
    bustingAfter(adminClient.put<AdminSupplier>(`/suppliers/${id}`, data).then((r) => r.data)),

  deleteSupplier: (id: string) =>
    bustingAfter(adminClient.delete(`/suppliers/${id}`).then((r) => r.data)),

  getSupplierParts: (
    id: string,
    params: { page?: number; search?: string }
  ) =>
    adminClient
      .get<PaginatedResponse<Part>>(`/suppliers/${id}/parts`, { params })
      .then((r) => r.data),

  getCategories: () =>
    adminClient.get<AdminCategory[]>('/categories/').then((r) => r.data),

  getMessages: () =>
    adminClient.get<Message[]>('/admin/messages/').then((r) => r.data),

  getMessage: (id: string) =>
    adminClient.get<Message>(`/admin/messages/${id}`).then((r) => r.data),

  updateMessage: (id: string, update: Partial<MessageUpdate>) =>
    adminClient
      .patch<Message>(`/admin/messages/${id}`, update)
      .then((r) => r.data),

  // Message deletion is a HARD delete server-side — there is no trash to
  // restore from, which is why every call site confirms first. No
  // `bustingAfter`: an inbox row is not catalog data, so nothing the public
  // site caches can change.
  deleteMessage: (id: string) =>
    adminClient
      .delete<{ status: string }>(`/admin/messages/${id}`)
      .then((r) => r.data),

  // POST /api/admin/messages/bulk-delete -> { deleted, missing }. `missing`
  // counts ids the server no longer had (someone else deleted them, or the
  // list was stale) — the UI reports it rather than claiming they were all
  // deleted. Caller must keep each batch within BULK_DELETE_MAX (200) ids;
  // past that the route answers 422 `too_many_ids`.
  bulkDeleteMessages: (ids: string[]) =>
    adminClient
      .post<BulkDeleteResult>('/admin/messages/bulk-delete', { ids })
      .then((r) => r.data),

  getSponsors: () =>
    adminClient.get<AdminSponsor[]>('/admin/sponsors/').then((r) => r.data),

  // sponsor create/update/delete all bust the sponsor caches so the public
  // banner reflects the change on next navigation.
  createSponsor: (data: SponsorCreate) =>
    bustingAfter(adminClient.post<AdminSponsor>('/admin/sponsors/', data).then((r) => r.data)),

  updateSponsor: (id: string, data: Partial<SponsorCreate>) =>
    bustingAfter(adminClient.patch<AdminSponsor>(`/admin/sponsors/${id}`, data).then((r) => r.data)),

  deleteSponsor: (id: string) =>
    bustingAfter(adminClient.delete(`/admin/sponsors/${id}`).then((r) => r.data)),

  // ── Stripe quotes (sales-led billing; routes/admin_quotes.py) ────────────
  // No bustingAfter: creating/accepting a quote changes nothing the public
  // site renders — sponsors.status only ever moves via the Stripe webhook.
  // All four 404 when STRIPE_SECRET_KEY is unconfigured server-side; the
  // panel treats that as "billing not set up" rather than an error.

  getQuoteLadder: () =>
    adminClient.get<QuoteLadderResponse>('/admin/quote-ladder').then((r) => r.data),

  getSponsorQuotes: (sponsorId: string) =>
    adminClient
      .get<{ quotes: SponsorQuote[] }>(`/admin/sponsors/${sponsorId}/quotes`)
      .then((r) => r.data.quotes),

  createSponsorQuote: (sponsorId: string, body: QuoteCreateBody) =>
    adminClient
      .post<QuoteCreateResult>(`/admin/sponsors/${sponsorId}/quote`, body)
      .then((r) => r.data),

  acceptQuote: (quoteId: string) =>
    adminClient
      .post<{ quote_id: string; status: string; subscription_id: string | null }>(
        `/admin/quotes/${quoteId}/accept`
      )
      .then((r) => r.data),

  downloadQuotePdf: (quoteId: string) =>
    adminClient
      .get<Blob>(`/admin/quotes/${quoteId}/pdf`, { responseType: 'blob' })
      .then((r) => r.data),

  // ── Distributor feed keys (routes/feed_credentials.py) ──────────────────
  // No bustingAfter: a feed key changes nothing the public site renders — it
  // only decides whether POST /suppliers/{id}/sync has a credential to run
  // with. All three answer the SAME status list (provider/label/configured/
  // source/last4/updated_at) and NEVER the stored value, so a caller can
  // repaint the card straight off the mutation's response.

  getFeedCredentials: () =>
    adminClient
      .get<{ providers: FeedCredentialStatus[] }>('/admin/feed-credentials/')
      .then((r) => r.data.providers),

  putFeedCredential: (provider: string, apiKey: string) =>
    adminClient
      .put<{ providers: FeedCredentialStatus[] }>(
        `/admin/feed-credentials/${encodeURIComponent(provider)}`,
        { api_key: apiKey }
      )
      .then((r) => r.data.providers),

  deleteFeedCredential: (provider: string) =>
    adminClient
      .delete<{ providers: FeedCredentialStatus[] }>(
        `/admin/feed-credentials/${encodeURIComponent(provider)}`
      )
      .then((r) => r.data.providers),

  // ── Per-supplier feed settings (routes/suppliers.py) ────────────────────
  // No bustingAfter on either: this is a SETTING, not catalog data — nothing
  // the public site renders moves until the nightly job actually runs, and
  // that run busts on its own writes.
  //
  // The GET does NOT 404 when the feature is unconfigured (unlike sync/import):
  // the switch has to render greyed WITH a reason, and a missing endpoint gives
  // the UI nothing to say. The PATCH answers 409 `feed_not_configured` when
  // asked to ENABLE a feed that could never run; disabling is always allowed,
  // so send it unconditionally — a key can vanish while the toggle is on, and
  // an off switch that refuses to work traps the operator.

  getFeedSettings: (id: string) =>
    adminClient
      .get<FeedSettings>(`/suppliers/${encodeURIComponent(id)}/feed-settings`)
      .then((r) => r.data),

  // Second-click pause: asks the ACTIVE run to wind down at the next safe
  // part (404 = nothing running). The observer stream then receives the
  // paused sync_finished naturally — no client state to reconcile.
  pauseFeedRun: (id: string) =>
    adminClient
      .post<{ pausing: boolean; run_id: string }>(
        `/suppliers/${encodeURIComponent(id)}/feed-run/pause`,
      )
      .then((r) => r.data),

  patchFeedSettings: (id: string, enabled: boolean) =>
    adminClient
      .patch<FeedSettings>(`/suppliers/${encodeURIComponent(id)}/feed-settings`, {
        auto_import_enabled: enabled,
      })
      .then((r) => r.data),


  // ── Manufacturers + Leads CRM (2026-08-20). Leads reads 403 for the demo
  // account server-side (demo_account_no_leads); callers surface the block.
  getManufacturers: (params: Record<string, string | number | boolean>) =>
    adminClient
      .get<import('../types/manufacturers').ManufacturerListResponse>('/admin/manufacturers/', { params })
      .then((r) => r.data),

  getManufacturer: (id: string) =>
    adminClient
      .get<import('../types/manufacturers').AdminManufacturerDetail>(`/admin/manufacturers/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  createManufacturer: (data: { name: string; website?: string | null; description?: string | null }) =>
    adminClient.post('/admin/manufacturers/', data).then((r) => r.data),

  updateManufacturer: (id: string, data: Record<string, unknown>) =>
    adminClient.patch(`/admin/manufacturers/${encodeURIComponent(id)}`, data).then((r) => r.data),

  deleteManufacturer: (id: string) =>
    adminClient.delete(`/admin/manufacturers/${encodeURIComponent(id)}`).then((r) => r.data),

  // The sponsor bridge: creating/linking a supplier changes what the public
  // boards can sell, so these two bust the SW caches.
  promoteManufacturerToSupplier: (id: string) =>
    bustingAfter(
      adminClient.post<{ supplier_id: string; supplier_name: string }>(
        `/admin/manufacturers/${encodeURIComponent(id)}/promote`,
      ).then((r) => r.data),
    ),

  linkManufacturerSupplier: (id: string, supplierId: string) =>
    bustingAfter(
      adminClient.post(`/admin/manufacturers/${encodeURIComponent(id)}/link`, { supplier_id: supplierId })
        .then((r) => r.data),
    ),

  resolveMergeCandidate: (candidateId: string, action: 'approve' | 'reject') =>
    adminClient.post(`/admin/manufacturers/candidates/${encodeURIComponent(candidateId)}/${action}`)
      .then((r) => r.data),

  getLeads: (params: Record<string, string | number | boolean>) =>
    adminClient
      .get<import('../types/leads').LeadListResponse>('/admin/leads/', { params })
      .then((r) => r.data),

  getLead: (id: string) =>
    adminClient
      .get<import('../types/leads').AdminLeadDetail>(`/admin/leads/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  updateLead: (id: string, data: Record<string, unknown>) =>
    adminClient.patch(`/admin/leads/${encodeURIComponent(id)}`, data).then((r) => r.data),

  recordLeadOutcome: (id: string, data: { outcome: string; sale_tier?: string | null; note?: string | null }) =>
    adminClient
      .post<import('../types/leads').AdminLeadDetail>(`/admin/leads/${encodeURIComponent(id)}/contacts`, data)
      .then((r) => r.data),

  getRepActivity: (username: string) =>
    adminClient
      .get<import('../types/leads').RepActivity>(`/admin/leads/reps/${encodeURIComponent(username)}`)
      .then((r) => r.data),

  getRecentLeadContacts: (limit = 100) =>
    adminClient
      .get<{ contacts: import('../types/leads').RecentLeadContact[] }>('/dashboard/leads/recent', { params: { limit } })
      .then((r) => r.data),

  // ── Registered customer accounts (2026-08-25). Staff-only server-side
  // (require_staff): a customer who reaches the shared console sees the page
  // chrome and an error, never a roster.
  //
  // The server returns UNACTIVATED FIRST, then newest — the page's job is to
  // show who is waiting. Callers must not re-sort into created-desc and undo it.
  getUsers: () =>
    adminClient.get<AdminUser[]>('/admin/users/').then((r) => r.data),

  updateUser: (
    id: string,
    patch: { activated?: boolean; supplier_id?: string | null; manufacturer_id?: string | null },
  ) => adminClient.patch<AdminUser>(`/admin/users/${id}`, patch).then((r) => r.data),

  // ── The customer's own account (2026-08-25) ──────────────────────────────

  /**
   * GET /api/account/me — and, in practice, the activation probe (D17).
   *
   * The route is gated on `require_account_user`, so its ANSWER is the whole
   * signal: a 200 means this customer is activated, and
   * `403 account_not_activated` means they are not. AuthContext runs it once
   * per customer session and ProtectedRoute shows the awaiting-approval screen
   * on the 403 — without it a verified-but-unactivated customer reaches the
   * full console and every panel 403s at them one at a time.
   *
   * Staff must not call this: they are not customers, so they get
   * `403 staff_only`.
   */
  getAccountMe: () =>
    adminClient.get<AccountMe>('/account/me').then((r) => r.data),

  /**
   * DELETE /api/account/me — the Danger Zone's self-deletion.
   *
   * `request` rather than `adminClient.delete`: axios drops the body of a
   * `delete`, and the server needs the password. Sent without it the request
   * fails Pydantic validation (422) instead of reaching the re-auth, which
   * reads as a bug rather than a wrong password.
   *
   * Removes the SIGN-IN and that user's messages, and deliberately nothing
   * else — the linked Supplier, its listings and any active sponsorship keep
   * running and keep billing. The panel says so in as many words.
   *
   * Errors worth handling at the call site: 401 `Invalid credentials` (the
   * wrong password, or the per-account lockout after five of them, which
   * carries a `Retry-After`) and 403 `account_not_activated`. That 401 does
   * NOT retire the session — see @admin/services/reauthChallenge.
   */
  deleteMyAccount: (password: string) =>
    adminClient
      .request<{ status: string }>({ method: 'delete', url: '/account/me', data: { password } })
      .then((r) => r.data),

  // "Feature" a supplier on a category = a Featured sponsorship on that
  // (top-level) category — the single source of truth as of 2026-06-03
  // (the standalone category-suppliers feature flag was removed). Used by the
  // guided-tour wizard so the demo supplier shows up in the live-site preview.
  // Best-effort: resolve the slug to a category id, then create the sponsorship
  // (the caller swallows failures — e.g. a non-top-level slug or a duplicate).
  // The cache bust happens via createSponsor above.
  featureSupplierInCategory: async (supplierId: string, categorySlug: string) => {
    const cats = await adminApi.getCategories();
    const cat = cats.find((c) => c.slug === categorySlug);
    if (!cat) return null;
    return adminApi.createSponsor({
      supplier_id: supplierId,
      category_id: cat.id,
      tier: 'Platinum',
      status: 'Active',
    } as SponsorCreate);
  },
};
