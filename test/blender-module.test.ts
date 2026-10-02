/** The Blender module wired into a real Engine, Store and HTTP server: exposure, disallowed tools, admin-only routes, status light, config persistence. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// the fake file system speaks forward slashes; path.join gives backslashes on Windows
const fwd = (p: string): string => p.split(String.fromCharCode(92)).join('/');

import test, { after } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { createBlenderModule } from '../src/core/blender/index.js';
import type { BlenderModuleOptions } from '../src/core/blender/index.js';
import type { BlenderIo } from '../src/core/blender/setup.js';
import type { GetBlenderPorts, ManagedPin } from '../src/core/blender/get-blender.js';
import type { CoreModule } from '../src/core/modules.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import { BlenderState } from '../src/core/blender/state.js';
import type { LegionEvent } from '../src/shared/types.js';
import { BLENDER_EXEC_TOOL, DEFAULT_ADVANCED } from '../src/shared/blender.js';
import { init, ok } from './library-fakes.js';
import { asClient, AUTH, start, TOKEN } from './helpers-c.js';
import { agent, FakeBackend, FakeSandbox } from './blender-helpers.js';
import { FakeLocal } from './blender-local-fakes.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

interface Opts { enabled?: boolean; installs?: string[]; socketOpen?: boolean; mcpServers?: Record<string, any>; sandboxReady?: boolean; withSandbox?: boolean; unpinned?: boolean; localReady?: boolean; realLocal?: boolean; raw?: Record<string, unknown>; getPorts?: GetBlenderPorts; managedPin?: ManagedPin }

function fakeIo(versions: string[]): { io: BlenderIo; downloads: string[]; hash: { value?: string } } {
  const downloads: string[] = [];
  const hash: { value?: string } = {};
  const paths = versions.map((v) => `/opt/blender-${v}/blender`);
  const io: BlenderIo = {
    detect: {
      platform: 'linux', env: {}, home: '/home/u', exists: (p) => paths.includes(p), readDir: (p) => (p === '/opt' ? versions.map((v) => `blender-${v}`) : []),
      run: async (file, args) => { const i = paths.indexOf(file); return i >= 0 && args[0] === '--version' ? { code: 0, stdout: `Blender ${versions[i]}\n`, stderr: '' } : null; },
    },
    run: async (file, args) => (args[0] === '--version' && !paths.includes(file) ? { code: 0, stdout: 'uv 1', stderr: '' } : { code: 0, stdout: 'LEGION_ADDON_OK x /y\n', stderr: '' }),
    download: async (url) => { downloads.push(url); return { sha256: hash.value ?? (url.includes('blender_mcp') ? DEFAULT_ADVANCED.official.sha256 : 'c'.repeat(64)), bytes: 10 }; },
    extract: async () => undefined, mkdirp: () => undefined, writeText: () => undefined, readText: () => undefined, copyFile: () => undefined,
    exists: (p) => fwd(p).endsWith('/addon') || fwd(p).endsWith('/addon/blender_mcp_addon') || paths.includes(p), isDir: (p) => fwd(p).endsWith('/server/pkg'), listDir: (p) => (fwd(p).endsWith('/server') ? ['pkg'] : ['addon']),
    removeDir: () => undefined, spawnDetached: () => undefined, now: () => new Date('2026-10-02T00:00:00Z'),
  };
  return { io, downloads, hash };
}

async function mount(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-blm-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const raw = { port: 4747, authToken: TOKEN, workspaceDir: join(dir, 'ws'), claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test', apiKey: 'boat-secret-key-12345' }, mcpServers: o.mcpServers ?? {}, blender: { enabled: o.enabled ?? true, ...(o.raw ?? {}), ...(o.unpinned ? { advanced: { official: { sha256: '' } } } : {}) } };
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
  const store = new Store(dir);
  store.seedDefaults(join(dir, 'ws'));
  const bus = new EventBus();
  const config = defaultConfig();
  Object.assign(config, { authToken: TOKEN, workspaceDir: join(dir, 'ws'), mcpServers: o.mcpServers ?? {}, blender: raw.blender });
  const calls: Array<{ agent: string; options: any }> = [];
  const queryFn = ((p: any) => {
    const id = `s-${calls.length}`;
    calls.push({ agent: String(p.options.cwd).split(/[\\/]/).pop()!, options: p.options });
    const gen = (async function* () { yield init(id); yield ok('done', id); })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const approvals = new ApprovalBroker(bus, { timeoutMs: 2000 });
  const vms: any = { touch() {}, ensureRunning: async () => ({}), stop: async () => ({}), status: (id: string) => ({ agentId: id, state: 'none' }) };
  const engine = new Engine({ store, bus, vms, approvals, config, queryFn, boatConfigured: () => true, maxConcurrent: 4 });
  const { io, downloads, hash } = fakeIo(o.installs ?? ['5.1.0']);
  const backend = new FakeBackend();
  const sandbox = new FakeSandbox();
  sandbox.ready = { ready: o.sandboxReady ?? false, note: o.sandboxReady ? 'sandbox ok' : 'no key' };
  const local = new FakeLocal();
  local.ready = { ready: o.localReady ?? false, note: o.localReady ? 'Blender found' : 'no Blender' };
  const kinds: string[] = [];
  const opts: BlenderModuleOptions = {
    // the production default builds a real LocalRunner; these status tests pin the local fact unless they ask for it
    ...(o.realLocal ? {} : { local }),
    io, boatConfigured: () => true, backup: async () => ({ ok: true }), probe: async () => o.socketOpen ?? false,
    makeBackend: (k) => { kinds.push(k); return backend; },
    ...(o.withSandbox === false ? {} : { sandbox }),
    ...(o.getPorts ? { getPorts: o.getPorts } : {}), ...(o.managedPin ? { managedPin: o.managedPin } : {}),
  };
  const mod = createBlenderModule({ config, store, bus, engine, approvals, dataDir, bsvEnabled: () => false }, opts);
  const modules: CoreModule[] = [mod];
  engine.setModules(modules);
  const events: LegionEvent[] = [];
  bus.on((e) => { if (e.type.startsWith('blender.')) events.push(e); });
  const ctx: any = { config, store, bus, engine, vms, approvals, boatConfigured: () => true, modules, bsvEnabled: () => false, settings: { view: () => ({}) }, doctor: async () => [], catalog: async () => ({ commands: [], models: [], fetchedAt: 'x' }) };
  const srv = await start(ctx);
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH) => {
    const r = await fetch(srv.base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  const close = async () => { await mod.dispose?.(); await srv.close(); };
  closers.push(close);
  return { local, dir, dataDir, configPath, store, bus, engine, approvals, calls, mod, srv, http, events, downloads, sandbox, backend, kinds, config, close, hash };
}

const runAgent = async (m: Awaited<ReturnType<typeof mount>>, id: string) => {
  const t = m.engine.startTask({ agentId: id, prompt: 'go', source: 'ui' });
  await m.engine.waitFor(t.id, 5000);
  return [...m.calls].reverse().find((c) => c.agent === id)!.options;
};

test('disabled: nobody gets Blender tools, nothing is forbidden, the Sculptor is told it is off', async () => {
  const m = await mount({ enabled: false });
  const sc = m.store.getAgent('sculptor')!;
  assert.deepEqual(m.mod.mcpServers!(sc), {});
  assert.deepEqual(m.mod.disallowedTools!(sc), []);
  assert.match(m.mod.preamble!(sc), /switched off/);
  assert.equal(m.mod.preamble!(m.store.getAgent('builder')!), '');
});

test('enabled: ONLY the Sculptor gets legion_blender, in a real engine run; every other agent is told no (disallowed) and has no server', async () => {
  const m = await mount();
  const sc = await runAgent(m, 'sculptor');
  assert.ok(sc.mcpServers.legion_blender, 'the Sculptor has the server');
  for (const id of ['builder', 'zealot', 'scout']) {
    const o = await runAgent(m, id);
    assert.equal(o.mcpServers.legion_blender, undefined, `${id} must not get the server`);
    assert.ok(o.disallowedTools.includes('mcp__legion_blender'), `${id} forbids it explicitly`);
    assert.ok(o.disallowedTools.includes(BLENDER_EXEC_TOOL));
  }
  // the Sculptor itself is not told to avoid its own tools, but known raw Blender servers are forbidden for everyone
  assert.ok(!sc.disallowedTools.includes('mcp__legion_blender'));
  for (const raw of ['mcp__blender', 'mcp__blender-mcp', 'mcp__claude_ai_Blender']) assert.ok(sc.disallowedTools.includes(raw), raw);
  assert.ok(sc.disallowedTools.includes('SendMessage'), 'engine defaults are kept');
});

test('a user-configured Blender-looking MCP server is forbidden for every agent, whatever its name', async () => {
  const m = await mount({ mcpServers: { my3d: { type: 'stdio', command: 'uvx', args: ['blender-mcp'] }, notes: { type: 'stdio', command: 'notes-server' } } });
  const sc = m.store.getAgent('sculptor')!;
  const d = m.mod.disallowedTools!(sc);
  assert.ok(d.includes('mcp__my3d'));
  assert.ok(!d.includes('mcp__notes'));
});

test('the Sculptor server lists exactly the five guarded tools and none of them is a raw execute tool of a backend', async () => {
  const m = await mount();
  const cfg = m.mod.mcpServers!(m.store.getAgent('sculptor')!, { taskId: 't', taint: () => false }).legion_blender as any;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['blender_docs', 'blender_exec', 'blender_inspect', 'blender_screenshot', 'blender_status']);
  for (const n of names) assert.doesNotMatch(n, /execute|run_python|raw/);
  await c.close();
});

test('wiring: an approved script reaches the backend chosen by detection (5.1 gives official, 4.2 gives community)', async () => {
  for (const [v, kind] of [['5.1.0', 'official'], ['4.2.1', 'community']] as const) {
    const m = await mount({ installs: [v], socketOpen: true });
    // the official backend needs a saved entry; set one the way Setup would
    if (kind === 'official') m.mod.state.recordSetup({ kind: 'official', entry: { command: 'uv', args: [], env: {}, serverDir: '/s', at: 'x' }, addonInstalled: true });
    m.bus.on((e) => { if (e.type === 'approval.requested') setImmediate(() => m.approvals.resolve(e.approval.id, true)); });
    const cfg = m.mod.mcpServers!(m.store.getAgent('sculptor')!, { taskId: 'tk', taint: () => false, markTainted: () => undefined }).legion_blender as any;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(st);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(ct);
    const r: any = await c.callTool({ name: 'blender_exec', arguments: { script: 'import bpy\nbpy.ops.mesh.primitive_cube_add()\n', mode: 'live' } });
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.deepEqual(m.kinds, [kind]);
    assert.equal(m.backend.execs.length, 1);
    assert.ok(m.backend.execs[0]!.includes(Buffer.from('import bpy\nbpy.ops.mesh.primitive_cube_add()\n').toString('base64')), 'the approved script, wrapped by Legion, is what ran');
    await c.close();
  }
});

test('official backend without Set up gives a clear instruction, and nothing runs', async () => {
  const m = await mount({ installs: ['5.1.0'], socketOpen: true });
  m.bus.on((e) => { if (e.type === 'approval.requested') setImmediate(() => m.approvals.resolve(e.approval.id, true)); });
  const cfg = m.mod.mcpServers!(m.store.getAgent('sculptor')!, { taskId: 'tk', taint: () => false }).legion_blender as any;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  const r: any = await c.callTool({ name: 'blender_exec', arguments: { script: 'import bpy\n', mode: 'live' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Set up/);
  assert.equal(m.backend.execs.length, 0);
  await c.close();
});

test('routes are admin-only: a token-only client gets 403 on all of them, the admin gets answers', async () => {
  const m = await mount();
  for (const [method, path, body] of [['GET', '/api/blender'], ['POST', '/api/blender/setup', {}], ['POST', '/api/blender/test', {}], ['POST', '/api/blender/config', { enabled: false }], ['POST', '/api/blender/launch', {}]] as const) {
    const denied = await m.http(method, path, body, asClient);
    assert.equal(denied.status, 403, `${method} ${path} as client`);
  }
  assert.equal((await m.http('GET', '/api/blender')).status, 200);
  assert.equal(m.config.blender.enabled, true, 'the denied config call changed nothing');
});

test('status light: off, not-found, needs-setup, disconnected, connected, sandbox', async () => {
  const light = async (o: Opts) => (await (await mount(o)).http('GET', '/api/blender?refresh=1')).json.light;
  assert.equal(await light({ enabled: false }), 'off');
  assert.equal(await light({ installs: [] }), 'not-found');
  assert.equal(await light({ installs: ['5.1.0'] }), 'needs-setup');
  assert.equal(await light({ installs: [], sandboxReady: true }), 'sandbox');
  // set up but not listening
  const m = await mount({ installs: ['4.2.1'] });
  m.mod.state.recordSetup({ kind: 'community', addonInstalled: true });
  assert.equal((await m.http('GET', '/api/blender?refresh=1')).json.light, 'disconnected');
  // listening
  const m2 = await mount({ installs: ['4.2.1'], socketOpen: true });
  const v = (await m2.http('GET', '/api/blender?refresh=1')).json;
  assert.equal(v.light, 'connected');
  assert.equal(v.chosenBackend, 'community');
  assert.match(v.backendReason, /older than 5\.1/);
});

test('the status view carries no secrets (no boat key, no token)', async () => {
  const m = await mount({ installs: ['5.1.0'] });
  const t = (await m.http('GET', '/api/blender')).text;
  assert.ok(!t.includes('boat-secret-key-12345') && !t.includes(TOKEN));
});

test('config route validates, persists only the "blender" key in config.json, and emits a status event', async () => {
  const m = await mount({ enabled: false });
  const bad = [{ backend: 'evil' }, { sandbox: 'maybe' }, { port: 80 }, { port: 'x' }, { enabled: 'yes' }, { installPath: 5 }];
  for (const b of bad) assert.equal((await m.http('POST', '/api/blender/config', b)).status, 400, JSON.stringify(b));
  const before = JSON.parse(readFileSync(m.configPath, 'utf8'));
  const r = await m.http('POST', '/api/blender/config', { enabled: true, backend: 'community', sandbox: 'vm', port: 9999, host: '10.0.0.9', advanced: { vm: { runCommand: 'rm -rf /' } }, entry: { command: 'evil' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.enabled, true);
  assert.equal(r.json.port, 9999);
  const after = JSON.parse(readFileSync(m.configPath, 'utf8'));
  assert.equal(after.blender.enabled, true);
  assert.equal(after.blender.backend, 'community');
  assert.equal(after.blender.sandbox, 'vm');
  assert.equal(after.blender.port, 9999);
  assert.equal(after.blender.host, '127.0.0.1', 'host cannot be changed through the route');
  assert.equal(after.blender.entry, undefined, 'entry cannot be set through the route');
  assert.ok(!JSON.stringify(after.blender.advanced).includes('rm -rf'), 'advanced cannot be set through the route');
  assert.equal(after.authToken, before.authToken);
  assert.deepEqual(after.mcpServers, before.mcpServers);
  assert.ok(m.events.some((e) => e.type === 'blender.status' && e.status.enabled === true));
});

test('setup route: downloads only now, installs, records the entry and the hash, persists; a second status shows it', async () => {
  const m = await mount({ installs: ['5.1.0'] });
  assert.equal(m.downloads.length, 0, 'nothing downloaded before the button');
  const r = await m.http('POST', '/api/blender/setup', { target: 'live' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, JSON.stringify(r.json.steps));
  assert.equal(m.downloads.length, 1);
  const saved = JSON.parse(readFileSync(m.configPath, 'utf8'));
  assert.equal(saved.blender.entry.command, 'uv');
  assert.equal(r.json.status.setup.official.license, 'GPL-3.0-or-later');
  assert.ok(existsSync(join(m.dataDir, 'blender', 'setup.json')));
  assert.equal(r.json.status.light, 'disconnected');
  assert.equal((await m.http('POST', '/api/blender/setup', { target: 'nonsense' })).status, 400);
});

test('S5: setup route: a changed hash is refused (nothing replaced) until the user re-trusts; the trusted hash only changes on re-trust', async () => {
  const m = await mount({ installs: ['5.1.0'], unpinned: true });
  const setupFile = join(m.dataDir, 'blender', 'setup.json');
  m.hash.value = 'c'.repeat(64);
  const first = await m.http('POST', '/api/blender/setup', { target: 'live' });
  assert.equal(first.json.ok, true, JSON.stringify(first.json.steps));
  assert.equal(JSON.parse(readFileSync(setupFile, 'utf8')).official.sha256, 'c'.repeat(64));
  const entryBefore = JSON.parse(readFileSync(m.configPath, 'utf8')).blender.entry;
  m.hash.value = 'd'.repeat(64);
  const changed = await m.http('POST', '/api/blender/setup', { target: 'live' });
  assert.equal(changed.json.ok, false);
  assert.equal(changed.json.retrustRequired, 'official');
  assert.match(JSON.stringify(changed.json.steps), /CHANGED/);
  assert.equal(JSON.parse(readFileSync(setupFile, 'utf8')).official.sha256, 'c'.repeat(64), 'the trusted hash was not overwritten');
  assert.deepEqual(JSON.parse(readFileSync(m.configPath, 'utf8')).blender.entry, entryBefore, 'the start command was not replaced');
  assert.equal((await m.http('POST', '/api/blender/setup', { target: 'live', retrust: 'yes' })).status, 400, 'retrust must be a real boolean');
  const again = await m.http('POST', '/api/blender/setup', { target: 'live', retrust: true });
  assert.equal(again.json.ok, true, JSON.stringify(again.json.steps));
  assert.equal(JSON.parse(readFileSync(setupFile, 'utf8')).official.sha256, 'd'.repeat(64));
});

test('S5: the state store itself refuses to replace a trusted hash from the same address without retrust', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-blstate-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ blender: {} }));
  const st = new BlenderState({ dataDir: dir });
  const info = (sha256: string) => ({ url: 'https://example.org/a.zip', sha256, at: 'x', license: 'MIT' });
  st.recordSetup({ kind: 'official', info: info('1'.repeat(64)), addonInstalled: false });
  assert.throws(() => st.recordSetup({ kind: 'official', info: info('2'.repeat(64)), addonInstalled: false }), /re-trust/);
  assert.equal(st.setup.official!.sha256, '1'.repeat(64));
  st.recordSetup({ kind: 'official', info: info('2'.repeat(64)), addonInstalled: false, retrust: true });
  assert.equal(st.setup.official!.sha256, '2'.repeat(64));
});

test('B3: the status view carries the add-on socket notice (and says so next to the audit verdict) while the bridge can use a live backend', async () => {
  const m = await mount({ installs: ['4.2.1'], socketOpen: true });
  const r = await m.http('GET', '/api/blender?refresh=1');
  assert.equal(r.status, 200, r.text);
  assert.ok(Array.isArray(r.json.notices), JSON.stringify(r.json));
  assert.ok(r.json.notices.some((n: string) => /any program on this computer/.test(n)), r.json.notices.join('|'));
  // the socket notice is about live Blender only: not shown when scripts are restricted to this computer or to the VM
  for (const mode of ['local', 'vm']) {
    await m.http('POST', '/api/blender/config', { mode });
    const v = await m.http('GET', '/api/blender?refresh=1');
    assert.equal((v.json.notices ?? []).some((n: string) => /any program on this computer/.test(n)), false, mode);
  }
  await m.http('POST', '/api/blender/config', { mode: 'live' });
  assert.ok(((await m.http('GET', '/api/blender?refresh=1')).json.notices ?? []).some((n: string) => /any program on this computer/.test(n)));
});

test('setup is refused while the bridge is off', async () => {
  const m = await mount({ enabled: false });
  const r = await m.http('POST', '/api/blender/setup', {});
  assert.equal(r.json.ok, false);
  assert.equal(m.downloads.length, 0);
});

test('test route: socket closed gives a readable failure; open gives steps socket, connect, inspect', async () => {
  const closed = await mount({ installs: ['4.2.1'], socketOpen: false });
  const a = await closed.http('POST', '/api/blender/test', {});
  assert.equal(a.json.ok, false);
  assert.equal(a.json.steps[0].step, 'socket');
  const open = await mount({ installs: ['4.2.1'], socketOpen: true });
  const b = await open.http('POST', '/api/blender/test', {});
  assert.equal(b.json.ok, true, JSON.stringify(b.json.steps));
  assert.deepEqual(b.json.steps.map((s: any) => s.step).slice(0, 3), ['socket', 'connect', 'inspect']);
});

test('SSE: blender.status reaches the admin stream and is dropped from a token-only stream', async () => {
  const m = await mount();
  const read = async (headers: Record<string, string>) => {
    const ac = new AbortController();
    const res = await fetch(m.srv.base + '/api/events', { headers, signal: ac.signal });
    const reader = res.body!.getReader();
    let text = '';
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch { /* aborted */ } })();
    return { get text() { return text; }, stop: async () => { ac.abort(); await pump; } };
  };
  const admin = await read(AUTH);
  const client = await read(asClient);
  await new Promise((r) => setTimeout(r, 100));
  await m.http('POST', '/api/blender/config', { sandbox: 'off' });
  await new Promise((r) => setTimeout(r, 300));
  assert.match(admin.text, /blender\.status/);
  assert.doesNotMatch(client.text, /blender\.status/);
  await admin.stop(); await client.stop();
});

