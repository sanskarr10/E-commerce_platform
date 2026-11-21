// Runs against a REAL MySQL 8 server. Skipped unless MYSQL_HOST is set:
//   MYSQL_HOST=127.0.0.1 MYSQL_USER=ci MYSQL_PASSWORD=ci MYSQL_DATABASE=catalog_test npm run test:integration
//
// DESTRUCTIVE: the tables are dropped and recreated. For safety the database name must
// contain "test", otherwise the suite refuses to run.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mysql from 'mysql2/promise';
import { HttpError } from '../../src/errors.js';
import { createLogger } from '../../src/logger.js';
import { runMigrations } from '../../src/migrate.js';
import { ProductRepository } from '../../src/repository.js';
import { seed } from '../../src/seed.js';

const enabled = Boolean(process.env.MYSQL_HOST);
const silent = createLogger({ silent: true });
const filters = { q: null, category: null, min_price: null, max_price: null, in_stock: false, sort: 'newest', page: 1, page_size: 20 };

function connectionOptions() {
  const database = process.env.MYSQL_DATABASE ?? '';
  if (!/test/i.test(database)) {
    throw new Error(`Refusing to run destructive tests on database "${database}": its name must contain "test"`);
  }
  return {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database,
  };
}

async function dropSchema(options) {
  const connection = await mysql.createConnection(options);
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  await connection.query('DROP TABLE IF EXISTS products, categories, schema_migrations');
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  await connection.end();
}

const newProduct = (sku, extra = {}) => ({
  sku, name: `Product ${sku}`, description: null, price_minor: 1000, currency: 'INR', stock: 10, category_id: null, image_url: null, is_active: true, ...extra,
});

describe('migrations (real MySQL)', { skip: !enabled && 'MYSQL_HOST not set' }, () => {
  it('apply once, are idempotent, and are safe when two replicas start together', async () => {
    const options = connectionOptions();
    await dropSchema(options);

    const [first, second] = await Promise.all([
      runMigrations(options, { logger: silent }),
      runMigrations(options, { logger: silent }),
    ]);
    assert.equal(first.length + second.length, 1, 'exactly one runner applies 001_init.sql; the other waits on the lock');

    assert.deepEqual(await runMigrations(options, { logger: silent }), []);

    const connection = await mysql.createConnection(options);
    const [rows] = await connection.query('SELECT version FROM schema_migrations');
    await connection.end();
    assert.deepEqual(rows.map((row) => row.version), ['001_init.sql']);
  });
});

