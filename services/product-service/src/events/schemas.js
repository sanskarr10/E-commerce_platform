import { z } from 'zod';

// Tolerant reader: z.object() ignores unknown keys, so producers can add fields safely.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Must be a UUID');

export const envelopeSchema = z.object({
  id: uuid,
  type: z.string().min(1).max(64),
  version: z.literal(1),
  occurred_at: z.string().min(1),
  correlation_id: uuid,
  data: z.record(z.string(), z.unknown()),
});

const item = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().positive().max(1_000_000),
});

/** Payload schemas for the events this service consumes. */
export const consumedSchemas = {
  'order.created': z.object({ order_id: uuid, items: z.array(item).min(1).max(200) }),
  'order.cancelled': z.object({ order_id: uuid, reason: z.string().max(200).optional() }),
};

/** Payload schemas for the events this service produces (used by the contract tests). */
export const producedSchemas = {
  'stock.reserved': z.object({ order_id: uuid }),
  'stock.failed': z.object({
    order_id: uuid,
    failures: z.array(z.object({ product_id: z.number().int(), reason: z.string() })).min(1),
  }),
};