test('without a sandbox port the view says so and the light never claims the sandbox', async () => {
  const m = await mount({ installs: [], withSandbox: false });
  const v = (await m.http('GET', '/api/blender')).json;
  assert.equal(v.sandboxReady, false);
  assert.equal(v.light, 'not-found');
});

void agent;

test('C19 module: an install that enabled the bridge before the mode key existed gets the upgrade notice in the status view until any mode is saved; the mirror is written with it', async () => {
  const NOTICE = /Scripts now run in Blender on this computer by default when it is found\. Pick Cloud VM to keep the old behaviour\./;
  const m = await mount({ installs: ['5.1.0'], raw: { sandbox: 'auto' } });
  const a = (await m.http('GET', '/api/blender?refresh=1')).json;
  assert.ok((a.notices as string[]).some((n) => NOTICE.test(n)), JSON.stringify(a.notices));
  assert.equal(a.mode, 'auto');
  // an unrelated save does not clear it, and writes no mode key
  await m.http('POST', '/api/blender/config', { port: 9877 });
  assert.equal('mode' in JSON.parse(readFileSync(m.configPath, 'utf8')).blender, false);
  assert.ok(((await m.http('GET', '/api/blender?refresh=1')).json.notices as string[]).some((n) => NOTICE.test(n)));
  // saving a mode (here the same one) clears it, writes mode and mirrors the legacy key
  const saved = (await m.http('POST', '/api/blender/config', { mode: 'vm' })).json;
  assert.equal((saved.notices ?? []).some((n: string) => NOTICE.test(n)), false);
  const file = JSON.parse(readFileSync(m.configPath, 'utf8')).blender;
  assert.equal(file.mode, 'vm');
  assert.equal(file.sandbox, 'vm');
  assert.equal((await m.http('GET', '/api/blender?refresh=1')).json.mode, 'vm');
});

