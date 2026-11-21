import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildListQuery, escapeLike } from '../src/queries.js';

const base = { q: null, category: null, min_price: null, max_price: null, in_stock: false, sort: 'newest', page: 1, page_size: 20 };
const placeholders = (sql) => (sql.match(/\?/g) ?? []).length;

describe('buildListQuery', () => {
  it('only shows active products and paginates by default', () => {
    const query = buildListQuery(base);
    assert.match(query.listSql, /WHERE p\.is_active = 1 ORDER BY p\.created_at DESC, p\.id DESC LIMIT \? OFFSET \?/);
    assert.deepEqual(query.listParams, [20, 0]);
    assert.deepEqual(query.countParams, []);
  });

  it('adds each filter as a bound parameter, never inline', () => {
    const query = buildListQuery({ ...base, q: 'shoe', category: 'footwear', min_price: 100, max_price: 900, in_stock: true });
    assert.match(query.listSql, /p\.name LIKE \? OR p\.description LIKE \?/);
    assert.match(query.listSql, /c\.slug = \?/);
    assert.match(query.listSql, /p\.price_minor >= \?/);
    assert.match(query.listSql, /p\.price_minor <= \?/);
    assert.match(query.listSql, /p\.stock > 0/);
    assert.deepEqual(query.countParams, ['%shoe%', '%shoe%', 'footwear', 100, 900]);
    assert.ok(!query.listSql.includes('shoe') && !query.listSql.includes('footwear'));
  });

  it('keeps zero as a real price bound (not treated as "no filter")', () => {
    const query = buildListQuery({ ...base, min_price: 0, max_price: 0 });
    assert.deepEqual(query.countParams, [0, 0]);
  });

  it('computes the offset from page and page size', () => {
    assert.deepEqual(buildListQuery({ ...base, page: 3, page_size: 25 }).listParams, [25, 50]);
  });

  it('every placeholder has exactly one parameter', () => {
    const filters = { ...base, q: 'a', category: 'b', min_price: 1, max_price: 2, in_stock: true, page: 2 };
    const query = buildListQuery(filters);
    assert.equal(placeholders(query.countSql), query.countParams.length);
    assert.equal(placeholders(query.listSql), query.listParams.length);
  });

  it('every sort ends with the id for stable pagination, and unknown sorts fall back', () => {
    for (const sort of ['newest', 'price_asc', 'price_desc', 'name']) {
      assert.match(buildListQuery({ ...base, sort }).listSql, /ORDER BY [^L]*p\.id (ASC|DESC) LIMIT/);
    }
    const hostile = buildListQuery({ ...base, sort: 'id; DROP TABLE products; --' });
    assert.match(hostile.listSql, /ORDER BY p\.created_at DESC, p\.id DESC/);
    assert.ok(!hostile.listSql.includes('DROP'));
  });
});

describe('escapeLike', () => {
  it('escapes wildcard characters and backslashes', () => {
    assert.equal(escapeLike('50%'), '50\\%');
    assert.equal(escapeLike('a_b'), 'a\\_b');
    assert.equal(escapeLike('c:\\dir'), 'c:\\\\dir');
    assert.equal(escapeLike('plain'), 'plain');
  });

  it('is applied to search text before it becomes a pattern', () => {
    assert.deepEqual(buildListQuery({ ...base, q: '100%_' }).countParams, ['%100\\%\\_%', '%100\\%\\_%']);
  });
});
