import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { createLogger } from './logger.js';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_KEY = 7_105_001; // arbitrary constant: all replicas contend for the same advisory lock

/**
 * Creates the database if it does not exist yet. docker-entrypoint init scripts only run on a brand new
 * volume, so a stack that was started in an earlier phase would otherwise have no notifications_db.
 */
export async function ensureDatabase(databaseUrl, logger = createLogger(), { makeClient = (connectionString) => new pg.Client({ connectionString }) } = {}) {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe database name "${name}"`);
  url.pathname = '/postgres';
  const admin = makeClient(url.toString());
  await admin.connect();
  try {
    const exists = async () => (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
    // Replicas starting together all try to create it. PostgreSQL reports the loser of that race in
    // different ways (42P04 already exists, 23505 duplicate catalog row, 55006 template in use),
    // so any of them is fine as long as the database exists afterwards.
    const RACE_CODES = new Set(['42P04', '23505', '55006']);
    for (let attempt = 1; !(await exists()); attempt += 1) {
      try {
        await admin.query(`CREATE DATABASE ${name}`); // identifier validated above; it cannot be a bind parameter
        logger.info(`created database ${name}`);
      } catch (err) {
        if (!RACE_CODES.has(err.code) || attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
}

/** Applies pending .sql files in filename order. An advisory lock makes concurrent replicas safe. */
export async function runMigrations(databaseUrl, { dir = DEFAULT_DIR, logger = createLogger() } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      logger.info(`applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(file);
    }
    if (applied.length === 0) logger.info('database schema is up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Only the database is needed here (no JWT key, no broker), so this can run as an init step anywhere.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('migration failed: DATABASE_URL is not set');
    process.exit(1);
  }
  ensureDatabase(databaseUrl)
    .then(() => runMigrations(databaseUrl))
    .catch((err) => {
      console.error(`migration failed: ${err.message}`);
      process.exit(1);
    });
}
