const COLUMNS = 'id, user_id, user_email, type, order_id, title, body, email_status, email_error, created_at, read_at';

/** PostgreSQL storage. Every statement is parameterised; user input never reaches the SQL text. */
export class NotificationRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  /**
   * Inserts the notification unless one already exists for (order, type).
   * Returns { notification, created } so callers can tell a first delivery from a duplicate.
   */
  async createNotification({ userId, userEmail, type, orderId, title, body }) {
    const inserted = await this.pool.query(
      `INSERT INTO notifications (user_id, user_email, type, order_id, title, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (order_id, type) DO NOTHING
       RETURNING ${COLUMNS}`,
      [userId, userEmail ?? null, type, orderId, title, body],
    );
    if (inserted.rows[0]) return { notification: inserted.rows[0], created: true };
    const existing = await this.pool.query(`SELECT ${COLUMNS} FROM notifications WHERE order_id = $1 AND type = $2`, [
      orderId,
      type,
    ]);
    return { notification: existing.rows[0], created: false };
  }

  /**
   * Takes the right to send the email: pending rows, or rows whose previous attempt died
   * (claimed longer ago than the lease). Exactly one concurrent caller gets the row.
   */
  async claimEmail(id, leaseSeconds) {
    const result = await this.pool.query(
      `UPDATE notifications
          SET email_status = 'sending', email_claimed_at = now()
        WHERE id = $1
          AND (email_status = 'pending'
               OR (email_status = 'sending' AND email_claimed_at < now() - make_interval(secs => $2)))
        RETURNING ${COLUMNS}`,
      [id, leaseSeconds],
    );
    return result.rows[0] ?? null;
  }

  /** status: 'sent' | 'failed' | 'skipped' | 'pending' (released for a retry). */
  async setEmailStatus(id, status, error = null) {
    await this.pool.query(
      `UPDATE notifications SET email_status = $2, email_error = $3, email_claimed_at = NULL WHERE id = $1`,
      [id, status, error ? String(error).slice(0, 500) : null],
    );
  }

  async list(userId, { unreadOnly = false, page = 1, pageSize = 20 } = {}) {
    const where = unreadOnly ? 'user_id = $1 AND read_at IS NULL' : 'user_id = $1';
    const [rows, total, unread] = await Promise.all([
      this.pool.query(
        `SELECT ${COLUMNS} FROM notifications WHERE ${where} ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
        [userId, pageSize, (page - 1) * pageSize],
      ),
      this.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE ${where}`, [userId]),
      this.pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]),
    ]);
    return { items: rows.rows, total: total.rows[0].n, unread: unread.rows[0].n };
  }

  /** Only the owner can mark a notification read; someone else's id looks like a missing one. */
  async markRead(userId, id) {
    const result = await this.pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
      [id, userId],
    );
    return result.rows[0] ?? null;
  }

  async markAllRead(userId) {
    const result = await this.pool.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    return result.rowCount;
  }

  /** Emails not yet sent: a growing number means SMTP trouble. Exposed as a metric. */
  async countOpenEmails() {
    const result = await this.pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE email_status IN ('pending', 'sending')",
    );
    return result.rows[0].n;
  }
}
