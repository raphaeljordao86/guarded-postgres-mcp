// Loads the .env used by both entry points (the MCP server and test-conn).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

const PACKAGE_ENV = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');

/**
 * GUARD_ENV_FILE points at another .env (e.g. a staging database) without
 * touching the production one. Without it, the .env in the package root is
 * used if present. Variables already set in the environment win.
 *
 * - quiet: dotenv 17 prints a banner on stdout by default, and on the stdio
 *   transport stdout is the JSON-RPC channel.
 * - A GUARD_ENV_FILE that does not exist is an error: silently falling back to
 *   the client's PG_* variables could connect to production by mistake.
 */
export function loadEnv() {
  const explicit = process.env.GUARD_ENV_FILE;
  const envPath = explicit || PACKAGE_ENV;
  if (!existsSync(envPath)) {
    if (explicit) throw new Error(`GUARD_ENV_FILE points to a file that does not exist: ${explicit}`);
    return;
  }
  dotenv.config({ path: envPath, quiet: true });
}
