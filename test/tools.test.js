// Tool handlers against a fake pool: what reaches the database, in which
// order, and what is refused before anything does. No database needed.
// The same flows against a real PostgreSQL are in integration.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callTool, TOOLS } from '../src/tools.js';

/**
 * A pool whose client records every query. `respond(text, info)` returns a
 * partial result, an Error to throw, or undefined for an empty result.
 */
function fakePool(respond = () => undefined) {
  const calls = [];
  const releases = [];
  let connects = 0;
  const client = {
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      const queryMode = typeof q === 'string' ? undefined : q.queryMode;
      calls.push({ text, queryMode, values });
      const r = await respond(text, { queryMode, values });
      if (r instanceof Error) throw r;
      const command = text.trim().split(/\s+/)[0].toUpperCase();
      return { rows: [], rowCount: 0, command, fields: [], ...r };
    },
    release(err) {
      releases.push(err ?? null);
    },
  };
  return {
    pool: {
      async connect() {
        connects++;
        return client;
      },
    },
    calls,
    releases,
    get connects() {
      return connects;
    },
    /** First word of each statement sent, e.g. ['BEGIN', 'UPDATE', 'COMMIT']. */
    verbs() {
      return calls.map(c => c.text.trim().split(/\s+/)[0].toUpperCase());
    },
  };
}

const ctxOf = (fake, env = {}) => ({ env, getPool: () => fake.pool });
const textOf = res => res.content[0].text;
const payload = res => JSON.parse(textOf(res));

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

for (const [name, sql] of [
  ['a second statement', 'SELECT 1; DROP TABLE tab_x'],
  ['a DELETE after SELECT', 'SELECT 1; DELETE FROM tab_x'],
  ['EXPLAIN ANALYZE of a DELETE', 'EXPLAIN ANALYZE DELETE FROM tab_x'],
  ['a data-modifying CTE', 'WITH d AS (DELETE FROM tab_x RETURNING *) SELECT * FROM d'],
  ['SELECT ... INTO', 'SELECT * INTO tab_copy FROM tab_x'],
]) {
  test(`query refuses ${name} without touching the database`, async () => {
    const fake = fakePool();
    const res = await callTool(ctxOf(fake), 'query', { sql });
    assert.equal(res.isError, true, textOf(res));
    assert.equal(fake.connects, 0);
  });
}

test('query runs in a READ ONLY transaction, through a cursor, and always rolls back', async () => {
  const fake = fakePool(text =>
    text.startsWith('FETCH') ? { rows: [{ a: 1 }], fields: [{ name: 'a' }] } : undefined
  );
  const sql = 'SELECT a FROM tab_x';
  const res = await callTool(ctxOf(fake), 'query', { sql });

  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs(), ['BEGIN', 'DECLARE', 'FETCH', 'ROLLBACK', 'DISCARD']);
  assert.equal(fake.calls[0].text, 'BEGIN TRANSACTION READ ONLY');
  assert.equal(fake.calls[1].text, `DECLARE guard_query_cursor NO SCROLL CURSOR FOR ${sql}`);
  assert.equal(fake.calls[1].queryMode, 'extended');
  assert.equal(fake.calls[2].text, 'FETCH FORWARD 1001 FROM guard_query_cursor');
  assert.deepEqual(fake.releases, [null]);
  assert.deepEqual(payload(res).rows, [{ a: 1 }]);
  assert.equal(payload(res).summary.truncated, false);
});

test('query caps the rows at GUARD_QUERY_MAX_ROWS and says so', async () => {
  const fake = fakePool(text =>
    text.startsWith('FETCH') ? { rows: [{ n: 1 }, { n: 2 }, { n: 3 }], fields: [{ name: 'n' }] } : undefined
  );
  const res = await callTool(ctxOf(fake, { GUARD_QUERY_MAX_ROWS: '2' }), 'query', { sql: 'SELECT n FROM tab_x' });
  assert.equal(fake.calls[2].text, 'FETCH FORWARD 3 FROM guard_query_cursor');
  assert.deepEqual(payload(res).rows, [{ n: 1 }, { n: 2 }]);
  assert.equal(payload(res).summary.truncated, true);
  assert.match(payload(res).summary.note, /GUARD_QUERY_MAX_ROWS/);
});

