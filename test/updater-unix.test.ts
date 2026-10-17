/**
 * Mac and Linux self-update, updater core (M1, rulings R-M1 to R-M9 in .superpowers/sdd/2026-10-16-gates-pr2/mac-updater-plan.md).
 * Windows is pinned in updater-win32-pins.test.ts; everything here is off win32 only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { createUpdaterModule, installMode, INSTALL_MARKER_FILE, type UpdaterModule } from '../src/core/updater/index.js';
import { parseRoute, planRelease, UNIX_DEPS_TEXT } from '../src/core/updater/deps-change.js';
import { buildJob, commitMatches, windowShown } from '../src/core/updater/main-logic.js';
import { CODE_SET, FULL_PACKAGE_SET, windowLaunchPlan } from '../src/core/updater/apply.js';
import { Store } from '../src/core/store.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import { CHECKOUT_TEXT, closeAndReopenText, depsNotifyText } from '../ui/src/updatePanelText.js';
import { LOCK, makeKey, makeRelease, startFakeServer, type FakeServer, type Release } from './updater-helpers.js';

const HEAD = 'a'.repeat(40);
const root = '/home/u/.local/share/legion';
const goodMarker = { schema: 1, manager: 'install.sh', dir: root, origin: 'https://github.com/dnh33/legion.git', head: HEAD, tag: 'v0.3.5' };
interface Fs { exists: (p: string) => boolean; writable: () => boolean; realpath: (p: string) => string; readFile: (p: string) => string }
/** A fake folder: .git/HEAD and the marker, each overridable; a value of null means the file is missing. */
function fakeFs(o: { git?: boolean; head?: string | null; marker?: unknown | null | string; real?: string; writable?: boolean } = {}): Fs {
  const markerText = o.marker === undefined ? JSON.stringify(goodMarker) : o.marker === null ? null : typeof o.marker === 'string' ? o.marker : JSON.stringify(o.marker);
  const head = o.head === undefined ? HEAD + '\n' : o.head;
  return {
    exists: (p) => (p.endsWith('.git') ? o.git !== false : false),
    writable: () => o.writable !== false,
    realpath: () => o.real ?? root,
    readFile: (p) => {
      if (p.endsWith('HEAD')) { if (head === null) throw new Error('ENOENT'); return head; }
      if (p.endsWith(INSTALL_MARKER_FILE)) { if (markerText === null) throw new Error('ENOENT'); return markerText; }
      throw new Error('unexpected read ' + p);
    },
  };
}
const mode = (platform: NodeJS.Platform, f: Fs) => installMode({ root, platform, ...f });

test('installMode off win32: apply only with .git, a valid marker, a matching realpath, a matching bare-sha HEAD and a writable folder', () => {
  for (const p of ['linux', 'darwin'] as const) {
    assert.equal(mode(p, fakeFs()), 'apply', p);
    assert.equal(mode(p, fakeFs({ writable: false })), 'unwritable', `${p}: a valid managed clone in a read-only folder`);
    assert.equal(mode(p, fakeFs({ marker: null })), 'checkout', `${p}: no marker (hand-made clone)`);
    assert.equal(mode(p, fakeFs({ marker: 'not json' })), 'checkout', `${p}: unreadable marker`);
    assert.equal(mode(p, fakeFs({ marker: { ...goodMarker, schema: 2 } })), 'checkout', `${p}: other schema`);
    assert.equal(mode(p, fakeFs({ marker: { ...goodMarker, manager: 'npm' } })), 'checkout', `${p}: other manager`);
    assert.equal(mode(p, fakeFs({ marker: { ...goodMarker, dir: '/home/u/copy' } })), 'checkout', `${p}: a copied folder`);
    assert.equal(mode(p, fakeFs({ real: '/home/u/copy' })), 'checkout', `${p}: the marker names another folder than the real path`);
    assert.equal(mode(p, fakeFs({ marker: { ...goodMarker, head: 'b'.repeat(40) } })), 'checkout', `${p}: HEAD moved`);
    assert.equal(mode(p, fakeFs({ head: 'ref: refs/heads/main\n' })), 'checkout', `${p}: a developer on a branch`);
    assert.equal(mode(p, fakeFs({ head: null })), 'checkout', `${p}: .git without HEAD (a worktree file)`);
    assert.equal(mode(p, fakeFs({ marker: { ...goodMarker, head: 'zz' }, head: 'zz\n' })), 'checkout', `${p}: a head that is not a sha`);
    assert.equal(mode(p, fakeFs({ marker: { ...goodMarker, head: HEAD.toUpperCase() }, head: HEAD.toUpperCase() })), 'checkout', `${p}: only lowercase 40-hex counts`);
    assert.equal(mode(p, fakeFs({ marker: [1, 2] })), 'checkout', `${p}: marker is not an object`);
    assert.equal(mode(p, fakeFs({ git: false })), 'unsupported', `${p}: no .git keeps today's answer`);
  }
});

