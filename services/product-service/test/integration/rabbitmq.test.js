// Runs against a REAL RabbitMQ. Skipped unless RABBITMQ_URL is set:
//   RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672/ npm run test:integration
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import amqp from 'amqplib';
import { startMessaging } from '../../src/events/amqp.js';
import { EXCHANGE, QUEUE } from '../../src/events/envelope.js';
import { createLogger } from '../../src/logger.js';

const enabled = Boolean(process.env.RABBITMQ_URL);
const logger = createLogger({ silent: true });
const config = { retryDelayMs: 200, prefetch: 5, maxRetries: 2 };

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error('timed out waiting for condition');
}

describe('RabbitMQ adapter (real broker)', { skip: !enabled && 'RABBITMQ_URL not set' }, () => {
  let probe;
  let probeChannel;
  let messaging;
  const handled = [];
  let failures = 0;

  const envelope = (type, data = {}) => ({
    id: randomUUID(), type, version: 1, occurred_at: new Date().toISOString(), correlation_id: randomUUID(), data,
  });
  const send = (event, key = event.type) => probeChannel.publish(EXCHANGE, key, Buffer.from(JSON.stringify(event)), { persistent: true });
  const depth = async (queue) => (await probeChannel.checkQueue(queue)).messageCount;

  before(async () => {
    probe = await amqp.connect(process.env.RABBITMQ_URL);
    probeChannel = await probe.createChannel();
    // Fresh state: delete queues from earlier runs (retry TTL arguments must match when re-declared).
    for (const suffix of ['', '.retry', '.dlq']) await probeChannel.deleteQueue(`${QUEUE}${suffix}`).catch(() => {});
    probeChannel = await probe.createChannel();
    messaging = await startMessaging({
      url: process.env.RABBITMQ_URL,
      config,
      logger,
      handlers: {
        'order.created': async (event) => {
          if (event.data.fail === 'always') throw new Error('boom');
          if (event.data.fail === 'twice' && (failures += 1) <= 2) throw new Error('flaky');
          handled.push(event.id);
        },
      },
    });
  });
  after(async () => {
    await messaging?.close();
    await probeChannel?.close().catch(() => {});
    await probe?.close();
  });

  it('routes an event published to the exchange into the queue and handles it', async () => {
    const event = envelope('order.created');
    send(event);
    await waitFor(() => handled.includes(event.id));
  });

  it('publisher confirms resolve for the relay publish path', async () => {
    const event = envelope('order.created');
    await messaging.publish(event.type, JSON.stringify(event), event.id);
    await waitFor(() => handled.includes(event.id));
  });

  it('retries a transient failure via the retry queue and eventually succeeds', async () => {
    failures = 0;
    const event = envelope('order.created', { fail: 'twice' });
    send(event);
    await waitFor(() => handled.includes(event.id));
    assert.equal(failures, 3, 'two failures, then success on the third delivery');
  });

  it('dead-letters after the maximum retries and keeps the queue empty', async () => {
    const before = await depth(`${QUEUE}.dlq`);
    send(envelope('order.created', { fail: 'always' }));
    await waitFor(async () => (await depth(`${QUEUE}.dlq`)) === before + 1);
    assert.equal(await depth(QUEUE), 0);
  });

  it('dead-letters a poison message immediately', async () => {
    const before = await depth(`${QUEUE}.dlq`);
    probeChannel.publish(EXCHANGE, 'order.created', Buffer.from('not json'), { persistent: true });
    await waitFor(async () => (await depth(`${QUEUE}.dlq`)) === before + 1);
  });
});
