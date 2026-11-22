import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, createApiClient } from '@shop/shared';
import { mockFetch } from '../../../shared/src/test-utils';
import { App } from '../App';

const admin = { id: 'a1', email: 'admin@example.com', full_name: 'Admin', role: 'admin', is_active: true, created_at: '' };
const cat = { id: 1, name: 'Books', slug: 'books' };
const product = { id: 7, sku: 'BK-1', name: 'Field Guide', description: null, price_minor: 49900, currency: 'INR', stock: 3, category: cat, image_url: null, is_active: true, created_at: '', updated_at: '' };
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, page_size: 15 });

function setup(routes: Parameters<typeof mockFetch>[0], { path = '/products', user = admin as unknown, signedIn = true } = {}) {
  const m = mockFetch({
    'POST /api/users/refresh': signedIn ? { body: { access_token: 't' } } : { status: 401 },
    'GET /api/users/me': { body: user },
    'GET /api/products/categories': { body: [cat] },
    ...routes,
  });
  const api = createApiClient({ fetchImpl: m.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AuthProvider api={api}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></AuthProvider></QueryClientProvider>);
  return m;
}

describe('access control', () => {
  it('sends anonymous visitors to the sign in page', async () => {
    setup({}, { signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();
  });
  it('turns customers away', async () => {
    setup({}, { user: { ...admin, role: 'customer' } });
    expect(await screen.findByText(/not an administrator/i)).toBeInTheDocument();
  });
  it('rejects a customer who signs in on the admin login and signs them out again', async () => {
    const customer = { ...admin, role: 'customer' };
    const m = setup({
      'POST /api/users/login': { body: { access_token: 't', expires_in: 900 } },
      'GET /api/users/me': { body: customer },
      'POST /api/users/logout': { status: 204 },
    }, { path: '/login', signedIn: false });
    await userEvent.type(await screen.findByLabelText('Email'), 'c@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not an administrator/i);
    expect(m.calls.some((c) => c.url === '/api/users/logout')).toBe(true);
  });
});

describe('products', () => {
  it('lists products with low stock visible', async () => {
    setup({ 'GET /api/products': { body: page([product]) } });
    expect(await screen.findByText('Field Guide')).toBeInTheDocument();
    expect(screen.getByText('₹499')).toBeInTheDocument();
    expect(screen.getByText('3')).toHaveClass('low');
  });

  it('creates a product, converting the price to minor units', async () => {
    const m = setup({ 'GET /api/products': { body: page([]) }, 'POST /api/products': { status: 201, body: product } });
    await userEvent.click(await screen.findByRole('button', { name: 'New product' }));
    await userEvent.type(screen.getByLabelText('SKU'), 'BK-1');
    await userEvent.type(screen.getByLabelText('Name'), 'Field Guide');
    await userEvent.type(screen.getByLabelText(/Price/), '499.50');
    await userEvent.click(screen.getByRole('button', { name: 'Save product' }));
    await screen.findByText('Saved Field Guide');
    const post = m.calls.find((c) => c.method === 'POST' && c.url === '/api/products')!;
    expect(post.body).toMatchObject({ sku: 'BK-1', name: 'Field Guide', price_minor: 49950, stock: 0 });
  });

  it('shows a clear error for a bad price and does not call the API', async () => {
    const m = setup({ 'GET /api/products': { body: page([]) } });
    await userEvent.click(await screen.findByRole('button', { name: 'New product' }));
    await userEvent.type(screen.getByLabelText('SKU'), 'X');
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.type(screen.getByLabelText(/Price/), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save product' }));
    expect(await screen.findByText(/Enter a price like/)).toBeInTheDocument();
    expect(m.calls.some((c) => c.method === 'POST' && c.url === '/api/products')).toBe(false);
  });

  it('shows server conflicts such as a duplicate SKU', async () => {
    setup({ 'GET /api/products': { body: page([]) }, 'POST /api/products': { status: 409, body: { detail: 'SKU already exists' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'New product' }));
    await userEvent.type(screen.getByLabelText('SKU'), 'BK-1');
    await userEvent.type(screen.getByLabelText('Name'), 'Dup');
    await userEvent.type(screen.getByLabelText(/Price/), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('SKU already exists')).toBeInTheDocument();
  });

  it('archives after confirmation only', async () => {
    const m = setup({ 'GET /api/products': { body: page([product]) }, 'DELETE /api/products/7': { status: 204 } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(await screen.findByRole('button', { name: 'Archive Field Guide' }));
    expect(m.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Archive Field Guide' }));
    await screen.findByText('Archived Field Guide');
    confirm.mockRestore();
  });

  it('adjusts stock by a delta', async () => {
    const m = setup({ 'GET /api/products': { body: page([product]) }, 'PATCH /api/products/7/stock': { body: { ...product, stock: 13 } } });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('+10');
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust stock for Field Guide' }));
    await waitFor(() => expect(m.calls.find((c) => c.url === '/api/products/7/stock')?.body).toEqual({ delta: 10 }));
    prompt.mockRestore();
  });
});

describe('orders', () => {
  const order = (status: string) => ({ id: 'abcdef12-0000', user_id: 'u1', status, total_minor: 100, currency: 'INR', cancel_reason: null, items: [{ product_id: 1, sku: 's', name: 'n', unit_price_minor: 100, quantity: 2 }], created_at: '2026-01-01T00:00:00Z', updated_at: '' });

  it('ships a paid order', async () => {
    const m = setup({ 'GET /api/orders/admin/list': { body: page([order('PAID')]) }, 'POST /api/orders/abcdef12-0000/ship': { body: { ...order('SHIPPED'), history: [] } } }, { path: '/orders' });
    await userEvent.click(await screen.findByRole('button', { name: /ship order abcdef12/i }));
    await waitFor(() => expect(m.calls.some((c) => c.url.endsWith('/ship'))).toBe(true));
  });

  it('only offers the action that is valid for the status', async () => {
    setup({ 'GET /api/orders/admin/list': { body: page([order('PENDING'), order('SHIPPED')]) } }, { path: '/orders' });
    expect(await screen.findByRole('button', { name: /mark order .* delivered/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ship order/i })).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    const m = setup({ 'GET /api/orders/admin/list': { body: page([]) } }, { path: '/orders' });
    await userEvent.selectOptions(await screen.findByLabelText('Status'), 'PAID');
    await waitFor(() => expect(m.calls.some((c) => c.url.includes('status=PAID'))).toBe(true));
  });
});

describe('payments and categories', () => {
  it('lists payments', async () => {
    setup({ 'GET /api/payments/admin/list': { body: page([{ id: 'p1234567-0', order_id: 'o1234567-0', user_id: 'u', amount_minor: 249900, currency: 'INR', status: 'FAILED', provider_ref: null, failure_reason: 'card_declined', created_at: '2026-01-01T00:00:00Z', updated_at: '' }]) } }, { path: '/payments' });
    expect(await screen.findByText('card_declined')).toBeInTheDocument();
    expect(screen.getByText('₹2,499')).toBeInTheDocument();
  });
  it('adds a category', async () => {
    const m = setup({ 'POST /api/products/categories': { status: 201, body: { id: 2, name: 'Toys', slug: 'toys' } } }, { path: '/categories' });
    await userEvent.type(await screen.findByLabelText('New category'), 'Toys');
    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(m.calls.find((c) => c.method === 'POST' && c.url.endsWith('/categories'))?.body).toEqual({ name: 'Toys' }));
  });
});