test('C19 module: no upgrade notice for a bridge that is off, for installs whose legacy setting already restricts the place, or for one turned on just now; legacy "off" means live', async () => {
  const NOTICE = /Scripts now run in Blender on this computer/;
  const has = async (m: Awaited<ReturnType<typeof mount>>) => ((await m.http('GET', '/api/blender?refresh=1')).json.notices ?? []).some((n: string) => NOTICE.test(n));
  assert.equal(await has(await mount({ enabled: false, raw: { sandbox: 'auto' } })), false);
  assert.equal(await has(await mount({ raw: { sandbox: 'vm' } })), false);
  const off = await mount({ raw: { sandbox: 'off' } });
  assert.equal(await has(off), false);
  const v = (await off.http('GET', '/api/blender?refresh=1')).json;
  assert.equal(v.mode, 'live', 'the legacy "off" is the old name of live, never local');
  assert.match(v.nextRun, /open Blender/);
  // turning the bridge on from Settings records the mode in force, so a fresh install never sees the upgrade notice
  const fresh = await mount({ enabled: false });
  await fresh.http('POST', '/api/blender/config', { enabled: true });
  assert.equal(JSON.parse(readFileSync(fresh.configPath, 'utf8')).blender.mode, 'auto');
  assert.equal(await has(fresh), false);
});

