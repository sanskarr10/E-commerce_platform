import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createLogger, requestContext } from '../src/logger.js';
import { PUBLIC_KEY } from './helpers.js';

const env = (extra = {}) => ({ DATABASE_URL: 'postgresql://u:p@db/notifications_db', JWT_PUBLIC_KEY: PUBLIC_KEY, ...extra });

describe('loadConfig', () => {
  it('applies safe defaults and disables optional integrations when unset', () => {
    const c = loadConfig(env());
    assert.equal(c.port, 3100);
    assert.equal(c.rabbitmqUrl, '');
    assert.equal(c.smtpUrl, '');
    assert.equal(c.messaging.maxRetries, 5);
    assert.equal(c.emailLeaseSeconds, 120);
    assert.equal(c.jwt.issuer, 'ecommerce-user-service');
    assert.ok(Object.isFrozen(c));
  });
  it('reads overrides', () => {
    const c = loadConfig(env({ PORT: '4000', SMTP_URL: 'smtp://mail:1025', EVENT_MAX_RETRIES: '2', MAIL_FROM: 'x <x@y.z>' }));
    assert.equal(c.port, 4000);
    assert.equal(c.smtpUrl, 'smtp://mail:1025');
    assert.equal(c.messaging.maxRetries, 2);
    assert.equal(c.mailFrom, 'x <x@y.z>');
  });
  it('fails fast without a database or a public key', () => {
    assert.throws(() => loadConfig({ JWT_PUBLIC_KEY: PUBLIC_KEY }), /DATABASE_URL/);
    assert.throws(() => loadConfig({ DATABASE_URL: 'x' }), /JWT_PUBLIC_KEY/);
  });
  it('rejects non-numeric and negative numbers instead of guessing', () => {
    assert.throws(() => loadConfig(env({ PORT: 'abc' })), /PORT/);
    assert.throws(() => loadConfig(env({ EVENT_MAX_RETRIES: '-1' })), /EVENT_MAX_RETRIES/);
  });
  it('reads the public key from a file path', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'key-')), 'pub.pem');
    writeFileSync(file, PUBLIC_KEY);
    assert.equal(loadConfig({ DATABASE_URL: 'x', JWT_PUBLIC_KEY_PATH: file }).jwt.publicKey, PUBLIC_KEY);
  });
});

describe('logger', () => {
  it('writes one JSON line per message with the request id when there is one', () => {
    const lines = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
    try {
      const log = createLogger();
      requestContext.run({ requestId: 'req-1' }, () => log.info('hello', { extra: 1 }));
      log.warn('careful');
      log.error('bad');
    } finally {
      process.stdout.write = original;
    }
    const [a, b, c] = lines.map((l) => JSON.parse(l));
    assert.deepEqual([a.level, a.message, a.request_id, a.extra, a.logger], ['INFO', 'hello', 'req-1', 1, 'notification-service']);
    assert.deepEqual([b.level, b.request_id], ['WARNING', '-']);
    assert.equal(c.level, 'ERROR');
  });
  it('can be silenced', () => {
    createLogger({ silent: true }).info('nothing');
  });
});