test('query sends EXPLAIN as is (no cursor), still read-only and in extended mode', async () => {
  const fake = fakePool();
  await callTool(ctxOf(fake), 'query', { sql: 'EXPLAIN SELECT * FROM tab_x' });
  assert.deepEqual(fake.verbs(), ['BEGIN', 'EXPLAIN', 'ROLLBACK', 'DISCARD']);
  assert.equal(fake.calls[1].queryMode, 'extended');
});

test('query rolls back and releases after a Postgres error', async () => {
  const fake = fakePool(text => (text.startsWith('DECLARE') ? new Error('relation does not exist') : undefined));
  const res = await callTool(ctxOf(fake), 'query', { sql: 'SELECT * FROM tab_missing' });
  assert.equal(res.isError, true);
  assert.deepEqual(fake.verbs(), ['BEGIN', 'DECLARE', 'ROLLBACK', 'DISCARD']);
  assert.deepEqual(fake.releases, [null]);
});

test('a failed ROLLBACK discards the connection instead of returning it to the pool', async () => {
  const lost = new Error('connection terminated');
  const fake = fakePool(text => (text === 'ROLLBACK' ? lost : undefined));
  await callTool(ctxOf(fake), 'query', { sql: 'SELECT 1' });
  assert.deepEqual(fake.releases, [lost]);
  assert.ok(!fake.verbs().includes('DISCARD'), 'a broken connection is not reset, it is discarded');
});

// ---------------------------------------------------------------------------
// Session reset: what a call changes in the session must not reach the next
// call on the same pooled connection
// ---------------------------------------------------------------------------

// SET is refused in the write tools, but a function does the same:
// set_config(..., false) survives the COMMIT, a temporary table and a session
// advisory lock live until the session ends.
for (const [tool, args] of [
  ['query', { sql: "SELECT set_config('search_path', 'other', false)" }],
  ['execute', { sql: "SELECT set_config('statement_timeout', '0', false)", description: 'test' }],
  ['execute', { sql: 'CREATE TEMP TABLE t_leak AS SELECT 1', description: 'test' }],
  [
    'execute_transaction',
    { statements: ["SELECT set_config('search_path', 'other', false)", 'SELECT pg_advisory_lock(42)'], description: 'test' },
  ],
  ['snapshot_table', { source: 'tab_invoice' }],
]) {
  test(`${tool} resets the session (DISCARD ALL) before releasing the connection: ${JSON.stringify(args)}`, async () => {
    const fake = fakePool();
    const res = await callTool(ctxOf(fake), tool, args);
    assert.equal(res.isError, undefined, textOf(res));
    assert.equal(fake.calls.at(-1)?.text, 'DISCARD ALL', `the session was not reset; sent: ${fake.verbs().join(', ')}`);
    assert.deepEqual(fake.releases, [null]);
  });
}

test('the session is reset after a rolled-back write too', async () => {
  const fake = fakePool(text => (text.startsWith('UPDATE') ? new Error('deadlock detected') : undefined));
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: ["SELECT set_config('search_path', 'other', false)", 'UPDATE tab_x SET a = 1 WHERE id = 1'],
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.deepEqual(fake.verbs().slice(-2), ['ROLLBACK', 'DISCARD']);
  assert.deepEqual(fake.releases, [null]);
});

test('a connection whose session cannot be reset is discarded, not returned to the pool', async () => {
  const failed = new Error('server closed the connection unexpectedly');
  const fake = fakePool(text => (text === 'DISCARD ALL' ? failed : undefined));
  const res = await callTool(ctxOf(fake), 'execute', { sql: 'UPDATE tab_x SET a = 1 WHERE id = 1', description: 'test' });
  // The write itself was committed before the reset: the call still succeeds.
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.releases, [failed]);
});

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

const CATCH_ALL = 'UPDATE tab_x SET a = 1 WHERE 1=1';

test('i_understand as the string "false" is not consent', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'execute', { sql: CATCH_ALL, description: 'test', i_understand: 'false' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /must be a boolean/);
  assert.equal(fake.connects, 0);
});

test('i_understand=true (boolean) lets a catch-all WHERE run', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'execute', { sql: CATCH_ALL, description: 'test', i_understand: true });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs(), ['BEGIN', 'UPDATE', 'COMMIT', 'DISCARD']);
});

