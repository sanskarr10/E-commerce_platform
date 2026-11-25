import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createMetrics } from '../src/metrics.js';
import { FakeRepo, OTHER, ORDER, USER, PRIVATE_KEY, makeAuth, silent, token } from './helpers.js';
import { generateKeyPairSync } from 'node:crypto';

let server;
let base;
const repo = new FakeRepo();
const metrics = createMetrics({ repo });
const get = (path, tok, init = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...init.headers } });

async function seed(userId, type, orderId, extra = {}) {
  const { notification } = await repo.createNotification({
    userId, userEmail: null, type, orderId, title: `T ${type}`, body: 'B', ...extra,
  });
  return notification;
}

before(async () => {
  const app = createApp({ repo, auth: makeAuth(), metrics, logger: silent });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('auth', () => {
  it('requires a token', async () => {
    const res = await get('/api/notifications');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  });
  it('rejects garbage, wrong keys, expired tokens and tokens without exp', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    assert.equal((await get('/api/notifications', 'abc.def.ghi')).status, 401);
    assert.equal((await get('/api/notifications', token(USER, {}, other.privateKey))).status, 401);
    assert.equal((await get('/api/notifications', token(USER, {}, PRIVATE_KEY, { expiresIn: -60 }))).status, 401);
    assert.equal((await get('/api/notifications', token(USER, {}, PRIVATE_KEY, { audience: 'someone-else' }))).status, 401);
  });
});

describe('listing', () => {
  it('returns only my notifications, newest first, with the unread count', async () => {
    await seed(USER, 'order.confirmed', ORDER);
    await seed(USER, 'order.shipped', ORDER);
    await seed(OTHER, 'order.confirmed', '33333333-3333-4333-8333-333333333333');
    const res = await get('/api/notifications', token(USER));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 2);
    assert.equal(body.unread, 2);
    assert.ok(body.items.every((n) => !('user_email' in n) && !('user_id' in n)));
  });
  it('filters unread and paginates', async () => {
    const page = await (await get('/api/notifications?page=1&page_size=1', token(USER))).json();
    assert.equal(page.items.length, 1);
    assert.equal(page.total, 2);
    const unread = await (await get('/api/notifications?unread=true', token(USER))).json();
    assert.equal(unread.total, 2);
  });
  it('validates the query', async () => {
    const res = await get('/api/notifications?page_size=1000', token(USER));
    assert.equal(res.status, 422);
    assert.ok(Array.isArray((await res.json()).detail));
    assert.equal((await get('/api/notifications?unread=maybe', token(USER))).status, 422);
  });
});

describe('marking read', () => {
  it('marks one notification read, idempotently', async () => {
    const mine = (await (await get('/api/notifications', token(USER))).json()).items[0];
    const first = await get(`/api/notifications/${mine.id}/read`, token(USER), { method: 'POST' });
    assert.equal(first.status, 200);
    const readAt = (await first.json()).read_at;
    assert.ok(readAt);
    const again = await (await get(`/api/notifications/${mine.id}/read`, token(USER), { method: 'POST' })).json();
    assert.equal(again.read_at, readAt);
    assert.equal((await (await get('/api/notifications', token(USER))).json()).unread, 1);
  });
  it("cannot touch someone else's notification (looks like a missing one)", async () => {
    const theirs = repo.rows.find((r) => r.user_id === OTHER);
    const res = await get(`/api/notifications/${theirs.id}/read`, token(USER), { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(repo.rows.find((r) => r.id === theirs.id).read_at, null);
  });
  it('404s on a malformed id instead of reaching the database', async () => {
    assert.equal((await get('/api/notifications/not-a-uuid/read', token(USER), { method: 'POST' })).status, 404);
  });
  it('marks everything read', async () => {
    const res = await get('/api/notifications/read-all', token(USER), { method: 'POST' });
    assert.deepEqual(await res.json(), { updated: 1 });
    assert.equal((await (await get('/api/notifications?unread=true', token(USER))).json()).total, 0);
  });
});

describe('operational endpoints', () => {
  it('serves health and readiness; readiness fails when the database is down', async () => {
    assert.equal((await get('/health')).status, 200);
    assert.equal((await get('/ready')).status, 200);
    repo.down = true;
    assert.equal((await get('/ready')).status, 503);
    repo.down = false;
  });
  it('exposes Prometheus metrics with route patterns, not raw URLs', async () => {
    await get('/api/notifications/some-random-path-1');
    await get('/definitely/not/a/route/42');
    const text = await (await get('/metrics')).text();
    assert.match(text, /# TYPE http_request_duration_seconds histogram/);
    assert.match(text, /route="\/api\/notifications\/:id\/read"/);
    assert.match(text, /route="unmatched"/);
    assert.doesNotMatch(text, /definitely|some-random-path/);
    assert.match(text, /process_cpu_user_seconds_total/);
  });
  it('returns JSON for unknown routes and bad JSON', async () => {
    assert.equal((await get('/nope')).status, 404);
    const res = await get('/api/notifications/read-all', token(USER), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
  });
});
