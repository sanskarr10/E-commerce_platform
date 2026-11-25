import { readFileSync } from 'node:fs';

function intFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

/** 12-factor config: everything comes from environment variables. */
export function loadConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('Missing required environment variable: DATABASE_URL');
  const publicKey =
    env.JWT_PUBLIC_KEY || (env.JWT_PUBLIC_KEY_PATH ? readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8') : '');
  if (!publicKey) throw new Error('Set JWT_PUBLIC_KEY_PATH (or JWT_PUBLIC_KEY) to the user-service public key');

  return Object.freeze({
    env: env.NODE_ENV ?? 'development',
    port: intFrom(env, 'PORT', 3100),
    databaseUrl: env.DATABASE_URL,
    // Empty RABBITMQ_URL disables consuming: the API still works, but no notifications are created.
    rabbitmqUrl: env.RABBITMQ_URL ?? '',
    // Empty SMTP_URL disables email: notifications are still stored and shown in the app.
    smtpUrl: env.SMTP_URL ?? '',
    mailFrom: env.MAIL_FROM ?? 'Shop <no-reply@shop.local>',
    messaging: {
      maxRetries: intFrom(env, 'EVENT_MAX_RETRIES', 5),
      retryDelayMs: intFrom(env, 'EVENT_RETRY_DELAY_MS', 5000),
      prefetch: intFrom(env, 'EVENT_PREFETCH', 10),
    },
    // How long a claimed email may stay "sending" before another worker may take it over.
    emailLeaseSeconds: intFrom(env, 'EMAIL_LEASE_SECONDS', 120),
    jwt: {
      publicKey,
      issuer: env.JWT_ISSUER ?? 'ecommerce-user-service',
      audience: env.JWT_AUDIENCE ?? 'ecommerce',
    },
  });
}
