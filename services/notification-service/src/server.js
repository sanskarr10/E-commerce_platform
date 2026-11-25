import pg from 'pg';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { startConsumer } from './events/amqp.js';
import { createLogger } from './logger.js';
import { createMailer } from './mailer.js';
import { createMetrics } from './metrics.js';
import { NotificationRepository } from './repository.js';
import { NotificationService } from './service.js';

const logger = createLogger();
const config = loadConfig();

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000 });
pool.on('error', (err) => logger.error('idle database client error', { error: err.message }));

const repo = new NotificationRepository(pool);
const metrics = createMetrics({ repo });
const mailer = createMailer({ smtpUrl: config.smtpUrl, from: config.mailFrom });
const service = new NotificationService({ repo, mailer, config, logger, metrics });
let shuttingDown = false;

const app = createApp({ repo, auth: createAuth(config.jwt), metrics, logger });
const server = app.listen(config.port, () => {
  logger.info(`notification-service listening on :${config.port}`, { email: mailer.enabled ? 'smtp' : 'disabled' });
});

let consumer = null;
if (config.rabbitmqUrl) {
  try {
    consumer = await startConsumer({
      url: config.rabbitmqUrl,
      handlers: service.handlers(),
      config: config.messaging,
      logger,
      onOutcome: metrics.eventOutcome,
      onClose: () => {
        if (shuttingDown) return;
        logger.error('rabbitmq connection closed, exiting so the orchestrator restarts the service');
        process.exit(1);
      },
    });
    logger.info('consuming order events');
  } catch (err) {
    logger.error('could not start the consumer', { error: err.message });
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    if (consumer) await consumer.close();
    mailer.close();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
