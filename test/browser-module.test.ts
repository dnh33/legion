import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isClientRoute } from '../src/core/admin.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { createBrowserModule } from '../src/core/browser/index.js';
import type { ChromiumIo } from '../src/core/browser/chromium.js';
import type { LaunchPorts } from '../src/core/browser/launcher.js';
import { createLaunchPorts } from '../src/core/browser/system.js';
import type { Handler } from '../src/core/server.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import type { ApprovalRequest } from '../src/shared/types.js';
import type { BrowserCheckResult, BrowserStatusView } from '../src/shared/browser.js';
import { agent } from './blender-helpers.js';
import { fakeResolver } from './browser-fakes.js';

const FAKE_CHR = fileURLToPath(new URL('./browser-fake-chromium.js', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const NATIVE = 'n'.repeat(64);
const DNS = fakeResolver({ 'a.test': ['93.184.216.34'] });
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_DIR = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application';
const WINENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } as NodeJS.ProcessEnv;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 40)); } return cond(); };
const fsOf = (files: string[], dirs: Record<string, string[]> = {}): ChromiumIo => ({ exists: (p) => files.includes(p), readDir: (p) => dirs[p] ?? [] });
const EDGE_IO = fsOf([EDGE], { [EDGE_DIR]: ['120.0.2210.91', 'msedge.exe'] });

function rig(o: { mode?: string; limits?: Record<string, number>; nativeSecret?: string | null; io?: ChromiumIo; platform?: NodeJS.Platform; checkProbe?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'br-mod-'));
  const reportBase = join(dataDir, 'report');
  const pages = join(dataDir, 'pages.json');
  writeFileSync(pages, JSON.stringify({ 'https://a.test/': { title: 'Home', text: 'hello from the fake' } }));
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus);
  const cards: ApprovalRequest[] = [];
  bus.on((e) => { if (e.type === 'approval.requested') { cards.push(e.approval); setImmediate(() => approvals.resolve(e.approval.id, true)); } });
  const base = createLaunchPorts();
  const reports: string[] = [];
  const launchPorts: LaunchPorts = { ...base, proc: { spawn(req) { const rep = `${reportBase}-${reports.length + 1}.json`; reports.push(rep); return base.proc.spawn({ ...req, file: process.execPath, prefixArgs: [FAKE_CHR, rep, o.mode ?? 'ok', pages] }); }, kill: base.proc.kill } };
  const deps = { config: { authToken: 'tok-12345678' }, bus, approvals, dataDir } as unknown as ModuleDeps;
  const mod = createBrowserModule(deps, { launchPorts, resolve: DNS, limits: o.limits, platform: o.platform ?? 'win32', hostEnv: WINENV, chromiumIo: o.io ?? EDGE_IO, ...(o.checkProbe ? { checkProbe: o.checkProbe } : {}), ...(o.nativeSecret === null ? {} : { nativeSecret: o.nativeSecret ?? NATIVE }) });
  const routes = new Map<string, Handler>();
  mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  const call = async (key: string, body?: unknown, headers: Record<string, string> = {}) => (routes.get(key)!({ req: { headers }, body, url: new URL('http://x/'), params: [], res: {} } as never));
  const pidOf = (i: number) => (JSON.parse(readFileSync(reports[i]!, 'utf8')) as { pid: number }).pid;
  return { mod, dataDir, cards, call, routes, reports, pidOf, spawned: () => reports.length };
}
type Rig = ReturnType<typeof rig>;
const status = async (r: Rig) => await r.call('GET /api/browser') as BrowserStatusView;

async function tools(r: Rig, taskId = 'task_1', mode: 'ask' | 'full' = 'full') {
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
  assert.equal((await status(r)).enabled, false);
});

