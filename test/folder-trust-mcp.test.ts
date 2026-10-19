// test/folder-trust-mcp.test.ts: fix round 1 for folder trust.
// (1) A repository's .mcp.json counts as executable content when "Also load MCP servers" (inheritMcp) is on, because only strictMcpConfig stops an SDK run
//     from connecting it. Official source (opened 2026-10-18): code.claude.com/docs/en/permissions, "What runs before you trust a folder", the .mcp.json row:
//     for `claude -p` or the SDK a server is "Connected without asking, approved or not. The SDK loads them only when settingSources includes project settings."
//     With inheritMcp off Legion sets strictMcpConfig itself, so the file is not counted.
// (2) Every command, helper or server line shown in the dialog, the thread notice and the activity log goes through Legion's scrubber first; the fingerprint
//     still covers the raw content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { setup } from './away-rig.js';
import { idle, pause } from './gates-rig.js';
import { scanFolder } from '../src/core/folder-trust.js';
import { gatesChange, resetGatesCancelForTests } from '../src/electron/gates-ipc.js';
import type { GatesIpcDeps } from '../src/electron/gates-ipc.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { AUTH, makeFakes, start } from './helpers-c.js';
import type { GatesCore } from '../src/core/gates-settings/index.js';

const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const json = (path: string, v: unknown): void => put(path, JSON.stringify(v, null, 2));
const MCP = { mcpServers: { files: { command: 'node', args: ['serve.js', '--root', '.'], env: { API_TOKEN: 'ZZ-MCP-ENV-VALUE-1' } }, remote: { type: 'http', url: 'https://mcp.example.com/v1?key=ZZ-MCP-URL-KEY-2', headers: { Authorization: 'Bearer ZZ-MCP-HEADER-3' }, headersHelper: 'get-headers.sh' } } };
const VALUES = ['ZZ-MCP-ENV-VALUE-1', 'ZZ-MCP-URL-KEY-2', 'ZZ-MCP-HEADER-3'];

function world() {
  const home = tempDir('legion-mcp-home-');
  const repo = join(home, 'work', 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return { home, repo, o: { home, configDir: join(home, '.claude') } };
}

test('inheritMcp on: .mcp.json servers are executable, named, with variable and header NAMES only and an address cut to host and path', () => {
  const w = world();
  json(join(w.repo, '.mcp.json'), MCP);
  const s = scanFolder(w.repo, { ...w.o, mcp: true });
  assert.equal(s.executable, true);
  assert.equal(s.mcp, true);
  const text = s.lines.join('\n');
  assert.match(text, /MCP server files in \.mcp\.json starts: node serve\.js --root \./);
  assert.match(text, /MCP server files in \.mcp\.json gets variables: API_TOKEN/);
  assert.match(text, /MCP server remote in \.mcp\.json connects to: https:\/\/mcp\.example\.com\/v1/);
  assert.match(text, /MCP server remote in \.mcp\.json header helper runs: get-headers\.sh/);
  assert.match(text, /MCP server remote in \.mcp\.json sends headers: Authorization/);
  for (const v of VALUES) assert.equal(text.includes(v), false, v);
});

test('inheritMcp off (the default): .mcp.json is not counted, strictMcpConfig already blocks it', () => {
  const w = world();
  json(join(w.repo, '.mcp.json'), MCP);
  assert.equal(scanFolder(w.repo, w.o).executable, false);
  assert.equal(scanFolder(w.repo, { ...w.o, mcp: false }).mcp, false);
});

test('an empty server list is nothing to trust; a file that is not valid JSON or has a server list of the wrong shape is executable', () => {
  const w = world();
  json(join(w.repo, '.mcp.json'), { mcpServers: {} });
  assert.equal(scanFolder(w.repo, { ...w.o, mcp: true }).executable, false);
  put(join(w.repo, '.mcp.json'), '{ nope');
  assert.equal(scanFolder(w.repo, { ...w.o, mcp: true }).executable, true);
  json(join(w.repo, '.mcp.json'), { mcpServers: [1] });
  assert.equal(scanFolder(w.repo, { ...w.o, mcp: true }).executable, true);
});

test('a .mcp.json in a parent folder inside the repository counts (the CLI looks upward); above the repository root it does not', () => {
  const w = world();
  const cwd = join(w.repo, 'packages', 'app');
  mkdirSync(cwd, { recursive: true });
  json(join(w.repo, '.mcp.json'), MCP);
  assert.equal(scanFolder(cwd, { ...w.o, mcp: true }).executable, true);
  json(join(w.repo, '.mcp.json'), { mcpServers: {} });
  json(join(w.home, 'work', '.mcp.json'), MCP);
  assert.equal(scanFolder(cwd, { ...w.o, mcp: true }).executable, false);
});

test('the fingerprint follows the server: a changed command, URL or env value is a new fingerprint; the same file is the same one', () => {
  const w = world();
  json(join(w.repo, '.mcp.json'), MCP);
  const a = scanFolder(w.repo, { ...w.o, mcp: true }).digest;
  assert.equal(scanFolder(w.repo, { ...w.o, mcp: true }).digest, a);
  const edit = (f: (m: typeof MCP) => void): string => { const c = JSON.parse(JSON.stringify(MCP)) as typeof MCP; f(c); json(join(w.repo, '.mcp.json'), c); return scanFolder(w.repo, { ...w.o, mcp: true }).digest; };
  assert.notEqual(edit((m) => { m.mcpServers.files.args.push('--more'); }), a);
  assert.notEqual(edit((m) => { m.mcpServers.files.env.API_TOKEN = 'other'; }), a, 'an env value counts in the hash');
  assert.notEqual(edit((m) => { m.mcpServers.remote.url = 'https://mcp.example.com/v2'; }), a);
  assert.notEqual(scanFolder(w.repo, { ...w.o, mcp: false }).digest, a, 'the same folder scanned with the switch off is another fingerprint, so trust given with the switch off does not carry over');
});

// ---- (2) the scrubber ----

const CURL = 'curl -H "Authorization: Bearer test-not-real" https://api.example.com/x';
const ASSIGN = 'TOKEN=abc123 ./deploy.sh';
const HOOK_SETTINGS = { hooks: { Stop: [{ hooks: [{ type: 'command', command: CURL }] }], SessionStart: [{ hooks: [{ type: 'command', command: ASSIGN }] }] }, apiKeyHelper: 'AUTH=hunter2 get-key.sh' };
const RAW = ['test-not-real', 'abc123', 'hunter2'];

test('scan lines: a Bearer header, an inline variable and a helper variable show no value; the commands are still named', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), HOOK_SETTINGS);
  const s = scanFolder(w.repo, w.o);
  const text = s.lines.join('\n');
  for (const v of RAW) assert.equal(text.includes(v), false, v);
  assert.match(text, /curl/);
  assert.match(text, /api\.example\.com/);
  assert.match(text, /deploy\.sh/);
  assert.match(text, /get-key\.sh/);
  assert.match(text, /TOKEN=<omitted>/);
});

