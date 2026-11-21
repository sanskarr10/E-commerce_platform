import { randomUUID } from 'node:crypto';
import express from 'express';
import swaggerUiDist from 'swagger-ui-dist';
import { requestContext } from './logger.js';
import { HttpError } from './errors.js';
import { openapi } from './openapi.js';
import { createProductRouter } from './routes.js';

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Product Service API</title>
  <link rel="stylesheet" href="/api/products/docs/assets/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/products/docs/assets/swagger-ui-bundle.js"></script>
  <script>window.ui = SwaggerUIBundle({ url: '/api/products/openapi.json', dom_id: '#swagger-ui' });</script>
</body>
</html>`;

/** Reuses the gateway's X-Request-ID so a request can be followed across services. */
function requestMiddleware(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID().replaceAll('-', '');
    res.setHeader('X-Request-ID', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health') return;
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      // Path only, never the query string, which may contain search terms.
      logger.info(`${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} (${elapsedMs.toFixed(1)} ms)`, {
        request_id: requestId,
      });
    });
    requestContext.run({ requestId }, next);
  };
}

function errorHandler(logger) {
  // Express identifies error middleware by its four parameters, so _next must stay.
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      return res.status(err.status).json({ detail: err.detail });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Invalid JSON body' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ detail: 'Request body too large' });
    logger.error('Unhandled error', { error: err?.message, stack: err?.stack });
    return res.status(500).json({ detail: 'Internal server error' });
  };
}

export function createApp({ service, auth, repo, cache, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestMiddleware(logger));
  app.use(express.json({ limit: '100kb' }));

  /** Liveness: the process is up. */
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  /** Readiness: MySQL must answer. Redis being down degrades speed, not correctness. */
  app.get('/ready', async (_req, res) => {
    try {
      await repo.ping();
    } catch {
      return res.status(503).json({ detail: 'Database unavailable' });
    }
    return res.json({ status: 'ready', cache: await cache.status() });
  });

  // Docs are mounted before the router so "docs" and "openapi.json" are never read as product ids.
  app.get('/api/products/openapi.json', (_req, res) => res.json(openapi));
  app.use('/api/products/docs/assets', express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false }));
  app.get('/api/products/docs', (_req, res) => res.type('html').send(DOCS_HTML));

  app.use('/api/products', createProductRouter({ service, auth }));

  app.use((_req, res) => res.status(404).json({ detail: 'Not found' }));
  app.use(errorHandler(logger));
  return app;
}
