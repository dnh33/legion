import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isClientRoute } from '../src/core/admin.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { createBrowserModule } from '../src/core/browser/index.js';
import type { LaunchPorts } from '../src/core/browser/launcher.js';
import { createLaunchPorts, createGetPorts } from '../src/core/browser/system.js';
import type { Handler } from '../src/core/server.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import type { ApprovalRequest } from '../src/shared/types.js';
import { agent } from './blender-helpers.js';
import { fakeResolver } from './browser-fakes.js';

const FAKE = fileURLToPath(new URL('./browser-fake-lightpanda.js', import.meta.url));
const NATIVE = 'n'.repeat(64);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 40)); } return cond(); };
const DNS = fakeResolver({ 'a.test': ['93.184.216.34'] });

function rig(o: { mode?: string; limits?: Record<string, number>; nativeSecret?: string | null; answer?: (a: ApprovalRequest) => boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'br-mod-'));
  const reportBase = join(dataDir, 'report');
  const pages = join(dataDir, 'pages.json');
  writeFileSync(pages, JSON.stringify({ 'https://a.test/': { title: 'Home', text: 'hello from the fake' } }));
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus);
  const cards: ApprovalRequest[] = [];
  bus.on((e) => { if (e.type === 'approval.requested') { cards.push(e.approval); setImmediate(() => approvals.resolve(e.approval.id, o.answer ? o.answer(e.approval) : true)); } });
  const base = createLaunchPorts();
  let n = 0;
  const reports: string[] = [];
  const launchPorts: LaunchPorts = { ...base, proc: { spawn(req) { const rep = `${reportBase}-${++n}.json`; reports.push(rep); return base.proc.spawn({ ...req, file: process.execPath, prefixArgs: [FAKE, rep, o.mode ?? 'ok', pages] }); }, kill: base.proc.kill } };
  const deps = { config: { authToken: 'tok-12345678' }, bus, approvals, dataDir } as unknown as ModuleDeps;
  const mod = createBrowserModule(deps, { launchPorts, resolve: DNS, limits: o.limits, ...(o.nativeSecret === null ? {} : { nativeSecret: o.nativeSecret ?? NATIVE }) });
  const routes = new Map<string, Handler>();
  mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  const call = async (key: string, body?: unknown, headers: Record<string, string> = {}) => (routes.get(key)!({ req: { headers }, body, url: new URL('http://x/'), params: [], res: {} } as never));
  const pidOf = (i: number) => (JSON.parse(readFileSync(reports[i]!, 'utf8')) as { pid: number }).pid;
  return { mod, dataDir, cards, call, routes, reports, pidOf, spawned: () => reports.length };
}

async function tools(r: ReturnType<typeof rig>, taskId = 'task_1', mode: 'ask' | 'full' = 'full') {
  const tainted = { n: 0 };
  const job: ModuleJob = { taskId, taint: () => tainted.n > 0, markTainted: () => { tainted.n++; } };
  const srv = r.mod.mcpServers!(agent('worker', { approval: mode }), job)['legion_browser'] as unknown as { instance: { connect(t: unknown): Promise<void> } };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.instance.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => { const res = await client.callTool({ name, arguments: args }); return { text: (res.content as Array<{ text?: string }>).map((c) => c.text).join('\n'), isError: res.isError === true }; };
  return { call, client, tainted };
}

test('off by default: no tools, no preamble, no process', async () => {
  const r = rig();
  assert.deepEqual(r.mod.mcpServers!(agent('w')), {});
  assert.equal(r.mod.preamble!(agent('w')), '');
  assert.equal(r.spawned(), 0);
  assert.equal(((await r.call('GET /api/browser')) as { enabled: boolean }).enabled, false);
});

test('C15: the browser routes are admin-only by default-deny (none is on the MCP client list)', () => {
  const r = rig();
  for (const key of r.routes.keys()) { const [m, p] = key.split(' '); assert.equal(isClientRoute(m!, p!), false, key); }
  assert.deepEqual([...r.routes.keys()].sort(), ['GET /api/browser', 'POST /api/browser/config', 'POST /api/browser/get', 'POST /api/browser/local', 'POST /api/browser/test']);
});