test('without i_understand a catch-all WHERE is refused before running', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'execute', { sql: CATCH_ALL, description: 'test' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /i_understand=true/);
  assert.equal(fake.connects, 0);
});

test('arguments of the wrong type get a clear error, not "Internal error"', async () => {
  const fake = fakePool();
  for (const args of [
    { sql: 42, description: 'x' },
    { sql: 'UPDATE tab_x SET a = 1 WHERE id = 1' },
    { sql: 'UPDATE tab_x SET a = 1 WHERE id = 1', description: '  ' },
  ]) {
    const res = await callTool(ctxOf(fake), 'execute', args);
    assert.equal(res.isError, true);
    assert.doesNotMatch(textOf(res), /Internal error/);
  }
  const res = await callTool(ctxOf(fake), 'execute_transaction', { statements: ['SELECT 1', 7], description: 'x' });
  assert.match(textOf(res), /statements\[1\]/);
  assert.equal(fake.connects, 0);
});

for (const [name, sql] of [
  ['BEGIN/COMMIT around the statement', 'BEGIN; UPDATE tab_x SET a = 1 WHERE id = 1; COMMIT'],
  ['two statements', 'UPDATE tab_x SET a = 1 WHERE id = 1; DELETE FROM tab_x'],
  ['SET search_path', 'SET search_path = other'],
  ['DO block', 'DO $$ BEGIN DELETE FROM tab_x; END $$'],
  ['EXPLAIN ANALYZE', 'EXPLAIN ANALYZE DELETE FROM tab_x WHERE id = 1'],
]) {
  test(`execute refuses ${name} without touching the database`, async () => {
    const fake = fakePool();
    const res = await callTool(ctxOf(fake), 'execute', { sql, description: 'test' });
    assert.equal(res.isError, true, textOf(res));
    assert.equal(fake.connects, 0);
  });
}

test('execute runs its statement in its own transaction, in extended mode', async () => {
  const fake = fakePool(text => (text.startsWith('UPDATE') ? { rowCount: 1, command: 'UPDATE' } : undefined));
  const res = await callTool(ctxOf(fake), 'execute', {
    sql: 'UPDATE tab_x SET a = 1 WHERE id = 1',
    description: 'test',
  });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs(), ['BEGIN', 'UPDATE', 'COMMIT', 'DISCARD']);
  assert.equal(fake.calls[1].queryMode, 'extended');
  assert.deepEqual(fake.releases, [null]);
  assert.equal(payload(res).summary.rowCount, 1);
});

test('execute rolls back when the statement fails', async () => {
  const fake = fakePool(text => (text.startsWith('UPDATE') ? new Error('deadlock detected') : undefined));
  const res = await callTool(ctxOf(fake), 'execute', { sql: 'UPDATE tab_x SET a = 1 WHERE id = 1', description: 't' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /rolled back/);
  assert.deepEqual(fake.verbs(), ['BEGIN', 'UPDATE', 'ROLLBACK', 'DISCARD']);
  assert.deepEqual(fake.releases, [null]);
});

test('row limit: a statement that changes more than GUARD_MAX_ROWS rows is rolled back', async () => {
  // WHERE id > 0 references a column, so only the measured row count can catch it.
  const fake = fakePool(text => (text.startsWith('DELETE') ? { rowCount: 11, command: 'DELETE' } : undefined));
  const res = await callTool(ctxOf(fake, { GUARD_MAX_ROWS: '10' }), 'execute', {
    sql: 'DELETE FROM tab_x WHERE id > 0',
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /changed 11 rows, above GUARD_MAX_ROWS \(10\)/);
  assert.deepEqual(fake.verbs(), ['BEGIN', 'DELETE', 'ROLLBACK', 'DISCARD']);
});

test('row limit: MERGE ... THEN DELETE is measured like any DML', async () => {
  const fake = fakePool(text => (text.startsWith('MERGE') ? { rowCount: 5000, command: 'MERGE' } : undefined));
  const res = await callTool(ctxOf(fake), 'execute', {
    sql: 'MERGE INTO tab_x t USING tab_y s ON t.id = s.id WHEN MATCHED THEN DELETE',
    description: 'test',
  });
  assert.equal(res.isError, true);
  // WITH = the catalog lookup for the sequence check (MERGE INTO can insert rows).
  assert.deepEqual(fake.verbs(), ['WITH', 'BEGIN', 'MERGE', 'ROLLBACK', 'DISCARD']);
});

test('row limit: i_understand=true lifts it', async () => {
  const fake = fakePool(text => (text.startsWith('DELETE') ? { rowCount: 11, command: 'DELETE' } : undefined));
  const res = await callTool(ctxOf(fake, { GUARD_MAX_ROWS: '10' }), 'execute', {
    sql: 'DELETE FROM tab_x WHERE id > 0',
    description: 'test',
    i_understand: true,
  });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs(), ['BEGIN', 'DELETE', 'COMMIT', 'DISCARD']);
});

// ---------------------------------------------------------------------------
// execute_transaction
// ---------------------------------------------------------------------------

test('execute_transaction refuses a COMMIT in the list before anything runs', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: ['UPDATE tab_x SET a = 1 WHERE id = 1', 'COMMIT', 'UPDATE tab_x SET a = 2 WHERE id = 2'],
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Statement 2\/3 blocked/);
  assert.equal(fake.connects, 0);
});

