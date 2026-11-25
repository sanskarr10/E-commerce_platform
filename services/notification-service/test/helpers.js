import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createAuth } from '../src/auth.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';
import { createMailer } from '../src/mailer.js';
import { NotificationService } from '../src/service.js';

export const { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export const silent = createLogger({ silent: true });
export const USER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const ORDER = '5f3c1d52-8d3e-4a52-9a52-0c6a0d3f9b10';

export function token(sub = USER, overrides = {}, key = PRIVATE_KEY, options = {}) {
  return jwt.sign({ sub, role: 'customer', ...overrides }, key, {
    algorithm: 'RS256',
    issuer: 'ecommerce-user-service',
    audience: 'ecommerce',
    expiresIn: '5m',
    ...options,
  });
}

export const authConfig = { publicKey: PUBLIC_KEY, issuer: 'ecommerce-user-service', audience: 'ecommerce' };
export const makeAuth = () => createAuth(authConfig);

/** In-memory twin of NotificationRepository with the same semantics (unique key, claim lease). */
export class FakeRepo {
  constructor({ now = () => Date.now() } = {}) {
    this.rows = [];
    this.now = now;
    this.down = false;
  }

  #check() {
    if (this.down) throw new Error('database down');
  }

  async ping() {
    this.#check();
  }

  async createNotification({ userId, userEmail, type, orderId, title, body }) {
    this.#check();
    const existing = this.rows.find((r) => r.order_id === orderId && r.type === type);
    if (existing) return { notification: { ...existing }, created: false };
    const row = {
      id: randomUUID(),
      user_id: userId,
      user_email: userEmail ?? null,
      type,
      order_id: orderId,
      title,
      body,
      email_status: 'pending',
      email_claimed_at: null,
      email_error: null,
      created_at: new Date(this.now()).toISOString(),
      read_at: null,
    };
    this.rows.push(row);
    return { notification: { ...row }, created: true };
  }

  async claimEmail(id, leaseSeconds) {
    this.#check();
    const row = this.rows.find((r) => r.id === id);
    const expired = row?.email_status === 'sending' && this.now() - row.email_claimed_at > leaseSeconds * 1000;
    if (!row || !(row.email_status === 'pending' || expired)) return null;
    row.email_status = 'sending';
    row.email_claimed_at = this.now();
    return { ...row };
  }

  async setEmailStatus(id, status, error = null) {
    this.#check();
    const row = this.rows.find((r) => r.id === id);
    Object.assign(row, { email_status: status, email_error: error, email_claimed_at: null });
  }

  async list(userId, { unreadOnly = false, page = 1, pageSize = 20 } = {}) {
    this.#check();
    const mine = this.rows.filter((r) => r.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const filtered = unreadOnly ? mine.filter((r) => !r.read_at) : mine;
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize).map((r) => ({ ...r })),
      total: filtered.length,
      unread: mine.filter((r) => !r.read_at).length,
    };
  }

  async markRead(userId, id) {
    this.#check();
    const row = this.rows.find((r) => r.id === id && r.user_id === userId);
    if (!row) return null;
    row.read_at ??= new Date(this.now()).toISOString();
    return { ...row };
  }

  async markAllRead(userId) {
    this.#check();
    const open = this.rows.filter((r) => r.user_id === userId && !r.read_at);
    open.forEach((r) => (r.read_at = new Date(this.now()).toISOString()));
    return open.length;
  }

  async countOpenEmails() {
    this.#check();
    return this.rows.filter((r) => ['pending', 'sending'].includes(r.email_status)).length;
  }
}

/** A nodemailer-like transport that records messages and can be told to fail. */
export class FakeTransport {
  constructor() {
    this.sent = [];
    this.failures = [];
  }

  async sendMail(message) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(message);
  }
}

export function smtpError(code, message = 'smtp problem') {
  return Object.assign(new Error(message), { responseCode: code });
}

export function envelope(type, data, id = randomUUID()) {
  return { id, type, version: 1, occurred_at: new Date().toISOString(), correlation_id: data.order_id ?? ORDER, data };
}

export const confirmed = (over = {}) => ({
  order_id: ORDER,
  user_id: USER,
  user_email: 'asha@example.com',
  total_minor: 249900,
  currency: 'INR',
  ...over,
});

export function buildService({ transport = new FakeTransport(), repo = new FakeRepo(), mailer, config = {} } = {}) {
  const metrics = createMetrics({ repo });
  const service = new NotificationService({
    repo,
    mailer: mailer ?? createMailer({ transport, from: 'Shop <no-reply@shop.local>' }),
    config: { emailLeaseSeconds: 120, ...config },
    logger: silent,
    metrics,
  });
  return { service, repo, transport, metrics };
}