test('status: lights local and busy, localReady, nextRun and busy field follow the mode and the runners', async () => {
  const light = async (o: Parameters<typeof mount>[0]) => (await (await mount(o)).http('GET', '/api/blender?refresh=1')).json;
  const a = await light({ installs: ['5.1.0'], localReady: true, raw: { mode: 'auto' } });
  assert.equal(a.light, 'local');
  assert.equal(a.localReady, true);
  assert.equal(a.busy, null);
  assert.match(a.nextRun, /^On this computer \(Blender 5\.1\.0\)/);
  // local-only with nothing found: not a VM light
  const b = await light({ installs: [], localReady: false, sandboxReady: true, raw: { mode: 'local' } });
  assert.equal(b.light, 'not-found');
  assert.match(b.nextRun, /Blender was not found on this computer/);
  // Automatic falls to the VM light and says so in nextRun
  const c = await light({ installs: [], localReady: false, sandboxReady: true, raw: { mode: 'auto' } });
  assert.equal(c.light, 'sandbox');
  assert.match(c.nextRun, /cloud VM/);
  // VM-only does not claim a local light even when Blender is there
  const d = await light({ installs: ['5.1.0'], localReady: true, sandboxReady: true, raw: { mode: 'vm' } });
  assert.equal(d.light, 'sandbox');
  assert.equal(d.localReady, true);
  assert.match(d.nextRun, /cloud VM/);
  // nothing injected: the production LocalRunner reads the detected install (see blender-production-wiring.test.ts for the full path)
  const e = await light({ installs: ['5.1.0'], realLocal: true, raw: { mode: 'auto' } });
  assert.equal(e.localReady, true);
  assert.match(e.localNote, /Blender 5\.1\.0/);
});

