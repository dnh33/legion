// A stdio MCP server for the process-tree tests. On start it records itself and a grandchild (a sleeping node process) in
// PID_FILE (one "label pid" per line). Tools: echo, hang (never answers). No network, no secrets.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `server ${process.pid}\ngrandchild ${gc.pid}\n`);
const s = new McpServer({ name: 'fake-tree', version: '1' });
s.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: 'echo:' + text }] }));
s.registerTool('hang', { description: 'Never answers' }, async () => new Promise(() => undefined));
await s.connect(new StdioServerTransport());
