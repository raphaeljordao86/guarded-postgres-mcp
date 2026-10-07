// Static guardrails for agent-written SQL. Pure functions, no I/O.
//
// They run on the tokens of src/sql-lexer.js, never on raw text, so comments
// count as whitespace and keywords inside strings or quoted identifiers are
// just text. They are still not a SQL parser: the checks that need the real
// effect of a statement (rows touched, sequence position) run inside the
// transaction, in src/tools.js.

import { lex } from './sql-lexer.js';

const word = tk => (tk && tk.t === 'w' ? tk.u : null);
const fold = tk => (tk.t === 'id' ? tk.v : tk.v.toLowerCase());

// Right before UPDATE or TRUNCATE, these mean the word is part of another
// construct (FOR UPDATE, ON UPDATE CASCADE, AFTER INSERT OR UPDATE, INSTEAD OF
// UPDATE, GRANT UPDATE, GRANT SELECT, UPDATE ...), not a statement.
const NOT_A_STATEMENT_AFTER = new Set(['FOR', 'KEY', 'ON', 'OR', 'BEFORE', 'AFTER', 'OF', 'GRANT', 'REVOKE', ',']);

function previousKey(toks, k) {
  const p = toks[k - 1];
  if (!p) return null;
  return p.t === 'w' ? p.u : p.t;
}

/** End (exclusive) of the scope that starts at `from` at depth `d`. */
function scopeEnd(toks, from, d) {
  let j = from;
  while (j < toks.length && toks[j].d >= d) j++;
  return j;
}

/** Index of the word `w` at exactly depth `d` inside that scope, or -1. */
function findAtDepth(toks, from, d, w) {
  const end = scopeEnd(toks, from, d);
  for (let j = from; j < end; j++) {
    if (toks[j].d === d && word(toks[j]) === w) return j;
  }
  return -1;
}

function snippet(sql, toks, k, max = 200) {
  const start = toks[k]?.p ?? 0;
  return String(sql).slice(start, start + max);
}

/**
 * Every data-modifying statement in a token list, wherever it sits: at the
 * top, after a WITH, inside a CTE, after EXPLAIN, in a rule action.
 * Returns [{ kind, k (token index), d (depth) }].
 */
function dmlStarts(toks) {
  const found = [];
  for (let k = 0; k < toks.length; k++) {
    const kw = word(toks[k]);
    if (!kw) continue;
    const next = word(toks[k + 1]);
    const prev = previousKey(toks, k);
    const d = toks[k].d;
    if (kw === 'DELETE' && next === 'FROM') {
      found.push({ kind: 'DELETE', k, d });
    } else if (kw === 'INSERT' && next === 'INTO') {
      found.push({ kind: 'INSERT', k, d });
    } else if (kw === 'MERGE' && next === 'INTO') {
      found.push({ kind: 'MERGE', k, d });
    } else if (
      kw === 'UPDATE' &&
      next !== 'SET' && // ON CONFLICT DO UPDATE SET, MERGE ... THEN UPDATE SET
      !NOT_A_STATEMENT_AFTER.has(prev) &&
      findAtDepth(toks, k + 1, d, 'SET') !== -1
    ) {
      found.push({ kind: 'UPDATE', k, d });
    } else if (kw === 'TRUNCATE' && !NOT_A_STATEMENT_AFTER.has(prev)) {
      found.push({ kind: 'TRUNCATE', k, d });
    }
  }
  return found;
}

/**
 * Reads `name`, `schema.name` or `"Quoted"."Name"` starting at token k.
 * Returns { text (as written, quotes kept, for to_regclass), last (the last
 * part, case-folded the way PostgreSQL does), end } or null.
 */
function readQualifiedName(toks, k) {
  const parts = [];
  while (k < toks.length && (toks[k].t === 'w' || toks[k].t === 'id')) {
    parts.push(toks[k]);
    k++;
    if (toks[k]?.t === '.' && (toks[k + 1]?.t === 'w' || toks[k + 1]?.t === 'id')) {
      k++;
      continue;
    }
    break;
  }
  if (parts.length === 0) return null;
  return {
    text: parts.map(p => (p.t === 'id' ? `"${p.v.replace(/"/g, '""')}"` : p.v)).join('.'),
    last: fold(parts[parts.length - 1]),
    end: k,
  };
}

