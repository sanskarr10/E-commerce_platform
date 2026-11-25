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

// user_email is optional and nullable: tokens without an email claim still produce in-app notifications.
const who = { order_id: uuid, user_id: uuid, user_email: z.string().max(320).nullish() };

export const consumedSchemas = {
  'order.confirmed': z.object({
    ...who,
    total_minor: z.number().int().nonnegative(),
    currency: z.string().length(3),
  }),
  'order.shipped': z.object(who),
  'order.delivered': z.object(who),
  // user_id arrived after the first version of this event; without it nobody can be told.
  'order.cancelled': z.object({ ...who, reason: z.string().max(200).nullish() }),
};
