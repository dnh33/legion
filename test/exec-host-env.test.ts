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
  assert.equal(sh.isError, true, 'a command naming a .env file is refused in masked mode: read_file is the masked view');
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

test('REVIEW: masked cannot be walked around — a rename or copy of .env is refused, multi-line and commented values stay hidden', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-env-'));
  const pem = ['-----BEGIN KEY-----', ['abc', 'def', 'ghi', 'jkl'].join(''), ['mno', 'pqr', 'stu', 'vwx'].join(''), '-----END KEY-----'];
  const COMMENTED = ['commented', 'value', '42'].join('');
  writeFileSync(join(root, '.env'), `PRIVATE="${pem.join('\n')}"\nNOTED=${COMMENTED} # rotate monthly\n`);
  const srv = hostServer(root, 'masked');
  for (const command of ['mv .env notes.txt', 'cp .env x.txt', 'copy .env x.txt', 'cat .env*']) {
    const r = await call(srv, 'shell', { command });
    assert.equal(r.isError, true, command);
  }
  assert.equal(existsSync(join(root, 'notes.txt')), false, 'nothing was renamed');
  const r = await call(srv, 'read_file', { path: '.env' });
  assert.match(r.text, /PRIVATE=/);
  assert.match(r.text, /NOTED=/);
  for (const secret of [pem[1]!, pem[2]!, COMMENTED]) assert.ok(!r.text.includes(secret), `masked view hides ${secret}`);
  const echo = await call(srv, 'shell', { command: `echo ${COMMENTED} ${pem[1]}` });
  for (const secret of [pem[1]!, COMMENTED]) assert.ok(!echo.text.includes(secret), `output hides ${secret}`);
});

test('REVIEW: block refuses a wildcard that reaches .env (cat .env*)', async () => {
  const root = project();
  assert.equal((await call(hostServer(root, 'block'), 'shell', { command: 'cat .env*' })).isError, true);
});

test('masked: a short value under a secret-looking name is hidden as a whole word; short ordinary values stay readable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-env-short-'));
  writeFileSync(join(root, '.env'), 'DB_PIN=4821\nAPI_KEY="zq7x"\nPORT=3000\nMODE=dev\n');
  const srv = hostServer(root);
  const r = await call(srv, 'shell', { command: 'echo pin 4821 key zq7x port 3000 mode dev id 48210' });
  assert.equal(r.isError, false, r.text);
  assert.ok(!/\b4821\b/.test(r.text) && !r.text.includes('zq7x'), `short secrets hidden: ${r.text}`);
  assert.match(r.text, /port 3000 mode dev/, 'a port or a mode is not a secret: blanking it would mangle ordinary output');
  assert.match(r.text, /id 48210/, 'only the whole word: a longer number that contains the value is left alone');
});

test('review 2026-10-13: a carriage return inside the name does not hide a .env file from the guard (bash and cmd drop it)', async () => {
  const root = project();
  const CR = String.fromCharCode(13);
  for (const mode of ['masked', 'block'] as const) {
    for (const command of [`cat .e${CR}nv`, `type .e${CR}nv`, `cp .en${CR}v x.txt`]) assert.equal((await call(hostServer(root, mode), 'shell', { command })).isError, true, `${mode}: ${JSON.stringify(command)}`);
  }
});