test('the fingerprint still covers the raw content: another token is another fingerprint, though both show the same lines', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), HOOK_SETTINGS);
  const a = scanFolder(w.repo, w.o);
  json(join(w.repo, '.claude', 'settings.json'), JSON.parse(JSON.stringify(HOOK_SETTINGS).replace('abc123', 'zzz999')));
  const b = scanFolder(w.repo, w.o);
  assert.notEqual(a.digest, b.digest);
  assert.deepEqual(a.lines, b.lines);
});

async function bootDialog(answers: boolean[]) {
  resetGatesCancelForTests();
  const data = join(tempDir('legion-mcp-ipc-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const core = createGatesCore({ dataDir: data, projects, keyring: { get: () => Buffer.alloc(32, 9) }, inheritMcp: () => true });
  const mod = createGatesModule({ config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false }, { projects, core, nativeSecret: 'native-secret' });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const real = async (method: string, route: string, body?: unknown, native?: boolean, extra?: Record<string, string>) => {
    const r = await fetch(s.base + route, { method, headers: { ...AUTH, 'Content-Type': 'application/json', ...(native ? { 'X-Legion-Native': 'native-secret' } : {}), ...(extra ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const deps: GatesIpcDeps = { call: real as GatesIpcDeps['call'], async confirm(d) { dialogs.push(d); return answers.shift() ?? false; } };
  return { core, deps, dialogs, close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('the native dialog shows no value for the hooks, the helper or the MCP servers, and trusting works with the switch on', async () => {
  const r = await bootDialog([true]);
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), HOOK_SETTINGS);
  json(join(w.repo, '.mcp.json'), MCP);
  try {
    const res = await gatesChange({ kind: 'app', patch: { trustFolder: w.repo } }, r.deps);
    assert.equal(res.ok, true);
    const d = r.dialogs[0]!;
    const all = d.title + d.message + d.detail;
    for (const v of [...RAW, ...VALUES]) assert.equal(all.includes(v), false, v);
    assert.match(d.detail, /MCP server files/);
    assert.match(d.detail, /deploy\.sh/);
    assert.equal(r.core.trustedFolders().length, 1);
  } finally { await r.close(); }
});

test('a folder whose only executable content is .mcp.json cannot be trusted with the switch off (nothing needs it)', async () => {
  const r = await bootDialog([true]);
  const w = world();
  json(join(w.repo, '.mcp.json'), MCP);
  const off = createGatesCore({ dataDir: join(tempDir('legion-mcp-off-'), 'data'), keyring: { get: () => Buffer.alloc(32, 9) }, inheritMcp: () => false });
  try {
    assert.throws(() => off.store.preview('app', { trustFolder: w.repo }), /Nothing in that folder/);
    assert.doesNotThrow(() => r.core.store.preview('app', { trustFolder: w.repo }));
  } finally { await r.close(); }
});

// ---- the engine ----

const prompt = (o: Record<string, unknown>): string => ((o.systemPrompt as { append?: string }).append) ?? '';
async function rig(cwd: string, inheritMcp: boolean) {
  const r = setup({ gatesCore: true, activity: true, approval: 'ask', script: idle });
  r.config.claude.inheritMcp = inheritMcp;
  r.store.agents.get('a1')!.cwd = cwd;
  const core = r.core as GatesCore;
  const run = async () => {
    for (const id of r.store.tasks.keys()) r.engine.cancel(id);
    await pause(60);
    const before = r.calls.length;
    const t = r.start('a1', 'go');
    await pause(150);
    assert.equal(r.calls.length, before + 1, 'the run started');
    return { options: r.calls[before]!.options, taskId: t.id };
  };
  const messages = (id: string) => r.store.msgs.filter((m) => m.taskId === id);
  return { r, core, run, messages, stop: () => { for (const id of r.store.tasks.keys()) r.engine.cancel(id); } };
}
const mcpRepo = (extra: Record<string, unknown> = {}): string => {
  const repo = join(tempDir('legion-mcp-eng-'), 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  json(join(repo, '.mcp.json'), MCP);
  for (const [k, v] of Object.entries(extra)) json(join(repo, k), v);
  return repo;
};

test('engine, inheritMcp on: a repo with a .mcp.json is held back (user source only, strictMcpConfig on), the notice names the servers, no value anywhere', async () => {
  const x = await rig(mcpRepo(), true);
  try {
    const { options, taskId } = await x.run();
    assert.deepEqual(options.settingSources, ['user']);
    assert.equal(options.strictMcpConfig, true, 'the SDK is told to ignore .mcp.json as well, in case the project source were not the only way in');
    const note = x.messages(taskId).find((m) => m.folderTrust)!;
    assert.ok(note, 'a notice');
    assert.match(note.text, /MCP server files/);
    assert.match(note.text, /MCP server remote/);
    assert.match(note.text, /MCP servers from your Claude Code setup were off for this run too/);
    const everything = JSON.stringify([prompt(options), x.messages(taskId), x.r.activity!.read()]);
    for (const v of VALUES) assert.equal(everything.includes(v), false, v);
  } finally { x.stop(); }
});

test('engine, inheritMcp on: trusted at this content, the project source loads and the server is not blocked; a changed .mcp.json asks again; restored, it runs', async () => {
  const repo = mcpRepo();
  const x = await rig(repo, true);
  try {
    x.core.store.patchApp({ trustFolder: repo });
    const a = await x.run();
    assert.deepEqual(a.options.settingSources, ['user', 'project', 'local']);
    assert.equal(a.options.strictMcpConfig, undefined, 'inheritMcp is on and the folder is trusted: the servers load');
    const changed = JSON.parse(JSON.stringify(MCP));
    changed.mcpServers.files.args.push('--evil');
    json(join(repo, '.mcp.json'), changed);
    const b = await x.run();
    assert.deepEqual(b.options.settingSources, ['user']);
    assert.equal(b.options.strictMcpConfig, true);
    json(join(repo, '.mcp.json'), MCP);
    assert.deepEqual((await x.run()).options.settingSources, ['user', 'project', 'local']);
  } finally { x.stop(); }
});

test('engine, inheritMcp off: .mcp.json is not counted and strictMcpConfig stays on as it always was', async () => {
  const x = await rig(mcpRepo(), false);
  try {
    const { options, taskId } = await x.run();
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.equal(options.strictMcpConfig, true);
    assert.equal(x.messages(taskId).some((m) => m.folderTrust), false);
  } finally { x.stop(); }
});

test('engine: a hook with a Bearer header and an inline variable leaves no value in the prompt, the thread notice or the activity log; a held-back run for hooks alone keeps the owner\'s own MCP servers', async () => {
  const repo = join(tempDir('legion-mcp-eng2-'), 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  json(join(repo, '.claude', 'settings.json'), HOOK_SETTINGS);
  const x = await rig(repo, true);
  try {
    const { options, taskId } = await x.run();
    assert.deepEqual(options.settingSources, ['user']);
    assert.equal(options.strictMcpConfig, undefined, 'held back for hooks, not for a .mcp.json: the owner\'s MCP choice is untouched');
    const everything = JSON.stringify([prompt(options), x.messages(taskId), x.r.activity!.read()]);
    for (const v of RAW) assert.equal(everything.includes(v), false, v);
    assert.match(everything, /deploy\.sh/);
  } finally { x.stop(); }
});
