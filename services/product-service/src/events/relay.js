import { setTimeout as sleep } from 'node:timers/promises';

const BATCH = 50;
const LEASE_SECONDS = 30;

/** MySQL side of the outbox: claim rows with a lease, then mark them published. */
export class MysqlOutboxStore {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Leases up to `limit` unpublished rows in seq order. SKIP LOCKED lets several replicas share
   * the table without blocking each other; the lease (claimed_until) lets a crashed relay's rows
   * be picked up again after LEASE_SECONDS.
   */
  async claim(limit = BATCH) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        `SELECT seq, id, event_type, payload FROM outbox
          WHERE published_at IS NULL AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(3))
          ORDER BY seq LIMIT ? FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (rows.length > 0) {
        await connection.query(
          'UPDATE outbox SET claimed_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND) WHERE seq IN (?)',
          [LEASE_SECONDS, rows.map((row) => row.seq)],
        );
      }
      await connection.commit();
      return rows;
    } catch (err) {
      await connection.rollback().catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  async markPublished(seqs) {
    if (seqs.length === 0) return;
    await this.pool.query('UPDATE outbox SET published_at = CURRENT_TIMESTAMP(3), claimed_until = NULL WHERE seq IN (?)', [seqs]);
  }

  /** Gives unpublished rows back immediately instead of waiting for the lease to expire. */
  async release(seqs) {
    if (seqs.length === 0) return;
    await this.pool.query('UPDATE outbox SET claimed_until = NULL WHERE seq IN (?) AND published_at IS NULL', [seqs]);
  }
}

/**
 * Publishes outbox rows to the broker in order.
 * A row is marked published only AFTER the broker confirmed it, so a crash in between means a
 * duplicate (which consumers drop via their inbox), never a lost event. On the first failure the
 * rest of the batch is released so order is preserved on the next pass.
 */
export class OutboxRelay {
  #running = false;
  #loop = null;
  #stopSignal = new AbortController();

  constructor({ store, publish, logger, intervalMs = 500 }) {
    this.store = store;
    this.publish = publish; // async (routingKey, bodyString, messageId) => resolves after broker confirm
    this.logger = logger;
    this.intervalMs = intervalMs;
  }

  /** One pass. Returns how many events were published. */
  async flush() {
    const rows = await this.store.claim();
    const done = [];
    try {
      for (const row of rows) {
        await this.publish(row.event_type, row.payload, row.id);
        done.push(row.seq);
      }
    } catch (err) {
      this.logger.warn('outbox publish failed, will retry', { error: err.message, published: done.length });
    } finally {
      await this.store.markPublished(done);
      await this.store.release(rows.map((row) => row.seq).filter((seq) => !done.includes(seq)));
    }
    return done.length;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#loop = (async () => {
      while (this.#running) {
        let published = 0;
        try {
          published = await this.flush();
        } catch (err) {
          this.logger.warn('outbox relay pass failed', { error: err.message });
        }
        // Keep draining while there is work; sleep only when idle or failing.
        if (published === 0) await sleep(this.intervalMs, undefined, { signal: this.#stopSignal.signal }).catch(() => {});
      }
    })();
  }

  async stop() {
    this.#running = false;
    this.#stopSignal.abort();
    await this.#loop;
  }
}
