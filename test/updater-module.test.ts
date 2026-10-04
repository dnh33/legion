/** C3, C11, C12, C15, C19, C20 (flow part): the module end to end against a fake release server, with a real Store and ApprovalBroker. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_HEADER, gate, NATIVE_HEADER } from '../src/core/admin.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { createUpdaterModule, installMode, type UpdaterModule } from '../src/core/updater/index.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import { Store } from '../src/core/store.js';
import type { Task } from '../src/shared/types.js';
import { LOCK, makeKey, makeRelease, sha256, startFakeServer, type FakeServer, type Release } from './updater-helpers.js';

const k = makeKey('k1');
const NATIVE = 'n'.repeat(64);
const T0 = Date.parse('2026-10-20T12:00:00Z');

interface Rig { mod: UpdaterModule; srv: FakeServer; store: Store; approvals: ApprovalBroker; root: string; data: string; clock: { t: number }; engine: FakeEngine; routes: Map<string, (c: unknown) => unknown>; call: (method: string, path: string, c?: { body?: unknown; admin?: boolean; native?: string | false }) => Promise<unknown> }
interface FakeEngine { started: unknown[]; cancelled: string[]; live: Set<string>; running(): string[]; cancel(id: string): boolean; startTask(p: unknown): unknown }

async function rig(release: Release | null, o: { version?: string; platform?: NodeJS.Platform; git?: boolean; keys?: boolean; probes?: Record<string, () => boolean> } = {}): Promise<Rig> {
  const srv = await startFakeServer(release);
  const root = cleanupTemp('upd-root-'); const data = cleanupTemp('upd-data-');
  writeFileSync(join(root, 'package-lock.json'), LOCK);
  if (o.git) mkdirSync(join(root, '.git'));
  const store = new Store(data);
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus);
  const engine: FakeEngine = {
    started: [], cancelled: [], live: new Set(),
    running() { return [...this.live]; },
    cancel(id) { this.cancelled.push(id); this.live.delete(id); const t = store.getTask(id); if (t) store.upsertTask({ ...t, status: 'cancelled' }); return true; },
    startTask(p) { this.started.push(p); return {}; },
  };
  const clock = { t: T0 };
  const deps = { config: {}, store, bus, engine, approvals, dataDir: data, bsvEnabled: () => false } as unknown as ModuleDeps;
  const mod = createUpdaterModule(deps, { root, nativeSecret: NATIVE, source: srv.source, keys: o.keys === false ? [] : [k.key], version: o.version ?? '0.2.0', platform: o.platform ?? 'win32', timers: false, now: () => clock.t, ...(o.probes ? { probes: o.probes } : {}), freeBytes: () => 10 ** 12 });
  const routes = new Map<string, (c: unknown) => unknown>();
  mod.routes!(((m: string, p: string, h: (c: unknown) => unknown) => { routes.set(`${m} ${p}`, h); }) as unknown as RouteAdder);
  const call = async (method: string, path: string, c: { body?: unknown; admin?: boolean; native?: string | false } = {}) => {
    const h = routes.get(`${method} ${path}`); assert.ok(h, `no route ${method} ${path}`);
    const headers: Record<string, string> = {}; if (c.native !== false && c.native !== undefined) headers[NATIVE_HEADER] = c.native;
    return h({ req: { headers, legionAdmin: c.admin !== false }, body: c.body, params: [], url: new URL('http://x/') });
  };
  return { mod, srv, store, approvals, root, data, clock, engine, routes, call };
}
const hitsFor = (r: Rig, part: string) => r.srv.hits.filter((h) => h.includes(part)).length;
const quiet = (r: Rig) => { r.clock.t += 120_000; };
const task = (id: string, status: Task['status']): Task => ({ id, agentId: 'builder', status, prompt: 'p', createdAt: 'x', updatedAt: 'x' } as unknown as Task);
async function stagedRig(version = '0.2.1'): Promise<Rig> {
  const r = await rig(makeRelease(k, version));
  await r.mod.check(true);
  assert.equal((await r.mod.install()).ok, true); // no approval card: the click is the consent
  return r;
}
async function waitFor(cond: () => boolean): Promise<void> { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'timed out'); }

test('check: a verified newer release becomes "available"; nothing is downloaded', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true);
    const s = await r.mod.status();
    assert.equal(s.available?.version, '0.2.1');
    assert.equal(s.available?.notes, 'Test notes <b>x</b>', 'notes are passed as plain text (the UI shows them as text)');
    assert.match(s.check.lastResult!, /update available/);
    assert.equal(hitsFor(r, '/releases/download/'), 0, 'the package is not requested by a check');
    assert.equal(s.phase, 'idle'); assert.equal(s.staged, undefined);
  } finally { await r.srv.close(); }
});
test('C5/C7 through the module: bad signature, wrong key, tampered manifest, older or equal version: never offered', async () => {
  const cases: Array<[string, Release]> = [
    ['signed with another key', makeRelease(k, '0.2.1', { signWith: makeKey('k1') })],
    ['unknown key id', makeRelease(k, '0.2.1', { signWith: makeKey('zzz') })],
    ['equal version', makeRelease(k, '0.2.0')],
    ['downgrade', makeRelease(k, '0.1.0')],
    ['wrong channel', makeRelease(k, '0.2.1', { manifest: { channel: 'beta' } })],
  ];
  for (const [name, rel] of cases) {
    const r = await rig(rel);
    try { await r.mod.check(true); assert.equal((await r.mod.status()).available, undefined, name); } finally { await r.srv.close(); }
  }
  const t = makeRelease(k, '0.2.1'); t.manifest[t.manifest.length - 4] ^= 1; // tampered after signing
  const r = await rig(t);
  try { await r.mod.check(true); const s = await r.mod.status(); assert.equal(s.available, undefined); assert.match(s.check.lastResult!, /rejected/); } finally { await r.srv.close(); }
});
test('C5: a build with no embedded key makes no network request at all', async () => {
  const r = await rig(makeRelease(k, '0.2.1'), { keys: false });
  try { await r.mod.check(true); assert.deepEqual(r.srv.hits, []); const s = await r.mod.status(); assert.equal(s.keyConfigured, false); assert.match(s.check.lastResult!, /no update key/); } finally { await r.srv.close(); }
});
test('C20: offline and rate limit do not throw, change nothing, and back off', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  r.srv.handler.custom = (_q, res) => { res.writeHead(429, { 'retry-after': '600' }); res.end(); return true; };
  try {
    await r.mod.check(true);
    const s = await r.mod.status();
    assert.match(s.check.lastResult!, /asked us to wait/); assert.ok(s.check.nextAllowedAt);
    const before = r.srv.hits.length;
    await r.mod.check(false); assert.equal(r.srv.hits.length, before, 'a periodic check inside the back-off makes no request');
    await assert.rejects(r.mod.check(true), /wait/);
    r.clock.t += 601_000; r.srv.handler.custom = undefined;
    await r.mod.check(true); assert.equal((await r.mod.status()).available?.version, '0.2.1');
  } finally { await r.srv.close(); }
  const off = await rig(makeRelease(k, '0.2.1')); await off.srv.close();
  await off.mod.check(true);
  assert.match((await off.mod.status()).check.lastResult!, /offline/);
});

test('C11: clicking Update installs straight away, with no approval card (owner directive 2026-10-03)', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true);
    // The click IS the consent: nothing is asked a second time, and the download starts immediately.
    const p = r.mod.install();
    assert.equal(r.approvals.pending().length, 0, 'clicking Update must not raise an approval card');
    assert.deepEqual(await p, { ok: true });
    assert.ok(hitsFor(r, '/releases/download/') > 0, 'the package is fetched straight after the click');
    const s = await r.mod.status();
    assert.equal(s.consent, true, 'the click records consent');
    assert.equal(s.phase, 'staged');
    assert.notEqual(s.phase, 'awaiting-approval', 'the update can never strand the panel on an approval wait');
  } finally { await r.srv.close(); }
});

test('C11b: auto-install-when-idle also asks nothing, matching what the setting promises', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true);
    // The setting is confirmed by the owner when they turn it on, and its label says "without asking again".
    const p = r.mod.install({ auto: true });
    assert.equal(r.approvals.pending().length, 0, 'auto-install must not raise an approval card');
    assert.deepEqual(await p, { ok: true });
    assert.equal((await r.mod.status()).phase, 'staged');
  } finally { await r.srv.close(); }
});
test('C11: auto-install is OFF by default (a check with an update available downloads nothing); ON it stages without a card', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    assert.equal((await r.mod.status()).settings.autoInstallWhenIdle, false);
    await r.mod.check(true); await new Promise((x) => setTimeout(x, 50));
    assert.equal(hitsFor(r, '/releases/download/'), 0);
    await r.call('PATCH', '/api/update/settings', { body: { autoInstallWhenIdle: true } });
    await r.mod.check(true); await waitFor(() => hitsFor(r, '/releases/download/') === 1);
    for (let i = 0; i < 100 && !(await r.mod.status()).staged; i++) await new Promise((x) => setTimeout(x, 20));
    assert.equal((await r.mod.status()).staged?.version, '0.2.1');
    assert.equal(r.approvals.pending().length, 0);
  } finally { await r.srv.close(); }
});
test('C11: settings validate their input; a non-boolean never turns auto-install on', async () => {
  const r = await rig(null);
  try {
    for (const bad of [{ autoInstallWhenIdle: 'true' }, { autoInstallWhenIdle: 1 }, { checkEnabled: 'no' }, { intervalHours: 'x' }, 5, null]) await assert.rejects(Promise.resolve(r.call('PATCH', '/api/update/settings', { body: bad })), /must be|Expected/);
    assert.equal((await r.mod.status()).settings.autoInstallWhenIdle, false);
    assert.equal(((await r.call('PATCH', '/api/update/settings', { body: { intervalHours: 99999 } })) as { intervalHours: number }).intervalHours, 168);
    assert.equal(((await r.call('PATCH', '/api/update/settings', { body: { intervalHours: 0 } })) as { intervalHours: number }).intervalHours, 1);
  } finally { await r.srv.close(); }
});
test('C11: every update route is admin-only: the MCP bearer token gets 403, no token gets 401', () => {
  for (const [m, p] of [['GET', '/api/update/status'], ['POST', '/api/update/check'], ['PATCH', '/api/update/settings'], ['POST', '/api/update/install'], ['POST', '/api/update/cancel'], ['POST', '/api/update/ack'], ['POST', '/api/update/drain'], ['POST', '/api/update/commit'], ['POST', '/api/update/abort-commit']] as const) {
    const bearer = gate({ method: m, path: p, adminOk: false, bearerOk: true, hasSecret: true });
    assert.equal(bearer.allow, false, `${m} ${p}`);
    assert.equal(gate({ method: m, path: p, adminOk: false, bearerOk: false, hasSecret: true }).allow, false);
    assert.equal(gate({ method: m, path: p, adminOk: true, bearerOk: true, hasSecret: true }).allow, true);
  }
  assert.equal(ADMIN_HEADER, 'x-legion-admin');
});

test('C12: drain, commit and abort-commit need admin AND the native secret', async () => {
  const r = await stagedRig();
  try {
    for (const p of ['/api/update/drain', '/api/update/commit', '/api/update/abort-commit']) {
      await assert.rejects(Promise.resolve(r.call('POST', p, { native: false })), /native_required/, `${p} without native`);
      await assert.rejects(Promise.resolve(r.call('POST', p, { native: 'wrong'.repeat(13) })), /native_required/);
      await assert.rejects(Promise.resolve(r.call('POST', p, { native: NATIVE, admin: false })), /admin_required/);
    }
    assert.deepEqual(await r.call('POST', '/api/update/abort-commit', { native: NATIVE }), { ok: true });
  } finally { await r.srv.close(); }
});

test('C13/C14/C15: commit refuses while busy or not quiet; when it goes ahead it freezes new task starts; abort lifts the freeze', async () => {
  const r = await stagedRig();
  try {
    await assert.rejects(r.mod.commit(), /quiet long enough|just started/);
    quiet(r);
    r.store.upsertTask(task('t1', 'running'));
    await assert.rejects(r.mod.commit(), /busy: 1 task/);
    r.store.upsertTask(task('t1', 'done'));
    r.clock.t += 1000;
    await assert.rejects(r.mod.commit(), /quiet long enough/, 'the busy sample restarted the quiet clock');
    quiet(r);
    const eng = r.mod as unknown as { };
    void eng;
    const job = await r.mod.commit();
    assert.equal(job.from, '0.2.0'); assert.equal(job.to, '0.2.1'); assert.equal(job.installDir, r.root);
    assert.match(job.stagedDir, /legion-0\.2\.1$/);
    assert.equal((await r.mod.status()).phase, 'committing');
    // the freeze: the wrapper installed on the engine refuses (HTTP 503) until abort
    const wrapped = (r.engine as unknown as { startTask(p: unknown): unknown });
    assert.throws(() => wrapped.startTask({ agentId: 'a' }), /restarting to install an update/);
    r.mod.abortCommit();
    wrapped.startTask({ agentId: 'a' });
    assert.equal(r.engine.started.length, 1);
    assert.equal((await r.mod.status()).phase, 'staged');
  } finally { await r.srv.close(); }
});
test('C13: a pending approval, a busy probe and a VM operation each block commit', async () => {
  let blender = false;
  const r = await rig(makeRelease(k, '0.2.1'), { probes: { 'a Blender download is running': () => blender } });
  try {
    await r.mod.check(true);
    await r.mod.install();
    quiet(r);
    // A pending approval blocks the commit even after the update is staged.
    const other = r.approvals.request('t', 'a', 'Bash', {}); await waitFor(() => r.approvals.pending().length === 1);
    await assert.rejects(r.mod.commit(), /approval/);
    r.approvals.resolve(r.approvals.pending()[0]!.id, false); await other;
    blender = true; await assert.rejects(r.mod.commit(), /Blender download/);
    blender = false; r.store.upsertVm({ agentId: 'builder', sandboxId: 's', state: 'archiving', size: 'default', lastUsedAt: null, createdAt: null } as never);
    await assert.rejects(r.mod.commit(), /VM operation/);
    r.store.upsertVm({ agentId: 'builder', sandboxId: 's', state: 'running', size: 'default', lastUsedAt: null, createdAt: null } as never);
    quiet(r);
    await r.mod.commit();
  } finally { await r.srv.close(); }
});

test('Restart now: drain cancels running and queued tasks, denies approvals, records what it stopped; commit then goes ahead without the quiet period', async () => {
  const r = await stagedRig();
  try {
    r.store.upsertTask(task('run1', 'running')); r.store.upsertTask(task('q1', 'queued')); r.engine.live.add('run1');
    const pending = r.approvals.request('run1', 'builder', 'Bash', {});
    await waitFor(() => r.approvals.pending().length === 1);
    r.clock.t += 90_000;
    assert.ok((await r.mod.status()).busy.reasons.length > 0, 'busy while the tasks run');
    const out = await r.mod.drain();
    assert.equal(out.settled, true);
    assert.deepEqual(out.stopped.map((t) => t.id).sort(), ['q1', 'run1']);
    assert.equal(await pending, false);
    assert.deepEqual(r.engine.cancelled.sort(), ['q1', 'run1']);
    assert.equal(r.store.getTask('run1')!.status, 'cancelled');
    const s = await r.mod.status();
    assert.deepEqual(s.stopped?.tasks.map((t) => t.id).sort(), ['q1', 'run1']);
    await assert.rejects(r.mod.commit(), /quiet long enough/, 'without force the quiet period still applies');
    const job = await r.mod.commit({ force: true });
    assert.equal(job.to, '0.2.1');
    await r.call('POST', '/api/update/ack');
    assert.equal((await r.mod.status()).stopped, undefined);
  } finally { await r.srv.close(); }
});
test('commit with force only works within a minute of a drain', async () => {
  const r = await stagedRig();
  try { await assert.rejects(r.mod.commit({ force: true }), /quiet long enough|just started/); } finally { await r.srv.close(); }
});

test('C19: a git checkout, an unwritable folder or a non-Windows system is notify-only: install and commit refuse, nothing is run', async () => {
  for (const o of [{ git: true }, { platform: 'linux' as const }]) {
    const r = await rig(makeRelease(k, '0.2.1'), o);
    try {
      await r.mod.check(true);
      const s = await r.mod.status();
      assert.equal(s.available?.version, '0.2.1', 'the notice still appears');
      assert.notEqual(s.mode, 'apply');
      await assert.rejects(r.mod.install(), /git checkout|cannot be updated/);
      await assert.rejects(r.mod.commit(), /cannot be updated/);
      assert.equal(hitsFor(r, '/releases/download/'), 0);
    } finally { await r.srv.close(); }
  }
  assert.equal(installMode({ root: 'C:\\L', platform: 'win32', exists: (p) => p.endsWith('.git'), writable: () => true }), 'checkout');
  assert.equal(installMode({ root: 'C:\\L', platform: 'win32', exists: () => false, writable: () => false }), 'unwritable');
  assert.equal(installMode({ root: 'C:\\L', platform: 'win32', exists: () => false, writable: () => true }), 'apply');
  assert.equal(installMode({ root: '/l', platform: 'darwin', exists: () => false, writable: () => true }), 'unsupported');
});
test('C10/C20: a release that changes dependencies is notify-only; a package whose lock differs from the installed one is refused at staging', async () => {
  const full = await rig(makeRelease(k, '0.2.1', { requiresFullInstall: true }));
  try { await full.mod.check(true); await assert.rejects(full.mod.install(), /dependencies/); assert.equal(hitsFor(full, '/releases/download/'), 0); } finally { await full.srv.close(); }
  const lock = await rig(makeRelease(k, '0.2.1', { lock: '{"other":1}' }));
  try {
    await lock.mod.check(true);
    assert.deepEqual(await lock.mod.install(), { ok: false }); // no card to answer any more
    const s = await lock.mod.status();
    assert.match(s.error!, /dependencies/); assert.equal(s.staged, undefined); assert.equal(s.available?.requiresFullInstall, true);
  } finally { await lock.srv.close(); }
  assert.equal(sha256(LOCK).length, 64);
});
test('a rolled-back version recorded by the helper is never offered again', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    mkdirSync(join(r.root, '.update'), { recursive: true });
    writeFileSync(join(r.root, '.update', 'outcome.json'), JSON.stringify({ at: 'x', from: '0.2.0', to: '0.2.1', result: 'rolled-back', reason: 'test' }));
    const again = createUpdaterModule({ config: {}, store: r.store, bus: new EventBus(), engine: r.engine, approvals: r.approvals, dataDir: r.data, bsvEnabled: () => false } as unknown as ModuleDeps, { root: r.root, source: r.srv.source, keys: [k.key], version: '0.2.0', platform: 'win32', timers: false, now: () => r.clock.t });
    await again.check(true);
    const s = await again.status();
    assert.equal(s.available, undefined); assert.match(s.check.lastResult!, /failed its first start/);
    assert.equal(s.outcome?.result, 'rolled-back');
  } finally { await r.srv.close(); }
});
