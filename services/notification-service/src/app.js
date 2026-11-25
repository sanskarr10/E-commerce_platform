import { randomUUID } from 'node:crypto';
import express from 'express';
import { requestContext } from './logger.js';
import { HttpError } from './errors.js';
import { createRouter } from './routes.js';

/** Reuses the gateway's X-Request-ID so a request can be followed across services. */
function requestMiddleware(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID().replaceAll('-', '');
    res.setHeader('X-Request-ID', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health' || req.path === '/metrics') return;
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info(`${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} (${elapsedMs.toFixed(1)} ms)`, {
        request_id: requestId,
      });
    });
    requestContext.run({ requestId }, next);
  };
}

function errorHandler(logger) {
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      return res.status(err.status).json({ detail: err.detail });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Invalid JSON body' });
    logger.error('Unhandled error', { error: err?.message, stack: err?.stack });
    return res.status(500).json({ detail: 'Internal server error' });
  };
}

export function createApp({ repo, auth, metrics, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestMiddleware(logger));
  app.use(metrics.middleware);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (_req, res) => {
    try {
      await repo.ping();
    } catch {
      return res.status(503).json({ detail: 'Database unavailable' });
    }
    return res.json({ status: 'ready' });
  });
  // Scraped by Prometheus over the internal network. The gateway never routes this path.
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.contentType).send(await metrics.render());
  });

  app.use('/api/notifications', createRouter({ repo, auth }));
  app.use((_req, res) => res.status(404).json({ detail: 'Not found' }));
  app.use(errorHandler(logger));
  return app;
}