test('execute_transaction runs every statement between one BEGIN and one COMMIT', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: ["INSERT INTO tab_log (note) VALUES ('a')", 'UPDATE tab_x SET a = 1 WHERE id = 1'],
    description: 'test',
  });
  assert.equal(res.isError, undefined, textOf(res));
  // WITH = the catalog lookup for the sequence check of the INSERT target.
  assert.deepEqual(fake.verbs(), ['WITH', 'BEGIN', 'INSERT', 'UPDATE', 'COMMIT', 'DISCARD']);
  assert.ok(fake.calls.slice(2, 4).every(c => c.queryMode === 'extended'));
});

// ---------------------------------------------------------------------------
// Sequence invariant (the incident in the README)
// ---------------------------------------------------------------------------

const INCIDENT_INSERT =
  'INSERT INTO tab_sensor_reading (reading_id, quantity) ' +
  'SELECT (SELECT MAX(reading_id) FROM tab_sensor_reading) + ROW_NUMBER() OVER (), 1000.00';
const SEQ = 'public.gen_sensor_reading';

/**
 * Catalog: tab_sensor_reading.reading_id is fed by gen_sensor_reading.
 * `states` answer each measurement in order: before BEGIN, before COMMIT,
 * and after a ROLLBACK (the repair check). true = behind MAX, false = in step.
 */
function sequenceFake(states, extra = () => undefined) {
  const queue = [...states];
  return fakePool((text, info) => {
    if (text.includes('pg_get_serial_sequence')) {
      return { rows: [{ table_name: 'public.tab_sensor_reading', column_name: 'reading_id', sequence_name: SEQ }] };
    }
    if (text.includes('pg_depend')) {
      return { rows: [{ table_name: 'public.tab_sensor_reading', column_name: 'reading_id' }] };
    }
    if (text.includes('setval($1::regclass')) {
      return { rows: [{ value: '120' }] };
    }
    if (text.includes('is_called')) {
      const next = queue.shift();
      if (next instanceof Error) return next;
      if (next === undefined) return new Error('unexpected measurement');
      return {
        rows: [{ max_value: '120', last_value: next ? '100' : '120', used: next ? '100' : '120', behind: next }],
      };
    }
    return extra(text, info);
  });
}

const repairCall = fake => fake.calls.find(c => c.text.includes('setval($1::regclass'));

test('sequence: the incident INSERT alone, through execute, is rolled back', async () => {
  const fake = sequenceFake([false, true, false]);
  const res = await callTool(ctxOf(fake), 'execute', { sql: INCIDENT_INSERT, description: 'test' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /nextval\('public\.gen_sensor_reading'\)/);
  assert.match(
    textOf(res),
    /setval\('public\.gen_sensor_reading', \(SELECT MAX\("reading_id"\) FROM public\.tab_sensor_reading\)\)/
  );
  // INSERT, measure, ROLLBACK, measure again (nothing to repair: the INSERT is gone).
  assert.deepEqual(fake.verbs().slice(-5), ['INSERT', 'SELECT', 'ROLLBACK', 'SELECT', 'DISCARD']);
  assert.equal(repairCall(fake), undefined);
});

test('sequence: a setval to a low value is rolled back, and the sequence repaired', async () => {
  // The first version accepted any setval of the right sequence as a fix. And
  // since setval is not transactional, rolling back is not enough by itself.
  const fake = sequenceFake([false, true, true]);
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: [INCIDENT_INSERT, `SELECT setval('gen_sensor_reading', 1)`],
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /leave the sequence public\.gen_sensor_reading .* behind/);
  assert.match(textOf(res), /not transactional.*moved public\.gen_sensor_reading back to 120/);
  assert.ok(!fake.verbs().includes('COMMIT'));
  // Repaired to MAX or to where it was before the call (used = 120), whichever is higher.
  assert.deepEqual(repairCall(fake).values, [SEQ, '120']);
});

