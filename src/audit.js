// JSONL audit log, off unless GUARD_AUDIT_LOG_PATH is set: one line per event
// (a write logs one line before it runs and one after).
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function audit(env, entry) {
  const path = env.GUARD_AUDIT_LOG_PATH;
  if (!path) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  }) + '\n';

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, 'utf8');
  } catch (e) {
    // A failing audit write must not abort the operation; report it on stderr.
    console.error('[audit] failed to write entry:', e.message);
  }
}
