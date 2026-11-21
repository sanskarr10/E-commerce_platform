import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openapi } from '../src/openapi.js';
import { adminToken, api, startServer, widget } from './helpers.js';

describe('products API', () => {
  let ctx;
  let admin;
  const call = (method, path, options = {}) => api(ctx.baseUrl, method, path, { token: admin, ...options });
  const anonymous = (method, path, options = {}) => api(ctx.baseUrl, method, path, options);

  before(async () => {
    ctx = await startServer();
    admin = adminToken();
  });
  after(() => ctx.close());
  beforeEach(() => {
    ctx.repo.reset();
    ctx.cache.reset();
  });

  describe('create', () => {
    it('applies defaults and returns 201 with the stored product', async () => {
      const response = await call('POST', '/api/products', { body: widget() });
      assert.equal(response.status, 201);
      assert.equal(response.body.currency, 'INR');
      assert.equal(response.body.stock, 0);
      assert.equal(response.body.is_active, true);
      assert.equal(response.body.category, null);
      assert.ok(response.body.id > 0);
    });

    it('rejects a duplicate SKU with 409', async () => {
      await call('POST', '/api/products', { body: widget() });
      const again = await call('POST', '/api/products', { body: widget({ name: 'Other' }) });
      assert.equal(again.status, 409);
      assert.equal(again.body.detail, 'SKU already exists');
    });

    it('reports validation problems in FastAPI style: { detail: [{ loc, msg }] }', async () => {
      const response = await call('POST', '/api/products', { body: { price_minor: -5 } });
      assert.equal(response.status, 422);
      assert.ok(Array.isArray(response.body.detail));
      const locations = response.body.detail.map((issue) => issue.loc.join('.'));
      assert.ok(locations.includes('body.sku'));
      assert.ok(locations.includes('body.name'));
      assert.ok(locations.includes('body.price_minor'));
      assert.ok(response.body.detail.every((issue) => typeof issue.msg === 'string'));
    });

    it('rejects an unknown category with 422', async () => {
      const response = await call('POST', '/api/products', { body: widget({ category_id: 999 }) });
      assert.equal(response.status, 422);
    });

    it('links an existing category', async () => {
      const category = (await call('POST', '/api/products/categories', { body: { name: 'Tools' } })).body;
      const response = await call('POST', '/api/products', { body: widget({ category_id: category.id }) });
      assert.deepEqual(response.body.category, category);
    });

    it('treats a missing body as a validation error, not a crash', async () => {
      assert.equal((await call('POST', '/api/products')).status, 422);
    });
  });

  describe('read', () => {
    it('returns a product, then serves it from cache', async () => {
      const { id } = (await call('POST', '/api/products', { body: widget() })).body;
      const first = await anonymous('GET', `/api/products/${id}`);
      const second = await anonymous('GET', `/api/products/${id}`);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('x-cache'), 'MISS');
      assert.equal(second.headers.get('x-cache'), 'HIT');
      assert.deepEqual(first.body, second.body);
    });

    it('returns 404 for unknown and archived products, 422 for malformed ids', async () => {
      assert.equal((await anonymous('GET', '/api/products/12345')).status, 404);
      for (const id of ['abc', '0', '-1', '1e3', '1.5']) {
        assert.equal((await anonymous('GET', `/api/products/${id}`)).status, 422, `id ${id}`);
      }
    });

    it('does not shadow /categories with the :id route', async () => {
      const response = await anonymous('GET', '/api/products/categories');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, []);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      const shoes = (await call('POST', '/api/products/categories', { body: { name: 'Shoes' } })).body;
      const books = (await call('POST', '/api/products/categories', { body: { name: 'Books' } })).body;
      const make = (body) => call('POST', '/api/products', { body });
      await make(widget({ sku: 'S1', name: 'Red Sneaker', price_minor: 5000, stock: 3, category_id: shoes.id }));
      await make(widget({ sku: 'S2', name: 'Blue Sneaker', price_minor: 7000, stock: 0, category_id: shoes.id }));
      await make(widget({ sku: 'B1', name: 'Novel', price_minor: 900, stock: 10, category_id: books.id }));
    });

    it('returns the page envelope', async () => {
      const response = await anonymous('GET', '/api/products');
      assert.equal(response.status, 200);
      assert.equal(response.body.total, 3);
      assert.equal(response.body.page, 1);
      assert.equal(response.body.page_size, 20);
      assert.equal(response.body.items.length, 3);
    });

    it('passes parsed, normalised filters to the repository', async () => {
      await anonymous('GET', '/api/products?q=sneaker&category=shoes&min_price=1000&max_price=9000&in_stock=true&sort=price_asc&page=1&page_size=5');
      assert.deepEqual(ctx.repo.lastFilters, {
        q: 'sneaker', category: 'shoes', min_price: 1000, max_price: 9000, in_stock: true, sort: 'price_asc', page: 1, page_size: 5,
      });
    });

    it('filters, sorts and paginates', async () => {
      assert.equal((await anonymous('GET', '/api/products?category=books')).body.total, 1);
      assert.equal((await anonymous('GET', '/api/products?in_stock=true')).body.total, 2);
      const byPrice = await anonymous('GET', '/api/products?sort=price_desc');
      assert.deepEqual(byPrice.body.items.map((p) => p.sku), ['S2', 'S1', 'B1']);
      const page2 = await anonymous('GET', '/api/products?sort=price_desc&page=2&page_size=2');
      assert.deepEqual(page2.body.items.map((p) => p.sku), ['B1']);
      assert.equal(page2.body.total, 3);
    });

    it('rejects invalid query parameters with 422', async () => {
      for (const query of ['page=0', 'page_size=500', 'sort=hax', 'min_price=9&max_price=1', 'in_stock=maybe']) {
        const response = await anonymous('GET', `/api/products?${query}`);
        assert.equal(response.status, 422, query);
        assert.equal(response.body.detail[0].loc[0], 'query');
      }
    });

    it('serves repeated identical listings from cache and varies by filter', async () => {
      assert.equal((await anonymous('GET', '/api/products?sort=name')).headers.get('x-cache'), 'MISS');
      assert.equal((await anonymous('GET', '/api/products?sort=name')).headers.get('x-cache'), 'HIT');
      assert.equal((await anonymous('GET', '/api/products?sort=price_asc')).headers.get('x-cache'), 'MISS');
    });
  });

  describe('update, stock and archive', () => {
    let id;
    beforeEach(async () => {
      id = (await call('POST', '/api/products', { body: widget({ stock: 5 }) })).body.id;
    });

    it('patches only the supplied fields', async () => {
      const response = await call('PATCH', `/api/products/${id}`, { body: { price_minor: 2500 } });
      assert.equal(response.status, 200);
      assert.equal(response.body.price_minor, 2500);
      assert.equal(response.body.name, 'Widget');
      assert.equal(response.body.currency, 'INR');
    });

    it('rejects empty patches, sku changes and direct stock writes', async () => {
      for (const body of [{}, { sku: 'NEW' }, { stock: 99 }]) {
        assert.equal((await call('PATCH', `/api/products/${id}`, { body })).status, 422);
      }
    });

    it('returns 404 when patching a missing product', async () => {
      assert.equal((await call('PATCH', '/api/products/999', { body: { name: 'x' } })).status, 404);
    });

    it('adjusts stock and refuses to go negative', async () => {
      assert.equal((await call('PATCH', `/api/products/${id}/stock`, { body: { delta: -3 } })).body.stock, 2);
      assert.equal((await call('PATCH', `/api/products/${id}/stock`, { body: { delta: 10 } })).body.stock, 12);
      const tooMuch = await call('PATCH', `/api/products/${id}/stock`, { body: { delta: -100 } });
      assert.equal(tooMuch.status, 409);
      assert.equal(tooMuch.body.detail, 'Insufficient stock');
      assert.equal((await call('PATCH', `/api/products/${id}/stock`, { body: { delta: 0 } })).status, 422);
      assert.equal((await call('PATCH', '/api/products/999/stock', { body: { delta: 1 } })).status, 404);
    });

    it('archives with 204, hides the product, and removes it from listings', async () => {
      assert.equal((await call('DELETE', `/api/products/${id}`)).status, 204);
      assert.equal((await anonymous('GET', `/api/products/${id}`)).status, 404);
      assert.equal((await anonymous('GET', '/api/products')).body.total, 0);
      assert.equal((await call('DELETE', '/api/products/999')).status, 404);
    });

    it('requires an admin for every write', async () => {
      const writes = [
        ['PATCH', `/api/products/${id}`, { name: 'x' }],
        ['PATCH', `/api/products/${id}/stock`, { delta: 1 }],
        ['DELETE', `/api/products/${id}`, undefined],
        ['POST', '/api/products/categories', { name: 'x' }],
      ];
      for (const [method, path, body] of writes) {
        assert.equal((await anonymous(method, path, { body })).status, 401, `${method} ${path}`);
      }
    });
  });

  describe('categories', () => {
    it('creates, lists (sorted, cached) and rejects duplicates', async () => {
      const created = await call('POST', '/api/products/categories', { body: { name: 'Home & Kitchen' } });
      assert.equal(created.status, 201);
      assert.equal(created.body.slug, 'home-kitchen');
      await call('POST', '/api/products/categories', { body: { name: 'Books' } });

      const list = await anonymous('GET', '/api/products/categories');
      assert.deepEqual(list.body.map((c) => c.name), ['Books', 'Home & Kitchen']);
      assert.equal((await anonymous('GET', '/api/products/categories')).headers.get('x-cache'), 'HIT');

      assert.equal((await call('POST', '/api/products/categories', { body: { name: 'Books' } })).status, 409);
    });

    it('a new category appears immediately (cache invalidated)', async () => {
      await call('POST', '/api/products/categories', { body: { name: 'A' } });
      await anonymous('GET', '/api/products/categories');
      await call('POST', '/api/products/categories', { body: { name: 'B' } });
      const list = await anonymous('GET', '/api/products/categories');
      assert.deepEqual(list.body.map((c) => c.name), ['A', 'B']);
    });

    it('rejects names that produce an empty slug', async () => {
      assert.equal((await call('POST', '/api/products/categories', { body: { name: '!!!' } })).status, 422);
    });
  });

  describe('HTTP behaviour', () => {
    it('returns 400 for malformed JSON and 413 for oversized bodies', async () => {
      const malformed = await call('POST', '/api/products', { rawBody: '{not json', headers: { 'content-type': 'application/json' } });
      assert.equal(malformed.status, 400);
      const huge = await call('POST', '/api/products', { body: widget({ description: 'x'.repeat(200_000) }) });
      assert.equal(huge.status, 413);
    });

    it('returns a JSON 404 for unknown routes', async () => {
      const response = await anonymous('GET', '/api/nope');
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { detail: 'Not found' });
    });

    it('echoes a safe X-Request-ID and generates one otherwise', async () => {
      const echoed = await anonymous('GET', '/health', { headers: { 'x-request-id': 'trace-123' } });
      assert.equal(echoed.headers.get('x-request-id'), 'trace-123');
      const generated = await anonymous('GET', '/health');
      assert.match(generated.headers.get('x-request-id'), /^[0-9a-f]{32}$/);
      const unsafe = await anonymous('GET', '/health', { headers: { 'x-request-id': 'bad id with spaces' } });
      assert.notEqual(unsafe.headers.get('x-request-id'), 'bad id with spaces');
    });

    it('does not advertise the framework', async () => {
      assert.equal((await anonymous('GET', '/health')).headers.get('x-powered-by'), null);
    });
  });

  describe('health, readiness and docs', () => {
    it('liveness is always ok', async () => {
      assert.deepEqual((await anonymous('GET', '/health')).body, { status: 'ok' });
    });

    it('readiness reflects the database and reports the cache state', async () => {
      assert.deepEqual((await anonymous('GET', '/ready')).body, { status: 'ready', cache: 'ok' });
      ctx.cache.down = true;
      const degraded = await anonymous('GET', '/ready');
      assert.equal(degraded.status, 200); // Redis down must not take the service out of rotation
      assert.equal(degraded.body.cache, 'down');
      ctx.repo.down = true;
      assert.equal((await anonymous('GET', '/ready')).status, 503);
    });

    it('serves OpenAPI JSON, a Swagger UI page and its static assets', async () => {
      const spec = await anonymous('GET', '/api/products/openapi.json');
      assert.equal(spec.status, 200);
      assert.equal(spec.body.openapi, '3.1.0');
      const page = await anonymous('GET', '/api/products/docs');
      assert.equal(page.status, 200);
      assert.match(page.text, /SwaggerUIBundle/);
      assert.equal((await anonymous('GET', '/api/products/docs/assets/swagger-ui.css')).status, 200);
      assert.equal((await anonymous('GET', '/api/products/docs/assets/swagger-ui-bundle.js')).status, 200);
    });

    it('every operation in the OpenAPI spec is a real route (guards against doc drift)', async () => {
      for (const [specPath, operations] of Object.entries(openapi.paths)) {
        for (const method of Object.keys(operations).filter((key) => key !== 'parameters')) {
          const response = await anonymous(method.toUpperCase(), specPath.replace('{id}', '1'));
          const isFallthrough = response.status === 404 && response.body?.detail === 'Not found';
          assert.ok(!isFallthrough, `${method.toUpperCase()} ${specPath} is documented but not routed`);
        }
      }
    });
  });
});