// ---------------------------------------------------------------------------
// applyGuardrails: destructive patterns, blocked before anything runs
// ---------------------------------------------------------------------------

/** DO and CALL run code that the guardrails cannot read. Always on. */
function opaqueCode(toks) {
  const first = word(toks[0]);
  if (first === 'DO') return 'DO blocks run code the guardrails cannot inspect';
  if (first === 'CALL') return 'CALL runs a procedure the guardrails cannot inspect';
  return null;
}

/** DELETE/UPDATE without a WHERE of their own (anywhere), and any TRUNCATE. */
function unsafeDml(toks) {
  for (const s of dmlStarts(toks)) {
    if (s.kind === 'TRUNCATE') return { reason: 'TRUNCATE blocked (use DELETE ... WHERE)', k: s.k };
    if ((s.kind === 'DELETE' || s.kind === 'UPDATE') && findAtDepth(toks, s.k + 1, s.d, 'WHERE') === -1) {
      return { reason: `${s.kind} without WHERE`, k: s.k };
    }
  }
  return null;
}

// Snapshot tables created by snapshot_table may be dropped.
const SNAPSHOT_TABLE = /^tmp_\w+_backup_\d{8}$/;
// ALTER ... DROP followed by these does not remove data.
const ALTER_DROP_ALLOWED = new Set(['CONSTRAINT', 'DEFAULT', 'NOT', 'EXPRESSION', 'IDENTITY']);

/** DROP TABLE [IF EXISTS] tmp_..._backup_YYYYMMDD [, ...] [RESTRICT], without CASCADE. */
function isSnapshotDrop(toks) {
  if (word(toks[1]) !== 'TABLE') return false;
  let k = 2;
  if (word(toks[k]) === 'IF' && word(toks[k + 1]) === 'EXISTS') k += 2;
  let names = 0;
  while (k < toks.length) {
    const q = readQualifiedName(toks, k);
    if (!q || !SNAPSHOT_TABLE.test(q.last)) return false;
    names++;
    k = q.end;
    if (k >= toks.length) break;
    if (toks[k].t === ',') {
      k++;
      continue;
    }
    return word(toks[k]) === 'RESTRICT' && k === toks.length - 1 && names > 0;
  }
  return names > 0;
}

/** Any DROP statement (except snapshot tables) and ALTER ... DROP [COLUMN]. */
function dangerousDrop(toks) {
  const first = word(toks[0]);
  if (first === 'DROP') {
    if (isSnapshotDrop(toks)) return null;
    return `DROP ${word(toks[1]) ?? ''}`.trim();
  }
  if (first === 'ALTER') {
    for (let k = 1; k < toks.length; k++) {
      if (word(toks[k]) === 'DROP' && !ALTER_DROP_ALLOWED.has(word(toks[k + 1]))) {
        return `ALTER ... DROP ${word(toks[k + 1]) ?? 'column'}`;
      }
    }
  }
  return null;
}

