/** H2: the swap helper writes every step it runs, with the one update id from the job, and drives the window (start early, hand the lock over before any restart, tell it the result). */
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FULL_PACKAGE_SET, HELPER_JOURNEY_STEPS, realDeps, runApply, type ApplyDeps, type ApplyJob } from '../src/core/updater/apply.js';
import { JOURNEY_STEPS, journeyLine, parseJourneyLine } from '../src/core/updater/journey.js';
import { readJourneyEvents } from '../src/core/updater/journey-io.js';

function put(root: string, files: Record<string, string>): void { for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); } }
const OLD = { 'package.json': '{"version":"1.0.0"}', 'dist/a.js': 'old', 'dist-ui/index.html': 'old-ui', 'node_modules/x/y.js': 'old-dep', 'runtime/electron/electron.exe': 'old-exe' };
const NEW = { 'package.json': '{"version":"1.1.0"}', 'dist/a.js': 'new', 'dist-ui/index.html': 'new-ui', 'node_modules/x/y.js': 'new-dep', 'runtime/electron/electron.exe': 'new-exe' };
function fixture(): { root: string; install: string; staged: string; data: string } {
  const root = tempDir('h2-helper-');
  const install = join(root, 'install'); const data = join(root, 'data');
  put(install, OLD); mkdirSync(data, { recursive: true });
  const staged = join(install, '.update', 'staging', '1.1.0', 'x', 'legion-1.1.0');
  put(staged, NEW);
  return { root, install, staged, data };
}
const job = (f: { install: string; staged: string; data: string }, over: Partial<ApplyJob> = {}): ApplyJob => ({
  installDir: f.install, stagedDir: f.staged, parentPid: 1, port: 4747, from: '1.0.0', to: '1.1.0', updateId: 'ab12cd34', dataDir: f.data,
  relaunch: { cmd: 'x', args: [], cwd: f.install }, healthTimeoutMs: 40, parentWaitMs: 40, portFreeMs: 40, swapRetryMs: 40, ...over,
});

/** Fakes that record one timeline of everything the helper does, so the ORDER is what is asserted. */
function rig(f: { install: string }, o: { newHealthy?: boolean; parentAlive?: boolean } = {}): { d: ApplyDeps; t: string[]; fin: Array<{ result: string; started?: boolean }> } {
  const fin: Array<{ result: string; started?: boolean }> = [];
  const t: string[] = [];
  const st = { newUp: false, oldUp: false };
  const d: ApplyDeps = {
    isAlive: (pid) => (pid === 1 ? !!o.parentAlive : false),
    health: async () => (st.newUp ? { ok: true, version: '1.1.0' } : st.oldUp ? { ok: true, version: '1.0.0' } : null),
    spawnApp: () => { t.push('spawn'); const swapped = readFileSync(join(f.install, 'package.json'), 'utf8').includes('1.1.0'); if (swapped && o.newHealthy !== false) st.newUp = true; else st.oldUp = true; return { pid: 4242 }; },
    killTree: async () => undefined, sleep: async () => undefined, log: () => undefined,
    journey: (step, state, extra) => { t.push(`${step}:${state}${extra?.during ? `(${extra.during})` : ''}`); },
    window: {
      start: () => { t.push('window:start'); },
      releaseLock: async () => { t.push('window:release-lock'); },
      finish: async (result, _m, started) => { t.push(`window:finish:${result}`); fin.push({ result, started }); },
    },
  };
  return { d, t, fin };
}

test('H2 helper: a code-only update writes closing, installing, starting, health in order; the window starts first, lets go of the lock before the new build starts, and is told it worked', async () => {
  const f = fixture(); const { d, t } = rig(f);
  assert.equal(await runApply(job(f), d), 'ok');
  assert.deepEqual(t, [
    'window:start', 'closing:start', 'closing:done', 'installing:start', 'installing:done',
    'window:release-lock', 'starting:start', 'spawn', 'starting:done', 'health:start', 'health:done', 'window:finish:ok',
  ]);
});

test('H2 helper: a full update has the Preparing step between closing and installing', async () => {
  const f = fixture(); const { d, t } = rig(f);
  process.env.LEGION_APPLY_REEXEC = '1';
  try { assert.equal(await runApply(job(f, { names: FULL_PACKAGE_SET }), d), 'ok'); } finally { delete process.env.LEGION_APPLY_REEXEC; }
  const steps = t.filter((x) => !x.startsWith('window') && x !== 'spawn');
  assert.deepEqual(steps, ['closing:start', 'closing:done', 'preparing:start', 'preparing:done', 'installing:start', 'installing:done', 'starting:start', 'starting:done', 'health:start', 'health:done']);
});