describe('ProductRepository (real MySQL)', { skip: !enabled && 'MYSQL_HOST not set' }, () => {
  let pool;
  let repo;

  before(async () => {
    const options = connectionOptions();
    await dropSchema(options);
    await runMigrations(options, { logger: silent });
    pool = mysql.createPool({ ...options, timezone: 'Z', connectionLimit: 25 });
    repo = new ProductRepository(pool);
  });
  after(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM products');
    await pool.query('DELETE FROM categories');
  });

  describe('create and read', () => {
    it('stores and returns a product with timestamps and a category', async () => {
      const category = await repo.createCategory('Tools', 'tools');
      const created = await repo.create(newProduct('T-1', { category_id: category.id, description: 'Hammer', image_url: 'https://x.test/a.png' }));
      assert.equal(created.sku, 'T-1');
      assert.equal(created.is_active, true);
      assert.deepEqual(created.category, category);
      assert.ok(created.created_at instanceof Date);
      assert.deepEqual(await repo.getById(created.id), created);
    });

    it('rejects a duplicate SKU (case-insensitively) with 409', async () => {
      await repo.create(newProduct('DUP-1'));
      await assert.rejects(repo.create(newProduct('dup-1')), (err) => err instanceof HttpError && err.status === 409);
    });

    it('rejects an unknown category with 422', async () => {
      await assert.rejects(repo.create(newProduct('FK-1', { category_id: 999999 })), (err) => err instanceof HttpError && err.status === 422);
    });

    it('the database itself refuses negative stock (CHECK constraint)', async () => {
      await assert.rejects(pool.query('INSERT INTO products (sku, name, price_minor, stock) VALUES (?, ?, ?, ?)', ['NEG', 'n', 1, -1]));
    });

    it('hides archived products from public reads but keeps the row', async () => {
      const { id } = await repo.create(newProduct('ARC-1'));
      await repo.archive(id);
      assert.equal(await repo.getById(id), null);
      assert.equal((await repo.findBySku('ARC-1')).is_active, false);
      await assert.rejects(repo.archive(987654), (err) => err.status === 404);
    });

    it('deleting a category keeps its products (ON DELETE SET NULL)', async () => {
      const category = await repo.createCategory('Temp', 'temp');
      const { id } = await repo.create(newProduct('CAT-1', { category_id: category.id }));
      await pool.query('DELETE FROM categories WHERE id = ?', [category.id]);
      assert.equal((await repo.getById(id)).category, null);
    });
  });

  describe('update', () => {
    it('changes only the given columns and bumps updated_at semantics', async () => {
      const { id } = await repo.create(newProduct('UPD-1', { price_minor: 500 }));
      const updated = await repo.update(id, { price_minor: 900, is_active: false });
      assert.equal(updated.price_minor, 900);
      assert.equal(updated.is_active, false);
      assert.equal(updated.name, 'Product UPD-1');
    });

    it('404s for a missing product and 422s for a bad category', async () => {
      await assert.rejects(repo.update(424242, { name: 'x' }), (err) => err.status === 404);
      const { id } = await repo.create(newProduct('UPD-2'));
      await assert.rejects(repo.update(id, { category_id: 999999 }), (err) => err.status === 422);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      const shoes = await repo.createCategory('Shoes', 'shoes');
      const books = await repo.createCategory('Books', 'books');
      await repo.create(newProduct('L1', { name: 'Red Sneaker', price_minor: 5000, stock: 3, category_id: shoes.id, description: 'Fast shoe' }));
      await repo.create(newProduct('L2', { name: 'Blue Sneaker', price_minor: 7000, stock: 0, category_id: shoes.id }));
      await repo.create(newProduct('L3', { name: '100% Cotton Tee', price_minor: 900, stock: 10, category_id: books.id }));
      await repo.create(newProduct('L4', { name: '100 Cotton Sock', price_minor: 400, stock: 10 }));
      await repo.create(newProduct('L5', { name: 'Hidden', price_minor: 1, stock: 1, is_active: false }));
    });

    it('lists only active products with a correct total', async () => {
      const page = await repo.list(filters);
      assert.equal(page.total, 4);
      assert.equal(page.items.length, 4);
    });

    it('filters by text (name and description), category, price range and stock', async () => {
      assert.equal((await repo.list({ ...filters, q: 'sneaker' })).total, 2);
      assert.equal((await repo.list({ ...filters, q: 'fast shoe' })).total, 1);
      assert.equal((await repo.list({ ...filters, category: 'shoes' })).total, 2);
      assert.equal((await repo.list({ ...filters, min_price: 5000, max_price: 7000 })).total, 2);
      assert.equal((await repo.list({ ...filters, in_stock: true })).total, 3);
      assert.equal((await repo.list({ ...filters, category: 'shoes', in_stock: true })).total, 1);
    });

    it('treats LIKE wildcards in the search text literally', async () => {
      const percent = await repo.list({ ...filters, q: '100%' });
      assert.deepEqual(percent.items.map((p) => p.sku), ['L3']); // would also match L4 if % were a wildcard
      assert.equal((await repo.list({ ...filters, q: 'Sneak_r' })).total, 0); // _ must not match "e"
    });

    it('sorts and paginates deterministically', async () => {
      const byPrice = await repo.list({ ...filters, sort: 'price_asc' });
      assert.deepEqual(byPrice.items.map((p) => p.sku), ['L4', 'L3', 'L1', 'L2']);
      const second = await repo.list({ ...filters, sort: 'price_asc', page: 2, page_size: 2 });
      assert.deepEqual(second.items.map((p) => p.sku), ['L1', 'L2']);
      assert.equal(second.total, 4);
      const byName = await repo.list({ ...filters, sort: 'name' });
      assert.deepEqual(byName.items.map((p) => p.name), ['100 Cotton Sock', '100% Cotton Tee', 'Blue Sneaker', 'Red Sneaker']);
    });
  });

  describe('atomic stock', () => {
    it('adjustStock: 50 concurrent removals on stock 10 succeed exactly 10 times', async () => {
      const { id } = await repo.create(newProduct('RACE-1', { stock: 10 }));
      const results = await Promise.allSettled(Array.from({ length: 50 }, () => repo.adjustStock(id, -1)));
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const refused = results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length;
      assert.equal(succeeded, 10);
      assert.equal(refused, 40);
      assert.equal((await repo.getById(id)).stock, 0);
    });

    it('adjustStock: adds stock, 404s for unknown ids', async () => {
      const { id } = await repo.create(newProduct('ADJ-1', { stock: 1 }));
      assert.equal((await repo.adjustStock(id, 5)).stock, 6);
      await assert.rejects(repo.adjustStock(777777, 1), (err) => err.status === 404);
    });

    it('reserveStock never oversells: 20 concurrent single-unit orders on stock 5 -> exactly 5 win', async () => {
      const { id } = await repo.create(newProduct('RES-1', { stock: 5 }));
      const results = await Promise.all(Array.from({ length: 20 }, () => repo.reserveStock([{ product_id: id, quantity: 1 }])));
      assert.equal(results.filter((r) => r.ok).length, 5);
      assert.ok(results.filter((r) => !r.ok).every((r) => r.failures[0].reason === 'insufficient_stock'));
      assert.equal((await repo.getById(id)).stock, 0);
    });

    it('reserveStock is all-or-nothing: a failing line rolls back the earlier lines', async () => {
      const a = await repo.create(newProduct('AON-A', { stock: 5 }));
      const b = await repo.create(newProduct('AON-B', { stock: 0 }));
      const result = await repo.reserveStock([{ product_id: a.id, quantity: 2 }, { product_id: b.id, quantity: 1 }]);
      assert.deepEqual(result, { ok: false, failures: [{ product_id: b.id, reason: 'insufficient_stock' }] });
      assert.equal((await repo.getById(a.id)).stock, 5, 'stock of the first line must be restored');
    });

    it('reserveStock reports not_found and inactive, and merges duplicate lines', async () => {
      const a = await repo.create(newProduct('REAS-A', { stock: 3 }));
      assert.deepEqual((await repo.reserveStock([{ product_id: 555555, quantity: 1 }])).failures, [{ product_id: 555555, reason: 'not_found' }]);
      assert.equal((await repo.reserveStock([{ product_id: a.id, quantity: 2 }, { product_id: a.id, quantity: 2 }])).ok, false); // 4 > 3
      assert.equal((await repo.getById(a.id)).stock, 3);
      await repo.archive(a.id);
      assert.equal((await repo.reserveStock([{ product_id: a.id, quantity: 1 }])).failures[0].reason, 'inactive');
    });

    it('opposite-order concurrent orders do not deadlock (locks are taken in id order)', async () => {
      const a = await repo.create(newProduct('DL-A', { stock: 1000 }));
      const b = await repo.create(newProduct('DL-B', { stock: 1000 }));
      const orders = Array.from({ length: 60 }, (_, i) =>
        repo.reserveStock(i % 2 === 0
          ? [{ product_id: a.id, quantity: 1 }, { product_id: b.id, quantity: 1 }]
          : [{ product_id: b.id, quantity: 1 }, { product_id: a.id, quantity: 1 }]),
      );
      const results = await Promise.all(orders); // would reject with ER_LOCK_DEADLOCK without ordering/retry
      assert.ok(results.every((r) => r.ok));
      assert.equal((await repo.getById(a.id)).stock, 940);
      assert.equal((await repo.getById(b.id)).stock, 940);
    });

    it('releaseStock gives reserved units back', async () => {
      const { id } = await repo.create(newProduct('REL-1', { stock: 4 }));
      await repo.reserveStock([{ product_id: id, quantity: 3 }]);
      await repo.releaseStock([{ product_id: id, quantity: 3 }]);
      assert.equal((await repo.getById(id)).stock, 4);
    });
  });

  describe('categories and seed', () => {
    it('lists categories by name and rejects duplicates', async () => {
      await repo.createCategory('B', 'b');
      await repo.createCategory('A', 'a');
      assert.deepEqual((await repo.listCategories()).map((c) => c.name), ['A', 'B']);
      await assert.rejects(repo.createCategory('A', 'a-2'), (err) => err.status === 409);
      await assert.rejects(repo.createCategory('Other', 'a'), (err) => err.status === 409);
    });

    it('seed is idempotent', async () => {
      const first = await seed(pool);
      const second = await seed(pool);
      assert.equal(first.productsCreated, 12);
      assert.equal(second.productsCreated, 0);
      assert.equal((await repo.list({ ...filters, page_size: 100 })).total, 12);
      assert.equal((await repo.listCategories()).length, 4);
    });
  });

  it('ping succeeds', async () => {
    await repo.ping();
  });
});
