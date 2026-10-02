import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { createBrowserModule } from '../src/core/browser/index.js';
import type { ChromiumIo } from '../src/core/browser/chromium.js';
import type { LaunchPorts } from '../src/core/browser/launcher.js';
import { createLaunchPorts } from '../src/core/browser/system.js';
import type { Handler } from '../src/core/server.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import type { ApprovalRequest } from '../src/shared/types.js';
import { agent } from './blender-helpers.js';
import { fakeResolver } from './browser-fakes.js';

const FAKE_LP = fileURLToPath(new URL('./browser-fake-lightpanda.js', import.meta.url));
const FAKE_CHR = fileURLToPath(new URL('./browser-fake-chromium.js', import.meta.url));
const NATIVE = 'n'.repeat(64);
const DNS = fakeResolver({ 'a.test': ['93.184.216.34'] });
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WINENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } as NodeJS.ProcessEnv;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 40)); } return cond(); };

const fsOf = (files: string[], dirs: Record<string, string[]> = {}): ChromiumIo => ({ exists: (p) => files.includes(p), readDir: (p) => dirs[p] ?? [] });

function rig(o: { platform?: NodeJS.Platform; io?: ChromiumIo; env?: NodeJS.ProcessEnv } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'br-eng-'));
  const pages = join(dataDir, 'pages.json');
  writeFileSync(pages, JSON.stringify({ 'https://a.test/': { title: 'Home', text: 'hello from the fake' } }));
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus);
  const cards: ApprovalRequest[] = [];
  bus.on((e) => { if (e.type === 'approval.requested') { cards.push(e.approval); setImmediate(() => approvals.resolve(e.approval.id, true)); } });
  const base = createLaunchPorts();
  const spawns: Array<{ engine: 'chromium' | 'lightpanda'; report: string }> = [];
  const launchPorts: LaunchPorts = { ...base, proc: { spawn(req) {
    const engine = req.args.includes('--headless=new') ? 'chromium' : 'lightpanda';
    const report = join(dataDir, `report-${spawns.length}.json`);
    spawns.push({ engine, report });
    return base.proc.spawn({ ...req, file: process.execPath, prefixArgs: [engine === 'chromium' ? FAKE_CHR : FAKE_LP, report, 'ok', pages] });
  }, kill: base.proc.kill } };
  const deps = { config: { authToken: 'tok-12345678' }, bus, approvals, dataDir } as unknown as ModuleDeps;
  const mod = createBrowserModule(deps, { launchPorts, resolve: DNS, nativeSecret: NATIVE, platform: o.platform ?? 'win32', hostEnv: o.env ?? WINENV, chromiumIo: o.io ?? fsOf([EDGE], { 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application': ['120.0.2210.91', 'msedge.exe'] }) });
  const routes = new Map<string, Handler>();
  mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  const call = async (key: string, body?: unknown, headers: Record<string, string> = {}) => (routes.get(key)!({ req: { headers }, body, url: new URL('http://x/'), params: [], res: {} } as never));
  const pid = (i: number) => (JSON.parse(readFileSync(spawns[i]!.report, 'utf8')) as { pid: number }).pid;
  return { mod, dataDir, cards, call, spawns, pid };
}
type Rig = ReturnType<typeof rig>;
const status = async (r: Rig) => await r.call('GET /api/browser') as { engine: string; engineChosen: boolean; chromium: { name: string; version?: string; tooOld?: boolean } | null; chromiumTried: string[]; note: string };

async function tools(r: Rig, taskId = 'task_1') {
  const job: ModuleJob = { taskId, taint: () => true, markTainted: () => undefined };
  const srv = r.mod.mcpServers!(agent('worker', { approval: 'full' }), job)['legion_browser'] as unknown as { instance: { connect(t: unknown): Promise<void> } };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.instance.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => { const res = await client.callTool({ name, arguments: args }); return { text: (res.content as Array<{ text?: string }>).map((c) => c.text).join('\n'), isError: res.isError === true }; };
  return { call, client };
}

test('E7: the default engine: Windows uses the Chromium-family browser found; elsewhere what is configured (Lightpanda if set up, else a Chromium found)', async () => {
  let r = rig();
  let s = await status(r);
  assert.equal(s.engine, 'chromium'); assert.equal(s.engineChosen, false);
  assert.equal(s.chromium!.name, 'Microsoft Edge'); assert.equal(s.chromium!.version, '120.0.2210.91');
  assert.match(s.note, /nothing is downloaded/);
  // Windows with nothing found: still chromium (never a silent switch to Lightpanda, which has no Windows build); the status says what to do
  r = rig({ io: fsOf([]) });
  s = await status(r);
  assert.equal(s.engine, 'chromium'); assert.equal(s.chromium, null); assert.ok(s.chromiumTried.length > 0); assert.match(s.note, /No Chromium-family browser was found/);
  // Linux: nothing configured and a Chromium present: chromium; Lightpanda configured: lightpanda
  r = rig({ platform: 'linux', io: fsOf(['/usr/bin/google-chrome']) });
  assert.equal((await status(r)).engine, 'chromium');
  await r.call('POST /api/browser/config', { binaryPath: '/opt/lightpanda' }, { 'x-legion-native': NATIVE });
  assert.equal((await status(r)).engine, 'lightpanda');
  // Linux with neither: lightpanda (its own "not installed" text)
  r = rig({ platform: 'linux', io: fsOf([]) });
  assert.equal((await status(r)).engine, 'lightpanda');
});

test('E7: an explicit engine choice wins both ways, needs no native secret, and rejects junk; the browser path does need it', async () => {
  const r = rig({ platform: 'linux', io: fsOf(['/usr/bin/google-chrome']) });
  await r.call('POST /api/browser/config', { engine: 'lightpanda' });
  let s = await status(r); assert.equal(s.engine, 'lightpanda'); assert.equal(s.engineChosen, true);
  await r.call('POST /api/browser/config', { engine: 'chromium' });
  assert.equal((await status(r)).engine, 'chromium');
  await assert.rejects(r.call('POST /api/browser/config', { engine: 'firefox' }), /engine must be/);
  await r.call('POST /api/browser/config', { engine: null });
  s = await status(r); assert.equal(s.engineChosen, false);
  await assert.rejects(r.call('POST /api/browser/config', { chromiumPath: '/tmp/evil' }), /native_required/);
  await assert.rejects(r.call('POST /api/browser/config', { chromiumPath: '/tmp/evil' }, { 'x-legion-native': 'wrong' }), /native_required/);
  await r.call('POST /api/browser/config', { chromiumPath: '/usr/bin/chromium' }, { 'x-legion-native': NATIVE });
  // the owner's path is used and nothing else is tried when it is missing
  const st = await status(r);
  assert.equal(st.chromium, null); assert.deepEqual(st.chromiumTried, ['/usr/bin/chromium']);
});

test('E8: a full run on the Chromium engine (fake Edge on Windows paths): the result names the engine, a card shows the first page, nothing is downloaded, and the process is stopped when the run ends', async () => {
  const r = rig();
  await r.call('POST /api/browser/config', { enabled: true });
  const t = await tools(r);
  try {
    const open = await t.call('browser_open', { url: 'https://a.test/' });
    assert.equal(open.isError, false, open.text);
    assert.match(open.text, /Engine: Microsoft Edge 120\.0\.2210\.91 \(headless\)\./);
    assert.match((await t.call('browser_text')).text, /hello from the fake/);
    assert.match((await t.call('browser_status')).text, /Engine: Microsoft Edge 120\.0\.2210\.91 \(headless\)/);
    assert.equal(r.cards.length, 1); assert.match(r.cards[0]!.summary, /Open a web page: https:\/\/a\.test\//);
    assert.deepEqual(r.spawns.map((s) => s.engine), ['chromium']);
    const rep = JSON.parse(readFileSync(r.spawns[0]!.report, 'utf8')) as { argv: string[]; cwd: string; userDataDir: string };
    assert.ok(rep.argv.includes('--headless=new') && !rep.argv.includes('--no-sandbox'));
    const p = r.pid(0); assert.ok(alive(p));
    r.mod.onTaskEnd!({ id: 'task_1' } as never, agent('w'), { status: 'done', isError: false, tainted: true });
    assert.equal(await until(() => !alive(p)), true, 'the browser process is gone when the run ends');
    assert.equal(r.mod.manager.running(), 0);
  } finally { await r.mod.dispose!(); await t.client.close(); }
});

test('E9: the engine never changes during a run, and there is no fallback to the other engine when the chosen one cannot start', async () => {
  // run with chromium, then the owner switches the setting to Lightpanda: the open browser keeps its engine; a new browser after close uses the new setting, and says so
  const r = rig({ platform: 'linux', io: fsOf(['/usr/bin/google-chrome']) });
  await r.call('POST /api/browser/config', { enabled: true, engine: 'chromium' });
  await r.call('POST /api/browser/config', { binaryPath: '/opt/lightpanda' }, { 'x-legion-native': NATIVE });
  const t = await tools(r);
  try {
    assert.match((await t.call('browser_open', { url: 'https://a.test/' })).text, /Engine: Google Chrome \(headless\)\./);
    await r.call('POST /api/browser/config', { engine: 'lightpanda' });
    assert.match((await t.call('browser_open', { url: 'https://a.test/' })).text, /Engine: Google Chrome \(headless\)\./, 'same run, same engine');
    assert.deepEqual(r.spawns.map((s) => s.engine), ['chromium']);
    await t.call('browser_close');
    assert.match((await t.call('browser_open', { url: 'https://a.test/' })).text, /Engine: Lightpanda\./, 'a new browser uses the new setting and names it');
    assert.deepEqual(r.spawns.map((s) => s.engine), ['chromium', 'lightpanda']);
  } finally { await r.mod.dispose!(); await t.client.close(); }
  // chosen chromium, none found, Lightpanda configured: an error, and Lightpanda is NOT started instead
  const r2 = rig({ platform: 'linux', io: fsOf([]) });
  await r2.call('POST /api/browser/config', { enabled: true, engine: 'chromium' });
  await r2.call('POST /api/browser/config', { binaryPath: '/opt/lightpanda' }, { 'x-legion-native': NATIVE });
  const t2 = await tools(r2);
  try {
    const res = await t2.call('browser_open', { url: 'https://a.test/' });
    assert.equal(res.isError, true); assert.match(res.text, /No Chromium-family browser/);
    assert.equal(r2.spawns.length, 0, 'no process of any engine was started');
  } finally { await r2.mod.dispose!(); await t2.client.close(); }
});

test('E9: a browser that is too old for headless mode is not started, and says which', async () => {
  const r = rig({ io: fsOf([EDGE], { 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application': ['100.0.1185.29'] }) });
  await r.call('POST /api/browser/config', { enabled: true });
  const t = await tools(r);
  try {
    const res = await t.call('browser_open', { url: 'https://a.test/' });
    assert.equal(res.isError, true); assert.match(res.text, /too old for headless mode/);
    assert.equal(r.spawns.length, 0);
  } finally { await r.mod.dispose!(); await t.client.close(); }
});

test('the test route starts the chosen engine and names it', async () => {
  const r = rig();
  const res = await r.call('POST /api/browser/test') as { ok: boolean; detail: string };
  assert.equal(res.ok, true); assert.match(res.detail, /Microsoft Edge 120\.0\.2210\.91 \(headless\) started/);
  assert.equal(await until(() => !alive(r.pid(0))), true);
});