test('sequence: a setval placed BEFORE the INSERT is rolled back', async () => {
  const fake = sequenceFake([false, true, false]);
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: [`SELECT setval('gen_sensor_reading', (SELECT MAX(reading_id) FROM tab_sensor_reading))`, INCIDENT_INSERT],
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.ok(!fake.verbs().includes('COMMIT'));
});

test('sequence: a setval alone that lowers the sequence is caught and repaired', async () => {
  // No INSERT at all: the sequence is found from the setval itself.
  const fake = sequenceFake([false, true, true]);
  const res = await callTool(ctxOf(fake, { GUARD_LEGACY_TABLE_PREFIX: 'tab_', GUARD_LEGACY_SEQUENCE_PREFIX: 'gen_' }), 'execute', {
    sql: "SELECT setval('gen_sensor_reading', 1)",
    description: 'test',
  });
  assert.equal(res.isError, true);
  const owners = fake.calls.find(c => c.text.includes('pg_depend'));
  assert.deepEqual(owners.values, ['gen_sensor_reading', 'tab_', 'gen_']);
  assert.ok(repairCall(fake), 'expected a repair setval after the rollback');
});

test('sequence: ALTER SEQUENCE ... RESTART is checked like setval', async () => {
  const fake = sequenceFake([false, true, true]);
  const res = await callTool(ctxOf(fake), 'execute', {
    sql: 'ALTER SEQUENCE gen_sensor_reading RESTART WITH 1',
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.ok(!fake.verbs().includes('COMMIT'));
});

test('sequence: a setval with a computed sequence name is refused before running', async () => {
  const fake = sequenceFake([]);
  const res = await callTool(ctxOf(fake), 'execute', {
    sql: "SELECT setval((SELECT 'gen_' || 'sensor_reading'), 1)",
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /cannot tell which sequence/);
  assert.equal(fake.connects, 0);
});

test('sequence: setval(pg_get_serial_sequence(...)) names its table and column', async () => {
  const fake = sequenceFake([false, false]);
  const res = await callTool(ctxOf(fake), 'execute', {
    sql: "SELECT setval(pg_get_serial_sequence('tab_sensor_reading', 'reading_id'), 500)",
    description: 'test',
  });
  assert.equal(res.isError, undefined, textOf(res));
  const lookup = fake.calls.find(c => c.text.includes('pg_get_serial_sequence') && c.values);
  assert.deepEqual(lookup.values.slice(0, 2), ['tab_sensor_reading', ['reading_id']]);
});

test('sequence: INSERT followed by a correct setval commits', async () => {
  const fake = sequenceFake([false, false]);
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: [INCIDENT_INSERT, `SELECT setval('gen_sensor_reading', (SELECT MAX(reading_id) FROM tab_sensor_reading))`],
    description: 'test',
  });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs().slice(-2), ['COMMIT', 'DISCARD']);
});

test('sequence: one that was already behind is a warning, not a block', async () => {
  const fake = sequenceFake([true, true]);
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: ["INSERT INTO tab_sensor_reading (reading_id, quantity) VALUES (nextval('gen_sensor_reading'), 1)"],
    description: 'test',
  });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs().slice(-2), ['COMMIT', 'DISCARD']);
  assert.match(payload(res).summary.warnings[0], /already behind/);
});

