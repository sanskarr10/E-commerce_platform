import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  categorySchema,
  createProductSchema,
  idSchema,
  listQuerySchema,
  slugify,
  stockSchema,
  updateProductSchema,
} from '../src/validation.js';

const ok = (schema, value) => {
  const result = schema.safeParse(value);
  assert.ok(result.success, `expected valid: ${JSON.stringify(value)} -> ${result.error?.message}`);
  return result.data;
};
const bad = (schema, value) => {
  assert.equal(schema.safeParse(value).success, false, `expected invalid: ${JSON.stringify(value)}`);
};

describe('listQuerySchema', () => {
  it('applies defaults', () => {
    const data = ok(listQuerySchema, {});
    assert.equal(data.sort, 'newest');
    assert.equal(data.page, 1);
    assert.equal(data.page_size, 20);
  });

  it('coerces query-string values', () => {
    const data = ok(listQuerySchema, { page: '2', page_size: '50', min_price: '100', in_stock: 'true', q: '  shoe  ' });
    assert.equal(data.page, 2);
    assert.equal(data.page_size, 50);
    assert.equal(data.min_price, 100);
    assert.equal(data.in_stock, true);
    assert.equal(data.q, 'shoe');
  });

  it('treats an empty search box as no search', () => {
    assert.equal(ok(listQuerySchema, { q: '   ' }).q, undefined);
  });

  it('rejects out-of-range and malformed values', () => {
    bad(listQuerySchema, { page: '0' });
    bad(listQuerySchema, { page_size: '101' });
    bad(listQuerySchema, { page_size: 'abc' });
    bad(listQuerySchema, { min_price: '-1' });
    bad(listQuerySchema, { in_stock: 'yes' });
    bad(listQuerySchema, { sort: 'random' });
    bad(listQuerySchema, { category: 'Not A Slug' });
    bad(listQuerySchema, { q: 'x'.repeat(101) });
    bad(listQuerySchema, { q: ['a', 'b'] }); // ?q=a&q=b
  });

  it('rejects an inverted price range', () => {
    bad(listQuerySchema, { min_price: '500', max_price: '100' });
    ok(listQuerySchema, { min_price: '100', max_price: '100' });
  });
});

describe('createProductSchema', () => {
  const valid = { sku: 'ABC-1', name: 'Thing', price_minor: 1000 };

  it('accepts the minimum and the full form', () => {
    ok(createProductSchema, valid);
    ok(createProductSchema, {
      ...valid, description: null, currency: 'USD', stock: 5, category_id: 2, image_url: 'https://cdn.example.com/a.png', is_active: false,
    });
  });

  it('requires sku, name and price', () => {
    bad(createProductSchema, { name: 'x', price_minor: 1 });
    bad(createProductSchema, { sku: 'x', price_minor: 1 });
    bad(createProductSchema, { sku: 'x', name: 'x' });
  });

  it('rejects bad numbers and codes', () => {
    bad(createProductSchema, { ...valid, price_minor: -1 });
    bad(createProductSchema, { ...valid, price_minor: 10.5 });
    bad(createProductSchema, { ...valid, price_minor: '1000' });
    bad(createProductSchema, { ...valid, stock: -1 });
    bad(createProductSchema, { ...valid, currency: 'inr' });
    bad(createProductSchema, { ...valid, sku: 'has space' });
  });

  it('only allows http(s) image URLs', () => {
    bad(createProductSchema, { ...valid, image_url: 'javascript:alert(1)' });
    bad(createProductSchema, { ...valid, image_url: 'data:text/html,<script>1</script>' });
    bad(createProductSchema, { ...valid, image_url: 'not a url' });
    ok(createProductSchema, { ...valid, image_url: 'http://localhost/a.png' });
  });

  it('rejects unknown fields instead of silently ignoring them', () => {
    bad(createProductSchema, { ...valid, role: 'admin' });
    bad(createProductSchema, { ...valid, id: 99 });
  });
});

describe('updateProductSchema', () => {
  it('accepts a partial body and applies NO defaults', () => {
    const data = ok(updateProductSchema, { price_minor: 500 });
    assert.deepEqual(data, { price_minor: 500 }); // currency must not be reset to a default
  });

  it('rejects an empty body, immutable sku, and direct stock writes', () => {
    bad(updateProductSchema, {});
    bad(updateProductSchema, { sku: 'NEW-SKU' });
    bad(updateProductSchema, { stock: 100 });
  });

  it('allows clearing nullable fields', () => {
    ok(updateProductSchema, { description: null, image_url: null, category_id: null });
  });
});

describe('stockSchema', () => {
  it('requires a non-zero integer delta', () => {
    ok(stockSchema, { delta: 5 });
    ok(stockSchema, { delta: -5 });
    bad(stockSchema, { delta: 0 });
    bad(stockSchema, { delta: 1.5 });
    bad(stockSchema, { delta: '5' });
    bad(stockSchema, {});
    bad(stockSchema, { delta: 1, extra: true });
  });
});

describe('idSchema', () => {
  it('accepts positive integers only', () => {
    assert.equal(ok(idSchema, '42'), 42);
    for (const value of ['0', '-1', '1.5', '1e3', 'abc', '', ' 1', '01', '9'.repeat(20)]) bad(idSchema, value);
  });
});

describe('categorySchema and slugify', () => {
  it('validates names', () => {
    ok(categorySchema, { name: 'Home & Kitchen' });
    bad(categorySchema, { name: '' });
    bad(categorySchema, { name: 'x'.repeat(101) });
  });

  it('builds URL-safe slugs', () => {
    assert.equal(slugify('Home & Kitchen'), 'home-kitchen');
    assert.equal(slugify('  Café Au Lait!! '), 'cafe-au-lait');
    assert.equal(slugify('---'), '');
    assert.equal(slugify('कपड़े'), ''); // no Latin letters: the service rejects empty slugs
  });
});
