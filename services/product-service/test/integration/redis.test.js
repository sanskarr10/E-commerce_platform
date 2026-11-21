// Runs against a REAL Redis. Skipped unless REDIS_URL is set:
//   REDIS_URL=redis://localhost:6379 npm run test:integration
// Every key is namespaced with a random prefix and removed afterwards, so it is safe to point
// at a Redis that holds other data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import Redis from 'ioredis';
import { RedisCache } from '../../src/cache.js';
import { ProductService } from '../../src/service.js';
import { FakeRepo, TTL, spyLogger } from '../helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const options = { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 500 };

describe('RedisCache against real Redis', { skip: !REDIS_URL && 'REDIS_URL not set' }, () => {
  const prefix = `itest:${randomUUID()}:`;
  let raw; // un-prefixed client, for inspection and cleanup
  let redis; // prefixed client used by the cache under test
  let cache;
  let logger;

  // With enableOfflineQueue=false a command sent before the socket is ready is rejected at once
  // (the cache would then report a miss by design), so tests wait for readiness first.
  const whenReady = (client) =>
    client.status === 'ready' ? Promise.resolve() : new Promise((resolve) => client.once('ready', resolve));

  before(async () => {
    raw = new Redis(REDIS_URL, options);
    redis = new Redis(REDIS_URL, { ...options, keyPrefix: prefix });
    logger = spyLogger();
    cache = new RedisCache(redis, logger);
    await Promise.all([whenReady(raw), whenReady(redis)]);
  });

  after(async () => {
    const keys = await raw.keys(`${prefix}*`);
    if (keys.length > 0) await raw.del(...keys);
    await raw.quit();
    await redis.quit();
  });

  it('round-trips JSON and applies the TTL', async () => {
    await cache.setJson('k1', { a: 1, nested: { b: [1, 2] } }, 30);
    assert.deepEqual(await cache.getJson('k1'), { a: 1, nested: { b: [1, 2] } });
    const ttl = await raw.ttl(`${prefix}k1`);
    assert.ok(ttl > 0 && ttl <= 30, `ttl was ${ttl}`);
  });

  it('entries really expire', async () => {
    await cache.setJson('short', { x: 1 }, 1);
    assert.deepEqual(await cache.getJson('short'), { x: 1 });
    await sleep(1300);
    assert.equal(await cache.getJson('short'), null);
  });

  it('returns null for a missing key and deletes several keys at once', async () => {
    assert.equal(await cache.getJson('nope'), null);
    await cache.setJson('d1', 1, 30);
    await cache.setJson('d2', 2, 30);
    await cache.del('d1', 'd2', 'never-existed');
    assert.equal(await cache.getJson('d1'), null);
    assert.equal(await cache.getJson('d2'), null);
    await cache.del(); // no-op, must not throw
  });

  it('versions start at 0, increment atomically, and are independent per namespace', async () => {
    assert.equal(await cache.version('ns-a'), 0);
    await Promise.all(Array.from({ length: 20 }, () => cache.bump('ns-a')));
    assert.equal(await cache.version('ns-a'), 20);
    assert.equal(await cache.version('ns-b'), 0);
  });

  it('treats a corrupt cached value as a miss instead of crashing', async () => {
    await raw.set(`${prefix}corrupt`, '{this is not json', 'EX', 30);
    assert.equal(await cache.getJson('corrupt'), null);
  });

  it('reports ok when Redis answers', async () => {
    assert.equal(await cache.status(), 'ok');
  });

  it('fails open when Redis is unreachable: every call degrades instead of throwing', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { ...options, retryStrategy: () => null });
    dead.on('error', () => {});
    const deadLogger = spyLogger();
    const broken = new RedisCache(dead, deadLogger);

    assert.equal(await broken.getJson('k'), null);
    await broken.setJson('k', 1, 10); // must not throw
    await broken.del('k');
    assert.equal(await broken.version('ns'), null); // null = "bypass the cache"
    assert.equal(await broken.bump('ns'), false);
    assert.equal(await broken.status(), 'down');
    assert.equal(deadLogger.lines.warn.length, 1, 'outage warnings are throttled to one line');
    dead.disconnect();
  });

  describe('through ProductService', () => {
    // Real Redis keeps state between tests (unlike MemoryCache), and each FakeRepo restarts
    // its ids at 1, so entries from a previous test would otherwise be served as hits.
    beforeEach(async () => {
      const keys = await raw.keys(`${prefix}*`);
      if (keys.length > 0) await raw.del(...keys);
    });

    it('serves hits, invalidates listings on write, and keeps stock writes cheap', async () => {
      const repo = new FakeRepo();
      const service = new ProductService({ repo, cache, ttl: TTL, logger: spyLogger() });
      const filters = { q: null, category: null, min_price: null, max_price: null, in_stock: false, sort: 'newest', page: 1, page_size: 20 };

      const { id } = await service.create({ sku: 'R-1', name: 'Redis Widget', price_minor: 100, currency: 'INR', stock: 5, is_active: true });
      assert.equal((await service.list(filters)).cache, 'MISS');
      assert.equal((await service.list(filters)).cache, 'HIT');
      assert.equal(repo.calls.list, 1);

      await service.create({ sku: 'R-2', name: 'Second', price_minor: 200, currency: 'INR', stock: 1, is_active: true });
      const afterWrite = await service.list(filters);
      assert.equal(afterWrite.cache, 'MISS');
      assert.equal(afterWrite.value.total, 2);

      await service.get(id);
      await service.adjustStock(id, -1);
      assert.equal((await service.get(id)).value.stock, 4);
      assert.equal((await service.list(filters)).cache, 'HIT'); // stock change did not wipe listings
    });

    it('concurrent identical requests produce one database read even with a real cache', async () => {
      const repo = new FakeRepo();
      const service = new ProductService({ repo, cache, ttl: TTL, logger: spyLogger() });
      const { id } = await service.create({ sku: 'R-3', name: 'Hot item', price_minor: 1, currency: 'INR', stock: 1, is_active: true });
      repo.delayMs = 30;
      await Promise.all(Array.from({ length: 30 }, () => service.get(id)));
      assert.equal(repo.calls.getById, 1);
    });
  });
});
