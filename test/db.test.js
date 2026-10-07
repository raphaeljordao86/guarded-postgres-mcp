// Pool configuration (no database needed: pg.Pool does not connect until used).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolConfig, getPool, closePool, intFromEnv } from '../src/db.js';

test('pool config sets the timeouts and the application name', () => {
  const c = buildPoolConfig({ PG_HOST: 'db', PG_PORT: '5433' });
  assert.equal(c.host, 'db');
  assert.equal(c.port, 5433);
  assert.equal(c.application_name, 'guarded-postgres-mcp');
  assert.equal(c.connectionTimeoutMillis, 10000);
  assert.equal(c.lock_timeout, 5000);
  assert.equal(c.statement_timeout, 120000);
  assert.ok(c.query_timeout > c.statement_timeout, 'the server must time out first');
  assert.equal(c.idle_in_transaction_session_timeout, 60000);
});

test('timeouts come from env, and 0 turns one off', () => {
  const c = buildPoolConfig({
    PG_LOCK_TIMEOUT_MS: '2000',
    PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
    PG_STATEMENT_TIMEOUT_MS: '0',
  });
  assert.equal(c.lock_timeout, 2000);
  assert.equal(c.idle_in_transaction_session_timeout, 0);
  assert.equal(c.statement_timeout, 0);
  assert.equal(c.query_timeout, 0);
});

test('no client_encoding is ever set (node-postgres only speaks UTF8)', () => {
  // Setting client_encoding to LATIN1 on the connection makes pg decode LATIN1
  // bytes as UTF-8 and corrupt accented text, so there is no setting for it:
  // even a PG_CLIENT_ENCODING variable in the environment is ignored.
  const c = buildPoolConfig({ PG_CLIENT_ENCODING: 'LATIN1' });
  assert.equal(JSON.stringify(c).includes('LATIN1'), false);
  assert.equal('client_encoding' in c, false);
});

test('invalid numbers fall back to the default', () => {
  assert.equal(intFromEnv({ X: 'abc' }, 'X', 7), 7);
  assert.equal(intFromEnv({ X: '-1' }, 'X', 7), 7);
  assert.equal(intFromEnv({ X: '1.5' }, 'X', 7), 7);
  assert.equal(intFromEnv({}, 'X', 7), 7);
  assert.equal(intFromEnv({ X: '12' }, 'X', 7), 12);
});

test('the pool has an error listener, so a dropped idle connection does not kill the process', async () => {
  const pool = getPool({ PG_HOST: '127.0.0.1', PG_PORT: '1' });
  try {
    assert.ok(pool.listenerCount('error') > 0);
  } finally {
    await closePool();
  }
});
