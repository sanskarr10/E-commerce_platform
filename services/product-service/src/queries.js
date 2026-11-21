export const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.description, p.price_minor, p.currency, p.stock,
  p.image_url, p.is_active, p.created_at, p.updated_at,
  c.id AS category_id, c.name AS category_name, c.slug AS category_slug`;

export const PRODUCT_FROM = 'FROM products p LEFT JOIN categories c ON c.id = p.category_id';

// ORDER BY comes from this whitelist, never from user input. Every sort ends in p.id so that
// pagination is stable when the primary sort key ties.
const SORTS = {
  newest: 'p.created_at DESC, p.id DESC',
  price_asc: 'p.price_minor ASC, p.id ASC',
  price_desc: 'p.price_minor DESC, p.id DESC',
  name: 'p.name ASC, p.id ASC',
};

/** Escape LIKE wildcards so a search for "50%" matches the text "50%", not "50 anything". */
export function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds the catalog search query. Pure function: returns SQL and parameters, touches no
 * database, so it is unit-tested directly. Values are always bound as parameters.
 */
export function buildListQuery(filters) {
  const where = ['p.is_active = 1'];
  const params = [];

  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(pattern, pattern);
  }
  if (filters.category) {
    where.push('c.slug = ?');
    params.push(filters.category);
  }
  if (filters.min_price !== null && filters.min_price !== undefined) {
    where.push('p.price_minor >= ?');
    params.push(filters.min_price);
  }
  if (filters.max_price !== null && filters.max_price !== undefined) {
    where.push('p.price_minor <= ?');
    params.push(filters.max_price);
  }
  if (filters.in_stock) {
    where.push('p.stock > 0');
  }

  const fromWhere = `${PRODUCT_FROM} WHERE ${where.join(' AND ')}`;
  return {
    countSql: `SELECT COUNT(*) AS total ${fromWhere}`,
    countParams: params,
    listSql: `SELECT ${PRODUCT_COLUMNS} ${fromWhere} ORDER BY ${SORTS[filters.sort] ?? SORTS.newest} LIMIT ? OFFSET ?`,
    listParams: [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  };
}