test('status: the busy light and field appear while a script runs through the module and go away afterwards', async () => {
  const m = await mount({ installs: ['5.1.0'], localReady: true, raw: { mode: 'local' } });
  const sc = m.store.getAgent('sculptor')!;
  let release: () => void = () => undefined;
  m.local.onRun = () => new Promise<void>((res) => { release = res; });
  const server = m.mod.mcpServers!(sc, { taskId: 't1' } as never)['legion_blender'] as { instance: { connect: (t: unknown) => Promise<void> } };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 'x', version: '0' });
  await client.connect(ct);
  m.bus.on((e) => { if (e.type === 'approval.requested') setImmediate(() => m.approvals.resolve(e.approval.id, true)); });
  const run = client.callTool({ name: 'blender_exec', arguments: { script: 'import bpy\nprint(1)\n' } });
  for (let i = 0; i < 200 && m.local.runs.length < 1; i++) await new Promise((x) => setTimeout(x, 10));
  const during = (await m.http('GET', '/api/blender?refresh=1')).json;
  assert.equal(during.light, 'busy');
  assert.equal(during.busy.mode, 'local');
  assert.match(during.busy.hash12, /^[0-9a-f]{12}$/);
  release();
  await run;
  const after = (await m.http('GET', '/api/blender?refresh=1')).json;
  assert.equal(after.busy, null);
  assert.equal(after.light, 'local');
  await client.close();
});

