import axios from 'axios';
import { API_BASE_URL } from './api';
import type {
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
} from '../types/admin';

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

  getSupplierParts: (
    id: string,
    params: { page?: number; search?: string }
  ) =>
    adminClient
      .get<PaginatedResponse<Part>>(`/suppliers/${id}/parts`, { params })
      .then((r) => r.data),

  getCategories: () =>
    adminClient.get<AdminCategory[]>('/categories/').then((r) => r.data),
};
