import { AsyncLocalStorage } from 'node:async_hooks';

/** Carries the per-request correlation id so every log line in a request can include it. */
export const requestContext = new AsyncLocalStorage();

function write(level, message, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    logger: 'notification-service',
    message,
    request_id: requestContext.getStore()?.requestId ?? '-',
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** One JSON object per line, matching the user-service log format. */
export function createLogger({ silent = false } = {}) {
  if (silent) {
    const noop = () => {};
    return { info: noop, warn: noop, error: noop };
  }
  return {
    info: (message, fields) => write('INFO', message, fields),
    warn: (message, fields) => write('WARNING', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
  };
}
