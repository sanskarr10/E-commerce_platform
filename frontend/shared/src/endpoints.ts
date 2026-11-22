import type { ApiClient } from './api';
import type {
  Category,
  Order,
  OrderDetail,
  Page,
  Payment,
  Product,
  ProductFilters,
  ProductInput,
  ProductPatch,
  User,
} from './types';

export interface PlaceOrderBody {
  items: Array<{ product_id: number; quantity: number }>;
  payment_method: string;
}

/** One typed function per backend operation, so components never build URLs by hand. */
export function createEndpoints(api: ApiClient) {
  return {
    users: {
      login: (email: string, password: string) =>
        api.request<{ access_token: string; expires_in: number }>('POST', '/api/users/login', {
          auth: 'none',
          body: { email, password },
        }),
      register: (email: string, password: string, full_name: string) =>
        api.request<User>('POST', '/api/users/register', { auth: 'none', body: { email, password, full_name } }),
      logout: () => api.request<void>('POST', '/api/users/logout', { auth: 'none' }),
      me: () => api.request<User>('GET', '/api/users/me', { auth: 'required' }),
    },
    products: {
      list: (filters: ProductFilters = {}) =>
        api.request<Page<Product>>('GET', '/api/products', { auth: 'none', query: { ...filters } }),
      get: (id: number | string) => api.request<Product>('GET', `/api/products/${id}`, { auth: 'none' }),
      categories: () => api.request<Category[]>('GET', '/api/products/categories', { auth: 'none' }),
      create: (body: ProductInput) => api.request<Product>('POST', '/api/products', { auth: 'required', body }),
      update: (id: number, patch: ProductPatch) =>
        api.request<Product>('PATCH', `/api/products/${id}`, { auth: 'required', body: patch }),
      adjustStock: (id: number, delta: number) =>
        api.request<Product>('PATCH', `/api/products/${id}/stock`, { auth: 'required', body: { delta } }),
      archive: (id: number) => api.request<void>('DELETE', `/api/products/${id}`, { auth: 'required' }),
      createCategory: (name: string) =>
        api.request<Category>('POST', '/api/products/categories', { auth: 'required', body: { name } }),
    },
    orders: {
      /** `replayed` is true when the Idempotency-Key matched an earlier request and no new order was created. */
      place: async (body: PlaceOrderBody, idempotencyKey: string) => {
        const response = await api.requestRaw<Order>('POST', '/api/orders', {
          auth: 'required',
          body,
          headers: { 'Idempotency-Key': idempotencyKey },
        });
        return { order: response.data, replayed: response.headers.get('Idempotent-Replayed') === 'true' };
      },
      mine: (page = 1, page_size = 10) =>
        api.request<Page<Order>>('GET', '/api/orders', { auth: 'required', query: { page, page_size } }),
      get: (id: string) => api.request<OrderDetail>('GET', `/api/orders/${id}`, { auth: 'required' }),
      adminList: (query: { status?: string; page?: number; page_size?: number } = {}) =>
        api.request<Page<Order>>('GET', '/api/orders/admin/list', { auth: 'required', query }),
      ship: (id: string) => api.request<OrderDetail>('POST', `/api/orders/${id}/ship`, { auth: 'required' }),
      deliver: (id: string) => api.request<OrderDetail>('POST', `/api/orders/${id}/deliver`, { auth: 'required' }),
    },
    payments: {
      forOrder: (orderId: string) =>
        api.request<Payment>('GET', `/api/payments/orders/${orderId}`, { auth: 'required' }),
      adminList: (query: { status?: string; page?: number; page_size?: number } = {}) =>
        api.request<Page<Payment>>('GET', '/api/payments/admin/list', { auth: 'required', query }),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
