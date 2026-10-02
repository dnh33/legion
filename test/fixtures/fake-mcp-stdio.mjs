// A tiny stdio MCP server for the provider tests: echo, envcheck. Every call is appended to MARK_FILE when it is set.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const mark = (n) => { if (process.env.MARK_FILE) appendFileSync(process.env.MARK_FILE, n + '\n'); };
const s = new McpServer({ name: 'fake-ext', version: '1' });
s.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }) => { mark('echo'); return { content: [{ type: 'text', text: 'echo:' + text }] }; });
s.registerTool('envcheck', { description: 'Report which env vars are visible' }, async () => { mark('envcheck'); return { content: [{ type: 'text', text: JSON.stringify({ leak: process.env.LEGION_TEST_SECRET ?? 'absent', own: process.env.OWN_VAR ?? 'absent' }) }] }; });
await s.connect(new StdioServerTransport());
