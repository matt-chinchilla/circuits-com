import axios from 'axios';
import type { Category, CategoryDetail } from '../types/category';
import type { Supplier } from '../types/supplier';
import type { Sponsor } from '../types/sponsor';

const client = axios.create({ baseURL: '/api' });

export interface SearchResults {
  categories: Category[];
  suppliers: Supplier[];
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
};
