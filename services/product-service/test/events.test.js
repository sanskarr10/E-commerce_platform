import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertTopology, startMessaging } from '../src/events/amqp.js';
import { PermanentError, processDelivery } from '../src/events/consumer.js';
import { EXCHANGE, QUEUE, buildEnvelope } from '../src/events/envelope.js';
import { createHandlers } from '../src/events/handlers.js';
import { OutboxRelay } from '../src/events/relay.js';
import { consumedSchemas, envelopeSchema, producedSchemas } from '../src/events/schemas.js';
import { ProductService } from '../src/service.js';
import { FakeRepo, MemoryCache, TTL, spyLogger } from './helpers.js';

const FIXTURES = new URL('../../../docs/events/fixtures/', import.meta.url);
const fixture = (type) => JSON.parse(readFileSync(new URL(`${type}.json`, FIXTURES), 'utf8'));
const ORDER = '5f3c1d52-8d3e-4a52-9a52-0c6a0d3f9b10';

async function setup() {
  const repo = new FakeRepo();
  const cache = new MemoryCache();
  const logger = spyLogger();
  const service = new ProductService({ repo, cache, ttl: TTL, logger });
  const handlers = createHandlers({ service, logger });
  const a = await repo.create({ sku: 'A', name: 'A', price_minor: 100, currency: 'INR', stock: 5, is_active: true });
  const b = await repo.create({ sku: 'B', name: 'B', price_minor: 100, currency: 'INR', stock: 1, is_active: true });
  return { repo, cache, logger, service, handlers, a, b };
}

const created = (items, id = undefined) => ({
  ...fixture('order.created'),
  ...(id ? { id } : {}),
  data: { order_id: ORDER, items },
});