test('sequence: the catalog lookup gets the table as written, the MAX columns and the legacy prefixes', async () => {
  const fake = sequenceFake([false, false]);
  await callTool(
    ctxOf(fake, { GUARD_LEGACY_TABLE_PREFIX: 'tab_', GUARD_LEGACY_SEQUENCE_PREFIX: 'gen_' }),
    'execute',
    { sql: INCIDENT_INSERT, description: 'test' }
  );
  const lookup = fake.calls.find(c => c.text.includes('pg_get_serial_sequence'));
  assert.deepEqual(lookup.values, ['tab_sensor_reading', ['reading_id'], 'tab_', 'gen_']);
  // Measured before BEGIN (autocommit) and again before COMMIT.
  assert.deepEqual(fake.verbs(), ['WITH', 'SELECT', 'BEGIN', 'INSERT', 'SELECT', 'COMMIT', 'DISCARD']);
});

test('sequence: GUARD_BLOCK_MANUAL_PK=false skips the check', async () => {
  const fake = sequenceFake([]);
  const res = await callTool(ctxOf(fake, { GUARD_BLOCK_MANUAL_PK: 'false' }), 'execute', {
    sql: INCIDENT_INSERT,
    description: 'test',
  });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs(), ['BEGIN', 'INSERT', 'COMMIT', 'DISCARD']);
});

test('sequence: a failed catalog lookup fails open (logged), as documented', async () => {
  const fake = fakePool(text => (text.includes('pg_get_serial_sequence') ? new Error('permission denied') : undefined));
  const res = await callTool(ctxOf(fake), 'execute', { sql: INCIDENT_INSERT, description: 'test' });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs().slice(-2), ['COMMIT', 'DISCARD']);
});

test('sequence: a failed measurement inside the transaction fails closed', async () => {
  const fake = sequenceFake([false, new Error('could not read sequence'), false]);
  const res = await callTool(ctxOf(fake), 'execute', { sql: INCIDENT_INSERT, description: 'test' });
  assert.equal(res.isError, true);
  assert.ok(fake.verbs().includes('ROLLBACK'));
  assert.ok(!fake.verbs().includes('COMMIT'));
});

test('sequence: an error after a setval also triggers the repair', async () => {
  const fake = sequenceFake([false, true], text =>
    text.startsWith('UPDATE') ? new Error('deadlock detected') : undefined
  );
  const res = await callTool(ctxOf(fake), 'execute_transaction', {
    statements: ["SELECT setval('gen_sensor_reading', 1)", 'UPDATE tab_other SET a = 1 WHERE id = 1'],
    description: 'test',
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Transaction failed \(rolled back\): deadlock detected/);
  assert.ok(repairCall(fake), 'expected a repair setval after the rollback');
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

test('the audit log records the SQL of transactions, blocks and the write-ahead entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-audit-'));
  const logPath = join(dir, 'audit.jsonl');
  try {
    const env = { GUARD_AUDIT_LOG_PATH: logPath };
    const statements = ["INSERT INTO tab_log (note) VALUES ('a')", 'UPDATE tab_x SET a = 1 WHERE id = 1'];
    await callTool(ctxOf(fakePool(), env), 'execute_transaction', { statements, description: 'ok set' });
    await callTool(ctxOf(fakePool(), env), 'execute_transaction', {
      statements: ['UPDATE tab_x SET a = 1'],
      description: 'static block',
    });
    await callTool(ctxOf(fakePool(), env), 'execute', { sql: CATCH_ALL, description: 'needs confirmation' });

    const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const byEvent = ev => entries.filter(e => e.event === ev);

    assert.deepEqual(byEvent('transaction_started')[0].statements, statements);
    assert.deepEqual(byEvent('transaction_ok')[0].statements, statements);
    const blocked = byEvent('transaction_blocked')[0];
    assert.deepEqual(blocked.statements, ['UPDATE tab_x SET a = 1']);
    assert.match(blocked.reason, /UPDATE without WHERE/);
    const confirm = byEvent('execute_blocked')[0];
    assert.equal(confirm.sql, CATCH_ALL);
    assert.match(confirm.reason, /i_understand/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unexpected error is audited as internal_error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-audit-'));
  const logPath = join(dir, 'audit.jsonl');
  try {
    const args = {
      get sql() {
        throw new Error('boom');
      },
    };
    const res = await callTool(ctxOf(fakePool(), { GUARD_AUDIT_LOG_PATH: logPath }), 'query', args);
    assert.match(textOf(res), /Internal error: boom/);
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim());
    assert.equal(entry.event, 'internal_error');
    assert.equal(entry.tool, 'query');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection failure is reported as such', async () => {
  const ctx = { env: {}, getPool: () => ({ connect: async () => Promise.reject(new Error('timeout expired')) }) };
  const res = await callTool(ctx, 'query', { sql: 'SELECT 1' });
  assert.match(textOf(res), /Could not connect to the database: timeout expired/);
});

// ---------------------------------------------------------------------------
// snapshot_table
// ---------------------------------------------------------------------------

test('snapshot_table refuses a where that adds a statement, before touching the database', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'snapshot_table', {
    source: 'tab_invoice',
    where: '1=1; DROP TABLE tab_invoice',
  });
  assert.equal(res.isError, true);
  assert.equal(fake.connects, 0);
});

