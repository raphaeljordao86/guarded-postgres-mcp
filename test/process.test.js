// The two entry points as real processes: the MCP server on stdio and
// test-conn. No database needed (the server connects lazily, and test-conn
// is pointed at a closed port).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'index.js');
const TEST_CONN = join(ROOT, 'src', 'test-conn.js');

/** Environment without any PG_* / GUARD_* inherited from the machine. */
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('PG') && !k.startsWith('GUARD_') && !k.startsWith('DOTENV_')) env[k] = v;
  }
  return { ...env, ...extra };
}

function withEnvFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-env-'));
  const file = join(dir, 'test.env');
  writeFileSync(file, contents);
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Runs a script to completion (or kills it after `ms`). */
function run(script, env, { ms = 15000, stdin } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => child.kill(), ms);
    child.on('exit', code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin) child.stdin.write(stdin);
  });
}

test('the server writes nothing but JSON-RPC on stdout, even with a .env present', async () => {
  // dotenv 17 prints a banner on stdout unless quiet; on stdio that line
  // corrupts the protocol stream before the first message.
  await withEnvFile('PG_HOST=127.0.0.1\nPG_PORT=1\n', async envFile => {
    const child = spawn(process.execPath, [SERVER], {
      env: cleanEnv({ GUARD_ENV_FILE: envFile }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    const listed = new Promise((resolveListed, reject) => {
      const timer = setTimeout(() => reject(new Error(`no tools/list response; stdout so far: ${stdout}`)), 15000);
      child.stdout.on('data', d => {
        stdout += d;
        if (/"id":2\b/.test(stdout)) {
          clearTimeout(timer);
          resolveListed();
        }
      });
    });

    const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    try {
      await listed;
    } finally {
      child.kill();
    }

    const lines = stdout.split('\n').filter(l => l.trim() !== '');
    for (const line of lines) {
      let msg;
      assert.doesNotThrow(() => (msg = JSON.parse(line)), `stdout line is not JSON: ${line}`);
      assert.equal(msg.jsonrpc, '2.0', `stdout line is not JSON-RPC: ${line}`);
    }
    const tools = lines.map(l => JSON.parse(l)).find(m => m.id === 2).result.tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['execute', 'execute_transaction', 'query', 'snapshot_table']);
    assert.equal(tools.find(t => t.name === 'query').annotations.readOnlyHint, true);
  });
});

test('the server refuses to start when GUARD_ENV_FILE points to a missing file', async () => {
  // Falling back silently to the PG_* of the client could reach production.
  const missing = join(tmpdir(), 'guard-env-does-not-exist', 'staging.env');
  const r = await run(SERVER, cleanEnv({ GUARD_ENV_FILE: missing }), { ms: 10000 });
  assert.equal(r.code, 1, `expected exit code 1, got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /GUARD_ENV_FILE points to a file that does not exist/);
});

test('test-conn loads the same .env as the server', async () => {
  // It used to skip the .env and print "connecting to undefined:undefined".
  await withEnvFile('PG_HOST=127.0.0.1\nPG_PORT=1\nPG_USER=nobody\nPG_DATABASE=none\nPG_PASSWORD=x\n', async envFile => {
    const r = await run(TEST_CONN, cleanEnv({ GUARD_ENV_FILE: envFile, PG_CONNECT_TIMEOUT_MS: '3000' }), { ms: 20000 });
    assert.match(r.stdout, /connecting to 127\.0\.0\.1:1\b/);
    assert.equal(r.code, 1, 'port 1 is closed, so the check must fail');
  });
});
