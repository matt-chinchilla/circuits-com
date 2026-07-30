import axios from 'axios';
import { API_BASE_URL } from '@shared/services/constants';
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
} from '@admin/types/admin';
import type { Message, MessageStatus, AssignedTo } from '@admin/types/messages';
import type { PlatformEngagementSeries } from '@admin/types/engagement';
import { bustSponsorCaches } from '@admin/services/swCache';

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

const adminClient = axios.create({ baseURL: API_BASE_URL });

adminClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

adminClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('admin_token');
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
  login: (username: string, password: string, remember = false) =>
    adminClient
      .post<AuthResponse>('/auth/login', { username, password, remember })
      .then((r) => r.data),

  getMe: () =>
    adminClient.get<UserInfo>('/auth/me').then((r) => r.data),

  // Account recovery. All three return a generic { status: "ok" } regardless of
  // whether an account matched (the backend is anti-enumeration), so the UI
  // shows the same "check your inbox" success either way.
  forgotPassword: (identifier: string) =>
    adminClient
      .post<{ status: string }>('/auth/forgot-password', { identifier })
      .then((r) => r.data),

  forgotUsername: (email: string) =>
    adminClient
      .post<{ status: string }>('/auth/forgot-username', { email })
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

  getAnalytics: (days = 30) =>
    adminClient.get<AnalyticsData>('/dashboard/analytics', { params: { days } }).then((r) => r.data),

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

  /** GET /dashboard/expenses/breakdown — current month, by category. */
  getExpensesBreakdown: () =>
    adminClient.get<ExpensesBreakdown>('/dashboard/expenses/breakdown').then((r) => r.data),

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
