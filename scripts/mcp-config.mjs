// Prints ready-to-paste MCP hookup snippets for Claude Code and Claude Desktop/Cowork.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectKind, mcpStdioEntry } from './lib/package-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.LEGION_HOME || join(homedir(), '.legion');
let port = 4747, token = '<token>';
const cfgPath = join(home, 'config.json');
if (existsSync(cfgPath)) {
  try {
    const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (c.port) port = c.port;
    if (c.authToken) token = c.authToken;
  } catch { /* ignore */ }
} else {
  console.error(`(no ${cfgPath} yet - start Legion once to generate a token)\n`);
}
if (process.env.LEGION_PORT) port = Number(process.env.LEGION_PORT) || port;

console.log('# 1) Claude Code (run in any terminal). This token only runs and reads agents (approvals stay with you: it cannot approve cards, accept notes or change settings):\n');
console.log(`claude mcp add --transport http legion http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"\n`);

const stdio = join(root, 'dist', 'src', 'bin', 'legion-mcp-stdio.js').replace(/\\/g, '/');
console.log('# 2) Claude Desktop / Cowork - add to claude_desktop_config.json:\n');
// A prebuilt package has no system Node: the proxy runs on the package's own Electron in node mode (the env entry switches that on).
const entry = detectKind(root).kind === 'package' ? mcpStdioEntry(root.replace(/\//g, '\\')) : { command: 'node', args: [stdio] };
console.log(JSON.stringify({ mcpServers: { legion: entry } }, null, 2));
