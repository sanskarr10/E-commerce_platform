import { HttpError, conflict, notFound } from './errors.js';
import { buildEnvelope } from './events/envelope.js';
import { PRODUCT_COLUMNS, PRODUCT_FROM, buildListQuery } from './queries.js';

const ER_DUP_ENTRY = 1062;
const ER_NO_REFERENCED_ROW = 1452;
const ER_LOCK_DEADLOCK = 1213;
const CONSUMER = 'product-service';

export function mapProduct(row) {
  return {
    id: Number(row.id),
    sku: row.sku,
    name: row.name,
    description: row.description,
    price_minor: row.price_minor,
    currency: row.currency,
    stock: row.stock,
    category:
      row.category_id === null
        ? null
        : { id: row.category_id, name: row.category_name, slug: row.category_slug },
    image_url: row.image_url,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const UPDATABLE = ['name', 'description', 'price_minor', 'currency', 'category_id', 'image_url', 'is_active'];

/** All MySQL access lives here. Every query binds its values as parameters. */
export class ProductRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  async list(filters) {
    const query = buildListQuery(filters);
    const [[countRow]] = await this.pool.query(query.countSql, query.countParams);
    const [rows] = await this.pool.query(query.listSql, query.listParams);
    return {
      items: rows.map(mapProduct),
      total: Number(countRow.total),
      page: filters.page,
      page_size: filters.page_size,
    };
  }

  async #fetch(id, { activeOnly = false } = {}) {
    const [rows] = await this.pool.query(
      `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id = ?${activeOnly ? ' AND p.is_active = 1' : ''}`,
      [id],
    );
    return rows.length > 0 ? mapProduct(rows[0]) : null;
  }

  /** Public read: archived products are invisible. */
  getById(id) {
    return this.#fetch(id, { activeOnly: true });
  }

  async findBySku(sku) {
    const [rows] = await this.pool.query('SELECT id FROM products WHERE sku = ?', [sku]);
    return rows.length > 0 ? this.#fetch(rows[0].id) : null;
  }

  #translate(err) {
    if (err?.errno === ER_DUP_ENTRY) return conflict('SKU already exists');
    if (err?.errno === ER_NO_REFERENCED_ROW) {
      return new HttpError(422, [{ loc: ['body', 'category_id'], msg: 'Category does not exist', type: 'value_error' }]);
    }
    return err;
  }

  async create(data) {
    try {
      const [result] = await this.pool.query(
        `INSERT INTO products (sku, name, description, price_minor, currency, stock, category_id, image_url, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.sku,
          data.name,
          data.description ?? null,
          data.price_minor,
          data.currency,
          data.stock,
          data.category_id ?? null,
          data.image_url ?? null,
          data.is_active ? 1 : 0,
        ],
      );
      return await this.#fetch(result.insertId);
    } catch (err) {
      throw this.#translate(err);
    }
  }

  async update(id, patch) {
    const columns = UPDATABLE.filter((column) => patch[column] !== undefined);
    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    const values = columns.map((column) => (column === 'is_active' ? (patch[column] ? 1 : 0) : patch[column]));
    try {
      const [result] = await this.pool.query(`UPDATE products SET ${assignments} WHERE id = ?`, [...values, id]);
      if (result.affectedRows === 0) throw notFound('Product');
      return await this.#fetch(id);
    } catch (err) {
      throw this.#translate(err);
    }
  }

  /** Soft delete: orders keep referencing the product id, so rows are never removed. */
  async archive(id) {
    const [result] = await this.pool.query('UPDATE products SET is_active = 0 WHERE id = ?', [id]);
    if (result.affectedRows === 0) throw notFound('Product');
  }

  /**
   * Atomic stock change. The check and the write are ONE statement, so two concurrent buyers
   * can never both take the last unit (no read-then-write race).
   */
  async adjustStock(id, delta) {
    const [result] = await this.pool.query(
      'UPDATE products SET stock = stock + ? WHERE id = ? AND stock + ? >= 0',
      [delta, id, delta],
    );
    if (result.affectedRows === 0) {
      if (!(await this.#fetch(id))) throw notFound('Product');
      throw conflict('Insufficient stock');
    }
    return this.#fetch(id);
  }

  async #transaction(work) {
    for (let attempt = 1; ; attempt += 1) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
      } catch (err) {
        await connection.rollback().catch(() => {});
        // Deadlocks are an expected, retryable outcome under contention.
        if (err?.errno === ER_LOCK_DEADLOCK && attempt < 3) continue;
        throw err;
      } finally {
        connection.release();
      }
    }
  }

  /** Batch lookup for the order service: active products only, unknown ids are simply absent. */
  async getManyByIds(ids) {
    if (ids.length === 0) return [];
    const [rows] = await this.pool.query(
      `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id IN (?) AND p.is_active = 1`,
      [ids],
    );
    return rows.map(mapProduct);
  }

  /**
   * Idempotent consumer step: records the event id in the SAME transaction as the effect.
   * A redelivery violates the primary key and is reported as a duplicate. In MySQL a duplicate-key
   * error does not abort the surrounding transaction, so the caller can simply return.
   */
  async #claimEvent(connection, eventId) {
    try {
      await connection.query('INSERT INTO inbox (event_id, consumer) VALUES (?, ?)', [eventId, CONSUMER]);
      return true;
    } catch (err) {
      if (err?.errno === ER_DUP_ENTRY) return false;
      throw err;
    }
  }

  async #emit(connection, event) {
    await connection.query('INSERT INTO outbox (id, event_type, payload) VALUES (?, ?, ?)', [
      event.id,
      event.type,
      JSON.stringify(event),
    ]);
  }

  /**
   * Saga step 1: hold stock for an order, all or nothing, and emit stock.reserved or stock.failed.
   * Everything happens in one transaction: inbox row, reservation row, stock updates and outbox row.
   * Lines are merged and locked in product-id order so two orders sharing products cannot deadlock.
   *
   * Returns { outcome: 'reserved' | 'failed' | 'duplicate' | 'already_handled', productIds }.
   */
  async reserveForOrder({ eventId, orderId, items, correlationId }) {
    const wanted = new Map();
    for (const { product_id: id, quantity } of items) wanted.set(id, (wanted.get(id) ?? 0) + quantity);
    const lines = [...wanted.entries()].sort(([a], [b]) => a - b).map(([product_id, quantity]) => ({ product_id, quantity }));

    return this.#transaction(async (connection) => {
      if (!(await this.#claimEvent(connection, eventId))) return { outcome: 'duplicate', productIds: [] };

      await connection.query('SAVEPOINT reserve');
      try {
        // The primary key makes "one reservation per order" a database guarantee. It also trips when
        // order.cancelled arrived first and left a tombstone, so a late order.created holds nothing.
        await connection.query('INSERT INTO stock_reservations (order_id, status, items) VALUES (?, ?, ?)', [
          orderId,
          'RESERVED',
          JSON.stringify(lines),
        ]);
      } catch (err) {
        if (err?.errno === ER_DUP_ENTRY) return { outcome: 'already_handled', productIds: [] };
        throw err;
      }

      for (const { product_id: id, quantity } of lines) {
        const [result] = await connection.query(
          'UPDATE products SET stock = stock - ? WHERE id = ? AND is_active = 1 AND stock >= ?',
          [quantity, id, quantity],
        );
        if (result.affectedRows === 1) continue;

        const [rows] = await connection.query('SELECT stock, is_active FROM products WHERE id = ?', [id]);
        let reason = 'insufficient_stock';
        if (rows.length === 0) reason = 'not_found';
        else if (!rows[0].is_active) reason = 'inactive';

        // Undo the reservation row and every earlier decrement for this order, keep the inbox row.
        await connection.query('ROLLBACK TO SAVEPOINT reserve');
        await connection.query('INSERT INTO stock_reservations (order_id, status, items) VALUES (?, ?, ?)', [
          orderId,
          'FAILED',
          JSON.stringify(lines),
        ]);
        await this.#emit(
          connection,
          buildEnvelope('stock.failed', { order_id: orderId, failures: [{ product_id: id, reason }] }, correlationId),
        );
        return { outcome: 'failed', productIds: [] };
      }

      await this.#emit(connection, buildEnvelope('stock.reserved', { order_id: orderId }, correlationId));
      return { outcome: 'reserved', productIds: lines.map((line) => line.product_id) };
    });
  }

  /**
   * Saga compensation: give the stock held for a cancelled order back, exactly once.
   * If no reservation exists yet (order.cancelled overtook order.created) a tombstone is written so
   * the late order.created cannot reserve stock for an order that is already dead.
   *
   * Returns { outcome: 'released' | 'nothing_to_release' | 'duplicate', productIds }.
   */
  async releaseForOrder({ eventId, orderId }) {
    return this.#transaction(async (connection) => {
      if (!(await this.#claimEvent(connection, eventId))) return { outcome: 'duplicate', productIds: [] };

      const [rows] = await connection.query('SELECT status, items FROM stock_reservations WHERE order_id = ? FOR UPDATE', [orderId]);
      if (rows.length === 0) {
        await connection.query('INSERT INTO stock_reservations (order_id, status, items) VALUES (?, ?, ?)', [orderId, 'CANCELLED', '[]']);
        return { outcome: 'nothing_to_release', productIds: [] };
      }
      if (rows[0].status !== 'RESERVED') return { outcome: 'nothing_to_release', productIds: [] };

      const lines = JSON.parse(rows[0].items);
      for (const { product_id: id, quantity } of lines) {
        await connection.query('UPDATE products SET stock = stock + ? WHERE id = ?', [quantity, id]);
      }
      await connection.query('UPDATE stock_reservations SET status = ? WHERE order_id = ?', ['RELEASED', orderId]);
      return { outcome: 'released', productIds: lines.map((line) => line.product_id) };
    });
  }

  async listCategories() {
    const [rows] = await this.pool.query('SELECT id, name, slug FROM categories ORDER BY name');
    return rows;
  }

  async createCategory(name, slug) {
    try {
      const [result] = await this.pool.query('INSERT INTO categories (name, slug) VALUES (?, ?)', [name, slug]);
      return { id: result.insertId, name, slug };
    } catch (err) {
      if (err?.errno === ER_DUP_ENTRY) throw conflict('Category already exists');
      throw err;
    }
  }
}