test('the Sculptor preamble and blender_status describe the decision table, not "scripts default to the sandbox"', async () => {
  const m = await mount({ installs: ['5.1.0'], localReady: true, raw: { mode: 'auto' } });
  const sc = m.store.getAgent('sculptor')!;
  const pre = m.mod.preamble!(sc);
  assert.doesNotMatch(pre, /default to the sandbox/);
  assert.match(pre, /Automatic/);
  assert.match(pre, /this computer/);
  assert.match(pre, /not redirected/);
});

test('config route: accepts mode (and still the legacy sandbox key), rejects junk', async () => {
  const m = await mount({ installs: ['5.1.0'] });
  assert.equal((await m.http('POST', '/api/blender/config', { mode: 'nope' })).status, 400);
  assert.equal((await m.http('POST', '/api/blender/config', { mode: 'off' })).status, 400, 'off is a legacy alias, not a mode');
  assert.equal((await m.http('POST', '/api/blender/config', { mode: 'local' })).json.mode, 'local');
  assert.equal(JSON.parse(readFileSync(m.configPath, 'utf8')).blender.sandbox, 'auto');
  assert.equal((await m.http('POST', '/api/blender/config', { sandbox: 'off' })).json.mode, 'live');
});

// ---------------------------------------------------------------- B4 (managed download) and B5 (first-use chooser) at module level
import { createHash } from 'node:crypto';
import { GET_BLENDER_TOOL, MANAGED_BLENDER } from '../src/shared/blender.js';
import { createGetBlenderPorts } from '../src/core/blender/system.js';
import { SCULPTOR_PREAMBLE_ON } from '../src/core/blender/index.js';
import { makeZip } from './zip-helpers.js';
import { rig as guardRig, connectTools, GOOD_SCRIPT } from './blender-helpers.js';

