// Quick connection check. Run: npm run test-conn
// Loads the same .env as the server (or GUARD_ENV_FILE).
import { loadEnv } from './env.js';
import { getPool, closePool } from './db.js';

try {
  loadEnv();
} catch (e) {
  console.error(`[test-conn] ${e.message}`);
  process.exit(1);
}

const env = process.env;

console.log('[test-conn] connecting to', `${env.PG_HOST || 'localhost'}:${env.PG_PORT || '5432'}`);

try {
  const pool = getPool(env);
  const r = await pool.query(
    "SELECT current_database() AS db, current_user AS usr, now() AS ts, version() AS ver, " +
      "current_setting('server_encoding') AS server_encoding"
  );
  console.log('[test-conn] OK:', r.rows[0]);

  const r2 = await pool.query(
    'SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = current_schema()'
  );
  console.log('[test-conn] tables in current schema:', r2.rows[0]);

  await closePool();
} catch (e) {
  console.error('[test-conn] FAILED:', e.message);
  process.exit(1);
}
