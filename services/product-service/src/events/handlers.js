import { PermanentError } from './consumer.js';
import { consumedSchemas } from './schemas.js';

function parseData(type, envelope) {
  const result = consumedSchemas[type].safeParse(envelope.data);
  if (!result.success) {
    // A payload that does not match the contract will never succeed on retry.
    throw new PermanentError(`invalid ${type} payload: ${result.error.issues[0].message}`);
  }
  return result.data;
}

/** Maps event types to handlers. Every handler is idempotent (see ProductService). */
export function createHandlers({ service, logger }) {
  return {
    'order.created': async (envelope) => {
      const data = parseData('order.created', envelope);
      const outcome = await service.reserveForOrder(envelope, data);
      logger.info(`order.created -> ${outcome}`, { order_id: data.order_id, event_id: envelope.id });
    },
    'order.cancelled': async (envelope) => {
      const data = parseData('order.cancelled', envelope);
      const outcome = await service.releaseForOrder(envelope, data);
      logger.info(`order.cancelled -> ${outcome}`, { order_id: data.order_id, event_id: envelope.id });
    },
  };
}
