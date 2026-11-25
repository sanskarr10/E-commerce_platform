// Dev-only stand-in for the gateway: lets you click through both frontends without Docker.
// It imitates the saga with timers (PENDING -> STOCK_RESERVED -> PAID | CANCELLED).
//   npm run dev:mock           -> http://localhost:8090
//   API_TARGET=http://localhost:8090 npm run dev:storefront
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8090);
const STEP_MS = Number(process.env.STEP_MS ?? 1500);

const cats = [
  { id: 1, name: 'Electronics', slug: 'electronics' },
  { id: 2, name: 'Books', slug: 'books' },
  { id: 3, name: 'Home & Kitchen', slug: 'home-kitchen' },
  { id: 4, name: 'Clothing', slug: 'clothing' },
];
const seed = [
  ['ELEC-001', 'Wireless Earbuds', 249900, 25, 1, 'Bluetooth 5.3 earbuds with a 24 hour case.'],
  ['ELEC-002', 'Mechanical Keyboard', 459900, 4, 1, 'Hot-swappable switches, aluminium frame.'],
  ['ELEC-003', '27-inch Monitor', 1899900, 8, 1, 'QHD IPS panel, 75 Hz.'],
  ['BOOK-001', 'Designing Data-Intensive Applications', 69900, 40, 2, 'The reference on distributed data systems.'],
  ['BOOK-002', 'The Pragmatic Programmer', 49900, 30, 2, 'Practical advice for working developers.'],
  ['BOOK-003', 'Site Reliability Engineering', 59900, 0, 2, 'How Google runs production systems.'],
  ['HOME-001', 'Cast Iron Skillet', 189900, 15, 3, 'Pre-seasoned 26 cm skillet.'],
  ['HOME-002', 'Pour-over Coffee Set', 129900, 3, 3, 'Dripper, carafe and filters.'],
  ['HOME-003', 'Chef Knife', 279900, 12, 3, '20 cm forged blade.'],
  ['CLTH-001', 'Cotton T-shirt', 59900, 60, 4, 'Heavyweight organic cotton.'],
  ['CLTH-002', 'Rain Jacket', 399900, 9, 4, 'Packable and waterproof.'],
  ['CLTH-003', 'Wool Socks (3 pack)', 79900, 35, 4, 'Merino blend.'],
];
const now = () => new Date().toISOString();
const products = seed.map(([sku, name, price, stock, cat, description], i) => ({
  id: i + 1, sku, name, description, price_minor: price, currency: 'INR', stock,
  category: cats.find((c) => c.id === cat), image_url: null, is_active: true, created_at: now(), updated_at: now(),
}));
const users = [
  { id: randomUUID(), email: 'admin@example.com', password: 'Admin123!', full_name: 'Shop Admin', role: 'admin', is_active: true, created_at: now() },
  { id: randomUUID(), email: 'demo@example.com', password: 'Demo1234', full_name: 'Demo Customer', role: 'customer', is_active: true, created_at: now() },
];
const sessions = new Map(); // refresh token -> user id
const access = new Map(); // access token -> user id
const orders = [];
const payments = [];
const idem = new Map();
const notes = []; // what the notification service would have stored

const pub = (user) => ({ ...user, password: undefined });
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
});
const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1];
const page = (items, url) => {
  const p = Number(url.searchParams.get('page') ?? 1), size = Number(url.searchParams.get('page_size') ?? 20);
  return { items: items.slice((p - 1) * size, p * size), total: items.length, page: p, page_size: size };
};
const history = new Map();
function move(order, to, reason = null) {
  history.get(order.id).push({ from_status: order.status, to_status: to, reason, created_at: now() });
  order.status = to; order.updated_at = now();
  const note = {
    PAID: ['order.confirmed', 'Payment received', 'is confirmed. We will tell you when it ships.'],
    SHIPPED: ['order.shipped', 'Your order has shipped', 'is on its way.'],
    DELIVERED: ['order.delivered', 'Your order was delivered', 'has been delivered. Enjoy!'],
    CANCELLED: ['order.cancelled', 'Your order was cancelled', 'was cancelled. You were not charged.'],
  }[to];
  if (note) notes.unshift({ id: randomUUID(), user_id: order.user_id, type: note[0], order_id: order.id, title: note[1], body: `Order #${order.id.slice(0, 8)} ${note[2]}`, created_at: now(), read_at: null });
  if (reason && to === 'CANCELLED') order.cancel_reason = reason;
}
const detail = (o) => ({ ...o, history: history.get(o.id) });

