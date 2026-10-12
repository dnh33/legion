/**
 * The agent shell and .env files (owner note 2026-10-12): a per-agent choice — allow, masked (default) or block.
 * Masked: read_file shows the names with the values hidden, every value from the root's .env files is taken out of all
 * tool output (so `cat .env` cannot bring one back), and writes to a .env file are refused (a read-then-write would save
 * the masks). Block: a .env file cannot be read, written or named in a command. Shared templates (.env.example, .sample,
 * .template) are ordinary files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALUE = ['db', 'pass', 'word', '9876'].join('-');
const TOKEN = ['tok', 'value', '5544', 'zz'].join('_');

function hostServer(rootDir: string, envFiles?: 'allow' | 'masked' | 'block') {
  const bus = new EventBus();
  const engine = new Engine({
    store: {} as never, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as never,
    approvals: new ApprovalBroker(bus), config: { workspaceDir: rootDir, mcpServers: {} } as never, queryFn: (async () => []) as never, boatConfigured: () => false,
  });
  const agent = {
    id: 'dev', name: 'Dev', emoji: 'D', description: '', systemPrompt: '', model: 'sonnet', approval: 'ask', mcpServers: [],
    vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, host: { enabled: true, rootDir, ...(envFiles ? { envFiles } : {}) },
  } as never;
  return (engine as never as { buildMcpServers: (a: unknown, j: unknown, act: unknown, r: string) => Record<string, any> })
    .buildMcpServers(agent, { taskId: 'env' }, { tainted: false }, 'claude').host;
}
async function call(srv: any, name: string, args: Record<string, unknown>) {
  const out = await srv.instance._registeredTools[name].handler(args, {});
  return { text: out.content.map((c: any) => c.text).join('\n'), isError: out.isError === true };
}
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'legion-env-'));
  writeFileSync(join(root, '.env'), `DB_PASSWORD=${VALUE}\n# a comment\nAPI_TOKEN="${TOKEN}"\nEMPTY=\n`);
  writeFileSync(join(root, '.env.example'), 'DB_PASSWORD=change-me\n');
  return root;
}

test('masked (the default): names are visible, values are not — in read_file and in any shell output', async () => {
  const root = project();
  const srv = hostServer(root);
  const r = await call(srv, 'read_file', { path: '.env' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /DB_PASSWORD=/);
  assert.match(r.text, /API_TOKEN=/);
  assert.match(r.text, /# a comment/);
  assert.ok(!r.text.includes(VALUE) && !r.text.includes(TOKEN), r.text);
  const sh = await call(srv, 'shell', { command: process.platform === 'win32' ? 'type .env' : 'cat .env' });
  assert.ok(!sh.text.includes(VALUE) && !sh.text.includes(TOKEN), 'cat/type cannot bring a value back');
  const echo = await call(srv, 'shell', { command: `echo ${VALUE}` });
  assert.ok(!echo.text.includes(VALUE), 'nor can a value printed any other way');
});

test('masked: a write to a .env file is refused (a read-then-write would save the masks); the example file is ordinary', async () => {
  const root = project();
  const srv = hostServer(root, 'masked');
  const w = await call(srv, 'write_file', { path: '.env', content: 'DB_PASSWORD=[masked]\n' });
  assert.equal(w.isError, true);
  assert.match(w.text, /\.env/);
  assert.match(readFileSync(join(root, '.env'), 'utf8'), new RegExp(VALUE), 'the file is untouched');
  const ex = await call(srv, 'read_file', { path: '.env.example' });
  assert.match(ex.text, /change-me/);
});

test('block: a .env file cannot be read, written or named in a command', async () => {
  const root = project();
  const srv = hostServer(root, 'block');
  assert.equal((await call(srv, 'read_file', { path: '.env' })).isError, true);
  assert.equal((await call(srv, 'read_file', { path: 'sub/../.env.local' })).isError, true);
  const w = await call(srv, 'write_file', { path: '.env', content: 'X=1' });
  assert.equal(w.isError, true);
  const sh = await call(srv, 'shell', { command: 'cat .env' });
  assert.equal(sh.isError, true);
  assert.equal(existsSync(join(root, '.env')), true);
  assert.equal((await call(srv, 'read_file', { path: '.env.example' })).isError, false);
});

test('allow: the file reads as written', async () => {
  const root = project();
  const r = await call(hostServer(root, 'allow'), 'read_file', { path: '.env' });
  assert.ok(r.text.includes(VALUE) && r.text.includes(TOKEN));
});