const TOPDIR = 'blender-5.2.2-windows-x64';
function getRig() {
  const zip = makeZip([{ name: `${TOPDIR}/` }, { name: `${TOPDIR}/blender.exe`, data: Buffer.from('MZ-fake'), method: 8 }]);
  const calls: string[] = [];
  const base = createGetBlenderPorts();
  const ports: GetBlenderPorts = {
    ...base, platform: 'win32',
    download: async (url, dest) => { calls.push(url); mkdirSync(join(dest, '..'), { recursive: true }); writeFileSync(dest, zip); return { sha256: createHash('sha256').update(zip).digest('hex'), bytes: zip.length }; },
  };
  const pin: ManagedPin = { ...MANAGED_BLENDER, topDir: TOPDIR, sha256: createHash('sha256').update(zip).digest('hex'), maxEntries: 50, maxUnpackedBytes: 1 << 20 };
  return { ports, pin, calls };
}
const answerNext = (m: Awaited<ReturnType<typeof mount>>, allow: boolean | 'ignore', seen: any[] = []) => m.bus.on((e) => {
  if (e.type === 'approval.requested') { seen.push(e.approval); if (allow !== 'ignore') setImmediate(() => m.approvals.resolve(e.approval.id, allow)); }
});

test('B4: POST /api/blender/get is admin-only: a token-only client gets 403 and no card or download happens', async () => {
  const g = getRig();
  const m = await mount({ getPorts: g.ports, managedPin: g.pin });
  const seen: any[] = [];
  answerNext(m, true, seen);
  const r = await m.http('POST', '/api/blender/get', {}, asClient);
  assert.equal(r.status, 403);
  assert.deepEqual(g.calls, []);
  assert.deepEqual(seen, []);
});

