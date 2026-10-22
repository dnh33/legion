#!/usr/bin/env node
/**
 * The stdio shim an agent host (Hermes) starts to reach Legion's own tools for one run. It forwards the host's tool list and tool
 * calls to this run's route in the core (src/core/acp/run-tools.ts), with the run key from its environment.
 *
 * It starts nothing, reads no file and never loads Legion's config, so it cannot learn the authToken. It sends the run key only to
 * 127.0.0.1 on the run route: any other address in the environment is refused before the key is used. It never writes the key
 * anywhere (stdout is the protocol channel, stderr gets short plain notes).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const log = (text: string) => process.stderr.write(`[legion-tools] ${text}\n`);
const RUN_URL = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/mcp\/run\/legion$/;
/** An ask can wait a long time for its answer; the core ends the call when the run ends. */
const CALL_TIMEOUT_MS = 3_700_000;

async function main(): Promise<void> {
  const url = process.env.LEGION_RUN_URL ?? '';
  const key = process.env.LEGION_RUN_TOKEN ?? '';
  delete process.env.LEGION_RUN_TOKEN; // nothing this process starts or loads should see it
  if (!RUN_URL.test(url) || !key) {
    log('Legion tools are not started: the run address or the run key is missing or not for your computer.');
    process.exit(2);
  }
  const client = new Client({ name: 'legion-acp-tools-stdio', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  } catch {
    log('Legion did not accept this run. The run may have ended.');
    process.exit(1);
  }

  const server = new Server({ name: 'legion', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await client.listTools()).tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return (await client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS })) as never;
    } catch {
      return { content: [{ type: 'text', text: 'Legion tools are not available: this run has ended or Legion is not running.' }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  const shutdown = () => { void client.close().finally(() => process.exit(0)); };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(() => { log('Legion tools stopped.'); process.exit(1); });