/**
 * Applies the static guardrails. Each check must hold under every reading of
 * the text (see lex()). Only the literal 'false' disables a flag.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function applyGuardrails(sql, env) {
  for (const statements of lex(sql)) {
    for (const toks of statements) {
      const opaque = opaqueCode(toks);
      if (opaque) {
        return { ok: false, reason: `GUARDRAIL: ${opaque}. Send the statements themselves instead.` };
      }

      if (env.GUARD_BLOCK_DML_WITHOUT_WHERE !== 'false') {
        const r = unsafeDml(toks);
        if (r) {
          return { ok: false, reason: `GUARDRAIL: ${r.reason}. Statement: ${snippet(sql, toks, r.k)}` };
        }
      }

      if (env.GUARD_BLOCK_DROP !== 'false') {
        const r = dangerousDrop(toks);
        if (r) {
          return {
            ok: false,
            reason:
              `GUARDRAIL: destructive DROP blocked (${r}). ` +
              'Only snapshot tables (tmp_*_backup_YYYYMMDD) may be dropped.',
          };
        }
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// checkStatementShape: what each tool accepts at all
// ---------------------------------------------------------------------------

const READ_COMMANDS = new Set(['SELECT', 'WITH', 'EXPLAIN']);

const TX_CONTROL =
  'the server opens and commits the transaction itself; use execute_transaction to group statements';
const SESSION_STATE = 'the server manages the session (timeouts, role, search_path) of its pooled connections';
const WRITE_FORBIDDEN = {
  BEGIN: TX_CONTROL,
  START: TX_CONTROL,
  COMMIT: TX_CONTROL,
  END: TX_CONTROL,
  ROLLBACK: TX_CONTROL,
  ABORT: TX_CONTROL,
  SAVEPOINT: TX_CONTROL,
  RELEASE: TX_CONTROL,
  PREPARE: SESSION_STATE,
  EXECUTE: SESSION_STATE,
  DEALLOCATE: SESSION_STATE,
  SET: SESSION_STATE,
  RESET: SESSION_STATE,
  DISCARD: SESSION_STATE,
  LISTEN: SESSION_STATE,
  EXPLAIN: 'EXPLAIN belongs in query (EXPLAIN ANALYZE executes the statement)',
};

/**
 * Checks the shape of a statement for a tool:
 *   'read'  (query): exactly one SELECT/WITH/EXPLAIN, no data-modifying
 *           statement anywhere in it, no SELECT ... INTO;
 *   'write' (execute, each item of execute_transaction, snapshot_table):
 *           exactly one statement, no transaction control, no session command
 *           (SET, RESET, DISCARD, PREPARE, EXECUTE, DEALLOCATE, LISTEN; SET
 *           CONSTRAINTS is transaction-scoped and allowed), no EXPLAIN. A
 *           function can still change the session (set_config); tools.js
 *           resets it with DISCARD ALL after every call.
 * Returns { ok: true, command } or { ok: false, reason }.
 */
export function checkStatementShape(sql, mode) {
  const fail = reason => ({ ok: false, reason: `GUARDRAIL: ${reason}` });
  let command = null;

  for (const statements of lex(sql)) {
    if (statements.length === 0) return fail('empty statement.');
    if (statements.length > 1) {
      return fail(
        mode === 'read'
          ? `query runs a single statement; found ${statements.length}.`
          : `one statement per call; found ${statements.length}. ` +
            'Send several statements through execute_transaction, one per item.'
      );
    }

    const toks = statements[0];
    const first = word(toks[0]);
    command ??= first;

    if (mode === 'read') {
      if (!READ_COMMANDS.has(first)) {
        return fail('query only accepts SELECT/WITH/EXPLAIN. Use execute for DML/DDL.');
      }
      const dml = dmlStarts(toks)[0];
      if (dml) return fail(`query is read-only and the statement contains ${dml.kind}. Use execute.`);
      if (first !== 'EXPLAIN' && toks.some(tk => tk.d === 0 && word(tk) === 'INTO')) {
        return fail('SELECT ... INTO creates a table. Use execute with CREATE TABLE ... AS.');
      }
    } else {
      const why = WRITE_FORBIDDEN[first];
      if (why && !(first === 'SET' && word(toks[1]) === 'CONSTRAINTS')) {
        return fail(`${first} is not accepted here: ${why}.`);
      }
    }
  }
  return { ok: true, command };
}

// ---------------------------------------------------------------------------
// needsConfirmation: statements that require i_understand=true
// ---------------------------------------------------------------------------

// A WHERE made only of these words, literals and operators references no
// column: it matches every row or none (WHERE 1=1, WHERE (2=2), WHERE NOT FALSE).
const CONSTANT_WORDS = new Set(['TRUE', 'FALSE', 'NOT', 'AND', 'OR', 'NULL', 'IS', 'IN', 'BETWEEN', 'LIKE', 'ILIKE']);

function isConstant(toks) {
  return toks.length > 0 && toks.every(tk => tk.t !== 'id' && (tk.t !== 'w' || CONSTANT_WORDS.has(tk.u)));
}