test('B4: a denied card downloads nothing; an allowed card installs, records and the status shows it', async () => {
  const g = getRig();
  const m = await mount({ getPorts: g.ports, managedPin: g.pin });
  const seen: any[] = [];
  const off = answerNext(m, false, seen);
  const denied = await m.http('POST', '/api/blender/get', {});
  assert.equal(denied.status, 200);
  assert.equal(denied.json.ok, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolName, GET_BLENDER_TOOL);
  assert.match(seen[0].summary, /GPL-3\.0-or-later/);
  assert.deepEqual(g.calls, [], 'denied: nothing fetched');
  assert.equal(denied.json.status.managed.installed, null);
  off();
  answerNext(m, true);
  const ok = await m.http('POST', '/api/blender/get', {});
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json.steps));
  assert.equal(g.calls.length, 1);
  assert.equal(ok.json.status.managed.installed.version, '5.2.2');
  assert.equal(ok.json.status.managed.pinned, true);
  assert.ok(existsSync(ok.json.status.managed.installed.path));
});

test('B4: the bridge must be on, and the shipped pin is what an unconfigured core reports', async () => {
  const m = await mount({ enabled: false });
  assert.equal((await m.http('POST', '/api/blender/get', {})).status, 409);
  const m2 = await mount();
  const st = (await m2.http('GET', '/api/blender')).json;
  assert.equal(st.managed.version, MANAGED_BLENDER.version);
  assert.equal(st.managed.pinned, true);
  assert.equal(st.managed.downloadPage, 'https://www.blender.org/download/');
});

test('B5: the chooser question is open until the user picks; enabling alone does not answer it; an agent-supplied mode never changes the saved settings', async () => {
  const m = await mount({ enabled: false });
  await m.http('POST', '/api/blender/config', { enabled: true });
  let st = (await m.http('GET', '/api/blender')).json;
  assert.equal(st.modeAsked, false, 'turning the bridge on does not answer it');
  assert.equal((await m.http('POST', '/api/blender/config', { mode: 'local' }, asClient)).status, 403, 'a token-class caller cannot answer it');
  assert.equal((await m.http('GET', '/api/blender')).json.modeAsked, false);

  // a model asking for another place through the tool argument changes nothing that is saved
  const before = JSON.stringify(readFileSync(m.configPath, 'utf8'));
  const g = guardRig();
  const t = await connectTools(g);
  await t.call('blender_exec', { script: GOOD_SCRIPT, mode: 'vm', purpose: 'x' });
  assert.equal(JSON.stringify(readFileSync(m.configPath, 'utf8')), before);
  assert.equal(g.cfg.mode, undefined, 'the guard config has no mode saved by the call');
  await t.close();

  const saved = await m.http('POST', '/api/blender/config', { mode: 'local' });
  assert.equal(saved.json.modeAsked, true);
  assert.equal(saved.json.mode, 'local');
  assert.equal(JSON.parse(readFileSync(m.configPath, 'utf8')).blender.modeAsked, true);
});

test('B5: the Sculptor preamble says when to use local, the VM and live, and that settings are not the model\'s to change', () => {
  const p = SCULPTOR_PREAMBLE_ON;
  assert.match(p, /"local"[^\n]*quick edits[^\n]*own scenes/i);
  assert.match(p, /"vm"[^\n]*(web|unknown source)[^\n]*long or heavy[^\n]*no Blender is installed/i);
  assert.match(p, /"live"[^\n]*only when the user asked/i);
  assert.match(p, /filter, not a sandbox/);
  assert.match(p, /in one line which place you chose and why/);
  assert.match(p, /ask the user in chat/);
  assert.match(p, /cannot change Settings/);
});
