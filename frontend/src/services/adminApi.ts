import axios from 'axios';
import { API_BASE_URL } from './api';
import type {
  AuthResponse,
  UserInfo,
  DashboardStats,
  ActivityItem,
  RevenueMonth,
  PopularData,
  Part,
  PartDetail,
  PaginatedResponse,
  AdminSupplier,
  BatchImportResult,
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
    adminClient.get<DashboardStats>('/admin/stats').then((r) => r.data),

  getActivity: () =>
    adminClient.get<ActivityItem[]>('/admin/activity').then((r) => r.data),

  getRevenue: () =>
    adminClient.get<RevenueMonth[]>('/admin/revenue').then((r) => r.data),

  getPopular: () =>
    adminClient.get<PopularData>('/admin/popular').then((r) => r.data),

  getParts: (params: {
    page?: number;
    search?: string;
    category_id?: string;
    supplier_id?: string;
  }) =>
    adminClient
      .get<PaginatedResponse<Part>>('/admin/parts', { params })
      .then((r) => r.data),

  getPart: (id: string) =>
    adminClient.get<PartDetail>(`/admin/parts/${id}`).then((r) => r.data),

  createPart: (data: Partial<PartDetail>) =>
    adminClient.post<Part>('/admin/parts', data).then((r) => r.data),

  updatePart: (id: string, data: Partial<PartDetail>) =>
    adminClient.put<Part>(`/admin/parts/${id}`, data).then((r) => r.data),

  deletePart: (id: string) =>
    adminClient.delete(`/admin/parts/${id}`).then((r) => r.data),

  batchImportParts: (data: Record<string, unknown>[]) =>
    adminClient
      .post<BatchImportResult>('/admin/parts/import', { parts: data })
      .then((r) => r.data),

  getSuppliers: () =>
    adminClient.get<AdminSupplier[]>('/admin/suppliers').then((r) => r.data),

  getSupplier: (id: string) =>
    adminClient.get<AdminSupplier>(`/admin/suppliers/${id}`).then((r) => r.data),

  createSupplier: (data: Partial<AdminSupplier>) =>
    adminClient.post<AdminSupplier>('/admin/suppliers', data).then((r) => r.data),

  updateSupplier: (id: string, data: Partial<AdminSupplier>) =>
    adminClient
      .put<AdminSupplier>(`/admin/suppliers/${id}`, data)
      .then((r) => r.data),

  getSupplierParts: (
    id: string,
    params: { page?: number; search?: string }
  ) =>
    adminClient
      .get<PaginatedResponse<Part>>(`/admin/suppliers/${id}/parts`, { params })
      .then((r) => r.data),
};
