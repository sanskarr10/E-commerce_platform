import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { createApp } from './app.js';
import { NullCache, RedisCache } from './cache.js';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { ProductRepository } from './repository.js';
import { ProductService } from './service.js';

const logger = createLogger();
const config = loadConfig();

const pool = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
  timezone: 'Z',
  connectTimeout: 5000,
  enableKeepAlive: true,
});

let redis = null;
if (config.redisUrl) {
  redis = new Redis(config.redisUrl, {
    // Fail fast instead of queueing commands while Redis is down; the cache wrapper then
    // treats every call as a miss and requests go straight to MySQL.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 500,
  });
  redis.on('error', () => {}); // errors are logged (throttled) by RedisCache; this stops unhandled 'error' events
  // Until the first connection is ready, cache calls are bypassed by design (fail open).
  redis.on('ready', () => logger.info('redis connected, caching enabled'));
  redis.on('close', () => logger.warn('redis connection lost, serving from database until it returns'));
}
const cache = redis ? new RedisCache(redis, logger) : new NullCache();

const repo = new ProductRepository(pool);
const service = new ProductService({ repo, cache, ttl: config.cacheTtl, logger });
const auth = createAuth(config.jwt);
const app = createApp({ service, auth, repo, cache, logger });

const server = app.listen(config.port, () => {
  logger.info(`product-service listening on :${config.port}`, { cache: redis ? 'redis' : 'disabled' });
});

// Graceful shutdown so Kubernetes rolling updates and `docker stop` do not drop in-flight requests.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref(); // hard stop if something hangs
  server.close(async () => {
    await pool.end().catch(() => {});
    if (redis) await redis.quit().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
