// Run: npm test  (node --test test/*.test.js)
// Covers the pure guardrail functions: the write targets behind the sequence
// check (born from the sequence-drift incident, see README), the shape each
// tool accepts, and the statements that need i_understand=true.
// The bypass table for applyGuardrails lives in bypasses.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGuardrails,
  checkStatementShape,
  findDataModification,
  findSequenceChanges,
  findWriteTargets,
  needsConfirmation,
} from '../src/guardrails.js';

// Same shape as the recovery statement that caused the incident: the key comes
// from MAX() + ROW_NUMBER() and no setval follows. Values are synthetic.
const SQL_INCIDENT = `
INSERT INTO tab_sensor_reading (reading_id, device_id, read_at, read_on, read_time, quantity, source)
SELECT (SELECT MAX(reading_id) FROM tab_sensor_reading) + ROW_NUMBER() OVER (ORDER BY v.device, v.day),
       v.device, v.day, v.day, '12:00', v.qty, 'BACKFILL - RECOVERY SCRIPT'
FROM (VALUES (1, DATE '2026-01-01', 1000.00)) AS v(device, day, qty)
WHERE NOT EXISTS (SELECT 1 FROM tab_sensor_reading r WHERE r.device_id = v.device)`;

// ---------------------------------------------------------------------------
// findWriteTargets
// ---------------------------------------------------------------------------

test('catches the incident INSERT (MAX + ROW_NUMBER)', () => {
  assert.deepEqual(findWriteTargets(SQL_INCIDENT), [
    { table: 'tab_sensor_reading', maxColumns: ['reading_id'] },
  ]);
});

test('catches the COALESCE(MAX(col),0)+1 form', () => {
  const sql = `INSERT INTO public.tab_customer (customer_id, name)
               SELECT COALESCE(MAX(customer_id), 0) + 1, 'ACME' FROM public.tab_customer`;
  assert.deepEqual(findWriteTargets(sql), [{ table: 'public.tab_customer', maxColumns: ['customer_id'] }]);
});

test('catches MAX qualified by a table alias', () => {
  const sql = `INSERT INTO tab_sensor_reading (reading_id, quantity)
               SELECT MAX(r.reading_id) + 1, 10 FROM tab_sensor_reading r`;
  assert.deepEqual(findWriteTargets(sql)[0].maxColumns, ['reading_id']);
});

test('an INSERT with nextval has no MAX column, but its table is still checked', () => {
  const sql = `insert into tab_sensor_reading (reading_id,device_id,quantity)
               values (nextval('gen_sensor_reading'),1,1000.00)`;
  assert.deepEqual(findWriteTargets(sql), [{ table: 'tab_sensor_reading', maxColumns: [] }]);
});

test('an INSERT with no MAX at all has no MAX column', () => {
  const sql = `INSERT INTO tab_sensor_reading (device_id, quantity) VALUES (1, 1000.00)`;
  assert.deepEqual(findWriteTargets(sql), [{ table: 'tab_sensor_reading', maxColumns: [] }]);
});

test('MAX of a column that is not in the INSERT column list does not count', () => {
  const sql = `INSERT INTO tab_report_page (report_id, page_no)
               SELECT 7, MAX(moved_at) FROM tab_stock_movement`;
  assert.deepEqual(findWriteTargets(sql)[0].maxColumns, []);
});

test('MAX inside a comment does not count', () => {
  const sql = `INSERT INTO tab_sensor_reading (reading_id, quantity)
               -- used to be MAX(reading_id) + 1, replaced by nextval
               VALUES (nextval('gen_sensor_reading'), 10)`;
  assert.deepEqual(findWriteTargets(sql)[0].maxColumns, []);
});

test('UPDATE and DELETE are not write targets', () => {
  assert.deepEqual(findWriteTargets('UPDATE tab_sensor_reading SET quantity = 1 WHERE reading_id = 2'), []);
  assert.deepEqual(findWriteTargets('DELETE FROM tab_sensor_reading WHERE reading_id = 2'), []);
});

test('MAX scoped by a parent key is detected; the sequence lookup is what clears it', () => {
  // tab_settlement_line has a composite key (settlement_id, line_no) and no
  // sequence: the catalog lookup finds nothing to check and the INSERT goes through.
  const sql = `INSERT INTO public.tab_settlement_line (settlement_id, line_no, label)
               SELECT 42, COALESCE(MAX(line_no), 0) + 1, 'AUDIT-TRAIL'
               FROM public.tab_settlement_line WHERE settlement_id = 42`;
  assert.deepEqual(findWriteTargets(sql)[0].maxColumns, ['line_no']);
});