test('one engine only: the engine list has one entry, and no Lightpanda, WSL, launcher, download or program-picker text exists in the product code or in the Settings page', async () => {
  const r = rig();
  const s = await status(r);
  assert.equal(s.engines.length, 1); assert.equal(s.engines[0]!.id, 'chromium');
  assert.equal(r.mod.engines.length, 1);
  assert.doesNotMatch(JSON.stringify(s), /lightpanda|wsl|launcher|download button|nightly/i);
  await r.call('POST /api/browser/config', { enabled: true });
  assert.doesNotMatch(r.mod.preamble!(agent('w')), /lightpanda|wsl/i);
  const t = await tools(r);
  try { assert.deepEqual((await t.client.listTools()).tools.map((x) => x.name).sort(), ['browser_click', 'browser_close', 'browser_eval', 'browser_links', 'browser_open', 'browser_status', 'browser_text', 'browser_type']); } finally { await t.client.close(); }
  // nothing under src/ or ui/src names it, and the UI source has no download or launcher control
  const walk = (rel: string, out: string[] = []): string[] => { for (const n of readdirSync(join(REPO, rel))) { const q = `${rel}/${n}`; if (n === 'node_modules' || n === 'dist' || n === 'seeds') continue; if (statSync(join(REPO, q)).isDirectory()) walk(q, out); else if (/\.(ts|tsx|js|cjs|mjs|css)$/.test(n)) out.push(q); } return out; };
  const hits = [...walk('src'), ...walk('ui/src')].filter((f) => /lightpanda/i.test(readFileSync(join(REPO, f), 'utf8').replace(/\r\n/g, '\n')));
  assert.deepEqual(hits, []);
  const ui = readFileSync(join(REPO, 'ui/src/browser/BrowserSection.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(ui, /lightpanda|\bwsl\b|launcher|managedSha|binaryPath|Get \w+ for Legion|>\s*Download/i);
  assert.match(ui, /Open test page/); assert.match(ui, /cloud VM is the only isolated way to browse/);
});

test('C15: the browser routes are admin-only by default-deny (none is on the MCP client list)', () => {
  const r = rig();
  for (const key of r.routes.keys()) { const [m, p] = key.split(' '); assert.equal(isClientRoute(m!, p!), false, key); }
  assert.deepEqual([...r.routes.keys()].sort(), ['GET /api/browser', 'POST /api/browser/check', 'POST /api/browser/config', 'POST /api/browser/local']);
});

test('C15: allow-local needs the native secret, lives in memory only and is off for a new module', async () => {
  const r = rig();
  const body = { allow: true, ports: [8080] };
  await assert.rejects(r.call('POST /api/browser/local', body), /native_required/);
  await assert.rejects(r.call('POST /api/browser/local', body, { 'x-legion-native': 'wrong' }), /native_required/);
  await assert.rejects(rig({ nativeSecret: null }).call('POST /api/browser/local', body, { 'x-legion-native': NATIVE }), /native_unavailable/);
  await assert.rejects(r.call('POST /api/browser/local', { allow: true, ports: ['x'] }, { 'x-legion-native': NATIVE }), /ports/);
  assert.equal(((await r.call('POST /api/browser/local', body, { 'x-legion-native': NATIVE })) as { allowLocal: boolean }).allowLocal, true);
  assert.ok(!readdirSync(r.dataDir).includes('browser') || !/allowLocal|localPorts|8080/.test(readFileSync(join(r.dataDir, 'browser', 'config.json'), 'utf8')), 'nothing about local addresses is written to disk');
  const fresh = rig(); assert.equal((await status(fresh)).allowLocal, false);
});

test('config route: validates, normalises, persists; choosing the browser path needs the app dialog (native secret); an older file with removed settings is read safely', async () => {
  const r = rig();
  await assert.rejects(r.call('POST /api/browser/config', { enabled: 'yes' }), /enabled/);
  await assert.rejects(r.call('POST /api/browser/config', { allowDomains: 'a.com' }), /allowDomains/);
  const st = await r.call('POST /api/browser/config', { enabled: true, allowDomains: ['Example.com', '*.docs.org', 'not a domain', 'localhost'] }) as BrowserStatusView;
  assert.equal(st.enabled, true); assert.deepEqual(st.allowDomains, ['example.com', 'docs.org']);
  await assert.rejects(r.call('POST /api/browser/config', { chromiumPath: 'C:\\evil\\x.exe' }), /native_required/);
  await assert.rejects(r.call('POST /api/browser/config', { chromiumPath: 'C:\\evil\\x.exe' }, { 'x-legion-native': 'wrong' }), /native_required/);
  const set = await r.call('POST /api/browser/config', { chromiumPath: 'D:\\Tools\\Brave Portable\\brave.exe' }, { 'x-legion-native': NATIVE }) as BrowserStatusView;
  assert.equal(set.chosenPath, 'D:\\Tools\\Brave Portable\\brave.exe');
  const cleared = await r.call('POST /api/browser/config', { chromiumPath: null }, { 'x-legion-native': NATIVE }) as BrowserStatusView;
  assert.equal(cleared.chosenPath, undefined);
  // a config.json written by an earlier build with settings that no longer exist
  const old = rig();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(old.dataDir, 'browser'), { recursive: true });
  writeFileSync(join(old.dataDir, 'browser', 'config.json'), JSON.stringify({ version: 1, enabled: true, binaryPath: '/tmp/evil', launcherArgs: ['-c', 'x'], managedSha256: 'a'.repeat(64), engine: 'other', allowDomains: ['example.com'] }));
  const fresh = createBrowserModule({ config: { authToken: 'x' }, bus: new EventBus(), approvals: new ApprovalBroker(new EventBus()), dataDir: old.dataDir } as unknown as ModuleDeps, { chromiumIo: EDGE_IO, platform: 'win32', hostEnv: WINENV });
  const rs = new Map<string, Handler>(); fresh.routes!((m, p, h) => { rs.set(`${m} ${p}`, h); });
  const s = await rs.get('GET /api/browser')!({} as never) as BrowserStatusView;
  assert.equal(s.enabled, true); assert.deepEqual(s.allowDomains, ['example.com']); assert.equal(s.chosenPath, undefined);
  await rs.get('POST /api/browser/config')!({ req: { headers: {} }, body: { allowDomains: ['example.org'] } } as never);
  const saved = JSON.parse(readFileSync(join(old.dataDir, 'browser', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['allowDomains', 'enabled', 'version']);
});

test('detection and the plain status line: Edge found with the version read from the install folder; none found; too old; a chosen path that is missing', async () => {
  let s = await status(rig());
  assert.equal(s.browser!.name, 'Microsoft Edge'); assert.equal(s.browser!.version, '120.0.2210.91'); assert.equal(s.browser!.path, EDGE);
  assert.match(s.note, /Pages are read with Microsoft Edge 120\.0\.2210\.91 \(headless\)\. Nothing is downloaded/);
  assert.match(s.note, /user rights/); assert.match(s.note, /cloud VM is the only isolated way to browse/);
  s = await status(rig({ io: fsOf([]) }));
  assert.equal(s.browser, null); assert.equal(s.note, 'No Edge or Chrome found: install one or set a path.'); assert.ok(s.tried.length > 0 && s.tried.every((t) => !t.includes('/')), 'Windows places, backslashes');
  s = await status(rig({ io: fsOf([EDGE], { [EDGE_DIR]: ['100.0.1185.29'] }) }));
  assert.equal(s.browser!.tooOld, true); assert.match(s.note, /too old for headless mode/);
  const r = rig();
  await r.call('POST /api/browser/config', { chromiumPath: 'D:\\Gone\\chrome.exe' }, { 'x-legion-native': NATIVE });
  s = await status(r);
  assert.equal(s.browser, null); assert.match(s.note, /you chose \(D:\\Gone\\chrome\.exe\) was not found/); assert.deepEqual(s.tried, ['D:\\Gone\\chrome.exe']);
});

test('E8: a full run (fake Edge on Windows paths): the result names the browser, a card shows the first page, the run is tainted, the last run is recorded, and the process stops when the run ends', async () => {
  const r = rig();
  await r.call('POST /api/browser/config', { enabled: true });
  assert.equal((await status(r)).lastRun, undefined);
  const t = await tools(r);
  try {
    const open = await t.call('browser_open', { url: 'https://a.test/' });
    assert.equal(open.isError, false, open.text);
    assert.match(open.text, /Browser: Microsoft Edge 120\.0\.2210\.91 \(headless\)\./);
    assert.match((await t.call('browser_text')).text, /hello from the fake/);
    assert.match((await t.call('browser_status')).text, /Browser: Microsoft Edge 120\.0\.2210\.91 \(headless\)/);
    assert.ok(t.tainted.n >= 1);
    // S5b: a `full` run gets no card at all, the first page included (one rule, no exceptions).
    assert.equal(r.cards.length, 0, `a full run must not card; got ${r.cards.map((c) => c.summary).join(' | ')}`);
    const rep = JSON.parse(readFileSync(r.reports[0]!, 'utf8')) as { argv: string[] };
    assert.ok(rep.argv.includes('--headless=new') && !rep.argv.includes('--no-sandbox'));
    const lr = (await status(r)).lastRun!;
    assert.equal(lr.ok, true); assert.match(lr.browser, /Microsoft Edge 120/);
    const p = r.pidOf(0); assert.ok(alive(p)); assert.equal(r.mod.manager.running(), 1);
    r.mod.onTaskEnd!({ id: 'task_1' } as never, agent('w'), { status: 'done', isError: false, tainted: true });
    assert.equal(await until(() => !alive(p)), true, 'the browser process is gone when the run ends');
    assert.equal(await until(() => r.mod.manager.running() === 0), true, 'the browser slot is freed when the run ends');
  } finally { await r.mod.dispose!(); await t.client.close(); }
});

test('C12: idle timeout and wall timeout stop the process; dispose stops all of them; browser_close stops it', async () => {
  let r = rig({ limits: { idleMs: 400, wallMs: 60_000 } });
  await r.call('POST /api/browser/config', { enabled: true });
  let t = await tools(r);
  await t.call('browser_open', { url: 'https://a.test/' });
  let pid = r.pidOf(0);
  assert.equal(await until(() => !alive(pid), 4000), true, 'idle: stopped');
  await t.client.close(); await r.mod.dispose!();

  r = rig({ limits: { idleMs: 60_000, wallMs: 500 } });
  await r.call('POST /api/browser/config', { enabled: true });
  t = await tools(r);
  await t.call('browser_open', { url: 'https://a.test/' });
  pid = r.pidOf(0);
  assert.equal(await until(() => !alive(pid), 4000), true, 'wall: stopped');
  await t.client.close(); await r.mod.dispose!();

  r = rig();
  await r.call('POST /api/browser/config', { enabled: true });
  t = await tools(r, 'task_a'); const t2 = await tools(r, 'task_b');
  await t.call('browser_open', { url: 'https://a.test/' }); await t2.call('browser_open', { url: 'https://a.test/' });
  const pids = [r.pidOf(0), r.pidOf(1)];
  await t.call('browser_close');
  assert.equal(await until(() => !alive(pids[0]!)), true, 'close: stopped');
  await r.mod.dispose!();
  assert.equal(await until(() => !alive(pids[1]!)), true, 'dispose: stopped');
  await t.client.close(); await t2.client.close();
});

test('C12: at most N browsers run at once; the next run is told to wait and no extra process starts', async () => {
  const r = rig({ limits: { maxProcesses: 1 } });
  await r.call('POST /api/browser/config', { enabled: true });
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

test('failures come back as plain tool errors: no browser found (nothing is started), too old, a browser that never reports its port; the last run records the failure', async () => {
  let r = rig({ io: fsOf([]) });
  await r.call('POST /api/browser/config', { enabled: true });
  let t = await tools(r);
  let res = await t.call('browser_open', { url: 'https://a.test/' });
  assert.equal(res.isError, true); assert.match(res.text, /No Edge or Chrome found: install one or set a path/);
  assert.equal(r.spawned(), 0);
  assert.equal((await status(r)).lastRun!.ok, false);
  await t.client.close(); await r.mod.dispose!();
  r = rig({ io: fsOf([EDGE], { [EDGE_DIR]: ['100.0.1185.29'] }) });
  await r.call('POST /api/browser/config', { enabled: true });
  t = await tools(r);
  res = await t.call('browser_open', { url: 'https://a.test/' });
  assert.equal(res.isError, true); assert.match(res.text, /too old for headless mode/); assert.equal(r.spawned(), 0);
  await t.client.close(); await r.mod.dispose!();
  r = rig({ mode: 'never', limits: { startTimeoutMs: 500 } });
  await r.call('POST /api/browser/config', { enabled: true });
  t = await tools(r);
  res = await t.call('browser_open', { url: 'https://a.test/' });
  assert.equal(res.isError, true); assert.match(res.text, /did not report its debugging port/);
  assert.equal(await until(() => !alive(r.pidOf(0))), true, 'the stuck browser was stopped');
  await t.client.close(); await r.mod.dispose!();
});

test('"Open test page": the check starts the browser, loads a page Legion answers itself, sees JavaScript run and the guard refuse a forbidden request, then stops the browser', async () => {
  const r = rig();
  const out = await r.call('POST /api/browser/check') as { result: BrowserCheckResult; status: BrowserStatusView };
  assert.equal(out.result.ok, true, JSON.stringify(out.result.steps));
  assert.deepEqual(out.result.steps.map((s) => [s.step, s.ok]), [['browser', true], ['start', true], ['load', true], ['javascript', true], ['guard', true]]);
  assert.match(out.result.browser!, /Microsoft Edge 120\.0\.2210\.91 \(headless\)/);
  assert.equal(out.status.lastRun!.ok, true);
  assert.equal(await until(() => !alive(r.pidOf(0))), true, 'the browser is stopped after the check');
  assert.equal(r.mod.manager.running(), 0);
  assert.equal(r.cards.length, 0, 'the owner clicked the button: no card');
});

test('"Open test page": failures are reported plainly: no browser, JavaScript not running', async () => {
  const none = await rig({ io: fsOf([]) }).call('POST /api/browser/check') as { result: BrowserCheckResult };
  assert.equal(none.result.ok, false); assert.equal(none.result.steps[0]!.detail.startsWith('No Edge or Chrome found: install one or set a path'), true);
  const r = rig({ mode: 'nojs' });
  const bad = await r.call('POST /api/browser/check') as { result: BrowserCheckResult; status: BrowserStatusView };
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.steps.find((s) => s.step === 'javascript')!.ok, false);
  assert.equal(bad.status.lastRun!.ok, false);
  assert.equal(await until(() => !alive(r.pidOf(0))), true);
});

test('"Open test page": if the guard did let the deliberate forbidden request through, the check says so and fails (do not use the browser tool)', async () => {
  // a public address the guard correctly allows stands in for a guard that stopped working
  const r = rig({ checkProbe: 'https://93.184.216.34/legion-check' });
  const out = await r.call('POST /api/browser/check') as { result: BrowserCheckResult; status: BrowserStatusView };
  assert.equal(out.result.ok, false);
  const guard = out.result.steps.find((x) => x.step === 'guard') ?? out.result.steps.find((x) => x.step === 'start');
  assert.equal(guard!.ok, false);
  assert.equal(out.status.lastRun!.ok, false);
  assert.equal(await until(() => !alive(r.pidOf(0))), true);
});
