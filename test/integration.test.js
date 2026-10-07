// The tools against a real PostgreSQL. Skipped unless GUARD_TEST_DATABASE_URL
// points at a DISPOSABLE database: the tests create and drop a schema, a
// snapshot table in the default schema and, if allowed, a LATIN1 database.
//
//   GUARD_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
//
// CI runs them against a postgres service container (.github/workflows/test.yml).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { callTool } from '../src/tools.js';
import { buildPoolConfig } from '../src/db.js';

const DATABASE_URL = process.env.GUARD_TEST_DATABASE_URL;
const skip = DATABASE_URL ? false : 'GUARD_TEST_DATABASE_URL is not set (point it at a disposable database)';

const S = `guard_it_${process.pid}`;
const ENV = { GUARD_LEGACY_TABLE_PREFIX: 'tab_', GUARD_LEGACY_SEQUENCE_PREFIX: 'gen_' };
const snapshots = [];
let pool;

// max: 1, so every tool call and every check below share one connection: any
// state a tool leaks (aborted transaction, SET, lock) shows up in the next call.
const newPool = url => new pg.Pool({ ...buildPoolConfig({}), connectionString: url, max: 1 });
const call = (name, args, extra = {}) => callTool({ env: { ...ENV, ...extra }, getPool: () => pool }, name, args);
const textOf = res => res.content[0].text;
const one = async sql => (await pool.query(sql)).rows[0];
const count = async () => (await one(`SELECT count(*)::int AS n FROM ${S}.tab_reading`)).n;

before(async () => {
  if (skip) return;
  pool = newPool(DATABASE_URL);
  await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  await pool.query(`CREATE SCHEMA ${S}`);
  // Legacy style: no default on the key, a standalone sequence the application calls.
  await pool.query(`CREATE SEQUENCE ${S}.gen_reading`);
  await pool.query(`CREATE TABLE ${S}.tab_reading (reading_id integer PRIMARY KEY, quantity numeric NOT NULL)`);
  await pool.query(`INSERT INTO ${S}.tab_reading SELECT nextval('${S}.gen_reading'), g FROM generate_series(1, 5) g`);
  // Modern style: serial column.
  await pool.query(`CREATE TABLE ${S}.tab_serial (id serial PRIMARY KEY, note text)`);
  await pool.query(`INSERT INTO ${S}.tab_serial (note) SELECT 'n' || g FROM generate_series(1, 3) g`);
});

after(async () => {
  if (skip) return;
  for (const name of snapshots) await pool.query(`DROP TABLE IF EXISTS ${name}`);
  await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  await pool.end();
});

test('the extended protocol refuses a second statement (what every tool relies on)', { skip }, async () => {
  const client = await pool.connect();
  try {
    await assert.rejects(
      client.query({ text: 'SELECT 1; SELECT 2', queryMode: 'extended' }),
      /cannot insert multiple commands into a prepared statement/
    );
  } finally {
    client.release();
  }
});

test('query reads rows and caps them', { skip }, async () => {
  const r = await call('query', { sql: `SELECT reading_id FROM ${S}.tab_reading ORDER BY reading_id` }, { GUARD_QUERY_MAX_ROWS: '2' });
  assert.equal(r.isError, undefined, textOf(r));
  const p = JSON.parse(textOf(r));
  assert.deepEqual(p.rows, [{ reading_id: 1 }, { reading_id: 2 }]);
  assert.equal(p.summary.truncated, true);
  assert.deepEqual(p.summary.cols, ['reading_id']);
});

test('query: the READ ONLY transaction refuses a write hidden in a function call', { skip }, async () => {
  const seqBefore = await one(`SELECT last_value::text AS v FROM ${S}.gen_reading`);
  const r = await call('query', { sql: `SELECT nextval('${S}.gen_reading')` });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /read-only transaction/);
  assert.deepEqual(await one(`SELECT last_value::text AS v FROM ${S}.gen_reading`), seqBefore);
});

test('query: session changes are rolled back with the transaction', { skip }, async () => {
  const before = (await one('SHOW search_path')).search_path;
  const r = await call('query', { sql: "SELECT set_config('search_path', 'nowhere', false)" });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal((await one('SHOW search_path')).search_path, before);
});

test('write tools: session changes made through functions do not reach the next call', { skip }, async () => {
  const session = () =>
    one("SELECT pg_backend_pid() AS pid, current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout");
  const before = await session();
  const temp = `guard_it_leak_${process.pid}`;
  const r = await call('execute_transaction', {
    statements: [
      "SELECT set_config('search_path', 'nowhere', false)",
      "SELECT set_config('statement_timeout', '0', false)",
      `CREATE TEMP TABLE ${temp} AS SELECT 1 AS n`,
    ],
    description: 'session state through functions',
  });
  assert.equal(r.isError, undefined, textOf(r));
  // Same connection (max: 1), back to the pool's own settings (statement_timeout
  // is a startup parameter, so DISCARD ALL returns to it), temporary table gone.
  assert.deepEqual(await session(), before);
  assert.equal((await one(`SELECT to_regclass('${temp}') IS NULL AS gone`)).gone, true);
});

