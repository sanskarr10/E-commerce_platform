import { envelopeSchema } from './schemas.js';

/** Throw this from a handler when retrying cannot help (the message is dead-lettered at once). */
export class PermanentError extends Error {}

/**
 * Decides what to do with one delivery (pure of broker details, so every outcome is unit-tested).
 *   { action: 'ack' }                      handled, duplicate, or a type we do not care about
 *   { action: 'retry', attempt }           transient failure, try again after the retry delay
 *   { action: 'dead_letter', reason }      give up, park it in the DLQ for a human
 */
export async function processDelivery({ content, retries = 0 }, { handlers, maxRetries, logger, onOutcome = () => {} }) {
  let envelope;
  try {
    envelope = envelopeSchema.parse(JSON.parse(content.toString('utf8')));
  } catch (err) {
    logger.error('malformed event, dead-lettering', { error: err.message });
    onOutcome('unknown', 'dead_letter');
    return { action: 'dead_letter', reason: 'malformed_envelope' };
  }

  const handler = handlers[envelope.type];
  if (!handler) {
    logger.warn(`ignoring unknown event type ${envelope.type}`, { event_id: envelope.id });
    onOutcome(envelope.type, 'ignored');
    return { action: 'ack' };
  }

  try {
    const result = await handler(envelope);
    onOutcome(envelope.type, result ?? 'processed');
    return { action: 'ack' };
  } catch (err) {
    if (err instanceof PermanentError) {
      logger.error(`event ${envelope.type} rejected: ${err.message}`, { event_id: envelope.id });
      onOutcome(envelope.type, 'dead_letter');
      return { action: 'dead_letter', reason: 'permanent_error' };
    }
    if (retries >= maxRetries) {
      logger.error(`event ${envelope.type} failed ${retries + 1} times, dead-lettering`, {
        event_id: envelope.id,
        error: err.message,
      });
      onOutcome(envelope.type, 'dead_letter');
      return { action: 'dead_letter', reason: 'retries_exhausted' };
    }
    logger.warn(`event ${envelope.type} failed, will retry`, { event_id: envelope.id, error: err.message });
    onOutcome(envelope.type, 'retry');
    return { action: 'retry', attempt: retries + 1 };
  }
}