// Gaps of the first, regex-based detector. Each case returned null there, so
// the table was never checked.
test('gap: INSERT without a column list is still a target', () => {
  const sql = `INSERT INTO tab_sensor_reading SELECT MAX(reading_id) + 1, 1, 1000.00 FROM tab_sensor_reading`;
  assert.deepEqual(findWriteTargets(sql), [{ table: 'tab_sensor_reading', maxColumns: [] }]);
});

test('gap: the second INSERT of a script is a target too', () => {
  const sql = `INSERT INTO tab_audit (note) VALUES ('start');
               INSERT INTO tab_sensor_reading (reading_id) SELECT MAX(reading_id) + 1 FROM tab_sensor_reading`;
  assert.deepEqual(findWriteTargets(sql), [
    { table: 'tab_audit', maxColumns: [] },
    { table: 'tab_sensor_reading', maxColumns: ['reading_id'] },
  ]);
});

test('gap: nextval in ANOTHER column does not hide MAX in the key column', () => {
  const sql = `INSERT INTO tab_sensor_reading (reading_id, batch_id)
               SELECT MAX(reading_id) + 1, nextval('gen_batch') FROM tab_sensor_reading`;
  assert.deepEqual(findWriteTargets(sql)[0].maxColumns, ['reading_id']);
});

test('an INSERT inside a CTE is a target', () => {
  const sql = `WITH ins AS (
                 INSERT INTO tab_sensor_reading (reading_id)
                 SELECT MAX(reading_id) + 1 FROM tab_sensor_reading RETURNING reading_id)
               SELECT * FROM ins`;
  assert.deepEqual(findWriteTargets(sql), [{ table: 'tab_sensor_reading', maxColumns: ['reading_id'] }]);
});

test('quoted names keep their quotes, so to_regclass finds the right table', () => {
  // Stripping the quotes made to_regclass fold "TabX" to tabx and miss the table.
  const sql = `INSERT INTO "Sales"."TabX" ("Id", note) SELECT MAX("Id") + 1, 'x' FROM "Sales"."TabX"`;
  assert.deepEqual(findWriteTargets(sql), [{ table: '"Sales"."TabX"', maxColumns: ['Id'] }]);
});

test('a column name with regex metacharacters does not throw', () => {
  // The regex-based detector built new RegExp(column) and threw a SyntaxError.
  const sql = `INSERT INTO tab_x ("a(b", note) SELECT MAX("a(b") + 1, 'x' FROM tab_x`;
  assert.deepEqual(findWriteTargets(sql), [{ table: 'tab_x', maxColumns: ['a(b'] }]);
});

test('MERGE INTO is a target', () => {
  const sql = `MERGE INTO tab_x t USING tab_y s ON t.id = s.id
               WHEN NOT MATCHED THEN INSERT (id, note) VALUES (s.id, s.note)`;
  assert.deepEqual(findWriteTargets(sql), [{ table: 'tab_x', maxColumns: [] }]);
});

// ---------------------------------------------------------------------------
// checkStatementShape
// ---------------------------------------------------------------------------

const READ_OK = [
  'SELECT 1',
  '-- leading comment\nSELECT * FROM tab_x',
  'WITH a AS (SELECT 1 AS n) SELECT n FROM a',
  'EXPLAIN SELECT * FROM tab_x',
  'SELECT 1;',
  "SELECT 'DELETE FROM tab_x; DROP TABLE tab_x'",
  'SELECT * FROM tab_x WHERE id = 1 FOR UPDATE', // the READ ONLY transaction refuses the lock
];

const READ_BLOCKED = [
  ['two statements', 'SELECT 1; DROP TABLE tab_x'],
  ['DELETE after SELECT', 'SELECT 1; DELETE FROM tab_x'],
  ['EXPLAIN ANALYZE runs the DELETE', 'EXPLAIN ANALYZE DELETE FROM tab_x WHERE id = 1'],
  ['data-modifying CTE', 'WITH d AS (DELETE FROM tab_x RETURNING *) SELECT * FROM d'],
  ['SELECT ... INTO creates a table', 'SELECT * INTO tab_copy FROM tab_x'],
  ['DML as the main statement', 'DELETE FROM tab_x WHERE id = 1'],
  ['comment hides nothing', '/* -- */ DELETE FROM tab_x WHERE id = 1'],
  ['empty', '  -- nothing here\n'],
];

