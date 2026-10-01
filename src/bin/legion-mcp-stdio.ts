#!/usr/bin/env node
/** stdio MCP bridge for Cowork / Claude Desktop: proxies to the running Legion Core's /mcp; starts core headless if down. */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, VERSION } from '../shared/config.js';

// stdout is the protocol channel: log to stderr only.
const log = (...a: unknown[]) => process.stderr.write(`[legion-mcp] ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function ensureCore(port: number): Promise<void> {
  if (await healthy(port)) return;
  const corePath = join(dirname(fileURLToPath(import.meta.url)), 'legion-core.js');
  log(`Legion Core not reachable on :${port}; starting ${corePath}`);
  const child = spawn(process.execPath, [corePath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log('failed to spawn core', e));
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await healthy(port)) return;
    await sleep(300);
  }
  throw new Error(`Legion Core did not become healthy on port ${port} within 15s`);
}

async function main() {
  const config = loadConfig();
  await ensureCore(config.port);

  const client = new Client({ name: 'legion-mcp-stdio', version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.authToken}` } },
  });
  await client.connect(transport);

  const server = new Server({ name: 'legion', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const r = await client.listTools();
    return { tools: r.tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return (await client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }, undefined, { timeout: 3_700_000 })) as any;
    } catch (e) {
      return { content: [{ type: 'text', text: `Legion bridge error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  const shutdown = () => { void client.close().finally(() => process.exit(0)); };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('bridge ready');
}

main().catch((e) => { log('fatal', e); process.exit(1); });
