import axios from 'axios';
import type { Category, CategoryDetail } from '@public/types/category';
import type { Supplier } from '@public/types/supplier';
import type { Sponsor } from '@public/types/sponsor';
import type { PublicPart, PartDetail } from '@public/types/part';

import { API_BASE_URL } from '@shared/services/constants';
export { API_BASE_URL };

const client = axios.create({ baseURL: API_BASE_URL });

export interface SearchResults {
  categories: Category[];
  suppliers: Supplier[];
  parts: PublicPart[];
}

export const api = {
  getCategories: () =>
    client.get<Category[]>('/categories/').then(r => r.data),

  getCategory: (slug: string) =>
    client.get<CategoryDetail>(`/categories/${slug}/`).then(r => r.data),

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

  submitKeywordRequest: (data: Record<string, string>) =>
    client.post('/keyword-request/', data),

  getPartDetail: (id: string) =>
    client.get<PartDetail>(`/parts/${id}`).then(r => r.data),
};
