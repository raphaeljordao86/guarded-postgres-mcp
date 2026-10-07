// PostgreSQL connection pool
import pg from 'pg';

let pool = null;

/** Non-negative integer from env, or the default. */
export function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Pool configuration. No client_encoding option on purpose: node-postgres
 * always talks UTF8 to the server, and the server converts from the database
 * encoding (LATIN1, WIN1252, ...) on its own. Forcing another client encoding
 * makes pg decode LATIN1 bytes as UTF-8 and corrupts accented text in both
 * directions. A SQL_ASCII database has no conversion at all (see README).
 */
export function buildPoolConfig(env) {
  const statementTimeout = intFromEnv(env, 'PG_STATEMENT_TIMEOUT_MS', 120000);
  return {
    host: env.PG_HOST,
    port: intFromEnv(env, 'PG_PORT', 5432),
    database: env.PG_DATABASE,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    application_name: env.PG_APPLICATION_NAME || 'guarded-postgres-mcp',
    max: 5,
    idleTimeoutMillis: 30000,
    // Without it, a call waits forever when the database is down.
    connectionTimeoutMillis: intFromEnv(env, 'PG_CONNECT_TIMEOUT_MS', 10000),
    // Server-side limit; the client-side one is a little longer so the server
    // cancels the statement first and the connection stays usable.
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout > 0 ? statementTimeout + 5000 : 0,
    // An ALTER TABLE waiting on a lock queues every ERP session behind it.
    lock_timeout: intFromEnv(env, 'PG_LOCK_TIMEOUT_MS', 5000),
    // PostgreSQL 9.6+. Set PG_IDLE_IN_TRANSACTION_TIMEOUT_MS=0 on older servers,
    // which reject the parameter at connection time.
    idle_in_transaction_session_timeout: intFromEnv(env, 'PG_IDLE_IN_TRANSACTION_TIMEOUT_MS', 60000),
  };
}

export function getPool(env) {
  if (pool) return pool;

  pool = new pg.Pool(buildPoolConfig(env));

  // pg-pool emits 'error' when an idle connection drops (database restart,
  // network hiccup). Without a listener Node.js would end the MCP process.
  pool.on('error', e => {
    console.error('[db] idle connection error:', e.message);
  });

  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