test('C15: allow-local needs the native secret, lives in memory only and is off for a new module', async () => {
  const r = rig();
  const body = { allow: true, ports: [8080] };
  await assert.rejects(r.call('POST /api/browser/local', body), /native_required/);
  await assert.rejects(r.call('POST /api/browser/local', body, { 'x-legion-native': 'wrong' }), /native_required/);
  const off = rig({ nativeSecret: null });
  await assert.rejects(off.call('POST /api/browser/local', body, { 'x-legion-native': NATIVE }), /native_unavailable/);
  await assert.rejects(r.call('POST /api/browser/local', { allow: true, ports: ['x'] }, { 'x-legion-native': NATIVE }), /ports/);
  const st = await r.call('POST /api/browser/local', body, { 'x-legion-native': NATIVE }) as { allowLocal: boolean };
  assert.equal(st.allowLocal, true);
  assert.ok(!readdirSync(r.dataDir).some((f) => f === 'browser') || !/allowLocal|localPorts|8080/.test(readFileSync(join(r.dataDir, 'browser', 'config.json'), 'utf8')), 'nothing about local addresses is written to disk');
  const fresh = createBrowserModule({ config: { authToken: 'x' }, bus: new EventBus(), approvals: new ApprovalBroker(new EventBus()), dataDir: r.dataDir } as unknown as ModuleDeps, {});
  const rs = new Map<string, Handler>(); fresh.routes!((m, p, h) => { rs.set(`${m} ${p}`, h); });
  assert.equal(((await rs.get('GET /api/browser')!({} as never)) as { allowLocal: boolean }).allowLocal, false);
});

test('config route validates, normalises and persists (domains cleaned, junk dropped)', async () => {
  const r = rig();
  await assert.rejects(r.call('POST /api/browser/config', { enabled: 'yes' }), /enabled/);
  await assert.rejects(r.call('POST /api/browser/config', { allowDomains: 'a.com' }), /allowDomains/);
  const st = await r.call('POST /api/browser/config', { enabled: true, allowDomains: ['Example.com', '*.docs.org', 'not a domain', 'localhost', 'x'.repeat(300) + '.com'] }) as { enabled: boolean; allowDomains: string[] };
  assert.equal(st.enabled, true);
  assert.deepEqual(st.allowDomains, ['example.com', 'docs.org']);
  assert.deepEqual(JSON.parse(readFileSync(join(r.dataDir, 'browser', 'config.json'), 'utf8')).allowDomains, ['example.com', 'docs.org']);
});

test('full stack: enabled module, a fake lightpanda process, a page read, and the run ending kills the process', async () => {
  const r = rig();
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  const t = await tools(r);
  try {
    assert.match(r.mod.preamble!(agent('w')), /untrusted|stranger/i);
    const open = await t.call('browser_open', { url: 'https://a.test/' });
    assert.equal(open.isError, false, open.text);
    assert.match((await t.call('browser_text')).text, /hello from the fake/);
    assert.equal(r.cards.length, 1);
    const pid = r.pidOf(0);
    assert.ok(alive(pid));
    assert.equal((r.mod.manager.running()), 1);
    r.mod.onTaskEnd!({ id: 'task_1' } as never, agent('w'), { status: 'done', isError: false, tainted: true });
    assert.equal(await until(() => !alive(pid)), true, 'the browser process is gone when the run ends');
    assert.equal(r.mod.manager.running(), 0);
  } finally { await r.mod.dispose!(); await t.client.close(); }
});

test('C12: idle timeout and wall timeout stop the process; dispose stops all of them', async () => {
  let r = rig({ limits: { idleMs: 400, wallMs: 60_000 } });
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  let t = await tools(r);
  await t.call('browser_open', { url: 'https://a.test/' });
  let pid = r.pidOf(0);
  assert.equal(await until(() => !alive(pid), 4000), true, 'idle: stopped');
  await t.client.close(); await r.mod.dispose!();

  r = rig({ limits: { idleMs: 60_000, wallMs: 500 } });
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  t = await tools(r);
  await t.call('browser_open', { url: 'https://a.test/' });
  pid = r.pidOf(0);
  assert.equal(await until(() => !alive(pid), 4000), true, 'wall: stopped');
  await t.client.close(); await r.mod.dispose!();

  r = rig();
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  t = await tools(r, 'task_a'); const t2 = await tools(r, 'task_b');
  await t.call('browser_open', { url: 'https://a.test/' }); await t2.call('browser_open', { url: 'https://a.test/' });
  const pids = [r.pidOf(0), r.pidOf(1)];
  await r.mod.dispose!();
  assert.equal(await until(() => pids.every((p) => !alive(p))), true, 'dispose: every process stopped');
  await t.client.close(); await t2.client.close();
});

