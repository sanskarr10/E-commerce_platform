import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { MYSQL_USER: 'u', MYSQL_PASSWORD: 'p', JWT_PUBLIC_KEY: 'PEM' };

describe('loadConfig', () => {
  it('applies sensible defaults', () => {
    const config = loadConfig(base);
    assert.equal(config.port, 3000);
    assert.equal(config.mysql.host, 'localhost');
    assert.equal(config.mysql.database, 'catalog');
    assert.equal(config.redisUrl, '');
    assert.equal(config.rabbitmqUrl, '');
    assert.deepEqual(config.messaging, { maxRetries: 5, retryDelayMs: 5000, prefetch: 10, relayIntervalMs: 500 });
    assert.equal(config.jwt.issuer, 'ecommerce-user-service');
    assert.equal(config.jwt.audience, 'ecommerce');
    assert.deepEqual(config.cacheTtl, { product: 300, list: 60, categories: 300 });
  });

  it('reads values from the environment', () => {
    const config = loadConfig({ ...base, PORT: '8080', MYSQL_HOST: 'db', REDIS_URL: 'redis://r:6379', CACHE_TTL_LIST: '5' });
    assert.equal(config.port, 8080);
    assert.equal(config.mysql.host, 'db');
    assert.equal(config.redisUrl, 'redis://r:6379');
    assert.equal(config.cacheTtl.list, 5);
  });

  it('reads messaging settings', () => {
    const config = loadConfig({ ...base, RABBITMQ_URL: 'amqp://u:p@mq:5672/', EVENT_MAX_RETRIES: '2', EVENT_RETRY_DELAY_MS: '100' });
    assert.equal(config.rabbitmqUrl, 'amqp://u:p@mq:5672/');
    assert.equal(config.messaging.maxRetries, 2);
    assert.equal(config.messaging.retryDelayMs, 100);
  });

  it('fails fast and names every missing required variable', () => {
    assert.throws(() => loadConfig({ JWT_PUBLIC_KEY: 'x' }), /MYSQL_USER, MYSQL_PASSWORD/);
  });

  it('requires a public key and loads it from a file path', () => {
    assert.throws(() => loadConfig({ MYSQL_USER: 'u', MYSQL_PASSWORD: 'p' }), /JWT_PUBLIC_KEY_PATH/);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cfg-')), 'pub.pem');
    writeFileSync(file, 'FILE-PEM');
    assert.equal(loadConfig({ MYSQL_USER: 'u', MYSQL_PASSWORD: 'p', JWT_PUBLIC_KEY_PATH: file }).jwt.publicKey, 'FILE-PEM');
  });

  it('rejects non-numeric numbers instead of silently using NaN', () => {
    assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), /PORT must be a non-negative integer/);
    assert.throws(() => loadConfig({ ...base, CACHE_TTL_LIST: '-1' }), /CACHE_TTL_LIST/);
  });

  it('is immutable', () => {
    assert.throws(() => {
      'use strict';
      loadConfig(base).port = 1;
    }, TypeError);
  });
});
