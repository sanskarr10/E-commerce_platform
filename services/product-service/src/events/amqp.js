import amqp from 'amqplib';
import { setTimeout as sleep } from 'node:timers/promises';
import { EXCHANGE, QUEUE, CONSUMED_TYPES } from './envelope.js';
import { processDelivery } from './consumer.js';

/**
 * Declares the topology (idempotent: re-declaring with identical arguments is a no-op).
 *   ecommerce.events (topic) --order.created/order.cancelled--> product-service.events
 *   product-service.events.retry  TTL queue that dead-letters back into the main queue
 *   product-service.events.dlq    parked messages for a human
 */
export async function assertTopology(channel, { retryDelayMs, queue = QUEUE, bindings = CONSUMED_TYPES }) {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(queue, { durable: true });
  await channel.assertQueue(`${queue}.retry`, {
    durable: true,
    arguments: {
      'x-message-ttl': retryDelayMs,
      'x-dead-letter-exchange': '', // default exchange routes by queue name
      'x-dead-letter-routing-key': queue,
    },
  });
  await channel.assertQueue(`${queue}.dlq`, { durable: true });
  for (const key of bindings) await channel.bindQueue(queue, EXCHANGE, key);
}

/** Retries the initial connection: in Docker Compose the broker may still be starting. */
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

/**
 * Wires the broker to the service: a confirm channel for publishing and a consumer for events.
 * If the connection drops, `onClose` is called; the process exits and the orchestrator restarts it,
 * which is simpler and safer than hand-rolled reconnection (the outbox guarantees nothing is lost).
 */
export async function startMessaging({ url, handlers, config, logger, onClose, onOutcome, connection }) {
  const conn = connection ?? (await connectWithRetry(url, logger));
  conn.on('error', (err) => logger.error('rabbitmq connection error', { error: err.message }));
  conn.on('close', () => onClose?.());

  const publishChannel = await conn.createConfirmChannel();
  const consumeChannel = await conn.createChannel();
  await assertTopology(consumeChannel, { retryDelayMs: config.retryDelayMs });
  await consumeChannel.prefetch(config.prefetch);

  /** Resolves only after the broker confirmed the message (publisher confirm). */
  const publish = (routingKey, body, messageId) =>
    new Promise((resolve, reject) => {
      publishChannel.publish(
        EXCHANGE,
        routingKey,
        Buffer.from(body),
        { persistent: true, contentType: 'application/json', messageId, type: routingKey },
        (err) => (err ? reject(err) : resolve()),
      );
    });

  const sendTo = (queue, msg, headers) =>
    new Promise((resolve, reject) => {
      publishChannel.sendToQueue(
        queue,
        msg.content,
        { persistent: true, contentType: 'application/json', headers },
        (err) => (err ? reject(err) : resolve()),
      );
    });

  await consumeChannel.consume(QUEUE, async (msg) => {
    if (!msg) return; // consumer cancelled by the broker
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
      consumeChannel.ack(msg);
    } catch (err) {
      // Could not even hand the message on: put it back for redelivery.
      logger.error('failed to settle message, requeueing', { error: err.message });
      consumeChannel.nack(msg, false, true);
    }
  });

  return {
    publish,
    close: async () => {
      await consumeChannel.close().catch(() => {});
      await publishChannel.close().catch(() => {});
      await conn.close().catch(() => {});
    },
  };
}
