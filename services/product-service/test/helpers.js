import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { HttpError, conflict, notFound } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import { ProductService } from '../src/service.js';

export const ISSUER = 'ecommerce-user-service';
export const AUDIENCE = 'ecommerce';
export const TTL = { product: 300, list: 60, categories: 300 };

// ---------- tokens ----------

function makeKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export const keys = makeKeyPair();

/** A valid RS256 token by default; override claims, the signing key, or the sign options. */
export function token(claims = {}, { key = keys.privateKey, signOptions = { expiresIn: '5m' } } = {}) {
  return jwt.sign(
    { sub: '11111111-1111-1111-1111-111111111111', role: 'admin', email: 'admin@shop.dev', ...claims },
    key,
    { algorithm: 'RS256', issuer: ISSUER, audience: AUDIENCE, ...signOptions },
  );
}

export const adminToken = () => token({ role: 'admin' });
export const customerToken = () => token({ role: 'customer' });

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Hand-built so we can forge exactly what an attacker would send. */
export function hs256Token(secret, claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const signature = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

export function unsignedToken(claims) {
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
}

export function validClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: '11111111-1111-1111-1111-111111111111',
    role: 'admin',
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

// ---------- fakes ----------

/** In-memory stand-in for ProductRepository with the same behaviour at the boundaries. */
export class FakeRepo {
  constructor() {
    this.delayMs = 0;
    this.reset();
  }

  reset() {
    this.products = new Map();
    this.categories = [];
    this.nextProductId = 1;
    this.nextCategoryId = 1;
    this.down = false;
    this.lastFilters = null;
    this.calls = { list: 0, getById: 0, listCategories: 0 };
  }

  async ping() {
    if (this.down) throw new Error('database down');
  }

  async list(filters) {
    this.calls.list += 1;
    this.lastFilters = filters;
    let items = [...this.products.values()].filter((p) => p.is_active);
    if (filters.q) items = items.filter((p) => p.name.toLowerCase().includes(filters.q.toLowerCase()));
    if (filters.category) items = items.filter((p) => p.category?.slug === filters.category);
    if (filters.min_price !== null && filters.min_price !== undefined) items = items.filter((p) => p.price_minor >= filters.min_price);
    if (filters.max_price !== null && filters.max_price !== undefined) items = items.filter((p) => p.price_minor <= filters.max_price);
    if (filters.in_stock) items = items.filter((p) => p.stock > 0);
    const sorters = {
      newest: (a, b) => b.id - a.id,
      price_asc: (a, b) => a.price_minor - b.price_minor || a.id - b.id,
      price_desc: (a, b) => b.price_minor - a.price_minor || b.id - a.id,
      name: (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
    };
    items.sort(sorters[filters.sort]);
    const start = (filters.page - 1) * filters.page_size;
    return {
      items: structuredClone(items.slice(start, start + filters.page_size)),
      total: items.length,
      page: filters.page,
      page_size: filters.page_size,
    };
  }

  async getById(id) {
    this.calls.getById += 1;
    if (this.delayMs) await sleep(this.delayMs);
    const product = this.products.get(id);
    return product?.is_active ? structuredClone(product) : null;
  }

  async findBySku(sku) {
    return [...this.products.values()].find((p) => p.sku === sku) ?? null;
  }

  async create(data) {
    if (await this.findBySku(data.sku)) throw conflict('SKU already exists');
    let category = null;
    if (data.category_id) {
      category = this.categories.find((c) => c.id === data.category_id) ?? null;
      if (!category) {
        throw new HttpError(422, [{ loc: ['body', 'category_id'], msg: 'Category does not exist', type: 'value_error' }]);
      }
    }
    const now = new Date().toISOString();
    const product = {
      id: this.nextProductId++,
      sku: data.sku,
      name: data.name,
      description: data.description ?? null,
      price_minor: data.price_minor,
      currency: data.currency,
      stock: data.stock,
      category,
      image_url: data.image_url ?? null,
      is_active: data.is_active,
      created_at: now,
      updated_at: now,
    };
    this.products.set(product.id, product);
    return structuredClone(product);
  }

  async update(id, patch) {
    const product = this.products.get(id);
    if (!product) throw notFound('Product');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'category_id') product.category = this.categories.find((c) => c.id === value) ?? null;
      else product[key] = value;
    }
    return structuredClone(product);
  }

  async archive(id) {
    const product = this.products.get(id);
    if (!product) throw notFound('Product');
    product.is_active = false;
  }

  async adjustStock(id, delta) {
    const product = this.products.get(id);
    if (!product) throw notFound('Product');
    if (product.stock + delta < 0) throw conflict('Insufficient stock');
    product.stock += delta;
    return structuredClone(product);
  }

  async reserveStock(items) {
    for (const { product_id: id, quantity } of items) {
      const product = this.products.get(id);
      if (!product) return { ok: false, failures: [{ product_id: id, reason: 'not_found' }] };
      if (product.stock < quantity) return { ok: false, failures: [{ product_id: id, reason: 'insufficient_stock' }] };
    }
    for (const { product_id: id, quantity } of items) this.products.get(id).stock -= quantity;
    return { ok: true };
  }

  async releaseStock(items) {
    for (const { product_id: id, quantity } of items) this.products.get(id).stock += quantity;
  }

  async listCategories() {
    this.calls.listCategories += 1;
    return structuredClone([...this.categories].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async createCategory(name, slug) {
    if (this.categories.some((c) => c.name === name || c.slug === slug)) throw conflict('Category already exists');
    const category = { id: this.nextCategoryId++, name, slug };
    this.categories.push(category);
    return { ...category };
  }
}

/** Behaves like Redis from the caller's side: JSON round-trip, versions, and an outage switch. */
export class MemoryCache {
  constructor() {
    this.reset();
  }

  reset() {
    this.store = new Map();
    this.ttls = new Map();
    this.versions = new Map();
    this.down = false;
  }

  async getJson(key) {
    if (this.down || !this.store.has(key)) return null;
    return JSON.parse(this.store.get(key));
  }

  async setJson(key, value, ttl) {
    if (this.down) return;
    this.store.set(key, JSON.stringify(value));
    this.ttls.set(key, ttl);
  }

  async del(...keys) {
    if (this.down) return;
    for (const key of keys) this.store.delete(key);
  }

  async version(name) {
    return this.down ? null : (this.versions.get(name) ?? 0);
  }

  async bump(name) {
    if (this.down) return false;
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
    return true;
  }

  async status() {
    return this.down ? 'down' : 'ok';
  }
}

export function spyLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message) => lines.info.push(message),
    warn: (message) => lines.warn.push(message),
    error: (message) => lines.error.push(message),
  };
}

// ---------- HTTP ----------

export async function startServer({ repo = new FakeRepo(), cache = new MemoryCache(), logger = createLogger({ silent: true }) } = {}) {
  const service = new ProductService({ repo, cache, ttl: TTL, logger });
  const auth = createAuth({ publicKey: keys.publicKey, issuer: ISSUER, audience: AUDIENCE });
  const app = createApp({ service, auth, repo, cache, logger });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    repo,
    cache,
    service,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/** Thin fetch wrapper that returns { status, headers, body (parsed JSON or null), text }. */
export async function api(baseUrl, method, path, { token: bearer, body, rawBody, headers = {} } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (docs HTML, assets)
  }
  return { status: response.status, headers: response.headers, body: json, text };
}

export const widget = (overrides = {}) => ({ sku: 'WID-1', name: 'Widget', price_minor: 19900, ...overrides });
