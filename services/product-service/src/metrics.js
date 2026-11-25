import client from 'prom-client';

/**
 * Prometheus metrics. One registry per app instance (not the global one), so tests stay isolated.
 * Route labels use the route PATTERN ("/api/products/:id"), never the raw URL, and anything that matched
 * no route is "unmatched": otherwise a scanner could create unlimited label values.
 * `outbox` is an optional { stats(): Promise<{ unpublished, oldestAgeSeconds }> } read at scrape time.
 */
export function createMetrics({ outbox, service = 'product-service' } = {}) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });

  const http = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route and status',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const cache = new client.Counter({
    name: 'product_cache_requests_total',
    help: 'Catalog reads by cache result (HIT, MISS, BYPASS when Redis is unavailable)',
    labelNames: ['result'],
    registers: [registry],
  });
  const events = new client.Counter({
    name: 'events_consumed_total',
    help: 'Events taken off the queue, by type and outcome',
    labelNames: ['type', 'outcome'],
    registers: [registry],
  });
  const published = new client.Counter({
    name: 'outbox_events_published_total',
    help: 'Outbox events confirmed by the broker',
    registers: [registry],
  });
  new client.Gauge({
    name: 'outbox_unpublished_events',
    help: 'Outbox rows not yet confirmed by the broker',
    registers: [registry],
    async collect() {
      if (!outbox) return;
      try {
        this.set((await outbox.stats()).unpublished);
      } catch {
        // Database down: keep the last value; /ready reports the outage.
      }
    },
  });
  new client.Gauge({
    name: 'outbox_oldest_unpublished_age_seconds',
    help: 'Age of the oldest unpublished outbox row (0 when the outbox is empty)',
    registers: [registry],
    async collect() {
      if (!outbox) return;
      try {
        this.set((await outbox.stats()).oldestAgeSeconds);
      } catch {
        // see above
      }
    },
  });

  return {
    registry,
    contentType: registry.contentType,
    render: () => registry.metrics(),
    middleware(req, res, next) {
      const end = http.startTimer();
      res.on('finish', () => {
        const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
        end({ method: req.method, route, status_code: String(res.statusCode) });
        const result = res.getHeader('X-Cache');
        if (typeof result === 'string') cache.inc({ result });
      });
      next();
    },
    eventOutcome: (type, outcome) => events.inc({ type, outcome }),
    eventsPublished: (count) => published.inc(count),
  };
}