test('execute: a failed statement leaves the connection usable', { skip }, async () => {
  const r = await call('execute', {
    sql: `UPDATE ${S}.tab_reading SET quantity = quantity / 0 WHERE reading_id = 1`,
    description: 'division by zero',
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /division by zero/);
  const q = await call('query', { sql: 'SELECT 1 AS ok' });
  assert.equal(q.isError, undefined, textOf(q));
});

test('execute: the row limit rolls back a large UPDATE', { skip }, async () => {
  const sum = async () => (await one(`SELECT sum(quantity)::text AS s FROM ${S}.tab_reading`)).s;
  const before = await sum();
  const r = await call(
    'execute',
    { sql: `UPDATE ${S}.tab_reading SET quantity = quantity + 1 WHERE reading_id > 0`, description: 'too many rows' },
    { GUARD_MAX_ROWS: '2' }
  );
  assert.equal(r.isError, true);
  assert.match(textOf(r), /changed \d+ rows, above GUARD_MAX_ROWS \(2\)/);
  assert.equal(await sum(), before);
});

const maxPlusOne = () =>
  `INSERT INTO ${S}.tab_reading (reading_id, quantity) SELECT MAX(reading_id) + 1, 1 FROM ${S}.tab_reading`;
const nextvalInsert = () => pool.query(`INSERT INTO ${S}.tab_reading VALUES (nextval('${S}.gen_reading'), 1)`);

test('sequence: MAX()+1 without setval is rolled back (legacy gen_ sequence)', { skip }, async () => {
  const n = await count();
  const r = await call('execute', { sql: maxPlusOne(), description: 'the incident' });
  assert.equal(r.isError, true, textOf(r));
  assert.match(textOf(r), /gen_reading/);
  assert.equal(await count(), n);
  await nextvalInsert(); // the application's path still works
});

test('sequence: MAX()+1 followed by setval(MAX) commits', { skip }, async () => {
  const n = await count();
  const r = await call('execute_transaction', {
    statements: [maxPlusOne(), `SELECT setval('${S}.gen_reading', (SELECT MAX(reading_id) FROM ${S}.tab_reading))`],
    description: 'backfill with explicit keys and resync',
  });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(await count(), n + 1);
  await nextvalInsert(); // would hit a duplicate key if the sequence were behind
});

test('sequence: a setval to a low value is rolled back and the sequence repaired', { skip }, async () => {
  const n = await count();
  const r = await call('execute_transaction', {
    statements: [maxPlusOne(), `SELECT setval('${S}.gen_reading', 1)`],
    description: 'wrong setval',
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not transactional/);
  assert.equal(await count(), n);
  await nextvalInsert(); // setval survives a rollback; without the repair this collides
});

test('sequence: an explicit key on a serial column is rolled back', { skip }, async () => {
  const r = await call('execute', {
    sql: `INSERT INTO ${S}.tab_serial (id, note) VALUES (1000, 'explicit')`,
    description: 'explicit id',
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /tab_serial_id_seq/);
});

test('sequence: a setval alone that lowers a serial sequence is caught and repaired', { skip }, async () => {
  const r = await call('execute', { sql: `SELECT setval('${S}.tab_serial_id_seq', 1)`, description: 'lower it' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not transactional/);
  await pool.query(`INSERT INTO ${S}.tab_serial (note) VALUES ('after the repair')`);
});

test('snapshot_table copies the filtered rows', { skip }, async () => {
  const r = await call('snapshot_table', { source: `${S}.tab_reading`, where: 'reading_id <= 2', suffix: 'it' });
  assert.equal(r.isError, undefined, textOf(r));
  const { summary } = JSON.parse(textOf(r));
  snapshots.push(summary.snapshot_table);
  assert.equal(summary.row_count, 2);
  assert.equal((await one(`SELECT count(*)::int AS n FROM ${summary.snapshot_table}`)).n, 2);
});

test('snapshot_table: a where with a second statement never reaches the database', { skip }, async () => {
  const r = await call('snapshot_table', { source: `${S}.tab_reading`, where: `1=1; DROP TABLE ${S}.tab_reading` });
  assert.equal(r.isError, true);
  assert.equal((await one(`SELECT to_regclass('${S}.tab_reading') IS NOT NULL AS present`)).present, true);
});

test('a LATIN1 database round-trips accented text with no client_encoding setting', { skip }, async t => {
  const db = `guard_it_latin1_${process.pid}`;
  try {
    await pool.query(`CREATE DATABASE ${db} ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  } catch (e) {
    t.skip(`cannot create a LATIN1 database here: ${e.message}`);
    return;
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${db}`;
  const latin = newPool(url.toString());
  const latinCall = (name, args) => callTool({ env: {}, getPool: () => latin }, name, args);
  try {
    await latin.query('CREATE TABLE tab_customer (id integer PRIMARY KEY, name text)');
    const name = 'Concei\u00e7\u00e3o';
    const w = await latinCall('execute', {
      sql: `INSERT INTO tab_customer (id, name) VALUES (1, '${name}')`,
      description: 'accented text',
    });
    assert.equal(w.isError, undefined, textOf(w));
    const r = await latinCall('query', { sql: 'SELECT name, octet_length(name) AS bytes FROM tab_customer' });
    const row = JSON.parse(textOf(r)).rows[0];
    assert.equal(row.name, name);
    // One byte per character in LATIN1: stored as LATIN1, not as UTF-8 bytes read as LATIN1.
    assert.equal(row.bytes, 9);
  } finally {
    await latin.end();
    await pool.query(`DROP DATABASE IF EXISTS ${db}`);
  }
});