test('C12: at most N browsers run at once; the next run is told to wait and no extra process starts', async () => {
  const r = rig({ limits: { maxProcesses: 1 } });
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  const a = await tools(r, 'task_a'); const b = await tools(r, 'task_b');
  try {
    assert.equal((await a.call('browser_open', { url: 'https://a.test/' })).isError, false);
    const second = await b.call('browser_open', { url: 'https://a.test/' });
    assert.equal(second.isError, true); assert.match(second.text, /already running/);
    assert.equal(r.spawned(), 1);
    await a.call('browser_close');
    assert.equal((await b.call('browser_open', { url: 'https://a.test/' })).isError, false, 'a free slot is reused');
  } finally { await r.mod.dispose!(); await a.client.close(); await b.client.close(); }
});

test('failure: no binary configured and the safety-option rejection come back as plain tool errors', async () => {
  let r = rig();
  await r.call('POST /api/browser/config', { enabled: true });
  let t = await tools(r);
  const none = await t.call('browser_open', { url: 'https://a.test/' });
  assert.equal(none.isError, true); assert.match(none.text, /not installed|Get Lightpanda|WSL/);
  assert.equal(r.spawned(), 0);
  await t.client.close(); await r.mod.dispose!();
  r = rig({ mode: 'reject' });
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  t = await tools(r);
  const rej = await t.call('browser_open', { url: 'https://a.test/' });
  assert.equal(rej.isError, true); assert.match(rej.text, /rejected a required safety option/);
  await t.client.close(); await r.mod.dispose!();
});

test('the test route starts the program with the safety options and reports plainly', async () => {
  let r = rig();
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  assert.equal(((await r.call('POST /api/browser/test')) as { ok: boolean }).ok, true);
  assert.equal(await until(() => !alive(r.pidOf(0))), true);
  r = rig({ mode: 'reject' });
  await r.call('POST /api/browser/config', { enabled: true, binaryPath: 'fake-lightpanda' }, { 'x-legion-native': NATIVE });
  const bad = (await r.call('POST /api/browser/test')) as { ok: boolean; detail: string };
  assert.equal(bad.ok, false); assert.match(bad.detail, /safety option/);
});

test('C10/C16 at module level: Get Lightpanda asks first; a tampered managed file is refused at start', async () => {
  const bytes = Buffer.from('fake program');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const dataDir = mkdtempSync(join(tmpdir(), 'br-modget-'));
  const bus = new EventBus(); const approvals = new ApprovalBroker(bus);
  const cards: ApprovalRequest[] = [];
  bus.on((e) => { if (e.type === 'approval.requested') { cards.push(e.approval); setImmediate(() => approvals.resolve(e.approval.id, true)); } });
  let downloads = 0;
  const getPorts = { ...createGetPorts(), platformKey: 'linux-x64', async download(_u: string, dest: string) { downloads++; writeFileSync(dest, bytes); return { sha256: sha, bytes: bytes.length }; } };
  const pin = { id: 'test-linux-x64', platform: 'linux-x64', url: 'https://example.com/lp', sha256: sha, approxBytes: 100, maxBytes: 1000, exe: 'lightpanda', license: 'AGPL-3.0', sourceUrl: 'https://example.com' };
  const mod = createBrowserModule({ config: { authToken: 'x' }, bus, approvals, dataDir } as unknown as ModuleDeps, { getPorts, pins: [pin], resolve: DNS });
  const routes = new Map<string, Handler>(); mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  const res = await routes.get('POST /api/browser/get')!({} as never) as { ok: boolean; status: { binary: string } };
  assert.equal(res.ok, true);
  assert.equal(res.status.binary, 'managed');
  assert.equal(cards.length, 1); assert.match(cards[0]!.summary, /AGPL-3\.0/); assert.equal(cards[0]!.toolName, 'browser_get_lightpanda');
  assert.equal(downloads, 1);
  // tamper with the installed file: the test route (and a run) must refuse to start it
  const rec = JSON.parse(readFileSync(join(dataDir, 'browser', 'managed.json'), 'utf8')) as { exe: string };
  writeFileSync(join(dataDir, 'browser', 'app', rec.exe), 'evil');
  await routes.get('POST /api/browser/config')!({ body: { enabled: true } } as never);
  const t = await routes.get('POST /api/browser/test')!({} as never) as { ok: boolean; detail: string };
  assert.equal(t.ok, false); assert.match(t.detail, /no longer matches/);
  assert.ok(existsSync(join(dataDir, 'browser', 'app')));
});