test('installMode off win32: a realpath that throws is a checkout, never a crash', () => {
  const f = fakeFs();
  assert.equal(installMode({ root, platform: 'linux', ...f, realpath: () => { throw new Error('EACCES'); } }), 'checkout');
});

const base = { depsSha256: 'a'.repeat(64) };
const fullAsset = { name: 'legion-0.3.5-win-x64.zip', size: 1, sha256: 'b'.repeat(64) };
test('planRelease off win32: a dependency release is notify with the installer copy, signed full package or not; code stays code', () => {
  for (const p of ['linux', 'darwin'] as const) {
    for (const m of [{ ...base, requiresFullInstall: true, fullAsset }, { ...base, requiresFullInstall: true }]) {
      const r = planRelease(m, p);
      assert.equal(r.route, 'notify', p);
      assert.ok(r.reason.includes(UNIX_DEPS_TEXT), r.reason);
      assert.doesNotMatch(r.reason, /setup\.cmd/);
    }
    assert.equal(planRelease({ ...base, requiresFullInstall: false, fullAsset }, p).route, 'code');
  }
  assert.equal(UNIX_DEPS_TEXT, "This update changes Legion's dependencies. On Mac and Linux, run the installer again to get it: curl -fsSL https://getlegion.xyz | sh (your data in ~/.legion stays).");
  assert.equal(planRelease({ ...base, requiresFullInstall: true, fullAsset }, 'win32').route, 'full', 'win32 is untouched');
});

test('an unknown future route value parses to notify, and the known ones are unchanged', () => {
  for (const v of ['rebuild', 'full-v2', '', 7, null, undefined, {}, 'CODE']) assert.equal(parseRoute(v), 'notify', String(v));
  for (const v of ['code', 'full', 'notify'] as const) assert.equal(parseRoute(v), v);
});

