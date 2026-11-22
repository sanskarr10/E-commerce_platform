import { readFileSync } from 'node:fs';

function intFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/** 12-factor config: everything comes from environment variables. */
export function loadConfig(env = process.env) {
  const missing = ['MYSQL_USER', 'MYSQL_PASSWORD'].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // This service only ever needs the PUBLIC key: it can verify tokens but never mint them.
  const publicKey =
    env.JWT_PUBLIC_KEY ||
    (env.JWT_PUBLIC_KEY_PATH ? readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8') : '');
  if (!publicKey) {
    throw new Error('Set JWT_PUBLIC_KEY_PATH (or JWT_PUBLIC_KEY) to the user-service public key');
  }

  return Object.freeze({
    env: env.NODE_ENV ?? 'development',
    port: intFrom(env, 'PORT', 3000),
    mysql: {
      host: env.MYSQL_HOST ?? 'localhost',
      port: intFrom(env, 'MYSQL_PORT', 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE ?? 'catalog',
      connectionLimit: intFrom(env, 'MYSQL_POOL_SIZE', 10),
    },
    // Empty REDIS_URL disables caching entirely; the service still works, just slower.
    redisUrl: env.REDIS_URL ?? '',
    // Empty RABBITMQ_URL disables messaging: the HTTP API still works, but no checkout events flow.
    rabbitmqUrl: env.RABBITMQ_URL ?? '',
    messaging: {
      maxRetries: intFrom(env, 'EVENT_MAX_RETRIES', 5),
      retryDelayMs: intFrom(env, 'EVENT_RETRY_DELAY_MS', 5000),
      prefetch: intFrom(env, 'EVENT_PREFETCH', 10),
      relayIntervalMs: intFrom(env, 'OUTBOX_POLL_MS', 500),
    },
    jwt: {
      publicKey,
      issuer: env.JWT_ISSUER ?? 'ecommerce-user-service',
      audience: env.JWT_AUDIENCE ?? 'ecommerce',
    },
    cacheTtl: {
      product: intFrom(env, 'CACHE_TTL_PRODUCT', 300),
      list: intFrom(env, 'CACHE_TTL_LIST', 60),
      categories: intFrom(env, 'CACHE_TTL_CATEGORIES', 300),
    },
  });
}
