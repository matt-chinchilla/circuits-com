/**
 * Category page URL ⇄ query-state — the one place that knows how a category
 * page's sort / filter / search / pagination state is spelled.
 *
 * Three consumers, and they MUST agree byte-for-byte:
 *   1. `@public/pages/category` reads the URL into state and writes it back.
 *   2. `@public/services/api.getCategory` turns that state into the request
 *      query string (and its preload-reuse guard compares the whole string).
 *   3. `frontend/index.html`'s inline LCP preload + `vite.config.ts`'s Workbox
 *      route both key off `CANONICAL_CATEGORY_QUERY` — the default first page.
 *      index.html can't import, so it hard-codes the string; the vitest beside
 *      this file asserts the two still match.
 *
 * Deliberately IMPORT-FREE (not even a type import): `vite.config.ts` loads
 * this module through esbuild, where the `@public/*` alias does not exist yet.
 *
 * The catalog passed 200k parts, so the page no longer fetches 500 rows and
 * filters them in the browser — every one of these knobs is a server parameter
 * now, and living in the URL is what makes back/forward and link-sharing work.
 */

/** Rows per page. The server ceiling is 100; this is the page's own size. */
export const PAGE_SIZE = 25;

/**
 * Every `sort` value the API accepts. Anything else is a 422 `unknown_sort` —
 * and so are `popular` and `sub` on a LEAF page, which has no subcategories to
 * group by and no cross-child popularity ordering (see `isUnknownSortError`,
 * which is how the page heals a link asking for one).
 */
export const SORT_KEYS = [
  'sku',
  'desc',
  'mfg',
  'sub',
  'qty1',
  'qty10',
  'qty100',
  'qty1k',
  'popular',
] as const;

export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface CategoryQuery {
  /** 1-based. */
  page: number;
  /**
   * `null` means "whatever the server orders by for this scope" (leaf → sku
   * asc, parent → popular desc). It is a REAL state, not a stand-in for
   * sku-asc: the column headers must not paint an active arrow for an order
   * the page is not actually asking for.
   */
  sort: SortKey | null;
  dir: SortDir;
  /** Free text, matched server-side against sku OR description. */
  q: string;
  /** Manufacturer names. EMPTY = unfiltered (never "show nothing"). */
  mfg: string[];
  /** Subcategory SLUGS — never names. EMPTY = unfiltered. */
  sub: string[];
}

export const DEFAULT_CATEGORY_QUERY: CategoryQuery = {
  page: 1,
  sort: null,
  dir: 'asc',
  q: '',
  mfg: [],
  sub: [],
};

/** The server bounds `q` at 120 chars (a 422 past it); clamp before it ships
 * so a pasted part description degrades to a shorter search, never an error
 * card. Mirrors `q: Query(None, max_length=120)` in routes/categories.py. */
export const Q_MAX_LENGTH = 120;

/**
 * The direction a sort means when the URL names none — MIRRORS the server's
 * `resolve_sort` rule (popular is stock DESC; every column is asc), the same
 * two-homes pattern as the password policy. Without this, a shared bare
 * `?sort=popular` link parsed to 'asc' and the client re-sent it explicitly,
 * opening parent pages on the parts nobody stocks — inverting what the same
 * URL means to the server itself.
 */
export function naturalDir(sort: SortKey | null): SortDir {
  return sort === 'popular' ? 'desc' : 'asc';
}