test('relaunch off win32 carries the allowlisted switches in argv order, and nothing else', () => {
  const c = { installDir: '/l', stagedDir: '/l/.update/staging/0.3.5/x', from: '0.3.4', to: '0.3.5' };
  const argv = ['/l/node_modules/electron/dist/electron', '/l', '--no-sandbox', '--remote-debugging-port=9222', '--disable-gpu', '--inspect', '--disable-dev-shm-usage', '--disable-software-rasterizer'];
  for (const platform of ['linux', 'darwin'] as const) {
    const j = buildJob(c, { parentPid: 1, port: 4747, execPath: '/l/node_modules/electron/dist/electron', platform, argv });
    assert.deepEqual(j.relaunch.args, ['/l', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-software-rasterizer'], platform);
    assert.equal(j.relaunch.cmd, '/l/node_modules/electron/dist/electron');
    assert.deepEqual(j.relaunch.env, { LEGION_UPDATE_HANDOFF: '1' });
  }
  assert.deepEqual(buildJob(c, { parentPid: 1, port: 4747, execPath: 'e', platform: 'linux', argv: ['x'] }).relaunch.args, ['/l']);
});

test('commitMatches off win32 refuses the full package set; the code set and no set still pass', () => {
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  const c = (names?: readonly string[]) => ({ installDir: install, stagedDir: join(install, '.update', 'staging', '0.3.5', 'x'), from: '0.3.4', to: '0.3.5', ...(names ? { names } : {}) });
  for (const p of ['linux', 'darwin'] as const) {
    assert.equal(commitMatches(c(FULL_PACKAGE_SET), install, p), false, p);
    assert.equal(commitMatches(c(CODE_SET), install, p), true, p);
    assert.equal(commitMatches(c(), install, p), true, p);
  }
});

test('the update window is win32 only: the plan is none and the window is not shown off win32', () => {
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  const dev = join(install, 'node_modules', 'electron', 'dist');
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(windowLaunchPlan({ runtimeDir: dev, installDir: install, hasAppShim: false, hasDefaultApp: true, platform }), 'none', `${platform}: the Linux clone shape that would start a second Electron`);
    assert.equal(windowLaunchPlan({ runtimeDir: join(install, '.update', 'runtime-copy'), installDir: install, hasAppShim: true, hasDefaultApp: false, platform }), 'none');
    assert.equal(windowShown(platform, undefined), false);
    assert.equal(windowShown(platform, true), false);
  }
  assert.equal(windowShown('win32', undefined), true, 'win32 default is on');
  assert.equal(windowShown('win32', true), true);
  assert.equal(windowShown('win32', false), false, 'win32 honours the setting');
  assert.equal(windowLaunchPlan({ runtimeDir: dev, installDir: install, hasAppShim: false, hasDefaultApp: true }), 'folder', 'no platform given: today\'s answer');
});

test('panel text: hand-made clones are told to fetch tags and check out the tag, never git pull; Mac and Linux get the installer line and the close-and-reopen line', () => {
  assert.equal(CHECKOUT_TEXT, 'This is a git checkout. Update it yourself: git fetch --tags, check out the new tag, then npm ci and npm run build.');
  assert.doesNotMatch(CHECKOUT_TEXT, /git pull/);
  assert.equal(depsNotifyText('linux'), UNIX_DEPS_TEXT);
  assert.equal(depsNotifyText('darwin'), UNIX_DEPS_TEXT);
  assert.match(depsNotifyText('win32'), /setup\.cmd/);
  assert.match(closeAndReopenText('darwin') ?? '', /close and reopen/);
  assert.equal(closeAndReopenText('win32'), undefined, 'win32 keeps its update window text');
  for (const t of [CHECKOUT_TEXT, UNIX_DEPS_TEXT, closeAndReopenText('linux') ?? '']) assert.doesNotMatch(t, /—/, 'no em dash');
});

// ---- the module, end to end, on a Linux managed clone (real folder, real marker, fake release server) ----
const k = makeKey('k1');
interface Rig { mod: UpdaterModule; srv: FakeServer; root: string; data: string; clock: { t: number }; call: (m: string, p: string, body?: unknown) => Promise<unknown> }
async function unixRig(release: Release | null, o: { platform?: NodeJS.Platform; managed?: boolean; settings?: Record<string, unknown>; log?: (...a: unknown[]) => void } = {}): Promise<Rig> {
  const srv = await startFakeServer(release);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'upd-unix-')));
  const data = cleanupTemp('upd-unix-data-');
  writeFileSync(join(dir, 'package-lock.json'), LOCK);
  if (o.managed !== false) {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), HEAD + '\n');
    writeFileSync(join(dir, INSTALL_MARKER_FILE), JSON.stringify({ ...goodMarker, dir }));
  }
  if (o.settings) { mkdirSync(join(data, 'updater'), { recursive: true }); writeFileSync(join(data, 'updater', 'settings.json'), JSON.stringify(o.settings)); }
  const bus = new EventBus();
  const store = new Store(data);
  const engine = { running: () => [] as string[], cancel: () => true, startTask: () => ({}) };
  const deps = { config: {}, store, bus, engine, approvals: new ApprovalBroker(bus), dataDir: data, bsvEnabled: () => false } as unknown as ModuleDeps;
  const clock = { t: Date.parse('2026-10-20T12:00:00Z') };
  const mod = createUpdaterModule(deps, { root: dir, source: srv.source, keys: [k.key], version: '0.2.0', platform: o.platform ?? 'linux', timers: false, now: () => clock.t, freeBytes: () => 10 ** 12, ...(o.log ? { log: o.log } : {}) });
  const routes = new Map<string, (c: unknown) => unknown>();
  mod.routes!(((m: string, p: string, h: (c: unknown) => unknown) => { routes.set(`${m} ${p}`, h); }) as unknown as RouteAdder);
  const call = async (m: string, p: string, body?: unknown) => routes.get(`${m} ${p}`)!({ req: { headers: {}, legionAdmin: true }, body, params: [], url: new URL('http://x/') });
  return { mod, srv, root: dir, data, clock, call };
}
const downloads = (r: Rig) => r.srv.hits.filter((h) => h.includes('/releases/download/'));
const noWinZip = (r: Rig) => assert.deepEqual(r.srv.hits.filter((h) => h.includes('-win-x64.zip')), [], 'no request for a Windows package');