for (const sql of READ_OK) {
  test(`query accepts: ${JSON.stringify(sql)}`, () => {
    const r = checkStatementShape(sql, 'read');
    assert.equal(r.ok, true, r.reason);
  });
}

for (const [name, sql] of READ_BLOCKED) {
  test(`query rejects: ${name}`, () => {
    assert.equal(checkStatementShape(sql, 'read').ok, false);
  });
}

test('query reports the command, so EXPLAIN is not wrapped in a cursor', () => {
  assert.equal(checkStatementShape('EXPLAIN SELECT 1', 'read').command, 'EXPLAIN');
  assert.equal(checkStatementShape('select 1', 'read').command, 'SELECT');
});

const WRITE_BLOCKED = [
  ['two statements in execute', "UPDATE tab_x SET a = 1 WHERE id = 1; UPDATE tab_x SET a = 2 WHERE id = 2"],
  ['BEGIN', 'BEGIN'],
  ['BEGIN with statements after it', 'BEGIN; UPDATE tab_x SET a = 1 WHERE id = 1; COMMIT'],
  ['COMMIT', 'COMMIT'],
  ['END', 'END'],
  ['ROLLBACK', 'ROLLBACK'],
  ['START TRANSACTION', 'START TRANSACTION'],
  ['SAVEPOINT', 'SAVEPOINT s1'],
  ['SET search_path', 'SET search_path = other_schema'],
  ['SET ROLE', 'SET ROLE postgres'],
  ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION postgres'],
  ['RESET', 'RESET ALL'],
  ['DISCARD', 'DISCARD ALL'],
  ['PREPARE', 'PREPARE p AS DELETE FROM tab_x WHERE id = $1'],
  ['EXECUTE', 'EXECUTE p(1)'],
  ['LISTEN', 'LISTEN channel_x'],
  ['EXPLAIN in execute', 'EXPLAIN ANALYZE UPDATE tab_x SET a = 1 WHERE id = 1'],
];

for (const [name, sql] of WRITE_BLOCKED) {
  test(`execute rejects: ${name}`, () => {
    assert.equal(checkStatementShape(sql, 'write').ok, false);
  });
}

test('execute accepts ordinary DML/DDL and SET CONSTRAINTS', () => {
  for (const sql of [
    'UPDATE tab_x SET a = 1 WHERE id = 1',
    "INSERT INTO tab_x (id) VALUES (nextval('gen_x'))",
    'CREATE INDEX idx_x ON tab_x (a)',
    'LOCK TABLE tab_x IN SHARE MODE',
    'SET CONSTRAINTS ALL DEFERRED',
    "SELECT setval('gen_x', (SELECT MAX(id) FROM tab_x))",
    'UPDATE tab_x SET a = 1 WHERE id = 1;',
  ]) {
    const r = checkStatementShape(sql, 'write');
    assert.equal(r.ok, true, `${sql}: ${r.reason}`);
  }
});

// ---------------------------------------------------------------------------
// needsConfirmation
// ---------------------------------------------------------------------------

const NEEDS_CONFIRMATION = [
  'DELETE FROM tab_x WHERE 1=1',
  'UPDATE tab_x SET a = 1 WHERE TRUE',
  // Not caught by the first heuristic, which only knew WHERE 1=1 / WHERE TRUE.
  'DELETE FROM tab_x WHERE (1=1)',
  'DELETE FROM tab_x WHERE 2=2',
  "DELETE FROM tab_x WHERE 'a'='a'",
  'UPDATE tab_x SET a = 1 WHERE NOT FALSE',
  'UPDATE tab_x SET a = 1 WHERE 1=1 RETURNING *',
  // DML whose row count the server does not report back.
  'WITH d AS (DELETE FROM tab_x WHERE id = 1 RETURNING *) SELECT count(*) FROM d',
  'WITH d AS (DELETE FROM tab_x WHERE id > 0 RETURNING *) INSERT INTO tab_archive SELECT * FROM d',
  // MERGE with a join condition that matches everything.
  'MERGE INTO tab_x t USING tab_y s ON true WHEN MATCHED THEN DELETE',
];

