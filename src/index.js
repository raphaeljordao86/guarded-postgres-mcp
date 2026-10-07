#!/usr/bin/env node
// guarded-postgres-mcp: MCP server that gives AI agents governed access to a
// legacy ERP PostgreSQL database.
// Exposes: query, execute, execute_transaction, snapshot_table (see tools.js).
//
// On the stdio transport stdout is the JSON-RPC channel: nothing else may be
// written there. Logs go to stderr.

import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadEnv } from './env.js';
import { getPool, closePool } from './db.js';
import { TOOLS, callTool } from './tools.js';

try {
  loadEnv();
} catch (e) {
  console.error(`[guarded-postgres-mcp] ${e.message}`);
  process.exit(1);
}

const env = process.env;
const ctx = { env, getPool: () => getPool(env) };
const { version } = createRequire(import.meta.url)('../package.json');

const server = new Server(
  { name: 'guarded-postgres-mcp', version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  return callTool(ctx, name, args);
});

// Clean up on exit
async function shutdown() {
  await closePool();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[guarded-postgres-mcp] MCP server started on stdio');
