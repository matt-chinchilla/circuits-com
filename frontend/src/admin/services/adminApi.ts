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
  PaginatedResponse,
  AdminSupplier,
  BatchImportResult,
  AdminCategory,
  AdminSponsor,
} from '@admin/types/admin';
import type { Message, MessageStatus, AssignedTo } from '@admin/types/messages';

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

export const adminApi = {
  login: (username: string, password: string) =>
    adminClient
      .post<AuthResponse>('/auth/login', { username, password })
      .then((r) => r.data),

  getMe: () =>
    adminClient.get<UserInfo>('/auth/me').then((r) => r.data),

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
    adminClient.post<Part>('/parts/', data).then((r) => r.data),

  updatePart: (id: string, data: Partial<PartDetail>) =>
    adminClient.put<Part>(`/parts/${id}`, data).then((r) => r.data),

  deletePart: (id: string) =>
    adminClient.delete(`/parts/${id}`).then((r) => r.data),

  batchImportParts: (supplierId: string, data: Record<string, unknown>[]) =>
    adminClient
      .post<BatchImportResult>('/parts/batch', { supplier_id: supplierId, parts: data })
      .then((r) => r.data),

  getSuppliers: () =>
    adminClient.get<AdminSupplier[]>('/suppliers/').then((r) => r.data),

  getSupplier: (id: string) =>
    adminClient.get<AdminSupplier>(`/suppliers/${id}`).then((r) => r.data),

  createSupplier: (data: Partial<AdminSupplier>) =>
    adminClient.post<AdminSupplier>('/suppliers/', data).then((r) => r.data),

  updateSupplier: (id: string, data: Partial<AdminSupplier>) =>
    adminClient
      .put<AdminSupplier>(`/suppliers/${id}`, data)
      .then((r) => r.data),

  deleteSupplier: (id: string) =>
    adminClient.delete(`/suppliers/${id}`).then((r) => r.data),

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

  createSponsor: (data: SponsorCreate) =>
    adminClient.post<AdminSponsor>('/admin/sponsors/', data).then((r) => r.data),

  updateSponsor: (id: string, data: Partial<SponsorCreate>) =>
    adminClient
      .patch<AdminSponsor>(`/admin/sponsors/${id}`, data)
      .then((r) => r.data),

  deleteSponsor: (id: string) =>
    adminClient.delete(`/admin/sponsors/${id}`).then((r) => r.data),

  // "Feature" a supplier on a category = a Featured sponsorship on that
  // (top-level) category — the single source of truth as of 2026-06-03
  // (the standalone category-suppliers feature flag was removed). Used by the
  // guided-tour wizard so the demo supplier shows up in the live-site preview.
  // Best-effort: resolve the slug to a category id, then create the sponsorship
  // (the caller swallows failures — e.g. a non-top-level slug or a duplicate).
  featureSupplierInCategory: async (supplierId: string, categorySlug: string) => {
    const cats = await adminApi.getCategories();
    const cat = cats.find((c) => c.slug === categorySlug);
    if (!cat) return null;
    return adminApi.createSponsor({
      supplier_id: supplierId,
      category_id: cat.id,
      tier: 'Featured',
      status: 'Active',
    } as SponsorCreate);
  },
};
