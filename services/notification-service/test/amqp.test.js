import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertTopology, startConsumer } from '../src/events/amqp.js';
import { PermanentError } from '../src/events/consumer.js';
import { confirmed, envelope, silent } from './helpers.js';

class FakeChannel {
  constructor() {
    this.calls = [];
    this.sent = [];
    this.acked = [];
    this.nacked = [];
    this.failSend = false;
  }
  async assertExchange(...a) { this.calls.push(['assertExchange', ...a]); }
  async assertQueue(...a) { this.calls.push(['assertQueue', ...a]); }
  async bindQueue(...a) { this.calls.push(['bindQueue', ...a]); }
  async prefetch(n) { this.calls.push(['prefetch', n]); }
  async consume(queue, fn) { this.consumer = fn; this.calls.push(['consume', queue]); }
  sendToQueue(queue, content, options, cb) { this.sent.push({ queue, options }); cb(this.failSend ? new Error('nack') : null); }
  ack(m) { this.acked.push(m); }
  nack(m, ...rest) { this.nacked.push([m, ...rest]); }
  async close() {}
}
const fakeConnection = (channel) => ({ on() {}, createConfirmChannel: async () => channel, close: async () => {} });
const delivery = (body, headers = {}) => ({ content: Buffer.from(JSON.stringify(body)), properties: { headers } });

describe('topology', () => {
  it('declares the exchange, queue, retry queue with TTL and DLQ, and binds every consumed type', async () => {
    const ch = new FakeChannel();
    await assertTopology(ch, { retryDelayMs: 1234 });
    const queues = ch.calls.filter((c) => c[0] === 'assertQueue').map((c) => c[1]);
    assert.deepEqual(queues, ['notification-service.events', 'notification-service.events.retry', 'notification-service.events.dlq']);
    const retry = ch.calls.find((c) => c[1] === 'notification-service.events.retry');
    assert.equal(retry[2].arguments['x-message-ttl'], 1234);
    assert.equal(retry[2].arguments['x-dead-letter-routing-key'], 'notification-service.events');
    assert.deepEqual(ch.calls.filter((c) => c[0] === 'bindQueue').map((c) => c[3]).sort(), ['order.cancelled', 'order.confirmed', 'order.delivered', 'order.shipped']);
  });
});

describe('consumer', () => {
  const cfg = { retryDelayMs: 10, prefetch: 5, maxRetries: 2 };
  async function setup(handler) {
    const ch = new FakeChannel();
    await startConsumer({ connection: fakeConnection(ch), handlers: { 'order.confirmed': handler }, config: cfg, logger: silent });
    return ch;
  }
  const event = envelope('order.confirmed', confirmed());

  it('sets prefetch and starts consuming the main queue', async () => {
    const ch = await setup(async () => {});
    assert.ok(ch.calls.some((c) => c[0] === 'prefetch' && c[1] === 5));
    assert.ok(ch.calls.some((c) => c[0] === 'consume' && c[1] === 'notification-service.events'));
  });
  it('acks a handled message', async () => {
    const ch = await setup(async () => {});
    const msg = delivery(event);
    await ch.consumer(msg);
    assert.deepEqual(ch.acked, [msg]);
    assert.equal(ch.sent.length, 0);
  });
  it('re-publishes to the retry queue with a bumped counter BEFORE acking', async () => {
    const ch = await setup(async () => { throw new Error('smtp down'); });
    const msg = delivery(event, { 'x-retries': 1 });
    await ch.consumer(msg);
    assert.equal(ch.sent[0].queue, 'notification-service.events.retry');
    assert.equal(ch.sent[0].options.headers['x-retries'], 2);
    assert.equal(ch.acked.length, 1);
  });
  it('parks a poison message in the DLQ with the reason', async () => {
    const ch = await setup(async () => { throw new PermanentError('bad'); });
    await ch.consumer(delivery(event));
    assert.equal(ch.sent[0].queue, 'notification-service.events.dlq');
    assert.equal(ch.sent[0].options.headers['x-dead-letter-reason'], 'permanent_error');
  });
  it('requeues instead of losing the message if it cannot be handed on', async () => {
    const ch = await setup(async () => { throw new Error('x'); });
    ch.failSend = true;
    const msg = delivery(event);
    await ch.consumer(msg);
    assert.equal(ch.acked.length, 0);
    assert.equal(ch.nacked.length, 1);
  });
  it('ignores a consumer-cancel notification', async () => {
    const ch = await setup(async () => {});
    await ch.consumer(null);
    assert.equal(ch.acked.length, 0);
  });
});