describe('contract: shared fixtures', () => {
  const types = readdirSync(FIXTURES).map((file) => file.replace(/\.json$/, ''));

  it('there is a fixture for every event in the contract', () => {
    assert.deepEqual(types.sort(), [
      'order.cancelled', 'order.confirmed', 'order.created', 'order.delivered', 'order.shipped',
      'payment.failed', 'payment.requested', 'payment.succeeded', 'stock.failed', 'stock.reserved',
    ]);
  });

  for (const type of readdirSync(FIXTURES).map((file) => file.replace(/\.json$/, ''))) {
    it(`${type} has a valid envelope`, () => {
      const event = fixture(type);
      assert.equal(envelopeSchema.safeParse(event).success, true);
      assert.equal(event.type, type);
    });
  }

  it('every event this service consumes parses with its schema', () => {
    for (const [type, schema] of Object.entries(consumedSchemas)) {
      assert.equal(schema.safeParse(fixture(type).data).success, true, type);
    }
  });

  it('consumers ignore unknown extra fields (tolerant reader)', () => {
    const data = { ...fixture('order.created').data, added_later: 'x' };
    assert.equal(consumedSchemas['order.created'].safeParse(data).success, true);
  });

  /** Same keys and same value types, recursively. Values themselves are allowed to differ. */
  function sameShape(actual, expected, path = 'data') {
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(actual), `${path} must be an array`);
      for (const [i, element] of actual.entries()) sameShape(element, expected[0], `${path}[${i}]`);
    } else if (expected && typeof expected === 'object') {
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`);
      for (const key of Object.keys(expected)) sameShape(actual[key], expected[key], `${path}.${key}`);
    } else {
      assert.equal(typeof actual, typeof expected, `${path} type`);
    }
  }

  it('stock.reserved produced by the service matches the fixture', async () => {
    const { handlers, repo } = await setup();
    await handlers['order.created'](created([{ product_id: 1, quantity: 1 }]));
    const [event] = repo.outbox;
    assert.equal(event.type, 'stock.reserved');
    sameShape(event.data, fixture('stock.reserved').data);
    assert.equal(producedSchemas['stock.reserved'].safeParse(event.data).success, true);
    assert.equal(envelopeSchema.safeParse(event).success, true);
    assert.equal(event.correlation_id, ORDER);
  });

  it('stock.failed produced by the service matches the fixture', async () => {
    const { handlers, repo } = await setup();
    await handlers['order.created'](created([{ product_id: 2, quantity: 9 }]));
    const [event] = repo.outbox;
    assert.equal(event.type, 'stock.failed');
    sameShape(event.data, fixture('stock.failed').data);
    assert.equal(producedSchemas['stock.failed'].safeParse(event.data).success, true);
  });
});

describe('saga handlers', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('order.created reserves stock and emits stock.reserved', async () => {
    await ctx.handlers['order.created'](created([{ product_id: ctx.a.id, quantity: 2 }]));
    assert.equal(ctx.repo.products.get(ctx.a.id).stock, 3);
    assert.deepEqual(ctx.repo.outbox.map((e) => e.type), ['stock.reserved']);
  });

  it('insufficient stock emits stock.failed and reserves nothing (all or nothing)', async () => {
    await ctx.handlers['order.created'](created([{ product_id: ctx.a.id, quantity: 2 }, { product_id: ctx.b.id, quantity: 5 }]));
    assert.equal(ctx.repo.products.get(ctx.a.id).stock, 5);
    const [event] = ctx.repo.outbox;
    assert.equal(event.type, 'stock.failed');
    assert.deepEqual(event.data.failures, [{ product_id: ctx.b.id, reason: 'insufficient_stock' }]);
  });

  it('reports unknown and archived products with their own reasons', async () => {
    await ctx.handlers['order.created'](created([{ product_id: 999, quantity: 1 }]));
    assert.equal(ctx.repo.outbox[0].data.failures[0].reason, 'not_found');
  });

  it('delivering the same event twice reserves once and emits once', async () => {
    const event = created([{ product_id: ctx.a.id, quantity: 2 }]);
    await ctx.handlers['order.created'](event);
    await ctx.handlers['order.created'](event);
    assert.equal(ctx.repo.products.get(ctx.a.id).stock, 3);
    assert.equal(ctx.repo.outbox.length, 1);
  });

  it('a second order.created for the same order (different event id) is ignored', async () => {
    await ctx.handlers['order.created'](created([{ product_id: ctx.a.id, quantity: 2 }], '00000000-0000-4000-8000-0000000000a1'));
    await ctx.handlers['order.created'](created([{ product_id: ctx.a.id, quantity: 2 }], '00000000-0000-4000-8000-0000000000a2'));
    assert.equal(ctx.repo.products.get(ctx.a.id).stock, 3);
    assert.equal(ctx.repo.outbox.length, 1);
  });

  it('order.cancelled gives the reserved stock back exactly once', async () => {
    await ctx.handlers['order.created'](created([{ product_id: ctx.a.id, quantity: 2 }]));
    const cancelled = fixture('order.cancelled');
    await ctx.handlers['order.cancelled'](cancelled);
    await ctx.handlers['order.cancelled'](cancelled); // redelivery
    await ctx.handlers['order.cancelled']({ ...cancelled, id: '00000000-0000-4000-8000-0000000000b2' }); // second cancel event
    assert.equal(ctx.repo.products.get(ctx.a.id).stock, 5);
  });

  it('order.cancelled after a failed reservation releases nothing', async () => {
    await ctx.handlers['order.created'](created([{ product_id: ctx.b.id, quantity: 9 }]));
    await ctx.handlers['order.cancelled'](fixture('order.cancelled'));
    assert.equal(ctx.repo.products.get(ctx.b.id).stock, 1);
  });

  it('order.cancelled arriving BEFORE order.created blocks the late reservation', async () => {
    await ctx.handlers['order.cancelled'](fixture('order.cancelled'));
    await ctx.handlers['order.created'](created([{ product_id: ctx.a.id, quantity: 2 }]));
    assert.equal(ctx.repo.products.get(ctx.a.id).stock, 5, 'no stock may be held for a dead order');
    assert.equal(ctx.repo.outbox.length, 0);
  });

  it('a payload that breaks the contract is a permanent error', async () => {
    await assert.rejects(
      ctx.handlers['order.created']({ ...fixture('order.created'), data: { order_id: 'nope', items: [] } }),
      PermanentError,
    );
    await assert.rejects(ctx.handlers['order.cancelled']({ ...fixture('order.cancelled'), data: {} }), PermanentError);
    await assert.rejects(ctx.handlers['order.cancelled']({ ...fixture('order.cancelled'), data: { order_id: 'not-a-uuid' } }), PermanentError);
  });
});

describe('processDelivery decisions', () => {
  const logger = spyLogger();
  const body = (event) => Buffer.from(typeof event === 'string' ? event : JSON.stringify(event));
  const run = (event, handlers, extra = {}) => processDelivery({ content: body(event), ...extra }, { handlers, maxRetries: 3, logger });

  it('acks a handled event', async () => {
    let seen = null;
    assert.deepEqual(await run(fixture('order.created'), { 'order.created': async (e) => { seen = e.id; } }), { action: 'ack' });
    assert.equal(seen, fixture('order.created').id);
  });

  it('dead-letters bodies that are not JSON or not an envelope', async () => {
    assert.deepEqual(await run('{not json', {}), { action: 'dead_letter', reason: 'malformed_envelope' });
    assert.deepEqual(await run({ hello: 'world' }, {}), { action: 'dead_letter', reason: 'malformed_envelope' });
  });

  it('acks unknown event types so the queue keeps moving', async () => {
    assert.deepEqual(await run(fixture('payment.succeeded'), {}), { action: 'ack' });
  });

  it('dead-letters a permanent error immediately, without retrying', async () => {
    const handlers = { 'order.created': async () => { throw new PermanentError('bad'); } };
    assert.deepEqual(await run(fixture('order.created'), handlers), { action: 'dead_letter', reason: 'permanent_error' });
  });

  it('retries a transient failure with a counted attempt, then gives up', async () => {
    const handlers = { 'order.created': async () => { throw new Error('db down'); } };
    assert.deepEqual(await run(fixture('order.created'), handlers), { action: 'retry', attempt: 1 });
    assert.deepEqual(await run(fixture('order.created'), handlers, { retries: 2 }), { action: 'retry', attempt: 3 });
    assert.deepEqual(await run(fixture('order.created'), handlers, { retries: 3 }), { action: 'dead_letter', reason: 'retries_exhausted' });
  });
});

describe('OutboxRelay', () => {
  class FakeStore {
    constructor(rows) {
      this.rows = rows.map((row, i) => ({ seq: i + 1, id: `id-${i + 1}`, event_type: row, payload: `{"n":${i + 1}}` }));
      this.published = [];
      this.released = [];
    }
    async claim() { return this.rows.filter((row) => !this.published.includes(row.seq)); }
    async markPublished(seqs) { this.published.push(...seqs); }
    async release(seqs) { this.released.push(...seqs); }
  }
  const logger = spyLogger();

  it('publishes in order and marks every row published', async () => {
    const store = new FakeStore(['stock.reserved', 'stock.failed']);
    const sent = [];
    const relay = new OutboxRelay({ store, logger, publish: async (key, body, id) => { sent.push([key, id]); } });
    assert.equal(await relay.flush(), 2);
    assert.deepEqual(sent, [['stock.reserved', 'id-1'], ['stock.failed', 'id-2']]);
    assert.deepEqual(store.published, [1, 2]);
    assert.deepEqual(store.released, []);
  });

  it('stops at the first failure: earlier rows are marked, the failed one and later ones are released', async () => {
    const store = new FakeStore(['a.one', 'a.two', 'a.three']);
    const relay = new OutboxRelay({
      store, logger,
      publish: async (key) => { if (key === 'a.two') throw new Error('nack'); },
    });
    assert.equal(await relay.flush(), 1);
    assert.deepEqual(store.published, [1]);
    assert.deepEqual(store.released, [2, 3], 'order must be preserved on the next pass');
  });

  it('keeps running after a failed pass and stops cleanly', async () => {
    let calls = 0;
    const store = {
      claim: async () => { calls += 1; if (calls === 1) throw new Error('db blip'); return []; },
      markPublished: async () => {},
      release: async () => {},
    };
    const relay = new OutboxRelay({ store, logger, publish: async () => {}, intervalMs: 5 });
    relay.start();
    relay.start(); // second start is a no-op
    await sleep(60);
    await relay.stop();
    assert.ok(calls >= 2, 'the loop survived the first failure');
  });
});

describe('AMQP adapter (against a fake channel; the real broker is covered by the integration suite)', () => {
  class FakeChannel {
    constructor() {
      this.calls = [];
      this.acked = [];
      this.nacked = [];
      this.sent = [];
      this.published = [];
      this.failSend = false;
      this.failPublish = false;
    }
    async assertExchange(...args) { this.calls.push(['assertExchange', ...args]); }
    async assertQueue(...args) { this.calls.push(['assertQueue', ...args]); }
    async bindQueue(...args) { this.calls.push(['bindQueue', ...args]); }
    async prefetch(n) { this.calls.push(['prefetch', n]); }
    async consume(queue, fn) { this.consumer = fn; this.calls.push(['consume', queue]); }
    ack(msg) { this.acked.push(msg); }
    nack(msg, allUpTo, requeue) { this.nacked.push([msg, allUpTo, requeue]); }
    sendToQueue(queue, content, options, cb) {
      if (this.failSend) return cb(new Error('broker refused'));
      this.sent.push({ queue, content, options });
      return cb(null);
    }
    publish(exchange, key, content, options, cb) {
      if (this.failPublish) return cb(new Error('nack'));
      this.published.push({ exchange, key, content, options });
      return cb(null);
    }
    async close() { this.closed = true; }
  }
  class FakeConnection {
    constructor() { this.handlers = {}; this.confirm = new FakeChannel(); this.plain = new FakeChannel(); }
    on(event, fn) { this.handlers[event] = fn; }
    async createConfirmChannel() { return this.confirm; }
    async createChannel() { return this.plain; }
    async close() { this.closed = true; }
  }

  const config = { retryDelayMs: 1234, prefetch: 7, maxRetries: 2 };
  const logger = spyLogger();
  const message = (event, headers = {}) => ({ content: Buffer.from(JSON.stringify(event)), properties: { headers } });

  it('declares the exchange, queue, retry queue with TTL dead-lettering back, DLQ and bindings', async () => {
    const channel = new FakeChannel();
    await assertTopology(channel, { retryDelayMs: 1234 });
    const queues = Object.fromEntries(channel.calls.filter((c) => c[0] === 'assertQueue').map((c) => [c[1], c[2]]));
    assert.deepEqual(Object.keys(queues), [QUEUE, `${QUEUE}.retry`, `${QUEUE}.dlq`]);
    assert.deepEqual(queues[`${QUEUE}.retry`].arguments, {
      'x-message-ttl': 1234,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': QUEUE,
    });
    assert.deepEqual(channel.calls.filter((c) => c[0] === 'bindQueue').map((c) => c.slice(1)), [
      [QUEUE, EXCHANGE, 'order.created'],
      [QUEUE, EXCHANGE, 'order.cancelled'],
    ]);
    assert.deepEqual(channel.calls[0].slice(0, 3), ['assertExchange', EXCHANGE, 'topic']);
  });

  async function start(handlers, onClose) {
    const connection = new FakeConnection();
    const messaging = await startMessaging({ connection, handlers, config, logger, onClose });
    return { connection, messaging, consumer: connection.plain.consumer, plain: connection.plain, confirm: connection.confirm };
  }

  it('acks a handled message', async () => {
    const { consumer, plain } = await start({ 'order.created': async () => {} });
    const msg = message(fixture('order.created'));
    await consumer(msg);
    assert.deepEqual(plain.acked, [msg]);
    assert.equal(plain.sent.length, 0);
    assert.ok(plain.calls.some((c) => c[0] === 'prefetch' && c[1] === 7));
  });

  it('a transient failure is re-published to the retry queue with a counted header, then acked', async () => {
    const { consumer, confirm, plain } = await start({ 'order.created': async () => { throw new Error('db down'); } });
    const msg = message(fixture('order.created'), { 'x-retries': 1 });
    await consumer(msg);
    assert.equal(confirm.sent[0].queue, `${QUEUE}.retry`);
    assert.equal(confirm.sent[0].options.headers['x-retries'], 2);
    assert.deepEqual(plain.acked, [msg]);
  });

  it('a poison message is moved to the DLQ with the reason, then acked', async () => {
    const { consumer, confirm, plain } = await start({});
    const msg = message({ nonsense: true });
    await consumer(msg);
    assert.equal(confirm.sent[0].queue, `${QUEUE}.dlq`);
    assert.equal(confirm.sent[0].options.headers['x-dead-letter-reason'], 'malformed_envelope');
    assert.deepEqual(plain.acked, [msg]);
  });

  it('when the retry publish itself fails the message is requeued, never lost', async () => {
    const { consumer, confirm, plain } = await start({ 'order.created': async () => { throw new Error('x'); } });
    confirm.failSend = true;
    const msg = message(fixture('order.created'));
    await consumer(msg);
    assert.equal(plain.acked.length, 0);
    assert.deepEqual(plain.nacked, [[msg, false, true]]);
  });

  it('ignores the null message the broker sends when the consumer is cancelled', async () => {
    const { consumer, plain } = await start({});
    await consumer(null);
    assert.equal(plain.acked.length + plain.nacked.length, 0);
  });

  it('publish resolves on broker confirm and rejects on nack', async () => {
    const { messaging, confirm } = await start({});
    await messaging.publish('stock.reserved', '{"a":1}', 'evt-1');
    assert.equal(confirm.published[0].exchange, EXCHANGE);
    assert.equal(confirm.published[0].key, 'stock.reserved');
    assert.equal(confirm.published[0].options.persistent, true);
    assert.equal(confirm.published[0].options.messageId, 'evt-1');
    confirm.failPublish = true;
    await assert.rejects(messaging.publish('stock.reserved', '{}', 'evt-2'), /nack/);
  });

  it('reports a closed connection and closes channels on shutdown', async () => {
    let closed = false;
    const { connection, messaging, plain, confirm } = await start({}, () => { closed = true; });
    connection.handlers.error(new Error('boom'));
    connection.handlers.close();
    assert.equal(closed, true);
    await messaging.close();
    assert.ok(plain.closed && confirm.closed && connection.closed);
  });
});

describe('buildEnvelope', () => {
  it('produces a valid, unique, correlated envelope', () => {
    const one = buildEnvelope('stock.reserved', { order_id: ORDER }, ORDER);
    const two = buildEnvelope('stock.reserved', { order_id: ORDER }, ORDER);
    assert.equal(envelopeSchema.safeParse(one).success, true);
    assert.notEqual(one.id, two.id);
    assert.equal(one.version, 1);
  });
});
