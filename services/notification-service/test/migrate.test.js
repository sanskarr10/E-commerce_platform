import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ensureDatabase } from '../src/migrate.js';
import { silent } from './helpers.js';

/** A scripted stand-in for the admin connection. `existsAfter` says when the database appears. */
function fakeAdmin({ createErrors = [], existsAfterCreateAttempts = 1 }) {
  const state = { creates: 0, ended: false };
  return {
    state,
    client: {
      async connect() {},
      async end() { state.ended = true; },
      async query(sql) {
        if (sql.startsWith('SELECT 1 FROM pg_database')) return { rowCount: state.creates >= existsAfterCreateAttempts ? 1 : 0 };
        state.creates += 1;
        const err = createErrors.shift();
        if (err) throw Object.assign(new Error(err.message ?? 'x'), { code: err.code });
        return {};
      },
    },
  };
}
const URL_OK = 'postgresql://u:p@db/notifications_db';
const run = (admin) => ensureDatabase(URL_OK, silent, { makeClient: () => admin.client });

describe('ensureDatabase', () => {
  it('creates the database when missing and closes the connection', async () => {
    const admin = fakeAdmin({});
    await run(admin);
    assert.equal(admin.state.creates, 1);
    assert.ok(admin.state.ended);
  });
  it('does nothing when it exists already', async () => {
    const admin = fakeAdmin({ existsAfterCreateAttempts: 0 });
    await run(admin);
    assert.equal(admin.state.creates, 0);
  });
  for (const code of ['42P04', '23505', '55006']) {
    it(`treats ${code} (another replica won the race) as success once the database exists`, async () => {
      const admin = fakeAdmin({ createErrors: [{ code }] });
      await run(admin);
      assert.equal(admin.state.creates, 1);
    });
  }
  it('retries a transient race and then gives up with the real error', async () => {
    const admin = fakeAdmin({ createErrors: Array.from({ length: 10 }, () => ({ code: '55006' })), existsAfterCreateAttempts: 99 });
    await assert.rejects(() => run(admin), (err) => err.code === '55006');
    assert.equal(admin.state.creates, 5);
    assert.ok(admin.state.ended);
  });
  it('does not swallow unrelated errors', async () => {
    const admin = fakeAdmin({ createErrors: [{ code: '42501', message: 'permission denied to create database' }] });
    await assert.rejects(() => run(admin), /permission denied/);
  });
  it('rejects unsafe database names before connecting', async () => {
    let connected = false;
    await assert.rejects(
      () => ensureDatabase('postgresql://u:p@db/x%3Bdrop', silent, { makeClient: () => { connected = true; return {}; } }),
      /Unsafe database name/,
    );
    assert.equal(connected, false);
  });
});
