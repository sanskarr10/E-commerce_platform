import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, createApiClient } from '@shop/shared';
import type { ReactNode } from 'react';
import { CartProvider } from './cart';
import { mockFetch } from '../../shared/src/test-utils';

export { mockFetch };

export const customer = { id: 'u1', email: 'asha@example.com', full_name: 'Asha', role: 'customer', is_active: true, created_at: '2026-01-01T00:00:00Z' };

export const phone = {
  id: 1, sku: 'ELEC-001', name: 'Wireless Earbuds', description: 'Bluetooth 5.3', price_minor: 249900, currency: 'INR', stock: 12,
  category: { id: 1, name: 'Electronics', slug: 'electronics' }, image_url: null, is_active: true, created_at: '', updated_at: '',
};

export function renderApp(ui: ReactNode, routes: Parameters<typeof mockFetch>[0], { path = '/', signedIn = true } = {}) {
  const m = mockFetch({
    'POST /api/users/refresh': signedIn ? { body: { access_token: 't' } } : { status: 401, body: { detail: 'no' } },
    'GET /api/users/me': { body: customer },
    ...routes,
  });
  const api = createApiClient({ fetchImpl: m.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider api={api}>
        <CartProvider>
          <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
        </CartProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return m;
}