test('module, Linux managed clone: mode is apply and a code-only release downloads and stages', async () => {
  const r = await unixRig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true);
    const s = await r.mod.status();
    assert.equal(s.mode, 'apply');
    assert.equal(s.platform, 'linux');
    assert.deepEqual(await r.mod.install(), { ok: true });
    assert.equal((await r.mod.status()).staged?.kind, 'code');
    noWinZip(r);
  } finally { await r.srv.close(); }
});

test('module, Linux managed clone: a dependency release with a signed full package is notify, canFullInstall false, install says run the installer, no request for the Windows zip', async () => {
  const r = await unixRig(makeRelease(k, '0.2.1', { requiresFullInstall: true, full: {} }));
  try {
    await r.mod.check(true);
    const s = await r.mod.status();
    assert.equal(s.mode, 'apply');
    assert.equal(s.available?.canFullInstall, false);
    await assert.rejects(r.mod.install(), (e: Error) => e.message === UNIX_DEPS_TEXT);
    await assert.rejects(r.mod.install({ auto: true }), (e: Error) => e.message === UNIX_DEPS_TEXT);
    assert.deepEqual(downloads(r), []);
    noWinZip(r);
  } finally { await r.srv.close(); }
});

test('module, Linux managed clone: a lock that changed without the flag (code route, full-install refusal) does NOT fall back to the Windows zip', async () => {
  const lines: string[] = [];
  const r = await unixRig(makeRelease(k, '0.2.1', { lock: '{"changed":true}', full: {} }), { log: (...a) => { lines.push(a.map(String).join(' ')); } });
  try {
    await r.mod.check(true);
    assert.deepEqual(await r.mod.install(), { ok: false });
    const s = await r.mod.status();
    assert.equal(s.error, UNIX_DEPS_TEXT);
    assert.equal(s.staged, undefined);
    noWinZip(r);
    assert.equal(downloads(r).length, 1, 'only the app package was fetched');
  } finally { await r.srv.close(); }
});

test('module, Linux: auto-install is off by default; on, it stages by itself; a dependency release never auto-downloads', async () => {
  const off = await unixRig(makeRelease(k, '0.2.1'));
  try { await off.mod.check(true); await new Promise((x) => setTimeout(x, 50)); assert.deepEqual(downloads(off), []); assert.equal((await off.mod.status()).settings.autoInstallWhenIdle, false); } finally { await off.srv.close(); }
  const on = await unixRig(makeRelease(k, '0.2.1'), { settings: { autoInstallWhenIdle: true } });
  try { await on.mod.check(true); for (let i = 0; i < 100 && !downloads(on).length; i++) await new Promise((x) => setTimeout(x, 10)); assert.equal(downloads(on).length, 1); } finally { await on.srv.close(); }
  const deps = await unixRig(makeRelease(k, '0.2.1', { requiresFullInstall: true, full: {} }), { settings: { autoInstallWhenIdle: true } });
  try { await deps.mod.check(true); await new Promise((x) => setTimeout(x, 50)); assert.deepEqual(downloads(deps), []); noWinZip(deps); } finally { await deps.srv.close(); }
});

test('module, Linux clone with a broken marker: checkout, notice only, 409 with the corrected text, nothing downloaded', async () => {
  const r = await unixRig(makeRelease(k, '0.2.1'));
  try {
    writeFileSync(join(r.root, INSTALL_MARKER_FILE), '{}'); // break the marker of an otherwise managed folder
    const mod2 = createUpdaterModule({ config: {}, store: new Store(r.data), bus: new EventBus(), engine: { running: () => [], cancel: () => true, startTask: () => ({}) }, approvals: new ApprovalBroker(new EventBus()), dataDir: r.data, bsvEnabled: () => false } as unknown as ModuleDeps, { root: r.root, source: r.srv.source, keys: [k.key], version: '0.2.0', platform: 'linux', timers: false, now: () => r.clock.t });
    await mod2.check(true);
    assert.equal((await mod2.status()).mode, 'checkout');
    await assert.rejects(mod2.install(), (e: Error) => /git fetch --tags/.test(e.message) && !/git pull/.test(e.message));
    assert.deepEqual(downloads(r), []);
  } finally { await r.srv.close(); }
});
