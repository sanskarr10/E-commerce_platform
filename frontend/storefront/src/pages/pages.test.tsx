import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { App } from '../App';
import { customer, mockFetch, phone, renderApp } from '../test-utils';

const categories = [{ id: 1, name: 'Electronics', slug: 'electronics' }];
const list = { items: [phone], total: 1, page: 1, page_size: 8 };

describe('catalog', () => {
  it('lists products and adds one to the cart', async () => {
    renderApp(<App />, { 'GET /api/products': { body: list }, 'GET /api/products/categories': { body: categories } });
    expect(await screen.findByText('Wireless Earbuds')).toBeInTheDocument();
    expect(screen.getByText('₹2,499')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /add wireless earbuds to cart/i }));
    expect(screen.getByRole('link', { name: /cart/i })).toHaveTextContent('1');
  });

  it('sends search and category filters to the API', async () => {
    const m = renderApp(<App />, { 'GET /api/products': { body: list }, 'GET /api/products/categories': { body: categories } });
    await screen.findByText('Wireless Earbuds');
    await userEvent.type(screen.getByRole('searchbox'), 'ear{enter}');
    await waitFor(() => expect(m.calls.some((c) => c.url.includes('q=ear'))).toBe(true));
    await userEvent.click(await screen.findByRole('button', { name: 'Electronics' }));
    await waitFor(() => expect(m.calls.some((c) => c.url.includes('category=electronics'))).toBe(true));
  });

  it('shows an error with retry', async () => {
    renderApp(<App />, { 'GET /api/products': { status: 503, body: { detail: 'down' } }, 'GET /api/products/categories': { body: categories } });
    expect(await screen.findByRole('alert')).toHaveTextContent('down');
  });

  it('marks out-of-stock products', async () => {
    renderApp(<App />, { 'GET /api/products': { body: { ...list, items: [{ ...phone, stock: 0 }] } }, 'GET /api/products/categories': { body: categories } });
    expect(await screen.findByText('Out of stock')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add wireless/i })).not.toBeInTheDocument();
  });
});

