// Tool definitions and handlers. Every handler receives a context
// { env, getPool } so the tests can hand it a fake pool; index.js wires the
// real one.
//
// Every call holds one pooled connection for its whole duration, in a
// transaction the server opens and closes itself, and each statement goes
// through the extended protocol (queryMode: 'extended'), which accepts exactly
// one statement: a `;` cannot smuggle a second one in, whatever the static
// checks missed. The session is reset (DISCARD ALL) before the connection goes
// back to the pool.

import {
  applyGuardrails,
  checkStatementShape,
  findDataModification,
  findSequenceChanges,
  findWriteTargets,
  needsConfirmation,
} from './guardrails.js';
import { intFromEnv } from './db.js';
import { audit } from './audit.js';

// =============================================================================
// Tool definitions
// =============================================================================

export const TOOLS = [
  {
    name: 'query',
    description:
      'Runs ONE SELECT/WITH/EXPLAIN inside a READ ONLY transaction that is always rolled back. ' +
      'Statements that modify data are rejected. Returns at most GUARD_QUERY_MAX_ROWS rows (default 1000) ' +
      'and says when the result was cut. Use it for investigation and analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One SELECT, WITH or EXPLAIN statement' },
      },
      required: ['sql'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'execute',
    description:
      'Runs ONE DML/DDL statement (UPDATE, INSERT, DELETE, ALTER, CREATE) in its own transaction, behind guardrails. ' +
      'Blocked: DELETE/UPDATE without their own WHERE (anywhere in the statement), TRUNCATE, DROP (except ' +
      'snapshot tables), ALTER ... DROP COLUMN, DO/CALL, BEGIN/COMMIT, SET and EXPLAIN. ' +
      'Requires i_understand=true when the statement changes more than GUARD_MAX_ROWS rows (default 1000), ' +
      'has a WHERE made only of constants (e.g. WHERE 1=1), or hides DML inside a WITH. ' +
      'Rolled back if it leaves a sequence behind MAX of its key. Commits only when every check passes, ' +
      'and writes an audit log entry.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One SQL statement (no BEGIN/COMMIT)' },
        i_understand: {
          type: 'boolean',
          description: 'Boolean true confirms a large or catch-all operation. Strings are rejected.',
          default: false,
        },
        description: {
          type: 'string',
          description: 'Short description of what the statement does (stored in the audit log)',
        },
      },
      required: ['sql', 'description'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'execute_transaction',
    description:
      'Runs several statements inside ONE transaction: all of them commit, or none. ' +
      'Every statement goes through the same checks as execute. The sequence check runs after the last ' +
      'statement, so an INSERT with explicit keys can be followed by its setval. ' +
      'Use it for operations that must be atomic (e.g. backup + delete + insert).',
    inputSchema: {
      type: 'object',
      properties: {
        statements: {
          type: 'array',
          items: { type: 'string' },
          description: 'SQL statements, one per item (no BEGIN/COMMIT: the server manages the transaction)',
        },
        i_understand: { type: 'boolean', default: false },
        description: { type: 'string', description: 'Description of the whole set' },
      },
      required: ['statements', 'description'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'snapshot_table',
    description:
      'Runs CREATE TABLE tmp_<source>[_<suffix>]_backup_YYYYMMDD AS SELECT * FROM <source> [WHERE ...]. ' +
      'Use it BEFORE a destructive operation so a manual rollback is possible afterwards. ' +
      'The name must fit in 63 bytes. Returns the snapshot table name and the number of rows copied.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source table (e.g. tab_invoice)' },
        where: {
          type: 'string',
          description:
            'Optional condition, without the WHERE keyword (e.g. status = \'OPEN\'). One condition only: ' +
            'no ";", no data-modifying statements and no setval. Without it the whole table is copied (dangerous on large tables)',
        },
        suffix: {
          type: 'string',
          description: 'Optional suffix for the name (e.g. "phase_a") -> tmp_source_phase_a_backup_YYYYMMDD',
        },
      },
      required: ['source'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

// =============================================================================
// Helpers
// =============================================================================

class GuardViolation extends Error {}

function formatResult(rows, summary) {
  return { content: [{ type: 'text', text: JSON.stringify({ summary, rows }) }] };
}

function formatError(reason) {
  return { content: [{ type: 'text', text: `Error: ${reason}` }], isError: true };
}

const isNonEmptyString = v => typeof v === 'string' && v.trim().length > 0;

function todayYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * i_understand must be a real boolean. Models often send booleans as strings,
 * and the string "false" is truthy: a loose check would read it as consent.
 */
function readConfirmation(args) {
  if (args.i_understand === undefined) return { ok: true, value: false };
  if (typeof args.i_understand !== 'boolean') {
    return { ok: false, reason: `i_understand must be a boolean (true or false), got ${JSON.stringify(args.i_understand)}` };
  }
  return { ok: true, value: args.i_understand };
}

async function connect(ctx, auditEntry) {
  try {
    return { client: await ctx.getPool().connect() };
  } catch (e) {
    await audit(ctx.env, { ...auditEntry, error: `connection failed: ${e.message}` });
    return { error: formatError(`Could not connect to the database: ${e.message}`) };
  }
}

/**
 * Ends the transaction. Returns the error when ROLLBACK itself fails, so the
 * caller hands it to releaseClean() and the pool discards the connection
 * instead of lending out a broken one.
 */
async function rollbackQuietly(client) {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (e) {
    return e;
  }
}

/**
 * Hands the connection back to the pool with a clean session. The static
 * checks refuse SET and its kin, but a function can still change the session
 * (set_config(..., false), a temporary table, a session advisory lock), and on
 * a pooled connection that would reach later calls. DISCARD ALL resets it; the
 * pool's timeouts and application_name survive, because they are startup
 * parameters and RESET returns to them. A connection whose ROLLBACK (`broken`)
 * or reset fails is discarded instead of going back to the pool.
 */
async function releaseClean(client, broken) {
  let err = broken;
  if (!err) {
    try {
      await client.query('DISCARD ALL');
    } catch (e) {
      err = e;
    }
  }
  client.release(err);
}

const quoteIdent = name => `"${String(name).replace(/"/g, '""')}"`;

// =============================================================================
// Sequence check
// =============================================================================

// For a table that receives rows: its integer key columns (the single-column
// primary key, plus any column the INSERT computes from MAX() of itself) and
// the sequence that feeds each one, if any:
//   1. a nextval default on the column (serial/identity);
//   2. the optional legacy naming convention GUARD_LEGACY_TABLE_PREFIX /
//      GUARD_LEGACY_SEQUENCE_PREFIX (tab_<base> is fed by gen_<base>).
// Sequences named after a COLUMN are deliberately not matched: in legacy
// schemas the same column name is reused by many tables, so the mapping is
// ambiguous and the check would compare against the wrong table.
const SEQUENCE_TARGETS_SQL = `
  WITH target AS (
    SELECT c.oid, n.nspname AS sch, c.relname AS tab
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = to_regclass($1) AND c.relkind IN ('r', 'p')
  ),
  cols AS (
    SELECT t.oid, a.attname
      FROM target t
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE a.atttypid IN ('int2'::regtype, 'int4'::regtype, 'int8'::regtype, 'numeric'::regtype)
       AND (a.attname::text = ANY($2::text[])
            OR EXISTS (SELECT 1
                         FROM pg_catalog.pg_index i
                        WHERE i.indrelid = t.oid AND i.indisprimary
                          AND i.indnatts = 1 AND i.indkey[0] = a.attnum))
  )
  SELECT quote_ident(t.sch) || '.' || quote_ident(t.tab) AS table_name,
         c.attname::text AS column_name,
         COALESCE(
           pg_get_serial_sequence(quote_ident(t.sch) || '.' || quote_ident(t.tab), c.attname::text),
           (SELECT quote_ident(sn.nspname) || '.' || quote_ident(s.relname)
              FROM pg_catalog.pg_class s
              JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
             WHERE s.relkind = 'S'
               AND sn.nspname = t.sch
               AND $3::text <> ''
               AND left(t.tab, length($3::text)) = $3::text
               AND s.relname = $4::text || substring(t.tab from length($3::text) + 1)
             LIMIT 1)
         ) AS sequence_name
    FROM target t
    JOIN cols c ON c.oid = t.oid`;

// Tables fed by a sequence that a statement moves directly (setval, ALTER
// SEQUENCE): the owner of a serial/identity sequence, with its column, and the
// table of the legacy naming convention.
const SEQUENCE_OWNERS_SQL = `
  SELECT quote_ident(tn.nspname) || '.' || quote_ident(t.relname) AS table_name,
         a.attname::text AS column_name
    FROM pg_catalog.pg_class s
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = s.oid
                               AND d.refclassid = 'pg_catalog.pg_class'::regclass
                               AND d.refobjsubid > 0 AND d.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class t ON t.oid = d.refobjid AND t.relkind IN ('r', 'p')
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
   WHERE s.oid = to_regclass($1) AND s.relkind = 'S'
  UNION
  SELECT quote_ident(tn.nspname) || '.' || quote_ident(t.relname), NULL
    FROM pg_catalog.pg_class s
    JOIN pg_catalog.pg_class t ON t.relnamespace = s.relnamespace AND t.relkind IN ('r', 'p')
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
   WHERE s.oid = to_regclass($1) AND s.relkind = 'S'
     AND $2::text <> '' AND $3::text <> ''
     AND left(s.relname, length($3::text)) = $3::text
     AND t.relname = $2::text || substring(s.relname from length($3::text) + 1)`;

/** Is the sequence behind MAX(column)? Names come from the catalog query above. */
async function measureSequence(client, probe) {
  const { rows } = await client.query(
    `SELECT m.v::text AS max_value,
            s.last_value::text AS last_value,
            (CASE WHEN s.is_called THEN s.last_value ELSE s.last_value - 1 END)::text AS used,
            (m.v IS NOT NULL
             AND m.v > CASE WHEN s.is_called THEN s.last_value ELSE s.last_value - 1 END) AS behind
       FROM (SELECT MAX(${quoteIdent(probe.column)}) AS v FROM ${probe.table}) m, ${probe.seq} s`
  );
  return rows[0];
}

/**
 * Before the transaction: finds the (table, key, sequence) triples the
 * statements can affect and records whether each sequence is already behind.
 * A lookup that fails is logged and skipped (fail open), as it runs outside
 * the transaction and must not take the operation down.
 */
async function prepareSequenceProbes(client, statements, env) {
  if (env.GUARD_BLOCK_MANUAL_PK === 'false') return [];

  const targets = new Map();
  const addTarget = (table, columns) => {
    const cols = targets.get(table) ?? [];
    for (const c of columns) if (c && !cols.includes(c)) cols.push(c);
    targets.set(table, cols);
  };
  const sequences = [];
  for (const sql of statements) {
    for (const t of findWriteTargets(sql)) addTarget(t.table, t.maxColumns);
    const changes = findSequenceChanges(sql);
    for (const t of changes.tables) addTarget(t.table, t.maxColumns);
    for (const seq of changes.sequences) if (!sequences.includes(seq)) sequences.push(seq);
  }
  for (const seq of sequences) {
    try {
      const { rows } = await client.query(SEQUENCE_OWNERS_SQL, [
        seq,
        env.GUARD_LEGACY_TABLE_PREFIX || null,
        env.GUARD_LEGACY_SEQUENCE_PREFIX || null,
      ]);
      for (const r of rows) addTarget(r.table_name, [r.column_name]);
    } catch (e) {
      console.error(`[guardrail] owner lookup failed for ${seq}: ${e.message}`);
    }
  }

  const probes = [];
  const seen = new Set();
  for (const [table, maxColumns] of targets) {
    let rows;
    try {
      ({ rows } = await client.query(SEQUENCE_TARGETS_SQL, [
        table,
        maxColumns,
        env.GUARD_LEGACY_TABLE_PREFIX || null,
        env.GUARD_LEGACY_SEQUENCE_PREFIX || null,
      ]));
    } catch (e) {
      console.error(`[guardrail] sequence lookup failed for ${table}: ${e.message}`);
      continue;
    }
    for (const r of rows) {
      const key = `${r.table_name}|${r.column_name}`;
      if (!r.sequence_name || seen.has(key)) continue;
      seen.add(key);
      const probe = { table: r.table_name, column: r.column_name, seq: r.sequence_name };
      try {
        probe.before = await measureSequence(client, probe);
      } catch (e) {
        console.error(`[guardrail] could not read ${probe.seq} / MAX(${probe.column}): ${e.message}`);
        continue;
      }
      probes.push(probe);
    }
  }
  return probes;
}

/**
 * Inside the transaction, after the last statement: the invariant itself.
 * A sequence that was in step before and is behind MAX(key) now would make
 * the application's next nextval collide with an existing key (the incident in
 * the README), so the transaction is rolled back. Errors here propagate and
 * roll back too (fail closed). A sequence that was already behind is reported
 * as a warning, since this call did not cause it.
 */
async function checkSequenceProbes(client, probes) {
  const warnings = [];
  for (const p of probes) {
    const after = await measureSequence(client, p);
    if (!after.behind) continue;
    if (p.before.behind) {
      warnings.push(
        `${p.seq} was already behind MAX(${p.column}) of ${p.table} before this call ` +
          `(last_value ${after.last_value}, MAX ${after.max_value}); resynchronize it with setval.`
      );
      continue;
    }
    throw new GuardViolation(
      `GUARDRAIL: these statements leave the sequence ${p.seq} (last_value ${after.last_value}) behind ` +
        `MAX(${p.column}) = ${after.max_value} in ${p.table}. The next nextval would return a key that ` +
        `already exists, and every later INSERT from the application would fail until the sequence is ` +
        `resynchronized. Everything was rolled back.\n` +
        `Fix it in one of these ways:\n` +
        `  1. (preferred) use nextval('${p.seq}') for ${p.column} instead of MAX() or explicit values;\n` +
        `  2. if the explicit keys are really needed, send the statements through execute_transaction ` +
        `ending with SELECT setval('${p.seq}', (SELECT MAX(${quoteIdent(p.column)}) FROM ${p.table}));`
    );
  }
  return warnings;
}

/**
 * After a ROLLBACK. setval is not transactional, so a rolled-back setval
 * still holds: a sequence that this call left behind MAX(key) is moved to
 * MAX(key), or back to where it was before the call if that is higher.
 * Returns human-readable notes for the error message and the audit log.
 */
async function repairSequences(client, probes) {
  const notes = [];
  for (const p of probes) {
    try {
      const now = await measureSequence(client, p);
      if (!now.behind || p.before.behind) continue;
      const { rows } = await client.query(
        `SELECT setval($1::regclass, GREATEST(m.v, $2::bigint)::bigint)::text AS value
           FROM (SELECT MAX(${quoteIdent(p.column)}) AS v FROM ${p.table}) m`,
        [p.seq, p.before.used]
      );
      notes.push(
        `setval is not transactional, so the rollback did not undo it: the server moved ${p.seq} ` +
          `back to ${rows[0].value} (MAX of ${p.column}, or its position before this call if higher).`
      );
    } catch (e) {
      notes.push(
        `${p.seq} may still be behind MAX(${p.column}) of ${p.table} and could not be repaired ` +
          `(${e.message}). Run SELECT setval('${p.seq}', (SELECT MAX(${quoteIdent(p.column)}) FROM ${p.table})); by hand.`
      );
    }
  }
  return notes;
}

// =============================================================================
// Tool implementations
// =============================================================================

async function toolQuery(ctx, args) {
  const { env } = ctx;
  const { sql } = args;
  if (!isNonEmptyString(sql)) return formatError('Parameter sql is required (non-empty string)');

  const shape = checkStatementShape(sql, 'read');
  if (!shape.ok) {
    await audit(env, { event: 'query_blocked', sql: sql.slice(0, 2000), reason: shape.reason });
    return formatError(shape.reason);
  }

  const maxRows = Math.max(1, intFromEnv(env, 'GUARD_QUERY_MAX_ROWS', 1000));
  const conn = await connect(ctx, { event: 'query_error', sql: sql.slice(0, 2000) });
  if (conn.error) return conn.error;
  const { client } = conn;

  let broken;
  try {
    // READ ONLY makes the server refuse any write, including one hidden in a
    // function call; the ROLLBACK in `finally` discards everything else.
    await client.query('BEGIN TRANSACTION READ ONLY');
    let result;
    if (shape.command === 'EXPLAIN') {
      result = await client.query({ text: sql, queryMode: 'extended' });
    } else {
      // DECLARE only accepts a plain query (a data-modifying WITH is refused),
      // and FETCH bounds how many rows come back into memory.
      await client.query({ text: `DECLARE guard_query_cursor NO SCROLL CURSOR FOR ${sql}`, queryMode: 'extended' });
      result = await client.query(`FETCH FORWARD ${maxRows + 1} FROM guard_query_cursor`);
    }

    const truncated = result.rows.length > maxRows;
    const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
    return formatResult(rows, {
      type: 'query',
      rowCount: rows.length,
      truncated,
      ...(truncated && {
        note: `Only the first ${maxRows} rows (GUARD_QUERY_MAX_ROWS). Add a LIMIT, a filter or an aggregate.`,
      }),
      cols: result.fields?.map(f => f.name) ?? [],
    });
  } catch (e) {
    await audit(env, { event: 'query_error', sql: sql.slice(0, 2000), error: e.message });
    return formatError(`Postgres error: ${e.message}`);
  } finally {
    broken = await rollbackQuietly(client);
    await releaseClean(client, broken);
  }
}

const ROW_LIMITED_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/**
 * Shared by execute (one statement) and execute_transaction (several).
 * Static checks first, then BEGIN, the statements, the row limit, the
 * sequence invariant and COMMIT. Any failure rolls everything back.
 */
async function runWrite(ctx, { kind, statements, confirmed, description }) {
  const { env } = ctx;
  const logged =
    kind === 'execute'
      ? { sql: statements[0].slice(0, 2000) }
      : { statements: statements.map(s => s.slice(0, 2000)) };
  const block = async reason => {
    await audit(env, { event: `${kind}_blocked`, description, ...logged, reason });
    return formatError(reason);
  };

  for (let i = 0; i < statements.length; i++) {
    const prefix = statements.length > 1 ? `Statement ${i + 1}/${statements.length} blocked: ` : '';
    const failed = [checkStatementShape(statements[i], 'write'), applyGuardrails(statements[i], env)].find(c => !c.ok);
    if (failed) return block(prefix + failed.reason);
    if (!confirmed) {
      const why = needsConfirmation(statements[i]);
      if (why) return block(`${prefix}GUARDRAIL: ${why}. Confirm with i_understand=true.`);
    }
    if (env.GUARD_BLOCK_MANUAL_PK !== 'false') {
      const [computed] = findSequenceChanges(statements[i]).unresolved;
      if (computed) {
        return block(
          `${prefix}GUARDRAIL: cannot tell which sequence this setval moves (${computed}). ` +
            "Name it with a literal, setval('schema.sequence', ...), or with " +
            "setval(pg_get_serial_sequence('table', 'column'), ...)."
        );
      }
    }
  }

  const conn = await connect(ctx, { event: `${kind}_error`, description, ...logged });
  if (conn.error) return conn.error;
  const { client } = conn;

  const maxRows = intFromEnv(env, 'GUARD_MAX_ROWS', 1000);
  const results = [];
  const start = Date.now();
  let probes = [];
  let broken;
  try {
    probes = await prepareSequenceProbes(client, statements, env);

    // Write-ahead entry: if the process dies after COMMIT, the log still
    // shows what was about to run.
    await audit(env, { event: `${kind}_started`, description, ...logged });

    await client.query('BEGIN');
    let lastRows = [];
    for (let i = 0; i < statements.length; i++) {
      const r = await client.query({ text: statements[i], queryMode: 'extended' });
      results.push({ idx: i + 1, command: r.command, rowCount: r.rowCount });
      lastRows = r.rows ?? [];
      if (!confirmed && ROW_LIMITED_COMMANDS.has(r.command) && r.rowCount > maxRows) {
        throw new GuardViolation(
          `GUARDRAIL: statement ${i + 1} changed ${r.rowCount} rows, above GUARD_MAX_ROWS (${maxRows}). ` +
            'Everything was rolled back. Repeat with i_understand=true if that many rows is intended.'
        );
      }
    }
    const warnings = await checkSequenceProbes(client, probes);
    await client.query('COMMIT');

    const elapsed = Date.now() - start;
    const totalRows = results.reduce((s, r) => s + (r.rowCount ?? 0), 0);
    await audit(env, {
      event: `${kind}_ok`,
      description,
      ...logged,
      results,
      total_rowCount: totalRows,
      elapsed_ms: elapsed,
      ...(warnings.length > 0 && { warnings }),
    });

    const summary = {
      type: kind,
      ...(kind === 'execute'
        ? { command: results[0].command, rowCount: results[0].rowCount }
        : { statements: statements.length, total_rowCount: totalRows }),
      elapsed_ms: elapsed,
      description,
      ...(warnings.length > 0 && { warnings }),
    };
    return formatResult(kind === 'execute' ? lastRows : results, summary);
  } catch (e) {
    broken = await rollbackQuietly(client);
    const repairs = broken
      ? probes.map(p => `The connection broke during the rollback: check ${p.seq} against MAX(${p.column}) of ${p.table}.`)
      : await repairSequences(client, probes);
    const tail = repairs.length > 0 ? `\n${repairs.join('\n')}` : '';
    const repaired = repairs.length > 0 ? { sequence_repairs: repairs } : {};
    if (e instanceof GuardViolation) {
      await audit(env, { event: `${kind}_blocked`, description, ...logged, reason: e.message, partial_results: results, ...repaired });
      return formatError(e.message + tail);
    }
    await audit(env, { event: `${kind}_error`, description, ...logged, error: e.message, partial_results: results, ...repaired });
    const prefix = kind === 'execute' ? 'Postgres error (rolled back)' : 'Transaction failed (rolled back)';
    return formatError(`${prefix}: ${e.message}${tail}`);
  } finally {
    await releaseClean(client, broken);
  }
}

async function toolExecute(ctx, args) {
  const { sql, description } = args;
  if (!isNonEmptyString(sql)) return formatError('Parameter sql is required (non-empty string)');
  if (!isNonEmptyString(description)) return formatError('Parameter description is required (non-empty string)');
  const confirm = readConfirmation(args);
  if (!confirm.ok) return formatError(confirm.reason);
  return runWrite(ctx, { kind: 'execute', statements: [sql], confirmed: confirm.value, description });
}

async function toolExecuteTransaction(ctx, args) {
  const { statements, description } = args;
  if (!Array.isArray(statements) || statements.length === 0) {
    return formatError('statements must be a non-empty array of SQL strings');
  }
  const bad = statements.findIndex(s => !isNonEmptyString(s));
  if (bad !== -1) return formatError(`statements[${bad}] must be a non-empty string`);
  if (!isNonEmptyString(description)) return formatError('Parameter description is required (non-empty string)');
  const confirm = readConfirmation(args);
  if (!confirm.ok) return formatError(confirm.reason);
  return runWrite(ctx, { kind: 'transaction', statements, confirmed: confirm.value, description });
}

const MAX_IDENTIFIER_BYTES = 63; // PostgreSQL's NAMEDATALEN - 1

async function toolSnapshotTable(ctx, args) {
  const { env } = ctx;
  const { source, where, suffix } = args;
  if (!isNonEmptyString(source)) return formatError('Parameter source is required (non-empty string)');
  if (!/^[\w."]+$/.test(source)) {
    return formatError('Invalid source name (letters, digits, underscore, dot and double quotes only)');
  }
  if (suffix !== undefined && (typeof suffix !== 'string' || !/^\w+$/.test(suffix))) {
    return formatError('Invalid suffix (letters, digits and underscore only)');
  }
  if (where !== undefined && typeof where !== 'string') return formatError('Parameter where must be a string');

  // Unquoted in the DDL, so PostgreSQL folds it to lower case.
  const snapshotName = `tmp_${source.replace(/\W/g, '_')}${suffix ? `_${suffix}` : ''}_backup_${todayYYYYMMDD()}`.toLowerCase();
  const nameBytes = Buffer.byteLength(snapshotName, 'utf8');
  if (nameBytes > MAX_IDENTIFIER_BYTES) {
    return formatError(
      `Snapshot name ${snapshotName} has ${nameBytes} bytes. PostgreSQL silently truncates names above ` +
        `${MAX_IDENTIFIER_BYTES}, which would cut off the date and could collide with another snapshot. ` +
        'Use a shorter suffix (or none).'
    );
  }

  const whereClause = isNonEmptyString(where) ? ` WHERE ${where}` : '';
  const sql = `CREATE TABLE ${snapshotName} AS SELECT * FROM ${source}${whereClause}`;

  // `where` is raw SQL from the agent: it may only narrow the copy. Another
  // statement after a `;`, a data-modifying clause or a setval (which a
  // rollback does not undo, and which this tool does not measure) is refused
  // before anything reaches the database.
  const failed = [checkStatementShape(sql, 'write'), applyGuardrails(sql, env)].find(c => !c.ok);
  const seq = findSequenceChanges(sql);
  const movesSequence = seq.sequences.length + seq.tables.length + seq.unresolved.length > 0;
  const dml = findDataModification(sql) ?? (movesSequence ? 'a setval' : null);
  if (failed || dml) {
    const reason = failed
      ? failed.reason
      : `GUARDRAIL: the where of snapshot_table must be a condition; it contains ${dml}.`;
    await audit(env, { event: 'snapshot_blocked', source, where: where ?? null, sql: sql.slice(0, 2000), reason });
    return formatError(reason);
  }

  const conn = await connect(ctx, { event: 'snapshot_error', source, sql: sql.slice(0, 2000) });
  if (conn.error) return conn.error;
  const { client } = conn;

  const start = Date.now();
  let broken;
  try {
    await client.query('BEGIN');
    const r = await client.query({ text: sql, queryMode: 'extended' });
    const rowCount = Number.isInteger(r.rowCount)
      ? r.rowCount
      : Number((await client.query(`SELECT COUNT(*) AS n FROM ${snapshotName}`)).rows[0].n);
    await client.query('COMMIT');
    const elapsed = Date.now() - start;

    await audit(env, {
      event: 'snapshot_ok',
      source,
      snapshot: snapshotName,
      where: where ?? null,
      sql: sql.slice(0, 2000),
      row_count: rowCount,
      elapsed_ms: elapsed,
    });

    return formatResult([], {
      type: 'snapshot',
      snapshot_table: snapshotName,
      source,
      row_count: rowCount,
      where: where ?? null,
      elapsed_ms: elapsed,
    });
  } catch (e) {
    broken = await rollbackQuietly(client);
    await audit(env, { event: 'snapshot_error', source, sql: sql.slice(0, 2000), error: e.message });
    return formatError(`Snapshot failed: ${e.message}`);
  } finally {
    await releaseClean(client, broken);
  }
}

// =============================================================================
// Entry point for the MCP server
// =============================================================================

export async function callTool(ctx, name, args) {
  const input = args ?? {};
  try {
    switch (name) {
      case 'query':
        return await toolQuery(ctx, input);
      case 'execute':
        return await toolExecute(ctx, input);
      case 'execute_transaction':
        return await toolExecuteTransaction(ctx, input);
      case 'snapshot_table':
        return await toolSnapshotTable(ctx, input);
      default:
        return formatError(`Unknown tool: ${name}`);
    }
  } catch (e) {
    await audit(ctx.env, { event: 'internal_error', tool: name, error: e.message });
    return formatError(`Internal error: ${e.message}`);
  }
}
