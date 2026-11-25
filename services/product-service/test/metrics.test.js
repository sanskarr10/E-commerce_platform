import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { processDelivery, PermanentError } from '../src/events/consumer.js';
import { MysqlOutboxStore, OutboxRelay } from '../src/events/relay.js';
import { createMetrics } from '../src/metrics.js';
import { adminToken, api, startServer, widget } from './helpers.js';
import { createLogger } from '../src/logger.js';

describe('GET /metrics', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  it('exposes request latency by route PATTERN, cache results and process metrics', async () => {
    const created = await api(srv.baseUrl, 'POST', '/api/products', { token: adminToken(), body: widget() });
    const id = created.body.id;
    await api(srv.baseUrl, 'GET', `/api/products/${id}`); // MISS
    await api(srv.baseUrl, 'GET', `/api/products/${id}`); // HIT
    await api(srv.baseUrl, 'GET', '/some/scanner/path/9876');
    const { text, status, headers } = await api(srv.baseUrl, 'GET', '/metrics');
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/plain|openmetrics/);
    assert.match(text, /# TYPE http_request_duration_seconds histogram/);
    assert.match(text, /route="\/api\/products\/:id"/);
    assert.match(text, /route="unmatched"/);
    assert.doesNotMatch(text, new RegExp(`/api/products/${id}"`)); // raw ids never become labels
    assert.doesNotMatch(text, /scanner/);
    assert.match(text, /product_cache_requests_total\{result="MISS",service="product-service"\} [1-9]/);
    assert.match(text, /product_cache_requests_total\{result="HIT",service="product-service"\} [1-9]/);
    assert.match(text, /process_cpu_user_seconds_total/);
  });

  it('does not count the metrics endpoint in the access log noise but does serve it repeatedly', async () => {
    assert.equal((await api(srv.baseUrl, 'GET', '/metrics')).status, 200);
    assert.equal((await api(srv.baseUrl, 'GET', '/metrics')).status, 200);
  });
});

describe('metrics registry', () => {
  it('reports the outbox backlog and its age at scrape time', async () => {
    const metrics = createMetrics({ outbox: { stats: async () => ({ unpublished: 7, oldestAgeSeconds: 42 }) } });
    const text = await metrics.render();
    assert.match(text, /outbox_unpublished_events\{service="product-service"\} 7/);
    assert.match(text, /outbox_oldest_unpublished_age_seconds\{service="product-service"\} 42/);
  });
  it('survives a database outage while scraping', async () => {
    const metrics = createMetrics({ outbox: { stats: async () => { throw new Error('db down'); } } });
    assert.match(await metrics.render(), /# TYPE outbox_unpublished_events gauge/);
  });
  it('counts consumed events and published outbox rows', async () => {
    const metrics = createMetrics();
    metrics.eventOutcome('order.created', 'processed');
    metrics.eventsPublished(3);
    const text = await metrics.render();
    assert.match(text, /events_consumed_total\{type="order.created",outcome="processed",service="product-service"\} 1/);
    assert.match(text, /outbox_events_published_total\{service="product-service"\} 3/);
  });
});

describe('outcome reporting', () => {
  const logger = createLogger({ silent: true });
  const body = (type = 'order.created') =>
    Buffer.from(JSON.stringify({
      id: '00000000-0000-4000-8000-000000000001', type, version: 1, occurred_at: 'x',
      correlation_id: '5f3c1d52-8d3e-4a52-9a52-0c6a0d3f9b10', data: {},
    }));
  const run = async (content, handler, retries = 0) => {
    const seen = [];
    await processDelivery({ content, retries }, { handlers: { 'order.created': handler }, maxRetries: 2, logger, onOutcome: (...a) => seen.push(a) });
    return seen;
  };

  it('reports processed, ignored, retry and dead_letter', async () => {
    assert.deepEqual(await run(body(), async () => {}), [['order.created', 'processed']]);
    assert.deepEqual(await run(body('stock.reserved'), async () => {}), [['stock.reserved', 'ignored']]);
    assert.deepEqual(await run(body(), async () => { throw new Error('x'); }), [['order.created', 'retry']]);
    assert.deepEqual(await run(body(), async () => { throw new Error('x'); }, 2), [['order.created', 'dead_letter']]);
    assert.deepEqual(await run(body(), async () => { throw new PermanentError('x'); }), [['order.created', 'dead_letter']]);
    assert.deepEqual(await run(Buffer.from('{nope'), async () => {}), [['unknown', 'dead_letter']]);
  });
});

describe('outbox store and relay hooks', () => {
  it('maps the stats query result to numbers', async () => {
    const pool = { query: async () => [[{ unpublished: '5', oldest: '12' }]] };
    assert.deepEqual(await new MysqlOutboxStore(pool).stats(), { unpublished: 5, oldestAgeSeconds: 12 });
  });
  it('tells the metrics how many events a pass published', async () => {
    const counts = [];
    const store = {
      claim: async () => [{ seq: 1, event_type: 'a', payload: '{}', id: 'x' }, { seq: 2, event_type: 'a', payload: '{}', id: 'y' }],
      markPublished: async () => {},
      release: async () => {},
    };
    const relay = new OutboxRelay({ store, logger: createLogger({ silent: true }), publish: async () => {}, onPublished: (n) => counts.push(n) });
    await relay.flush();
    assert.deepEqual(counts, [2]);
  });
});
