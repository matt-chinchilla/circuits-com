import axios from 'axios';
import type { Category, CategoryDetail, CategoryPartners } from '@public/types/category';
import type { Supplier } from '@public/types/supplier';
import type { Sponsor } from '@public/types/sponsor';
import type { PartDetail, RelatedParts } from '@public/types/part';
import type { SearchResultsV2, PublicManufacturers } from '@public/types/search';

import { API_BASE_URL } from '@shared/services/constants';
export { API_BASE_URL };

const client = axios.create({ baseURL: API_BASE_URL });

/** 8-4-4-4-12 hex. Distinguishes a part's UUID from its slug in `/part/:id`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Slugs already warmed via hover-prefetch this session — guards against
// redundant network calls when a user hovers the same card repeatedly.
const _prefetchedCategories = new Set<string>();

export const api = {
  getCategories: () =>
    client.get<Category[]>('/categories/').then(r => r.data),

  getCategory: async (slug: string, popularPage = 1, popularPerPage = 20, partsPage = 1, partsPerPage = 20) => {
    // Reuse the index.html preload fetch (2026-05-30): the inline
    // <script> in frontend/index.html fires the same URL at HTML parse
    // time on direct loads of /category/<slug>. Reading its promise
    // here means the React tree's first paint waits ~3 ms (network)
    // instead of ~400 ms (chunks + mount + axios cold start).
    const preload = typeof window !== 'undefined'
      ? (window as unknown as { __categoryPreload?: { slug: string; promise: Promise<CategoryDetail | null> } }).__categoryPreload
      : undefined;
    if (
      preload && preload.slug === slug
      && popularPage === 1 && popularPerPage === 500
      && partsPage === 1 && partsPerPage === 500
    ) {
      delete (window as unknown as { __categoryPreload?: unknown }).__categoryPreload;
      const cached = await preload.promise;
      if (cached) return cached;
    }
    const r = await client.get<CategoryDetail>(`/categories/${slug}/`, {
      params: {
        popular_page: popularPage, popular_per_page: popularPerPage,
        parts_page: partsPage, parts_per_page: partsPerPage,
      },
    });
    return r.data;
  },

  // Hover-prefetch the category's API data so the Service Worker caches it
  // before the click. MUST mirror the category page's call
  // (`getCategory(slug, 1, 500, 1, 500)`) exactly so the cached URL matches.
  prefetchCategory: (slug: string) => {
    if (_prefetchedCategories.has(slug)) return;
    _prefetchedCategories.add(slug);
    api.getCategory(slug, 1, 500, 1, 500).catch(() => {});
  },

  // Top-level Platinum Category Sponsor (small, cacheable) → { slug, name,
  // platinum: PlatinumSponsor | null }. No trailing slash — matches the route
  // exactly; the endpoint resolves a child slug to its parent.
  getCategoryPartners: (slug: string) =>
    client.get<CategoryPartners>(`/categories/${slug}/partners`).then(r => r.data),

  // Search v2 (same route, richer contract — see @public/types/search).
  // Dropdown/typeahead callers MUST pass { suggest: 0 } so zero-result
  // keystrokes never pay the server's fuzzy-recovery pipeline; the results
  // page omits it (server default suggest=1).
  // `compact: 1` is the dropdown's payload trim (parts ≤5, categories/suppliers
  // ≤3, no manufacturers) — the typeahead renders exactly that and the full
  // 20/12-cap enrichment was wasted work per keystroke.
  searchV2: (q: string, opts?: { suggest?: 0 | 1; compact?: 0 | 1 }) =>
    client
      .get<SearchResultsV2>('/search/', {
        params: {
          q,
          ...(opts?.suggest !== undefined ? { suggest: opts.suggest } : {}),
          ...(opts?.compact ? { compact: 1 } : {}),
        },
      })
      .then(r => r.data),

  // Public derived manufacturers (names + part counts only — no CRM data
  // exists behind this route). `total` is the full derived-list length.
  getManufacturers: (limit = 60) =>
    client.get<PublicManufacturers>('/manufacturers/', { params: { limit } }).then(r => r.data),

  getSuppliers: () =>
    client.get<Supplier[]>('/suppliers/').then(r => r.data),

  getSponsorByKeyword: (keyword: string) =>
    client.get<Sponsor>(`/sponsors/keyword/${keyword}/`).then(r => r.data),

  // POST the exact route path (no trailing slash). The form routes are defined
  // as `/api/contact|join|keyword-request` (no slash); a trailing slash forces a
  // 307 redirect that the client must re-POST through — works in mainstream
  // browsers but some proxies/security tools drop the body on a 307-POST, which
  // would silently lose a submission. Matching the path removes that round-trip.
  submitContact: (data: Record<string, string>) =>
    client.post('/contact', data),

  submitJoin: (data: Record<string, unknown>) =>
    client.post('/join', data),

  submitKeywordRequest: (data: {
    company_name: string;
    email: string;
    keyword: string;
    // `name` is required; `tier` is optional and constrained to the keyword
    // tier set ('silver' | 'gold'). Per the sponsor-tier-boards matrix
    // (2026-06-11) Platinum is reserved for top-level Category Sponsor boards —
    // the backend KeywordRequestForm.tier Literal rejects it (422). Both fields
    // reach the Message.payload + notify-email body.
    name: string;
    tier?: 'silver' | 'gold' | null;
    message?: string;
  }) => client.post('/keyword-request', data),

  /**
   * Resolve a part by EITHER its UUID or its slug.
   *
   * `/part/:id` has always accepted both shapes in the URL, but this only ever
   * called `/parts/{id}` — the UUID endpoint, which 404s on anything that is
   * not a UUID. So every slug URL was a SOFT 404: nginx served the SPA shell
   * with a 200, the page rendered its error state, and no title, canonical or
   * Product markup was emitted.
   *
   * That mattered because part pages canonicalize to the SLUG form
   * (`partSeo({ slug: part.slug ?? id })`), so ~3,600 working UUID pages were
   * pointing Google at URLs that resolved to nothing.
   *
   * Shape decides the endpoint. A slug is `slugify_sku(sku.lower())`, so a
   * value matching the UUID grammar exactly — 8-4-4-4-12 hex with hyphens in
   * those positions — is a UUID in practice, not a part number.
   */
  getPartDetail: (idOrSlug: string) =>
    client
      .get<PartDetail>(
        UUID_RE.test(idOrSlug)
          ? `/parts/${idOrSlug}`
          : `/parts/by-slug/${encodeURIComponent(idOrSlug)}`,
      )
      .then(r => r.data),

  // Alternates + companions for the part page. Called with the RESOLVED
  // part.id (a UUID) after getPartDetail lands, never with a slug.
  getRelatedParts: (id: string) =>
    client.get<RelatedParts>(`/parts/${id}/related`).then(r => r.data),

  // ── Self-serve Silver checkout (routes/checkout.py) ────────────────────
  // Both 404 when billing is unconfigured server-side; SilverPartners treats
  // that as "no self-serve here" and falls back to the Contact page.

  getSilverCheckoutInfo: () =>
    client
      .get<{ monthly_total: number; tax_included: boolean }>('/checkout/silver')
      .then(r => r.data),

  // The /pricing placement picker: every subcategory board with its open
  // Silver slot count. Choosing one deep-links to that category page with
  // ?sponsor=1, so the purchase still happens standing on the slot.
  getSilverBoards: () =>
    client
      .get<{
        monthly_total: number;
        boards: {
          category_id: string;
          name: string;
          parent_name: string;
          path: string;
          open_slots: number;
          total_slots: number;
        }[];
      }>('/checkout/silver/boards')
      .then(r => r.data),

  // `email` is the confirm panel's second field: Stripe's page opens
  // pre-filled with it and the customer record carries it, so the receipt and
  // every renewal invoice reach the buyer. Optional on the wire — the server
  // keeps accepting a request without one.
  createSilverCheckout: (body: {
    category_id?: string;
    keyword?: string;
    company_name: string;
    email?: string;
    website?: string;
  }) =>
    client
      .post<{ session_id: string; url: string }>('/checkout/silver', body)
      .then(r => r.data),
};
