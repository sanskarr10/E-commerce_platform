import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_NAME = 'product_service_migrations';

/**
 * Applies pending .sql files in filename order and records them in schema_migrations.
 * A MySQL advisory lock makes it safe for several replicas to start at the same time.
 * Returns the list of versions applied by this call.
 */
export async function runMigrations(connectionOptions, { dir = DEFAULT_DIR, logger = createLogger() } = {}) {
  const connection = await mysql.createConnection({ ...connectionOptions, multipleStatements: true });
  const applied = [];
  try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 60) AS acquired', [LOCK_NAME]);
    if (lock.acquired !== 1) throw new Error('Could not acquire the migration lock within 60 seconds');

    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(100) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);
    const [rows] = await connection.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((row) => row.version));

    const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      logger.info(`applying migration ${file}`);
      await connection.query(readFileSync(path.join(dir, file), 'utf8'));
      await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      applied.push(file);
    }
    if (applied.length === 0) logger.info('database schema is up to date');
    return applied;
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    await connection.end();
  }
}

// Run directly: `node src/migrate.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mysql: db } = loadConfig();
  runMigrations({ host: db.host, port: db.port, user: db.user, password: db.password, database: db.database }).catch(
    (err) => {
      console.error(`migration failed: ${err.message}`);
      process.exit(1);
    },
  );
}