const NO_CONFIRMATION = [
  'DELETE FROM tab_x WHERE id = 1',
  'UPDATE tab_x SET a = 1 WHERE 1=1 AND id = 5',
  'DELETE FROM tab_x WHERE id > 0', // left to the row limit, measured in the transaction
  // No column either, but a function call or a subquery is not recognized as
  // constant: these are left to the row limit too (see README).
  'DELETE FROM tab_x WHERE now() IS NOT NULL',
  'DELETE FROM tab_x WHERE EXISTS (SELECT 1)',
  'DELETE FROM tab_x WHERE CURRENT OF c_x',
  'MERGE INTO tab_x t USING tab_y s ON t.id = s.id WHEN MATCHED THEN DELETE',
  "UPDATE tab_x SET note = 'WHERE 1=1' WHERE id = 1",
];

for (const sql of NEEDS_CONFIRMATION) {
  test(`needs i_understand: ${sql}`, () => {
    assert.ok(needsConfirmation(sql), `expected a reason for: ${sql}`);
  });
}

for (const sql of NO_CONFIRMATION) {
  test(`no i_understand needed: ${sql}`, () => {
    assert.equal(needsConfirmation(sql), null);
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('findDataModification sees DML anywhere, and not inside strings', () => {
  assert.equal(findDataModification('SELECT * FROM t WHERE id IN (SELECT 1) AND x = 1'), null);
  assert.equal(findDataModification("SELECT 'DELETE FROM t'"), null);
  assert.equal(findDataModification('SELECT 1 FROM t WHERE 1=1; DELETE FROM t'), 'DELETE');
  assert.equal(findDataModification('WITH u AS (UPDATE t SET a = 1 WHERE id = 1 RETURNING *) SELECT 1'), 'UPDATE');
});

test('the incident INSERT passes the static guardrails (the sequence check is in the transaction)', () => {
  assert.equal(applyGuardrails(SQL_INCIDENT, {}).ok, true);
  assert.equal(checkStatementShape(SQL_INCIDENT, 'write').ok, true);
  assert.equal(needsConfirmation(SQL_INCIDENT), null);
});

// ---------------------------------------------------------------------------
// findSequenceChanges (setval is not transactional, see tools.js)
// ---------------------------------------------------------------------------

test('findSequenceChanges reads the sequence of setval and ALTER SEQUENCE', () => {
  assert.deepEqual(findSequenceChanges("SELECT setval('gen_x', 1)").sequences, ['gen_x']);
  assert.deepEqual(findSequenceChanges("SELECT setval('public.gen_x'::regclass, 1)").sequences, ['public.gen_x']);
  assert.deepEqual(findSequenceChanges("SELECT pg_catalog.setval('gen_x', 1, false)").sequences, ['gen_x']);
  assert.deepEqual(findSequenceChanges('ALTER SEQUENCE IF EXISTS "Sales".gen_x RESTART WITH 1').sequences, ['"Sales".gen_x']);
});

test('findSequenceChanges reads a quoted "setval" too (it calls the same function)', () => {
  assert.deepEqual(findSequenceChanges(`SELECT "setval"('gen_x', 1)`).sequences, ['gen_x']);
  assert.deepEqual(findSequenceChanges(`SELECT pg_catalog."setval"('gen_x', 1, false)`).sequences, ['gen_x']);
});

test('findSequenceChanges maps setval(pg_get_serial_sequence(...)) and identity RESTART to tables', () => {
  assert.deepEqual(findSequenceChanges("SELECT setval(pg_get_serial_sequence('tab_x', 'id'), 10)").tables, [
    { table: 'tab_x', maxColumns: ['id'] },
  ]);
  assert.deepEqual(findSequenceChanges('ALTER TABLE ONLY tab_x ALTER COLUMN id RESTART WITH 1').tables, [
    { table: 'tab_x', maxColumns: [] },
  ]);
});

test('findSequenceChanges flags a sequence it cannot read from the text', () => {
  assert.equal(findSequenceChanges("SELECT setval((SELECT 'gen_' || 'x'), 1)").unresolved.length, 1);
  assert.equal(findSequenceChanges("SELECT setval(E'gen_x', 1)").unresolved.length, 1);
  assert.equal(findSequenceChanges('SELECT setval(seq_name, 1) FROM tab_config').unresolved.length, 1);
});

test('findSequenceChanges ignores setval inside strings and comments', () => {
  assert.deepEqual(findSequenceChanges("SELECT 'setval(x)' -- setval('gen_x', 1)"), {
    sequences: [],
    tables: [],
    unresolved: [],
  });
});