/**
 * Fast, static reasons to ask for i_understand=true before running anything.
 * The real limit is the row count measured inside the transaction
 * (GUARD_MAX_ROWS, in tools.js); this only catches what is visible in the text.
 * Returns a reason string or null.
 */
export function needsConfirmation(sql) {
  for (const statements of lex(sql)) {
    for (const toks of statements) {
      for (const s of dmlStarts(toks)) {
        if (s.kind === 'TRUNCATE') continue; // applyGuardrails blocks it

        if (s.d > 0) {
          return (
            `${s.kind} inside a WITH clause or subquery: its row count is not measured, ` +
            'so the row limit cannot protect it'
          );
        }

        if (s.kind === 'DELETE' || s.kind === 'UPDATE') {
          const w = findAtDepth(toks, s.k + 1, s.d, 'WHERE');
          if (w === -1) continue; // applyGuardrails blocks it
          const returning = findAtDepth(toks, w + 1, s.d, 'RETURNING');
          const cond = toks.slice(w + 1, returning === -1 ? scopeEnd(toks, w + 1, s.d) : returning);
          if (word(cond[0]) !== 'CURRENT' && isConstant(cond)) {
            return `${s.kind} whose WHERE references no column (${snippet(sql, toks, w, 80)})`;
          }
        }

        if (s.kind === 'MERGE') {
          const on = findAtDepth(toks, s.k + 1, s.d, 'ON');
          if (on === -1) continue;
          const when = findAtDepth(toks, on + 1, s.d, 'WHEN');
          if (isConstant(toks.slice(on + 1, when === -1 ? toks.length : when))) {
            return 'MERGE whose join condition references no column';
          }
        }
      }
    }
  }
  return null;
}

/**
 * Kind of the first data-modifying statement found anywhere in `sql`
 * (INSERT, UPDATE, DELETE, MERGE, TRUNCATE), or null.
 */