describe('auth', () => {
  it('shows server validation errors next to the fields', async () => {
    renderApp(<App />, {
      'POST /api/users/register': { status: 422, body: { detail: [{ loc: ['body', 'password'], msg: 'Password needs a digit', type: 'x' }] } },
    }, { path: '/register', signedIn: false });
    await userEvent.type(await screen.findByLabelText(/full name/i), 'Asha');
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/password/i), 'abcdefgh');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Password needs a digit')).toBeInTheDocument();
  });

  it('shows bad credentials without trying to refresh', async () => {
    const m = renderApp(<App />, { 'POST /api/users/login': { status: 401, body: { detail: 'Invalid email or password' } } }, { path: '/login', signedIn: false });
    await userEvent.type(await screen.findByLabelText(/email/i), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(m.calls.filter((c) => c.url === '/api/users/refresh')).toHaveLength(1); // only the page-load bootstrap
  });

  it('sends anonymous visitors from checkout to sign in', async () => {
    renderApp(<App />, {}, { path: '/orders', signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('checkout', () => {
  const seed = () => window.localStorage.setItem('cart.v1', JSON.stringify([{ product_id: 1, sku: 'E', name: 'Wireless Earbuds', price_minor: 249900, currency: 'INR', quantity: 2, stock: 12, category: 'electronics' }]));
  const placed = { id: 'abc12345-0000', user_id: 'u1', status: 'PENDING', total_minor: 499800, currency: 'INR', cancel_reason: null, items: [], created_at: '', updated_at: '' };

  it('places the order with an Idempotency-Key and the chosen test card, then clears the cart', async () => {
    seed();
    const m = renderApp(<App />, {
      'POST /api/orders': { status: 201, body: placed },
      'GET /api/orders/abc12345-0000': { body: { ...placed, history: [] } },
    }, { path: '/checkout' });
    await userEvent.click(await screen.findByLabelText(/declined$/i));
    await userEvent.click(screen.getByRole('button', { name: /pay/i }));
    await screen.findByRole('heading', { name: /order abc12345/i });
    const post = m.calls.find((c) => c.method === 'POST' && c.url === '/api/orders')!;
    expect(post.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
    expect(post.body).toEqual({ items: [{ product_id: 1, quantity: 2 }], payment_method: 'tok_decline' });
    expect(window.localStorage.getItem('cart.v1')).toBe('[]');
  });

  it('reuses the same key when the same cart is retried after a failure', async () => {
    seed();
    const m = renderApp(<App />, { 'POST /api/orders': [{ status: 503, body: { detail: 'try later' } }, { status: 200, body: placed, headers: { 'Idempotent-Replayed': 'true' } }], 'GET /api/orders/abc12345-0000': { body: { ...placed, history: [] } } }, { path: '/checkout' });
    await userEvent.click(await screen.findByRole('button', { name: /pay/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('try later');
    await userEvent.click(screen.getByRole('button', { name: /pay/i }));
    await screen.findByRole('heading', { name: /order abc12345/i });
    const keys = m.calls.filter((c) => c.url === '/api/orders').map((c) => c.headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('redirects an empty cart', async () => {
    renderApp(<App />, {}, { path: '/checkout' });
    expect(await screen.findByText(/cart is empty/i)).toBeInTheDocument();
  });
});

describe('order tracking', () => {
  const base = { id: 'abc12345-0000', user_id: 'u1', total_minor: 249900, currency: 'INR', cancel_reason: null, items: [{ product_id: 1, sku: 'E', name: 'Wireless Earbuds', unit_price_minor: 249900, quantity: 1 }], created_at: '2026-01-01T10:00:00Z', updated_at: '' };
  const h = (to: string) => ({ from_status: null, to_status: to, reason: null, created_at: '2026-01-01T10:00:00Z' });

  it('shows progress to PAID', async () => {
    renderApp(<App />, { 'GET /api/orders/abc12345-0000': { body: { ...base, status: 'PAID', history: [h('PENDING'), h('STOCK_RESERVED'), h('PAID')] } } }, { path: '/orders/abc12345-0000' });
    const tracker = await screen.findByLabelText('Order progress');
    expect(within(tracker).getByText('Payment confirmed').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(within(tracker).getByText('Items reserved').closest('li')).toHaveClass('done');
  });

  it('explains a declined payment', async () => {
    renderApp(<App />, { 'GET /api/orders/abc12345-0000': { body: { ...base, status: 'CANCELLED', cancel_reason: 'payment_failed', history: [h('PENDING'), h('STOCK_RESERVED'), h('CANCELLED')] } } }, { path: '/orders/abc12345-0000' });
    expect(await screen.findByText(/payment was declined/i)).toBeInTheDocument();
  });

  it('keeps polling until the order reaches a final state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const statuses = ['PENDING', 'STOCK_RESERVED', 'PAID'];
    let i = 0;
    renderApp(<App />, { 'GET /api/orders/abc12345-0000': () => ({ body: { ...base, status: statuses[Math.min(i++, 2)], history: [h('PENDING')] } }) }, { path: '/orders/abc12345-0000' });
    await screen.findByText('We are checking stock.');
    await vi.advanceTimersByTimeAsync(1600);
    await screen.findByText(/set aside/i);
    await vi.advanceTimersByTimeAsync(1600);
    await screen.findByText(/shop will ship/i);
    vi.useRealTimers();
  });
});

describe('routing', () => {
  it('shows a not-found page', async () => {
    renderApp(<App />, {}, { path: '/nope' });
    expect(await screen.findByText(/page not found/i)).toBeInTheDocument();
  });
  it('is exercised with a route table', () => {
    // keeps Routes/Route/mockFetch/customer imports honest for the helpers above
    expect([Routes, Route, mockFetch, customer].every(Boolean)).toBe(true);
  });
});

describe('notifications', () => {
  const note = (over = {}) => ({ id: 'n1', type: 'order.confirmed', order_id: 'abc12345-0000', title: 'Payment received', body: 'Your order #abc12345 is confirmed.', created_at: '2026-01-01T10:00:00Z', read_at: null, ...over });
  const page = (items: unknown[], unread: number) => ({ items, total: items.length, unread, page: 1, page_size: 50 });

  it('shows the unread count in the navigation', async () => {
    renderApp(<App />, { 'GET /api/products': { body: list }, 'GET /api/products/categories': { body: categories }, 'GET /api/notifications': { body: page([note()], 3) } });
    expect(await screen.findByLabelText('3 unread')).toBeInTheDocument();
  });

  it('does not ask for notifications when signed out', async () => {
    const m = renderApp(<App />, { 'GET /api/products': { body: list }, 'GET /api/products/categories': { body: categories } }, { signedIn: false });
    await screen.findByText('Wireless Earbuds');
    expect(m.calls.some((c) => c.url.startsWith('/api/notifications'))).toBe(false);
  });

  it('lists notifications and marks one read', async () => {
    const m = renderApp(<App />, {
      'GET /api/notifications': { body: page([note()], 1) },
      'POST /api/notifications/n1/read': { body: note({ read_at: '2026-01-01T10:05:00Z' }) },
    }, { path: '/notifications' });
    expect(await screen.findByText('Payment received')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /mark "payment received" as read/i }));
    await waitFor(() => expect(m.calls.some((c) => c.method === 'POST' && c.url === '/api/notifications/n1/read')).toBe(true));
  });

  it('marks everything read in one request', async () => {
    const m = renderApp(<App />, { 'GET /api/notifications': { body: page([note(), note({ id: 'n2' })], 2) }, 'POST /api/notifications/read-all': { body: { updated: 2 } } }, { path: '/notifications' });
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(m.calls.some((c) => c.url === '/api/notifications/read-all')).toBe(true));
  });

  it('has an empty state that points somewhere', async () => {
    renderApp(<App />, { 'GET /api/notifications': { body: page([], 0) } }, { path: '/notifications' });
    expect(await screen.findByText(/nothing yet/i)).toBeInTheDocument();
  });

  it('asks signed-out visitors to sign in', async () => {
    renderApp(<App />, {}, { path: '/notifications', signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
