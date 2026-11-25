import amqp from 'amqplib';
import { setTimeout as sleep } from 'node:timers/promises';
import { EXCHANGE, QUEUE, CONSUMED_TYPES } from './envelope.js';
import { processDelivery } from './consumer.js';

/**
 * Declares the topology (idempotent):
 *   ecommerce.events (topic) --order.*--> notification-service.events
 *   notification-service.events.retry   TTL queue that dead-letters back into the main queue
 *   notification-service.events.dlq     parked messages for a human
 */
export async function assertTopology(channel, { retryDelayMs, queue = QUEUE, bindings = CONSUMED_TYPES }) {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(queue, { durable: true });
  await channel.assertQueue(`${queue}.retry`, {
    durable: true,
    arguments: { 'x-message-ttl': retryDelayMs, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
  });
  await channel.assertQueue(`${queue}.dlq`, { durable: true });
  for (const key of bindings) await channel.bindQueue(queue, EXCHANGE, key);
}

export async function connectWithRetry(url, logger, { attempts = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      if (attempt >= attempts) throw err;
      logger.warn(`rabbitmq not reachable (attempt ${attempt}/${attempts}), retrying`, { error: err.message });
      await sleep(delayMs);
    }
  }
}

/** Consume-only: this service publishes nothing, so there is no outbox and no publish channel. */
export async function startConsumer({ url, handlers, config, logger, onClose, onOutcome, connection }) {
  const conn = connection ?? (await connectWithRetry(url, logger));
  conn.on('error', (err) => logger.error('rabbitmq connection error', { error: err.message }));
  conn.on('close', () => onClose?.());

  const channel = await conn.createConfirmChannel();
  await assertTopology(channel, { retryDelayMs: config.retryDelayMs });
  await channel.prefetch(config.prefetch);

  const sendTo = (queue, msg, headers) =>
    new Promise((resolve, reject) => {
      channel.sendToQueue(
        queue,
        msg.content,
        { persistent: true, contentType: 'application/json', headers },
        (err) => (err ? reject(err) : resolve()),
      );
    });

  await channel.consume(QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const retries = Number(msg.properties.headers?.['x-retries'] ?? 0);
      const decision = await processDelivery(
        { content: msg.content, retries },
        { handlers, maxRetries: config.maxRetries, logger, onOutcome },
      );
      // Re-publish BEFORE acking, so a crash in between duplicates the message instead of losing it.
      if (decision.action === 'retry') {
        await sendTo(`${QUEUE}.retry`, msg, { ...msg.properties.headers, 'x-retries': decision.attempt });
      } else if (decision.action === 'dead_letter') {
        await sendTo(`${QUEUE}.dlq`, msg, { ...msg.properties.headers, 'x-dead-letter-reason': decision.reason });
      }
      channel.ack(msg);
    } catch (err) {
      logger.error('failed to settle message, requeueing', { error: err.message });
      channel.nack(msg, false, true);
    }
  });

  return {
    close: async () => {
      await channel.close().catch(() => {});
      await conn.close().catch(() => {});
    },
  };
}
