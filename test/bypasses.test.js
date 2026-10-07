// Known ways around the static guardrails, as a table of cases.
// 25 of the 26 "must block" rows below got through the first, regex-only
// version of applyGuardrails (an internal predecessor, not in this
// repository's history). That version blocked every DROP TABLE, so it caught
// the CASCADE row, which now pins the snapshot-drop exception added since.
// 5 of the 17 "must pass" rows were false positives of that version; the
// others pin forms the checks must keep allowing.
// The checks now run on a small SQL lexer (src/sql-lexer.js) that knows about
// comments, nested comments, strings, E'' strings, dollar quotes and
// parentheses, so a comment counts as whitespace and a keyword inside a string
// is just text.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyGuardrails } from '../src/guardrails.js';

const MUST_BLOCK = [
  // A comment is whitespace for PostgreSQL, so the keywords stay separate.
  ['comment between DELETE and FROM', 'DELETE/**/FROM tab_x'],
  ['comment between DROP and TABLE', 'DROP/**/TABLE tab_x'],
  ['comment between UPDATE and the table', 'UPDATE/**/tab_x SET a = 1'],
  ['comment between TRUNCATE and the table', 'TRUNCATE/**/tab_x'],
  // Comment markers in the wrong place.
  ['line comment marker inside a block comment', '/* -- */ DROP TABLE tab_x'],
  ['line comment marker inside a string', "SELECT '--'; DROP TABLE tab_x"],
  ['block comment markers inside strings', "SELECT '/*'; DELETE FROM tab_x; SELECT '*/'"],
  ['text after a nested comment closes', '/* outer /* inner */ still comment */ DELETE FROM tab_x'],
  // The WHERE must belong to the UPDATE/DELETE itself.
  ['WHERE only inside a subquery', 'UPDATE tab_x SET price = (SELECT price FROM tab_y WHERE tab_y.id = 5)'],
  ['WHERE only inside a string', "UPDATE tab_x SET note = 'WHERE'"],
  ['WHERE only inside RETURNING', 'DELETE FROM tab_x RETURNING (SELECT 1 FROM tab_y WHERE tab_y.id = 1)'],
  // DML that does not start the statement.
  ['UPDATE after a CTE', 'WITH c AS (SELECT 1) UPDATE tab_x SET a = 1'],
  ['DELETE inside a CTE', 'WITH d AS (DELETE FROM tab_x RETURNING *) SELECT * FROM d'],
  ['EXPLAIN ANALYZE runs the DELETE', 'EXPLAIN ANALYZE DELETE FROM tab_x'],
  ['EXPLAIN (ANALYZE) runs the UPDATE', 'EXPLAIN (ANALYZE, BUFFERS) UPDATE tab_x SET a = 1'],
  // Code the guardrails cannot read.
  ['DO block with a DELETE', 'DO $$ BEGIN DELETE FROM tab_x; END $$'],
  ['DO block with dynamic SQL', "DO $$ BEGIN EXECUTE 'DROP ' || 'TABLE tab_x'; END $$"],
  ['CALL of a procedure', 'CALL purge_everything()'],
  // DROP beyond TABLE/DATABASE/SCHEMA.
  ['DROP SEQUENCE', 'DROP SEQUENCE gen_x'],
  ['DROP VIEW', 'DROP VIEW v_x'],
  ['DROP FUNCTION', 'DROP FUNCTION f_x()'],
  ['DROP INDEX', 'DROP INDEX idx_x'],
  ['DROP OWNED', 'DROP OWNED BY app_role'],
  ['ALTER TABLE ... DROP COLUMN', 'ALTER TABLE tab_x DROP COLUMN note'],
  ['ALTER TABLE ... DROP <column> (COLUMN is optional)', 'ALTER TABLE tab_x DROP note'],
  ['DROP TABLE of a snapshot with CASCADE', 'DROP TABLE tmp_tab_x_backup_20260115 CASCADE'],
];