export function findDataModification(sql) {
  for (const statements of lex(sql)) {
    for (const toks of statements) {
      const s = dmlStarts(toks)[0];
      if (s) return s.kind;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// findWriteTargets: tables whose sequence must not fall behind MAX(key)
// ---------------------------------------------------------------------------

/**
 * Columns of an INSERT whose value comes from MAX(<that same column>), the
 * signature of the sequence-drift incident (see README). `k` is the token
 * right after the table name.
 */
function maxComputedColumns(toks, insert, k) {
  if (word(toks[k]) === 'AS') k += 2; // INSERT INTO t AS alias (...)
  if (toks[k]?.t !== '(') return [];

  const listDepth = toks[k].d;
  const columns = [];
  let j = k + 1;
  for (; j < toks.length && !(toks[j].t === ')' && toks[j].d === listDepth); j++) {
    if (toks[j].d === listDepth + 1 && (toks[j].t === 'w' || toks[j].t === 'id')) columns.push(fold(toks[j]));
  }

  const hits = [];
  const end = scopeEnd(toks, j, insert.d);
  for (let m = j; m < end; m++) {
    if (word(toks[m]) !== 'MAX' || toks[m + 1]?.t !== '(') continue;
    const q = readQualifiedName(toks, m + 2);
    if (!q || toks[q.end]?.t !== ')') continue;
    if (columns.includes(q.last) && !hits.includes(q.last)) hits.push(q.last);
  }
  return hits;
}

/**
 * Tables that receive rows (INSERT INTO, MERGE INTO), wherever the statement
 * sits, with the columns computed from MAX() of themselves.
 * Returns [{ table, maxColumns }], `table` as written (quotes kept).
 *
 * This is only the list of candidates. Whether a table has a sequence, and
 * whether the sequence fell behind, is decided against the catalog and the
 * data inside the transaction (tools.js), so an INSERT without a column list,
 * the second INSERT of a script or a nextval() in another column cannot slip
 * past it.
 */
export function findWriteTargets(sql) {
  const byTable = new Map();
  for (const statements of lex(sql)) {
    for (const toks of statements) {
      for (const s of dmlStarts(toks)) {
        if (s.kind !== 'INSERT' && s.kind !== 'MERGE') continue;
        const name = readQualifiedName(toks, s.k + 2);
        if (!name) continue;
        const entry = byTable.get(name.text) ?? { table: name.text, maxColumns: [] };
        byTable.set(name.text, entry);
        if (s.kind === 'INSERT') {
          for (const col of maxComputedColumns(toks, s, name.end)) {
            if (!entry.maxColumns.includes(col)) entry.maxColumns.push(col);
          }
        }
      }
    }
  }
  return [...byTable.values()];
}

/**
 * Text of a plain '...' or $tag$...$tag$ literal, or null when it cannot be
 * known for sure (E'' strings, or a backslash, whose meaning depends on
 * standard_conforming_strings).
 */
function literalValue(tk) {
  if (tk?.t !== 'str') return null;
  const raw = tk.v;
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    const inner = raw.slice(1, -1);
    return inner.includes('\\') ? null : inner.replace(/''/g, "'");
  }
  const m = /^(\$[^$]*\$)([\s\S]*)\1$/.exec(raw);
  return m ? m[2] : null;
}

/**
 * Statements that move a sequence directly. setval is NOT transactional in
 * PostgreSQL: a rollback does not undo it, so these sequences must be checked
 * (and, after a rollback, repaired) like the ones fed by an INSERT.
 *
 * Returns {
 *   sequences:  sequence names as written, from setval('<name>'[::regclass], ...)
 *               and ALTER SEQUENCE <name>;
 *   tables:     [{ table, maxColumns }] from setval(pg_get_serial_sequence('t', 'c'), ...)
 *               and ALTER TABLE <t> ... RESTART (identity columns);
 *   unresolved: setval calls whose sequence cannot be read from the text
 *               (computed name), which the tools refuse.
 * }
 */
export function findSequenceChanges(sql) {
  const sequences = [];
  const tables = [];
  const unresolved = [];
  const addSequence = name => sequences.includes(name) || sequences.push(name);

  for (const statements of lex(sql)) {
    for (const toks of statements) {
      if (word(toks[0]) === 'ALTER' && word(toks[1]) === 'SEQUENCE') {
        let k = 2;
        if (word(toks[k]) === 'IF' && word(toks[k + 1]) === 'EXISTS') k += 2;
        const name = readQualifiedName(toks, k);
        if (name) addSequence(name.text);
      }
      if (word(toks[0]) === 'ALTER' && word(toks[1]) === 'TABLE' && toks.some(tk => word(tk) === 'RESTART')) {
        let k = 2;
        if (word(toks[k]) === 'IF' && word(toks[k + 1]) === 'EXISTS') k += 2;
        if (word(toks[k]) === 'ONLY') k++;
        const name = readQualifiedName(toks, k);
        if (name) tables.push({ table: name.text, maxColumns: [] });
      }

      for (let k = 0; k < toks.length; k++) {
        // setval(...) or "setval"(...): a quoted name calls the same function.
        const isSetval = word(toks[k]) === 'SETVAL' || (toks[k].t === 'id' && toks[k].v === 'setval');
        if (!isSetval || toks[k + 1]?.t !== '(') continue;
        const a = k + 2;

        // setval('name', ...) or setval('name'::regclass, ...)
        const name = literalValue(toks[a]);
        const plain = toks[a + 1]?.t === ',';
        const cast =
          toks[a + 1]?.t === ':' && toks[a + 2]?.t === ':' && word(toks[a + 3]) === 'REGCLASS' && toks[a + 4]?.t === ',';
        if (name !== null && (plain || cast)) {
          addSequence(name);
          continue;
        }

        // setval(pg_get_serial_sequence('table', 'column'), ...)
        if (word(toks[a]) === 'PG_GET_SERIAL_SEQUENCE' && toks[a + 1]?.t === '(') {
          const table = literalValue(toks[a + 2]);
          const column = literalValue(toks[a + 4]);
          if (table !== null && column !== null && toks[a + 3]?.t === ',' && toks[a + 5]?.t === ')') {
            tables.push({ table, maxColumns: [column] });
            continue;
          }
        }

        unresolved.push(snippet(sql, toks, k, 120));
      }
    }
  }
  return { sequences, tables, unresolved };
}
