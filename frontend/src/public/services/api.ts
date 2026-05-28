import axios from 'axios';
import type { Category, CategoryDetail } from '@public/types/category';
import type { Supplier } from '@public/types/supplier';
import type { Sponsor } from '@public/types/sponsor';
import type { PublicPart, PartDetail } from '@public/types/part';

import { API_BASE_URL } from '@shared/services/constants';
export { API_BASE_URL };

const client = axios.create({ baseURL: API_BASE_URL });

// Slugs already warmed via hover-prefetch this session — guards against
// redundant network calls when a user hovers the same card repeatedly.
const _prefetchedCategories = new Set<string>();

export interface SearchResults {
  categories: Category[];
  suppliers: Supplier[];
  parts: PublicPart[];
}

export const api = {
  getCategories: () =>
    client.get<Category[]>('/categories/').then(r => r.data),

  getCategory: (slug: string, popularPage = 1, popularPerPage = 20, partsPage = 1, partsPerPage = 20) =>
    client
      .get<CategoryDetail>(`/categories/${slug}/`, {
        params: {
          popular_page: popularPage, popular_per_page: popularPerPage,
          parts_page: partsPage, parts_per_page: partsPerPage,
        },
      })
      .then(r => r.data),

  // Hover-prefetch the category's API data so the Service Worker caches it
  // before the click. MUST mirror the category page's call
  // (`getCategory(slug, 1, 500, 1, 500)`) exactly so the cached URL matches.
  prefetchCategory: (slug: string) => {
    if (_prefetchedCategories.has(slug)) return;
    _prefetchedCategories.add(slug);
    api.getCategory(slug, 1, 500, 1, 500).catch(() => {});
  },

  search: (q: string) =>
    client.get<SearchResults>('/search/', { params: { q } }).then(r => r.data),

  getSuppliers: () =>
    client.get<Supplier[]>('/suppliers/').then(r => r.data),

  getSponsorByKeyword: (keyword: string) =>
    client.get<Sponsor>(`/sponsors/keyword/${keyword}/`).then(r => r.data),

  submitContact: (data: Record<string, string>) =>
    client.post('/contact/', data),

  submitJoin: (data: Record<string, unknown>) =>
    client.post('/join/', data),

  submitKeywordRequest: (data: {
    company_name: string;
    email: string;
    keyword: string;
    // V2 design parity (2026-05-16): `name` is required and `tier` is optional
    // ('silver' | 'gold' | 'platinum'). Both reach the backend's
    // KeywordRequestForm and end up in the Message.payload + notify-email body.
    name: string;
    tier?: 'silver' | 'gold' | 'platinum' | null;
    message?: string;
  }) => client.post('/keyword-request/', data),

  getPartDetail: (id: string) =>
    client.get<PartDetail>(`/parts/${id}`).then(r => r.data),
};
