import client from 'prom-client';

/**
 * Prometheus metrics. One registry per app instance (not the global one), so tests stay isolated.
 * Route labels use the route PATTERN ("/api/notifications/:id/read"), never the raw URL, and anything
 * that matched no route is "unmatched": otherwise a scanner could create unlimited label values.
 */
export function createMetrics({ repo } = {}) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const http = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route and status',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const events = new client.Counter({
    name: 'events_consumed_total',
    help: 'Events taken off the queue, by type and outcome (processed, duplicate_*, ignored, retry, dead_letter)',
    labelNames: ['type', 'outcome'],
    registers: [registry],
  });
  const created = new client.Counter({
    name: 'notifications_created_total',
    help: 'Notifications stored, by event type',
    labelNames: ['type'],
    registers: [registry],
  });
  const emails = new client.Counter({
    name: 'notification_emails_total',
    help: 'Email attempts by result (sent, failed, skipped, retry)',
    labelNames: ['result'],
    registers: [registry],
  });
  new client.Gauge({
    name: 'notification_emails_open',
    help: 'Notifications whose email is not sent yet (pending or sending)',
    registers: [registry],
    async collect() {
      if (!repo) return;
      try {
        this.set(await repo.countOpenEmails());
      } catch {
        // Database down: leave the last value; the readiness probe reports the outage.
      }
    },
  });

  return {
    registry,
    contentType: registry.contentType,
    render: () => registry.metrics(),
    /** Express middleware that times every request. */
    middleware(req, res, next) {
      const end = http.startTimer();
      res.on('finish', () => {
        const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
        end({ method: req.method, route, status_code: String(res.statusCode) });
      });
      next();
    },
    eventOutcome: (type, outcome) => events.inc({ type, outcome }),
    notificationCreated: (type) => created.inc({ type }),
    emailResult: (result) => emails.inc({ result }),
  };
}
