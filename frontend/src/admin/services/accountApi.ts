/**
 * The customer console's HTTP client — everything under /api/account.
 *
 * Separate from `adminApi` because the two speak to different routers with
 * different guards: adminApi's endpoints are `require_staff`, these are
 * `require_account_user` and REFUSE staff. A customer page that reaches for an
 * admin method does not render a smaller version of the admin screen, it
 * renders a 403, so the split is what makes the mistake visible at the import.
 *
 * The session is NOT duplicated. The token lives in exactly one place and
 * `authHeaders` / `onUnauthorized` (adminApi) are its only readers, so this
 * module holds a second axios INSTANCE but not a second idea of who is signed
 * in. What is mirrored here is the two-line response policy — retire the token
 * on a 401, raise the forced-reset gate on a 403 `password_change_required` —
 * without adminApi's re-auth carve-out, which exists for the Danger Zone's
 * password prompt and has no counterpart among these read-only routes.
 *
 * Scoping is entirely server-side (`app/services/account_scope.py`). Nothing
 * here passes a supplier_id or a manufacturer_id, and nothing here should ever
 * start to: a client-supplied scope is a client-chosen scope.
 */

import axios from 'axios';
import { API_BASE_URL } from '@shared/services/constants';
import { adminApi, authHeaders, onUnauthorized } from '@admin/services/adminApi';
import { isPasswordChangeRequired, passwordGate } from '@admin/services/passwordGate';
import type {
  AccountActivityResponse,
  AccountBookOfBusiness,
  AccountCategoriesResponse,
  AccountDashboard,
  AccountImportQueue,
  AccountKpi,
  AccountLeadsSummary,
  AccountManufacturer,
  AccountManufacturersResponse,
  AccountMessage,
  AccountOperatingCosts,
  AccountPartsPage,
  AccountPartsQuery,
  AccountReferralClicks,
  AccountRevenue,
  AccountSponsorMix,
  AccountSponsorship,
  AccountSupplier,
  AccountSuppliersResponse,
} from '@admin/types/account';

const accountClient = axios.create({ baseURL: API_BASE_URL });

accountClient.interceptors.request.use((config) => {
  const auth = authHeaders();
  if (auth.Authorization) {
    config.headers.Authorization = auth.Authorization;
  }
  return config;
});

accountClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    if (status === 401) {
      // Expired or retired: drop it so the next render bounces to sign-in.
      onUnauthorized();
    } else if (isPasswordChangeRequired(status, error.response?.data?.detail)) {
      // The token is still VALID — clearing it here would sign the user out of
      // the only session that can clear the flag.
      passwordGate.set(true);
    }
    return Promise.reject(error);
  }
);

/**
 * True for the 404 that GET /my-supply and GET /my-manufacturing answer when
 * the account holds no such link.
 *
 * Those two routes 404 rather than returning an empty body, because "no row"
 * is the honest answer for an account that is not that kind of company. It is
 * a STATE, not a failure — a free account meets it on both — so the call site
 * must be able to tell it apart from a real error and render the empty state
 * the spec asks for instead of an error card.
 */
export function isNotLinked(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404;
}