function isSortKey(value: string | null): value is SortKey {
  return value !== null && (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * Dedupe + drop blanks + sort by code point (NOT `localeCompare`, whose order
 * varies by locale — these lists feed a cache key that must be identical on
 * every device).
 */
function normalizeList(values: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value) seen.add(value);
  }
  return Array.from(seen).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Read the page's state out of the URL. Unknown/garbage values fall back. */
export function parseCategoryQuery(params: URLSearchParams): CategoryQuery {
  const rawPage = Number.parseInt(params.get('p') ?? '1', 10);
  const rawSort = params.get('sort');
  const sort = isSortKey(rawSort) ? rawSort : null;
  const rawDir = params.get('dir');
  return {
    page: Number.isFinite(rawPage) && rawPage > 1 ? rawPage : 1,
    sort,
    dir: rawDir === 'desc' ? 'desc' : rawDir === 'asc' ? 'asc' : naturalDir(sort),
    q: (params.get('q') ?? '').trim().slice(0, Q_MAX_LENGTH),
    mfg: normalizeList(params.getAll('mfg')),
    sub: normalizeList(params.getAll('sub')),
  };
}

export interface CategoryQueryPatch {
  page?: number;
  sort?: SortKey | null;
  dir?: SortDir;
  q?: string;
  mfg?: string[];
  sub?: string[];
}

/**
 * Apply a patch to the CURRENT search params, returning the next set.
 *
 * Two rules live here rather than at the call sites:
 *  - Changing WHAT is listed (sort, search, either filter) resets to page 1.
 *    Doing it here is why the old `?p`-reset effect — and its
 *    `needsCanonicalRedirect` race guard — is gone: there is no second write.
 *  - A value equal to the default is DELETED, not written. That keeps the
 *    default first page on the canonical param-free URL (which is what the
 *    LCP preload and the prerendered documents address) and keeps shared
 *    links short.
 *
 * Params this page doesn't own (`welcome`, `sponsor`) are preserved.
 */
export function writeCategoryQuery(
  prev: URLSearchParams,
  patch: CategoryQueryPatch,
): URLSearchParams {
  const next = new URLSearchParams(prev);

  const resetsPage =
    patch.page === undefined
    && ('sort' in patch || 'dir' in patch || 'q' in patch || 'mfg' in patch || 'sub' in patch);

  if ('sort' in patch) {
    if (patch.sort == null) {
      next.delete('sort');
      next.delete('dir');
    } else {
      next.set('sort', patch.sort);
    }
  }
  if ('dir' in patch && patch.dir !== undefined && next.get('sort') != null) {
    // The sort's NATURAL direction is the deletable default — a bare
    // ?sort=popular must keep meaning desc to every consumer of the URL.
    const activeSort = next.get('sort');
    if (patch.dir === naturalDir(isSortKey(activeSort) ? activeSort : null)) next.delete('dir');
    else next.set('dir', patch.dir);
  }
  if ('q' in patch) {
    const q = (patch.q ?? '').trim().slice(0, Q_MAX_LENGTH);
    if (q) next.set('q', q);
    else next.delete('q');
  }
  for (const key of ['mfg', 'sub'] as const) {
    if (!(key in patch)) continue;
    next.delete(key);
    for (const value of normalizeList(patch[key] ?? [])) next.append(key, value);
  }

  const page = resetsPage ? 1 : patch.page;
  if (page !== undefined) {
    if (page > 1) next.set('p', String(page));
    else next.delete('p');
  }

  return next;
}

/**
 * A stable identity for "which rows does this URL ask for" — the rows-page
 * memo key. Values are percent-encoded so a search containing `&` or `|` can
 * never collide with a different query.
 */
export function categoryQuerySignature(query: CategoryQuery): string {
  const enc = encodeURIComponent;
  return [
    `p=${query.page}`,
    `s=${query.sort ?? ''}`,
    `d=${query.sort ? query.dir : ''}`,
    `q=${enc(query.q)}`,
    `m=${query.mfg.map(enc).join('|')}`,
    `b=${query.sub.map(enc).join('|')}`,
  ].join('&');
}

/**
 * The request query string for `GET /api/categories/{slug}/`.
 *
 * `popular_per_page=1` is deliberate: the legacy `popular_parts` block keeps
 * its exact old behavior for the tests that pin it, but the page reads the
 * scope-aware `parts` block now, so we ask for the smallest legal rollup
 * instead of a second 500-row payload.
 *
 * Built with URLSearchParams (not axios `params`) so the string is ours: the
 * Service Worker keys its cache on the URL, and index.html's preload has to
 * produce the identical one by hand.
 */
export function categoryRequestQuery(query: CategoryQuery = DEFAULT_CATEGORY_QUERY): string {
  const params = new URLSearchParams();
  params.set('popular_page', '1');
  params.set('popular_per_page', '1');
  params.set('parts_page', String(query.page));
  params.set('parts_per_page', String(PAGE_SIZE));
  if (query.sort) {
    params.set('sort', query.sort);
    params.set('dir', query.dir);
  }
  if (query.q) params.set('q', query.q);
  for (const value of query.mfg) params.append('mfg', value);
  for (const value of query.sub) params.append('sub', value);
  return params.toString();
}

/**
 * The default first page — the request every param-free direct load makes.
 * index.html's preload hard-codes this string; `vite.config.ts` builds its
 * StaleWhileRevalidate route from it.
 */
export const CANONICAL_CATEGORY_QUERY = categoryRequestQuery();

/**
 * Did the server reject our `sort` (a hand-edited or stale link asking for a
 * parent-only order on a leaf)? Structural check — no axios import, so this
 * stays usable from the import-free module and testable without a mock.
 */
export function isUnknownSortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const response = (err as { response?: { status?: unknown; data?: unknown } }).response;
  if (typeof response !== 'object' || response === null) return false;
  if (response.status !== 422) return false;
  const data = response.data;
  if (typeof data !== 'object' || data === null) return false;
  return (data as { detail?: unknown }).detail === 'unknown_sort';
}
