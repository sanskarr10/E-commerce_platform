import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ProductService } from '../src/service.js';
import { FakeRepo, MemoryCache, TTL, spyLogger } from './helpers.js';

const defaults = { q: null, category: null, min_price: null, max_price: null, in_stock: false, sort: 'newest', page: 1, page_size: 20 };
const product = (sku, extra = {}) => ({ sku, name: sku, price_minor: 100, currency: 'INR', stock: 5, is_active: true, ...extra });

describe('ProductService caching', () => {
  let repo;
  let cache;
  let logger;
  let service;

  beforeEach(() => {
    repo = new FakeRepo();
    cache = new MemoryCache();
    logger = spyLogger();
    service = new ProductService({ repo, cache, ttl: TTL, logger });
  });

  describe('detail pages', () => {
    it('miss then hit, with one database read', async () => {
      const { id } = await service.create(product('A'));
      assert.equal((await service.get(id)).cache, 'MISS');
      assert.equal((await service.get(id)).cache, 'HIT');
      assert.equal(repo.calls.getById, 1);
    });

    it('stores entries with the configured TTL', async () => {
      const { id } = await service.create(product('A'));
      await service.get(id);
      assert.equal(cache.ttls.get(`product:${id}`), TTL.product);
    });

    it('never caches "not found", so a later create is visible immediately', async () => {
      assert.equal((await service.get(1)).value, null);
      assert.equal((await service.get(1)).value, null);
      assert.equal(repo.calls.getById, 2);
      assert.equal(cache.store.size, 0, 'a miss for a nonexistent product must not write a cache entry');
      await service.create(product('A'));
      assert.equal((await service.get(1)).value.sku, 'A');
    });

    it('update invalidates the cached detail', async () => {
      const { id } = await service.create(product('A'));
      await service.get(id);
      await service.update(id, { price_minor: 999 });
      const fresh = await service.get(id);
      assert.equal(fresh.cache, 'MISS');
      assert.equal(fresh.value.price_minor, 999);
    });

    it('archive invalidates the cached detail', async () => {
      const { id } = await service.create(product('A'));
      await service.get(id);
      await service.archive(id);
      assert.equal((await service.get(id)).value, null);
    });

    it('collapses concurrent misses into ONE database query (single-flight)', async () => {
      const { id } = await service.create(product('A'));
      repo.delayMs = 20;
      const results = await Promise.all(Array.from({ length: 25 }, () => service.get(id)));
      assert.equal(repo.calls.getById, 1);
      assert.ok(results.every((result) => result.value.sku === 'A'));
    });

    it('does not share a failed load with later requests', async () => {
      const { id } = await service.create(product('A'));
      const original = repo.getById.bind(repo);
      repo.getById = async () => {
        throw new Error('db blip');
      };
      await assert.rejects(service.get(id), /db blip/);
      repo.getById = original;
      assert.equal((await service.get(id)).value.sku, 'A');
    });
  });

  describe('listings', () => {
    it('miss then hit; different filters use different keys', async () => {
      await service.create(product('A'));
      assert.equal((await service.list(defaults)).cache, 'MISS');
      assert.equal((await service.list(defaults)).cache, 'HIT');
      assert.equal((await service.list({ ...defaults, sort: 'name' })).cache, 'MISS');
      assert.equal(repo.calls.list, 2);
    });

    it('treats equivalent filters as the same key (undefined vs null, key order)', async () => {
      await service.list({ page: 1, page_size: 20, sort: 'newest' });
      const again = await service.list({ sort: 'newest', q: undefined, category: null, page_size: 20, page: 1 });
      assert.equal(again.cache, 'HIT');
    });

    it('any catalog change invalidates ALL cached listings in O(1) by bumping the version', async () => {
      await service.create(product('A'));
      await service.list(defaults);
      await service.list({ ...defaults, sort: 'name' });
      const versionBefore = cache.versions.get('products:list');

      await service.create(product('B'));

      assert.equal(cache.versions.get('products:list'), versionBefore + 1);
      assert.equal((await service.list(defaults)).cache, 'MISS');
      assert.equal((await service.list({ ...defaults, sort: 'name' })).cache, 'MISS');
      assert.equal((await service.list(defaults)).value.total, 2);
    });

    it('update and archive also invalidate listings', async () => {
      const { id } = await service.create(product('A'));
      await service.list(defaults);
      await service.update(id, { name: 'Renamed' });
      assert.equal((await service.list(defaults)).value.items[0].name, 'Renamed');
      await service.archive(id);
      assert.equal((await service.list(defaults)).value.total, 0);
    });

    it('stock changes clear the detail page but deliberately leave listings cached', async () => {
      const { id } = await service.create(product('A'));
      await service.get(id);
      await service.list(defaults);

      await service.adjustStock(id, -2);

      assert.equal((await service.get(id)).value.stock, 3); // detail is fresh
      assert.equal((await service.list(defaults)).cache, 'HIT'); // listing keeps its entry
    });

    it('reserve and release clear every touched detail page', async () => {
      const a = await service.create(product('A'));
      const b = await service.create(product('B'));
      await service.get(a.id);
      await service.get(b.id);

      const reserved = await service.reserveStock([{ product_id: a.id, quantity: 2 }, { product_id: b.id, quantity: 1 }]);
      assert.deepEqual(reserved, { ok: true });
      assert.equal((await service.get(a.id)).value.stock, 3);
      assert.equal((await service.get(b.id)).value.stock, 4);

      await service.releaseStock([{ product_id: a.id, quantity: 2 }]);
      assert.equal((await service.get(a.id)).value.stock, 5);
    });
  });

  describe('when Redis is unavailable (fail open)', () => {
    it('serves listings and details from the database, labelled BYPASS or MISS', async () => {
      const { id } = await service.create(product('A'));
      cache.down = true;
      const list = await service.list(defaults);
      assert.equal(list.cache, 'BYPASS');
      assert.equal(list.value.total, 1);
      assert.equal((await service.get(id)).value.sku, 'A');
    });

    it('writes still succeed, and a failed invalidation is logged loudly', async () => {
      cache.down = true;
      const created = await service.create(product('A'));
      assert.ok(created.id);
      assert.ok(logger.lines.error.some((line) => /invalidation failed/.test(line)));
    });

    it('never serves entries from an older cache epoch after Redis comes back', async () => {
      await service.create(product('A'));
      await service.list(defaults); // cached under version 0
      cache.down = true;
      await service.create(product('B')); // bump fails: listing cache NOT invalidated
      cache.down = false;
      // This is the documented bounded-staleness window: the old entry is still valid until its TTL.
      // What must hold is that a successful bump afterwards makes it unreachable.
      await service.create(product('C'));
      const fresh = await service.list(defaults);
      assert.equal(fresh.cache, 'MISS');
      assert.equal(fresh.value.total, 3);
    });
  });
});