const MUST_PASS = [
  ['semicolon inside a string', "UPDATE tab_x SET note = 'a;b' WHERE id = 1"],
  ['line comment marker inside a string', "UPDATE tab_x SET note = '--' WHERE id = 1"],
  ['nested comment hides the whole DELETE', '/* /* */ DELETE FROM tab_x */ SELECT 1'],
  ['WHERE in the UPDATE itself, subquery in SET', 'UPDATE tab_x SET price = (SELECT price FROM tab_y WHERE tab_y.id = 5) WHERE id = 1'],
  ['UPDATE ... FROM ... WHERE', 'UPDATE tab_x x SET a = y.a FROM tab_y y WHERE y.id = x.id'],
  ['SELECT ... FOR UPDATE', 'SELECT * FROM tab_x WHERE id = 1 FOR UPDATE'],
  ['ON CONFLICT DO UPDATE', 'INSERT INTO tab_x (id, a) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a'],
  ['trigger on INSERT OR UPDATE OR DELETE',
    'CREATE TRIGGER trg_x AFTER INSERT OR UPDATE OR DELETE ON tab_x FOR EACH ROW EXECUTE FUNCTION f_x()'],
  ['GRANT UPDATE, DELETE, TRUNCATE', 'GRANT SELECT, UPDATE, DELETE, TRUNCATE ON tab_x TO app_role'],
  ['foreign key ON DELETE CASCADE', 'ALTER TABLE tab_x ADD CONSTRAINT fk_y FOREIGN KEY (y_id) REFERENCES tab_y (id) ON DELETE CASCADE'],
  ['ALTER COLUMN ... DROP NOT NULL', 'ALTER TABLE tab_x ALTER COLUMN note DROP NOT NULL'],
  ['ALTER COLUMN ... DROP DEFAULT', 'ALTER TABLE tab_x ALTER COLUMN note DROP DEFAULT'],
  ['ALTER COLUMN ... DROP IDENTITY', 'ALTER TABLE tab_x ALTER COLUMN id DROP IDENTITY'],
  ['ALTER COLUMN ... DROP EXPRESSION', 'ALTER TABLE tab_x ALTER COLUMN total DROP EXPRESSION'],
  ['DROP of a snapshot made by snapshot_table', 'DROP TABLE IF EXISTS tmp_tab_x_fix_42_backup_20260115'],
  ['DELETE ... WHERE CURRENT OF', 'DELETE FROM tab_x WHERE CURRENT OF c_x'],
  ['keyword text in a dollar-quoted string', "SELECT $tag$DELETE FROM tab_x; DROP TABLE tab_x$tag$"],
];

for (const [name, sql] of MUST_BLOCK) {
  test(`blocks: ${name}`, () => {
    const r = applyGuardrails(sql, {});
    assert.equal(r.ok, false, `expected a block for: ${sql}`);
  });
}

for (const [name, sql] of MUST_PASS) {
  test(`allows: ${name}`, () => {
    const r = applyGuardrails(sql, {});
    assert.equal(r.ok, true, `expected no block for: ${sql}\nreason: ${r.reason}`);
  });
}

// The lexer has to read strings the way the server does, or text that the
// server sees as code would hide inside what the lexer thinks is a string.
const LEXER_TRAPS = [
  // With standard_conforming_strings = off (common on old ERP databases) a
  // backslash escapes the quote in a plain string; with it on, it does not.
  // The checks run under both readings.
  ['backslash quote, standard_conforming_strings off', "SELECT 'abc\\''; DELETE FROM tab_x; SELECT ''"],
  ['backslash quote, standard_conforming_strings on', "SELECT 'abc\\'; DELETE FROM tab_x; SELECT '\\'"],
  // E'' strings always use backslash escapes.
  ["E'' string with an escaped quote", "SELECT E'it\\'s'; DELETE FROM tab_x; --'"],
  // A quote inside a dollar-quoted string is not a string delimiter.
  ['quote inside a dollar-quoted string', "SELECT $x$ ' $x$; DELETE FROM tab_x; SELECT ''"],
  // A quoted identifier may contain anything, including comment markers.
  ['comment marker inside a quoted identifier', 'SELECT 1 AS "/*"; DELETE FROM tab_x; SELECT 1 AS "*/"'],
];

for (const [name, sql] of LEXER_TRAPS) {
  test(`blocks (lexer): ${name}`, () => {
    assert.equal(applyGuardrails(sql, {}).ok, false, `expected a block for: ${sql}`);
  });
}

test('flags: only the literal "false" disables a check', () => {
  assert.equal(applyGuardrails('DELETE FROM tab_x', { GUARD_BLOCK_DML_WITHOUT_WHERE: 'false' }).ok, true);
  assert.equal(applyGuardrails('DELETE FROM tab_x', { GUARD_BLOCK_DML_WITHOUT_WHERE: '0' }).ok, false);
  assert.equal(applyGuardrails('DROP SEQUENCE gen_x', { GUARD_BLOCK_DROP: 'false' }).ok, true);
  assert.equal(applyGuardrails('DROP SEQUENCE gen_x', { GUARD_BLOCK_DROP: 'no' }).ok, false);
  // DO/CALL are not covered by either flag.
  assert.equal(
    applyGuardrails('DO $$ BEGIN NULL; END $$', { GUARD_BLOCK_DML_WITHOUT_WHERE: 'false', GUARD_BLOCK_DROP: 'false' }).ok,
    false
  );
});
