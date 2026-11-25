// Needs a PostgreSQL server. The database name must contain "test": this suite drops its tables.
//   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/notifications_test npm run test:integration
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { ensureDatabase, runMigrations } from '../../src/migrate.js';
import { NotificationRepository } from '../../src/repository.js';
import { createLogger } from '../../src/logger.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ ? 'TEST_DATABASE_URL is not set' : false;
const silent = createLogger({ silent: true });

describe('postgres repository', { skip }, () => {
  let pool;
  let repo;
  const user = randomUUID();
  const other = randomUUID();
  const make = (over = {}) => ({
    userId: user, userEmail: 'asha@example.com', type: 'order.confirmed', orderId: randomUUID(), title: 'T', body: 'B', ...over,
  });

  before(async () => {
    const name = decodeURIComponent(new URL(URL_).pathname.slice(1));
    assert.match(name, /test/, 'refusing to run destructively on a database whose name has no "test"');
    await ensureDatabase(URL_, silent);
    const setup = new pg.Pool({ connectionString: URL_ });
    await setup.query('DROP TABLE IF EXISTS notifications, schema_migrations CASCADE');
    await setup.end();
    await runMigrations(URL_, { logger: silent });
    pool = new pg.Pool({ connectionString: URL_, max: 20 });
    repo = new NotificationRepository(pool);
  });
  after(() => pool?.end());

  it('migrations are idempotent and safe to run concurrently', async () => {
    assert.deepEqual(await runMigrations(URL_, { logger: silent }), []);
    await Promise.all([runMigrations(URL_, { logger: silent }), runMigrations(URL_, { logger: silent })]);
    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    assert.deepEqual(rows.map((r) => r.version), ['001_notifications.sql']);
  });

  it('ensureDatabase is a no-op when the database exists', async () => {
    await ensureDatabase(URL_, silent);
  });

  it('ensureDatabase refuses an unsafe database name', async () => {
    const bad = new URL(URL_);
    bad.pathname = '/x;drop table y';
    await assert.rejects(() => ensureDatabase(bad.toString(), silent), /Unsafe database name/);
  });

  it('creates a notification once per (order, type), however many times the event arrives', async () => {
    const input = make();
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.createNotification(input)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.notification.id)).size, 1);
    const other = await repo.createNotification({ ...input, type: 'order.shipped' });
    assert.equal(other.created, true);
  });

  it('exactly one of many concurrent workers wins the email claim', async () => {
    const { notification } = await repo.createNotification(make());
    const claims = await Promise.all(Array.from({ length: 10 }, () => repo.claimEmail(notification.id, 120)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.find(Boolean).email_status, 'sending');
  });

  it('a claim is retaken after the lease expires, not before', async () => {
    const { notification } = await repo.createNotification(make());
    assert.ok(await repo.claimEmail(notification.id, 120));
    assert.equal(await repo.claimEmail(notification.id, 120), null);
    await pool.query("UPDATE notifications SET email_claimed_at = now() - interval '3 minutes' WHERE id = $1", [notification.id]);
    assert.ok(await repo.claimEmail(notification.id, 120));
  });

  it('a sent email cannot be claimed again', async () => {
    const { notification } = await repo.createNotification(make());
    await repo.claimEmail(notification.id, 120);
    await repo.setEmailStatus(notification.id, 'sent');
    assert.equal(await repo.claimEmail(notification.id, 0), null);
  });

  it('releasing a failed attempt returns it to pending and records the error', async () => {
    const { notification } = await repo.createNotification(make());
    await repo.claimEmail(notification.id, 120);
    await repo.setEmailStatus(notification.id, 'pending', 'x'.repeat(900));
    const { rows } = await pool.query('SELECT email_status, email_error, email_claimed_at FROM notifications WHERE id = $1', [notification.id]);
    assert.equal(rows[0].email_status, 'pending');
    assert.equal(rows[0].email_error.length, 500);
    assert.equal(rows[0].email_claimed_at, null);
    assert.ok(await repo.claimEmail(notification.id, 120));
  });

  it('rejects an invalid email status at the database level', async () => {
    const { notification } = await repo.createNotification(make());
    await assert.rejects(() => repo.setEmailStatus(notification.id, 'bogus'), /check constraint/);
  });

  it('lists only my notifications, newest first, with paging and unread counts', async () => {
    const me = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      await repo.createNotification(make({ userId: me, title: `n${i}` }));
      await new Promise((r) => setTimeout(r, 5));
    }
    await repo.createNotification(make({ userId: randomUUID() }));
    const first = await repo.list(me, { page: 1, pageSize: 2 });
    assert.deepEqual(first.items.map((n) => n.title), ['n4', 'n3']);
    assert.equal(first.total, 5);
    assert.equal(first.unread, 5);
    assert.deepEqual((await repo.list(me, { page: 3, pageSize: 2 })).items.map((n) => n.title), ['n0']);
  });

  it('marks read only for the owner, and read-all counts what it changed', async () => {
    const me = randomUUID();
    const a = (await repo.createNotification(make({ userId: me }))).notification;
    await repo.createNotification(make({ userId: me }));
    assert.equal(await repo.markRead(other, a.id), null);
    const read = await repo.markRead(me, a.id);
    assert.ok(read.read_at);
    assert.equal((await repo.markRead(me, a.id)).read_at.getTime(), read.read_at.getTime());
    assert.equal((await repo.list(me, { unreadOnly: true })).total, 1);
    assert.equal(await repo.markAllRead(me), 1);
    assert.equal(await repo.markAllRead(me), 0);
  });

  it('counts emails that are still open', async () => {
    const before = await repo.countOpenEmails();
    const { notification } = await repo.createNotification(make());
    assert.equal(await repo.countOpenEmails(), before + 1);
    await repo.setEmailStatus(notification.id, 'sent');
    assert.equal(await repo.countOpenEmails(), before);
  });

  it('pings', async () => {
    await repo.ping();
  });
});