test('H2 helper: an app that does not close is a failed update in step closing, with the reason, and the window is told', async () => {
  const f = fixture(); const { d, t } = rig(f, { parentAlive: true });
  const notes: string[] = [];
  const j = d.journey!; d.journey = (s, st, x) => { if (s === 'failed') notes.push(x?.note ?? ''); j(s, st, x); };
  assert.equal(await runApply(job(f), d), 'failed');
  assert.deepEqual(t.filter((x) => !x.startsWith('window:start')), ['closing:start', 'failed:done(closing)', 'window:finish:failed']);
  assert.match(notes[0]!, /did not exit in time/);
});

test('H2 helper: before the helper starts the app again after a failure it lets go of the lock, or the old app would find it taken and quit', async () => {
  const f = fixture(); const { d, t } = rig(f);
  d.gracefulTeardown = async () => ({ ok: false, error: 'the Legion core did not exit in time; nothing was changed' });
  assert.equal(await runApply(job(f), d), 'failed');
  assert.ok(t.indexOf('window:release-lock') >= 0 && t.indexOf('window:release-lock') < t.indexOf('spawn'), t.join(' | '));
  assert.ok(t.includes('failed:done(closing)') && t.includes('window:finish:failed'));
});

test('H2 helper: a build that never reports healthy is rolled back; the journey says rolled back in step health and the window is told', async () => {
  const f = fixture(); const { d, t } = rig(f, { newHealthy: false });
  assert.equal(await runApply(job(f), d), 'rolled-back');
  assert.ok(t.includes('health:start'));
  assert.ok(t.includes('rolled-back:done(health)'), t.join(' | '));
  assert.ok(t.indexOf('window:finish:rolled-back') > t.indexOf('rolled-back:done(health)') && t.lastIndexOf('spawn') < t.indexOf('window:finish:rolled-back'), 'the previous version starts, then the window is told whether it did');
  assert.equal(t.filter((x) => x === 'window:release-lock').length >= 1, true);
});

test('H2 helper: with no window dependency nothing changes (the window is optional)', async () => {
  const f = fixture(); const { d, t } = rig(f);
  delete d.window;
  assert.equal(await runApply(job(f), d), 'ok');
  assert.ok(t.includes('health:done'));
});

test('H2 helper: the real step log carries the job\'s one update id, both versions and the helper process in the journey file, apply.log and app.log', async () => {
  const f = fixture(); const { d } = rig(f);
  const real = realDeps(f.install, { port: 4747, updateId: 'ab12cd34', dataDir: f.data, from: '1.0.0', to: '1.1.0' } as never);
  d.journey = real.journey; delete d.window;
  assert.equal(await runApply(job(f), d), 'ok');
  const ev = readJourneyEvents(f.install);
  assert.deepEqual([...new Set(ev.map((e) => e.id))], ['ab12cd34']);
  assert.deepEqual([...new Set(ev.map((e) => `${e.from}>${e.to}>${e.proc}`))], ['1.0.0>1.1.0>helper']);
  assert.deepEqual(ev.map((e) => `${e.step}:${e.state}`), ['closing:start', 'closing:done', 'installing:start', 'installing:done', 'starting:start', 'starting:done', 'health:start', 'health:done']);
  const al = readFileSync(join(f.install, '.update', 'apply.log'), 'utf8').split('\n').map((l) => parseJourneyLine(l)).filter(Boolean);
  assert.equal(al.length, ev.length, 'one apply.log line per step');
  assert.deepEqual([...new Set(al.map((e) => e!.id))], ['ab12cd34']);
  const app = readFileSync(join(f.data, 'logs', 'app.log'), 'utf8').split('\n').filter((l) => l.includes('journey-step'));
  assert.equal(app.length, ev.length, 'one app.log line per step');
  for (const l of app) { assert.match(l, /id="ab12cd34"/); assert.match(l, /from="1\.0\.0"/); assert.match(l, /to="1\.1\.0"/); assert.match(l, /proc="helper"/); }
});

