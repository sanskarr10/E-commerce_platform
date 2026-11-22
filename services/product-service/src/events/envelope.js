import { randomUUID } from 'node:crypto';

export const EXCHANGE = 'ecommerce.events';
export const QUEUE = 'product-service.events';
export const CONSUMED_TYPES = ['order.created', 'order.cancelled'];

/** Builds an event envelope as described in docs/events/README.md. */
export function buildEnvelope(type, data, correlationId) {
  return {
    id: randomUUID(),
    type,
    version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: correlationId,
    data,
  };
}
