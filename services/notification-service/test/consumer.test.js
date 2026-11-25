import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermanentError, processDelivery } from '../src/events/consumer.js';
import { ORDER, confirmed, envelope, silent } from './helpers.js';

const run = (body, handler, retries = 0, extra = {}) =>
  processDelivery(
    { content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), retries },
    { handlers: { 'order.confirmed': handler }, maxRetries: 2, logger: silent, ...extra },
  );

describe('processDelivery', () => {
  const event = envelope('order.confirmed', confirmed());

  it('acks a handled event and reports the outcome', async () => {
    const seen = [];
    const decision = await run(event, async () => 'emailed', 0, { onOutcome: (...a) => seen.push(a) });
    assert.deepEqual(decision, { action: 'ack' });
    assert.deepEqual(seen, [['order.confirmed', 'emailed']]);
  });
  it('dead-letters malformed JSON and bad envelopes', async () => {
    assert.deepEqual(await run('{not json', async () => {}), { action: 'dead_letter', reason: 'malformed_envelope' });
    assert.deepEqual(await run({ ...event, version: 2 }, async () => {}), { action: 'dead_letter', reason: 'malformed_envelope' });
  });
  it('acks and ignores events of other types', async () => {
    const seen = [];
    const decision = await run(envelope('stock.reserved', { order_id: ORDER }), async () => {}, 0, { onOutcome: (...a) => seen.push(a) });
    assert.deepEqual(decision, { action: 'ack' });
    assert.deepEqual(seen, [['stock.reserved', 'ignored']]);
  });
  it('retries a transient failure with a growing attempt number', async () => {
    assert.deepEqual(await run(event, async () => { throw new Error('boom'); }, 1), { action: 'retry', attempt: 2 });
  });
  it('dead-letters once retries are exhausted', async () => {
    assert.deepEqual(await run(event, async () => { throw new Error('boom'); }, 2), { action: 'dead_letter', reason: 'retries_exhausted' });
  });
  it('dead-letters a permanent error immediately', async () => {
    assert.deepEqual(await run(event, async () => { throw new PermanentError('bad'); }), { action: 'dead_letter', reason: 'permanent_error' });
  });
});