export const accountApi = {
  /**
   * GET /api/account/me — identity AND capability (`is_supplier`,
   * `is_manufacturer`), plus the derived tier.
   *
   * Bound to adminApi's method rather than re-declared: it is also the
   * activation probe (D17), where the ANSWER is the signal — a 200 means
   * activated, `403 account_not_activated` means not — and two declarations of
   * one endpoint is two places for that contract to drift. AuthContext runs it
   * once per customer session and puts the result on `account`, so a page
   * almost never needs to call this itself.
   */
  getAccountMe: adminApi.getAccountMe,

  /** GET /api/account/dashboard — the five scoped tiles. An unlinked account
   *  gets zeroes and a 200, which is the truth: it has not bought anything. */
  getAccountDashboard: () =>
    accountClient.get<AccountDashboard>('/account/dashboard').then((r) => r.data),

  /** GET /api/account/parts — same page shape as the admin parts list. */
  getAccountParts: (params: AccountPartsQuery = {}) =>
    accountClient.get<AccountPartsPage>('/account/parts', { params }).then((r) => r.data),

  /** GET /api/account/categories — where this account's catalog actually sits,
   *  counted by the caller's own slice. */
  getAccountCategories: () =>
    accountClient.get<AccountCategoriesResponse>('/account/categories').then((r) => r.data),

  /** GET /api/account/manufacturers — the makers this DISTRIBUTOR sells.
   *  Empty (200, not an error) without a supplier link. */
  getAccountManufacturers: () =>
    accountClient.get<AccountManufacturersResponse>('/account/manufacturers').then((r) => r.data),

  /** GET /api/account/suppliers — the distributors selling this MANUFACTURER's
   *  products. Empty (200, not an error) without a manufacturer link. */
  getAccountSuppliers: () =>
    accountClient.get<AccountSuppliersResponse>('/account/suppliers').then((r) => r.data),

  /** GET /api/account/my-supply — their own distributor row. 404 when the
   *  account holds no supplier link; read it with `isNotLinked`. */
  getMySupply: () =>
    accountClient.get<AccountSupplier>('/account/my-supply').then((r) => r.data),

  /** GET /api/account/my-manufacturing — their own maker row, whose
   *  `parts_count` is their parts in OUR catalog, never the CSV's figure.
   *  404 when the account holds no manufacturer link. */
  getMyManufacturing: () =>
    accountClient.get<AccountManufacturer>('/account/my-manufacturing').then((r) => r.data),

  /** GET /api/account/sponsors — every placement the company holds, live and
   *  lapsed. `[]` for a manufacturer-only or unlinked account, because
   *  `sponsors.supplier_id` is NOT NULL and a maker cannot hold one today. */
  getAccountSponsors: () =>
    accountClient.get<AccountSponsorship[]>('/account/sponsors').then((r) => r.data),

  /** GET /api/account/messages — this USER's mail, newest first. Keyed on the
   *  person, not the company: two colleagues at one distributor have two
   *  inboxes, and the shared staff inbox is never either of them. */
  getAccountMessages: () =>
    accountClient.get<AccountMessage[]>('/account/messages').then((r) => r.data),

  /** GET /api/account/messages/{id}. A message that is not yours and a message
   *  that never existed answer identically — 404, no existence oracle. */
  getAccountMessage: (id: string) =>
    accountClient.get<AccountMessage>(`/account/messages/${id}`).then((r) => r.data),

  /**
   * PATCH /api/account/messages/{id} — read or unread, and that is the whole
   * verb. The body carries `read` ALONE: the endpoint forbids extra keys, so
   * adding one is a 422 rather than a field the server quietly ignores.
   */
  setAccountMessageRead: (id: string, read: boolean) =>
    accountClient
      .patch<AccountMessage>(`/account/messages/${id}`, { read })
      .then((r) => r.data),

  // ── The dashboard board ──────────────────────────────────────────────────
  // Ten reads and one write, every one of them scoped server-side. They exist
  // so the customer console home can be built out of /api/account ALONE: the
  // staff dashboard's `/api/dashboard/*` endpoints are `require_staff`, so a
  // single stray adminApi call on that page is seven-eighths of a working
  // screen plus one 403, which is harder to notice than a blank one.

  /** GET /account/kpi — the chosen KPI's points, plus the registry entries this
   *  account's capability links actually allow. */
  getAccountKpi: () => accountClient.get<AccountKpi>('/account/kpi').then((r) => r.data),

  /**
   * PUT /account/kpi — persist the pick to `users.dashboard_kpi` and get the
   * SAME body back, already re-computed for the new key.
   *
   * The reply is the whole panel, so the caller replaces its state with it
   * rather than setting the key locally and refetching: two round trips would
   * leave a frame where the chart is last KPI's data under this KPI's label.
   * A key outside the registry — or one this account has no link for — is a
   * 422 `unknown_kpi`.
   */
  setAccountKpi: (key: string) =>
    accountClient.put<AccountKpi>('/account/kpi', { key }).then((r) => r.data),

  /** GET /account/referral-clicks — 12 months + 30 days of buyers routed from
   *  a part page to this company's own site. Clicks, never dollars. */
  getAccountReferralClicks: () =>
    accountClient.get<AccountReferralClicks>('/account/referral-clicks').then((r) => r.data),

  /** GET /account/revenue — 12 months of the caller's own revenue rows, oldest
   *  first. Empty months are present at zero, so the axis has no gaps. */
  getAccountRevenue: () =>
    accountClient.get<AccountRevenue>('/account/revenue').then((r) => r.data),

  /** GET /account/sponsor-mix — their placements as a name-keyed Sankey. A
   *  manufacturer-only account is empty by construction, not by failure. */
  getAccountSponsorMix: () =>
    accountClient.get<AccountSponsorMix>('/account/sponsor-mix').then((r) => r.data),

  /** GET /account/book-of-business — the counterparties on the other side of
   *  their catalog joins, with their own company as the graph's centre. */
  getAccountBookOfBusiness: () =>
    accountClient.get<AccountBookOfBusiness>('/account/book-of-business').then((r) => r.data),

  /** GET /account/activity — their own `activity_events`, newest first, 20. */
  getAccountActivity: () =>
    accountClient.get<AccountActivityResponse>('/account/activity').then((r) => r.data),

  /** GET /account/import-queue — the auto-import STATE and last sync of their
   *  feed. Never the provider, never the key: the console shows no control
   *  that could change any of it. */
  getAccountImportQueue: () =>
    accountClient.get<AccountImportQueue>('/account/import-queue').then((r) => r.data),

  /**
   * GET /account/operating-costs[?month=YYYY-MM] — one month of subscription
   * lines and their own expenses.
   *
   * The param is only sent when set, mirroring the staff breakdown: the server
   * pattern-validates `month`, so `?month=` (empty) is a 422 rather than a
   * request for the default month.
   */
  getAccountOperatingCosts: (month?: string) =>
    accountClient
      .get<AccountOperatingCosts>(
        '/account/operating-costs',
        month ? { params: { month } } : undefined,
      )
      .then((r) => r.data),

  /** GET /account/leads-summary — how many businesses they are working, and
   *  the five most recent. Empty at first for every account. */
  getAccountLeadsSummary: () =>
    accountClient.get<AccountLeadsSummary>('/account/leads-summary').then((r) => r.data),
};