test('snapshot_table refuses a where with a data-modifying statement', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'snapshot_table', {
    source: 'tab_invoice',
    where: 'id IN (WITH d AS (DELETE FROM tab_invoice WHERE id = 1 RETURNING id) SELECT id FROM d)',
  });
  assert.equal(res.isError, true);
  assert.equal(fake.connects, 0);
});

// setval is not undone by a rollback, and snapshot_table does not measure
// sequences: a setval in the where would move one with no check at all.
for (const where of [
  "setval('gen_invoice', 1) > 0",
  "id > 0 AND pg_catalog.setval('public.gen_invoice', 1, false) IS NOT NULL",
  `"setval"('gen_invoice', 1) > 0`,
]) {
  test(`snapshot_table refuses a where that moves a sequence: ${where}`, async () => {
    const fake = fakePool();
    const res = await callTool(ctxOf(fake), 'snapshot_table', { source: 'tab_invoice', where });
    assert.equal(res.isError, true, `expected a refusal, got: ${textOf(res)}`);
    assert.match(textOf(res), /setval/);
    assert.equal(fake.connects, 0);
  });
}

test('snapshot_table refuses a name PostgreSQL would truncate', async () => {
  const fake = fakePool();
  const res = await callTool(ctxOf(fake), 'snapshot_table', {
    source: 'tab_stock_movement_warehouse_history',
    suffix: 'phase_a_retry',
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /bytes/);
  assert.equal(fake.connects, 0);
});

test('snapshot_table runs CREATE TABLE AS in a transaction and uses its row count', async () => {
  const fake = fakePool(text => (text.startsWith('CREATE') ? { rowCount: 7, command: 'SELECT' } : undefined));
  const res = await callTool(ctxOf(fake), 'snapshot_table', {
    source: 'tab_invoice',
    where: "status = 'OPEN'",
    suffix: 'fix_42',
  });
  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(fake.verbs(), ['BEGIN', 'CREATE', 'COMMIT', 'DISCARD']);
  assert.equal(fake.calls[1].queryMode, 'extended');
  assert.match(fake.calls[1].text, /^CREATE TABLE tmp_tab_invoice_fix_42_backup_\d{8} AS SELECT \* FROM tab_invoice WHERE status = 'OPEN'$/);
  assert.equal(payload(res).summary.row_count, 7);
});

test('snapshot_table falls back to COUNT(*) when the server reports no row count', async () => {
  const fake = fakePool(text => {
    if (text.startsWith('CREATE')) return { rowCount: null, command: 'SELECT' };
    if (text.startsWith('SELECT COUNT')) return { rows: [{ n: '7' }] };
    return undefined;
  });
  const res = await callTool(ctxOf(fake), 'snapshot_table', { source: 'tab_invoice' });
  assert.equal(payload(res).summary.row_count, 7);
  assert.deepEqual(fake.verbs(), ['BEGIN', 'CREATE', 'SELECT', 'COMMIT', 'DISCARD']);
});

// ---------------------------------------------------------------------------
// Tool list
// ---------------------------------------------------------------------------

test('tools declare MCP annotations', () => {
  const byName = Object.fromEntries(TOOLS.map(t => [t.name, t.annotations]));
  assert.equal(byName.query.readOnlyHint, true);
  assert.equal(byName.execute.destructiveHint, true);
  assert.equal(byName.execute_transaction.destructiveHint, true);
  assert.equal(byName.snapshot_table.readOnlyHint, false);
});

test('unknown tool', async () => {
  const res = await callTool(ctxOf(fakePool()), 'drop_everything', {});
  assert.equal(res.isError, true);
});