test('H2 helper: a job from an older app has no id: the helper makes one and every one of its steps carries it', async () => {
  const f = fixture(); const { d } = rig(f);
  const real = realDeps(f.install, { port: 4747, from: '1.0.0', to: '1.1.0' } as never);
  d.journey = real.journey; delete d.window;
  assert.equal(await runApply(job(f, { updateId: undefined as never }), d), 'ok');
  const ids = new Set(readJourneyEvents(f.install).map((e) => e.id));
  assert.equal(ids.size, 1); assert.match([...ids][0]!, /^[0-9a-f]{8}$/);
});

test('H2 helper: the real window dependency exists only when the job turns it on and the helper runs from a runtime that no swap renames', () => {
  const f = fixture();
  const on = { enabled: true, userData: 'u' };
  assert.equal(realDeps(f.install, { port: 1 } as never).window, undefined, 'a job from an older app');
  assert.equal(realDeps(f.install, { port: 1, window: { ...on, enabled: false } } as never).window, undefined, 'turned off in Settings');
  assert.equal(realDeps(f.install, { port: 1, names: FULL_PACKAGE_SET, window: on } as never).window, undefined, 'a full update from the install runtime: it would block the swap');
  // the "Updating Legion" window is win32 only (windowShown, realDeps): on Linux and macOS a job never gets one, even when it asks
  const win = process.platform === 'win32';
  assert.equal(!!realDeps(f.install, { port: 1, window: on } as never).window, win, 'a code-only update: the install runtime is not swapped (a window on Windows only)');
  process.env.LEGION_APPLY_REEXEC = '1';
  try { assert.equal(!!realDeps(f.install, { port: 1, names: FULL_PACKAGE_SET, window: on } as never).window, win, 'a full update from the runtime copy outside the install (a window on Windows only)'); } finally { delete process.env.LEGION_APPLY_REEXEC; }
});

test('H2 helper: the helper\'s own step list is the shared table (the helper cannot import it, so this pins the copy), and its lines read back with the shared parser', () => {
  const shared = JOURNEY_STEPS.filter((s) => s.where === 'helper' || s.id === 'closing' || s.id === 'failed').map((s) => s.id).sort();
  assert.deepEqual([...HELPER_JOURNEY_STEPS].sort(), shared);
  const e = { at: '2026-10-15T10:00:00.000Z', id: 'ab12cd34', step: 'installing' as const, state: 'start' as const, proc: 'helper' as const, from: '1.0.0', to: '1.1.0', note: 'x "y"' };
  assert.deepEqual(parseJourneyLine(`[${e.at}] ${journeyLine(e)}`), e);
});

test('H2 r2: the window is told whether Legion was started again; a failure that starts nothing says so, so the window can start it', async () => {
  // before the old app is gone nothing is started: the backup fails
  const a = fixture(); const ra = rig(a);
  ra.d.runPreflight = () => ({ ok: false, error: 'disk full' } as never);
  assert.equal(await runApply(job(a), ra.d), 'failed');
  assert.deepEqual(ra.fin, [{ result: 'failed', started: false }], 'the backup failed: no Legion was started');
  // the app does not exit in time: nothing is started either
  const b = fixture(); const rb = rig(b, { parentAlive: true });
  assert.equal(await runApply(job(b), rb.d), 'failed');
  assert.deepEqual(rb.fin, [{ result: 'failed', started: false }]);
  // a core that still answers, a teardown that failed: the helper starts the old app again
  const c = fixture(); const rc = rig(c);
  rc.d.gracefulTeardown = async () => ({ ok: false, error: 'the Legion core did not exit in time; nothing was changed' });
  assert.equal(await runApply(job(c), rc.d), 'failed');
  assert.deepEqual(rc.fin, [{ result: 'failed', started: true }], 'the old app was started again before the window was told');
  assert.ok(rc.t.indexOf('spawn') < rc.t.indexOf('window:finish:failed'));
  // a spawn that fails is not a started Legion
  const d = fixture(); const rd = rig(d);
  rd.d.gracefulTeardown = async () => ({ ok: false, error: 'the Legion core did not exit in time; nothing was changed' });
  rd.d.spawnApp = () => null;
  assert.equal(await runApply(job(d), rd.d), 'failed');
  assert.deepEqual(rd.fin, [{ result: 'failed', started: false }]);
  // a rollback starts the old version, then tells the window
  const e = fixture(); const re = rig(e, { newHealthy: false });
  assert.equal(await runApply(job(e), re.d), 'rolled-back');
  assert.deepEqual(re.fin, [{ result: 'rolled-back', started: true }]);
});