function runSaga(order, method) {
  setTimeout(() => {
    const short = order.items.some((i) => (products.find((p) => p.id === i.product_id)?.stock ?? 0) < i.quantity);
    if (short) return move(order, 'CANCELLED', 'out_of_stock');
    order.items.forEach((i) => { products.find((p) => p.id === i.product_id).stock -= i.quantity; });
    move(order, 'STOCK_RESERVED');
    setTimeout(() => {
      const pay = { id: randomUUID(), order_id: order.id, user_id: order.user_id, amount_minor: order.total_minor, currency: 'INR', status: 'SUCCEEDED', provider_ref: `mock_${Date.now()}`, failure_reason: null, created_at: now(), updated_at: now() };
      if (method === 'tok_decline' || method === 'tok_insufficient') {
        Object.assign(pay, { status: 'FAILED', provider_ref: null, failure_reason: method === 'tok_decline' ? 'card_declined' : 'insufficient_funds' });
        payments.unshift(pay);
        order.items.forEach((i) => { products.find((p) => p.id === i.product_id).stock += i.quantity; });
        return move(order, 'CANCELLED', 'payment_failed');
      }
      payments.unshift(pay);
      move(order, 'PAID');
    }, STEP_MS);
  }, STEP_MS);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname, method = req.method;
  const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readBody(req) : {};
  const me = users.find((u) => u.id === access.get((req.headers.authorization ?? '').slice(7)));
  const need = (admin = false) => {
    if (!me) { send(res, 401, { detail: 'Not authenticated' }); return false; }
    if (admin && me.role !== 'admin') { send(res, 403, { detail: 'Admin access required' }); return false; }
    return true;
  };
  const issue = (user) => {
    const at = randomUUID(), rt = randomUUID();
    access.set(at, user.id); sessions.set(rt, user.id);
    return { token: { access_token: at, token_type: 'bearer', expires_in: 900 }, cookie: `refresh_token=${rt}; Path=/api/users; HttpOnly; SameSite=Lax` };
  };

  if (path === '/api/users/register' && method === 'POST') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email ?? '')) return send(res, 422, { detail: [{ loc: ['body', 'email'], msg: 'value is not a valid email address', type: 'value_error' }] });
    if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(body.password ?? '')) return send(res, 422, { detail: [{ loc: ['body', 'password'], msg: 'Password must be at least 8 characters with a letter and a digit', type: 'value_error' }] });
    if (users.some((u) => u.email === body.email)) return send(res, 409, { detail: 'Email already registered' });
    const u = { id: randomUUID(), email: body.email, password: body.password, full_name: body.full_name ?? '', role: 'customer', is_active: true, created_at: now() };
    users.push(u);
    return send(res, 201, pub(u));
  }
  if (path === '/api/users/login' && method === 'POST') {
    const u = users.find((x) => x.email === body.email && x.password === body.password);
    if (!u) return send(res, 401, { detail: 'Invalid email or password' });
    const s = issue(u);
    return send(res, 200, s.token, { 'Set-Cookie': s.cookie });
  }
  if (path === '/api/users/refresh' && method === 'POST') {
    const rt = cookie(req, 'refresh_token');
    const uid = rt && sessions.get(rt);
    if (!uid) return send(res, 401, { detail: 'Invalid refresh token' });
    sessions.delete(rt); // single use, like the real service
    const s = issue(users.find((u) => u.id === uid));
    return send(res, 200, s.token, { 'Set-Cookie': s.cookie });
  }
  if (path === '/api/users/logout' && method === 'POST') {
    sessions.delete(cookie(req, 'refresh_token'));
    return send(res, 204, undefined, { 'Set-Cookie': 'refresh_token=; Path=/api/users; Max-Age=0' });
  }
  if (path === '/api/users/me' && method === 'GET') return need() && send(res, 200, pub(me));

  if (path === '/api/products/categories') {
    if (method === 'GET') return send(res, 200, cats);
    if (!need(true)) return;
    const c = { id: cats.length + 1, name: body.name, slug: String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-') };
    cats.push(c);
    return send(res, 201, c);
  }
  if (path === '/api/products' && method === 'GET') {
    let list = products.filter((p) => p.is_active);
    const q = url.searchParams.get('q')?.toLowerCase(), cat = url.searchParams.get('category');
    if (q) list = list.filter((p) => `${p.name} ${p.sku} ${p.description}`.toLowerCase().includes(q));
    if (cat) list = list.filter((p) => p.category?.slug === cat);
    if (url.searchParams.get('in_stock') === 'true') list = list.filter((p) => p.stock > 0);
    const sort = url.searchParams.get('sort');
    if (sort === 'price_asc') list.sort((a, b) => a.price_minor - b.price_minor);
    if (sort === 'price_desc') list.sort((a, b) => b.price_minor - a.price_minor);
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    return send(res, 200, page(list, url), { 'X-Cache': 'MISS' });
  }
  if (path === '/api/products' && method === 'POST') {
    if (!need(true)) return;
    if (products.some((p) => p.sku === body.sku)) return send(res, 409, { detail: 'SKU already exists' });
    const p = { id: products.length + 1, description: null, currency: 'INR', stock: 0, image_url: null, is_active: true, created_at: now(), updated_at: now(), ...body, category: cats.find((c) => c.id === body.category_id) ?? null };
    products.push(p);
    return send(res, 201, p);
  }
  let m;
  if ((m = path.match(/^\/api\/products\/(\d+)\/stock$/)) && method === 'PATCH') {
    if (!need(true)) return;
    const p = products.find((x) => x.id === Number(m[1]));
    if (!p) return send(res, 404, { detail: 'Product not found' });
    if (p.stock + body.delta < 0) return send(res, 409, { detail: 'Stock cannot go below zero' });
    p.stock += body.delta;
    return send(res, 200, p);
  }
  if ((m = path.match(/^\/api\/products\/(\d+)$/))) {
    const p = products.find((x) => x.id === Number(m[1]));
    if (method === 'GET') return p ? send(res, 200, p) : send(res, 404, { detail: 'Product not found' });
    if (!need(true)) return;
    if (!p) return send(res, 404, { detail: 'Product not found' });
    if (method === 'PATCH') {
      Object.assign(p, body, { updated_at: now() });
      if ('category_id' in body) p.category = cats.find((c) => c.id === body.category_id) ?? null;
      return send(res, 200, p);
    }
    if (method === 'DELETE') { p.is_active = false; return send(res, 204); }
  }

  if (path === '/api/orders' && method === 'POST') {
    if (!need()) return;
    const key = req.headers['idempotency-key'];
    if (!key) return send(res, 400, { detail: 'Idempotency-Key header is required' });
    const prior = idem.get(`${me.id}:${key}`);
    if (prior) return send(res, 200, prior, { 'Idempotent-Replayed': 'true' });
    const items = [];
    for (const line of body.items ?? []) {
      const p = products.find((x) => x.id === line.product_id && x.is_active);
      if (!p) return send(res, 422, { detail: `Product ${line.product_id} not found` });
      items.push({ product_id: p.id, sku: p.sku, name: p.name, unit_price_minor: p.price_minor, quantity: line.quantity });
    }
    const o = { id: randomUUID(), user_id: me.id, status: 'PENDING', total_minor: items.reduce((n, i) => n + i.unit_price_minor * i.quantity, 0), currency: 'INR', cancel_reason: null, items, created_at: now(), updated_at: now() };
    history.set(o.id, [{ from_status: null, to_status: 'PENDING', reason: null, created_at: now() }]);
    orders.unshift(o);
    idem.set(`${me.id}:${key}`, o);
    runSaga(o, body.payment_method);
    return send(res, 201, o);
  }
  if (path === '/api/orders' && method === 'GET') return need() && send(res, 200, page(orders.filter((o) => o.user_id === me.id), url));
  if (path === '/api/orders/admin/list' && method === 'GET') {
    if (!need(true)) return;
    const s = url.searchParams.get('status');
    return send(res, 200, page(s ? orders.filter((o) => o.status === s) : orders, url));
  }
  if ((m = path.match(/^\/api\/orders\/([0-9a-f-]{36})(?:\/(ship|deliver))?$/))) {
    if (!need()) return;
    const o = orders.find((x) => x.id === m[1]);
    if (!o || (o.user_id !== me.id && me.role !== 'admin')) return send(res, 404, { detail: 'Order not found' });
    if (!m[2]) return send(res, 200, detail(o));
    if (me.role !== 'admin') return send(res, 403, { detail: 'Admin access required' });
    const [from, to] = m[2] === 'ship' ? ['PAID', 'SHIPPED'] : ['SHIPPED', 'DELIVERED'];
    if (o.status !== from) return send(res, 409, { detail: `Cannot move an order from ${o.status} to ${to}` });
    move(o, to);
    return send(res, 200, detail(o));
  }
  if (path === '/api/notifications' && method === 'GET') {
    if (!need()) return;
    const mine = notes.filter((n) => n.user_id === me.id);
    const list = url.searchParams.get('unread') === 'true' ? mine.filter((n) => !n.read_at) : mine;
    const out = page(list, url);
    out.items = out.items.map((n) => ({ ...n, user_id: undefined }));
    return send(res, 200, { ...out, unread: mine.filter((n) => !n.read_at).length });
  }
  if (path === '/api/notifications/read-all' && method === 'POST') {
    if (!need()) return;
    const open = notes.filter((n) => n.user_id === me.id && !n.read_at);
    open.forEach((n) => (n.read_at = now()));
    return send(res, 200, { updated: open.length });
  }
  if ((m = path.match(/^\/api\/notifications\/([0-9a-f-]{36})\/read$/)) && method === 'POST') {
    if (!need()) return;
    const n = notes.find((x) => x.id === m[1] && x.user_id === me.id);
    if (!n) return send(res, 404, { detail: 'Notification not found' });
    n.read_at ??= now();
    return send(res, 200, { ...n, user_id: undefined });
  }
  if (path === '/api/payments/admin/list' && method === 'GET') {
    if (!need(true)) return;
    const s = url.searchParams.get('status');
    return send(res, 200, page(s ? payments.filter((p) => p.status === s) : payments, url));
  }
  if ((m = path.match(/^\/api\/payments\/orders\/([0-9a-f-]{36})$/))) {
    if (!need()) return;
    const p = payments.find((x) => x.order_id === m[1]);
    return p ? send(res, 200, p) : send(res, 404, { detail: 'Payment not found' });
  }
  send(res, 404, { detail: 'Not found' });
}

createServer((req, res) => handle(req, res).catch((e) => { console.error(e); send(res, 500, { detail: 'Mock server error' }); })).listen(PORT, () => {
  console.log(`mock API on http://localhost:${PORT}  (admin@example.com / Admin123!   demo@example.com / Demo1234)`);
});
