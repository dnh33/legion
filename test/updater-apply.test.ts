/** C16, C17, C18: the swap touches only the code set, keeps one previous, recovers from a kill at any step, rolls back an unhealthy build. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cleanPrev, cleanStaleApplyCopies, settleAfterStart, CODE_SET, FULL_PACKAGE_SET, healthWindow, markCommitted, readJournal, readOutcome, recoverInterrupted, removeOwned, rollback, runApply, swapIn, type ApplyDeps, type ApplyJob } from '../src/core/updater/apply.js';

function put(root: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); }
}
function snap(root: string, skip = '.update'): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (relative(root, p) === skip) continue;
      if (statSync(p).isDirectory()) walk(p); else out[relative(root, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}
const OLD = { 'package.json': '{"version":"1.0.0"}', 'dist/src/electron/main.js': 'old-main', 'dist/src/bin/legion-core.js': 'old-core', 'dist-ui/index.html': 'old-ui', 'assets/icon.png': 'old-icon', 'node_modules/electron/keep.txt': 'KEEP', 'runtime/electron/electron.exe': 'old-electron', 'uninstall.cmd': 'UNINSTALL', 'extra-user-file.txt': 'mine' };
const NEW = { 'package.json': '{"version":"1.1.0"}', 'dist/src/electron/main.js': 'new-main', 'dist/src/bin/legion-core.js': 'new-core', 'dist-ui/index.html': 'new-ui', 'assets/icon.png': 'new-icon', 'node_modules/evil/x.js': 'EVIL', 'runtime/electron/electron.exe': 'new-electron', 'uninstall.cmd': 'EVIL-UNINSTALL', 'not-in-set.txt': 'x' };

function fixture(): { install: string; staged: string; data: string; root: string } {
  const root = cleanupTemp('upd-apply-');
  const install = join(root, 'install'); const data = join(root, 'data');
  put(install, OLD); put(data, { 'state.json': '{"tasks":[]}', 'config.json': '{"authToken":"x"}' });
  const staged = join(install, '.update', 'staging', '1.1.0', 'x', 'legion-1.1.0');
  put(staged, NEW);
  return { install, staged, data, root };
}
const kill = (label: string) => (l: string) => { if (l === label) throw Object.assign(new Error(`killed at ${l}`), { kill: true }); };

test('C16: the swap replaces only code-set names; node_modules, uninstall.cmd, user files and the data folder are untouched; the old build is kept once', async () => {
  const f = fixture();
  const dataBefore = snap(f.data);
  await swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0' });
  const now = snap(f.install);
  assert.equal(now['dist/src/electron/main.js'], 'new-main');
  assert.equal(now['package.json'], '{"version":"1.1.0"}');
  assert.equal(now['node_modules/electron/keep.txt'], 'KEEP');
  assert.equal(now['uninstall.cmd'], 'UNINSTALL');
  assert.equal(now['extra-user-file.txt'], 'mine');
  assert.equal(existsSync(join(f.install, 'node_modules', 'evil')), false, 'a node_modules entry in the package is never installed');
  assert.equal(existsSync(join(f.install, 'not-in-set.txt')), false);
  assert.equal(readFileSync(join(f.install, '.update', 'prev', 'dist', 'src', 'electron', 'main.js'), 'utf8'), 'old-main');
  assert.deepEqual(snap(f.data), dataBefore);
  assert.equal(readJournal(f.install)?.state, 'awaiting-health');
  // a second update keeps only the one before it
  markCommitted(f.install);
  const staged2 = join(f.install, '.update', 'staging', '1.2.0', 'x', 'legion-1.2.0');
  put(staged2, { ...NEW, 'package.json': '{"version":"1.2.0"}', 'dist/src/electron/main.js': 'newer-main' });
  await swapIn({ installDir: f.install, stagedDir: staged2, from: '1.1.0', to: '1.2.0' });
  assert.equal(readFileSync(join(f.install, '.update', 'prev', 'dist', 'src', 'electron', 'main.js'), 'utf8'), 'new-main', 'exactly one previous version: 1.1.0, not 1.0.0');
  assert.equal(readdirSync(join(f.install, '.update', 'prev')).includes('node_modules'), false);
  assert.ok(CODE_SET.every((n) => n !== 'node_modules' && n !== 'uninstall.cmd' && !n.includes('..') && !n.includes('/')));
});

test('C16b: a full-package swap (FULL_PACKAGE_SET) also replaces node_modules and runtime, keeps user files and uninstall.cmd, and one previous', async () => {
  const f = fixture();
  const dataBefore = snap(f.data);
  await swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET });
  const now = snap(f.install);
  assert.equal(now['node_modules/evil/x.js'], 'EVIL');
  assert.equal(existsSync(join(f.install, 'node_modules', 'electron', 'keep.txt')), false, 'the old dependency tree is gone');
  assert.equal(now['runtime/electron/electron.exe'], 'new-electron');
  assert.equal(now['uninstall.cmd'], 'UNINSTALL');
  assert.equal(now['extra-user-file.txt'], 'mine');
  assert.equal(readFileSync(join(f.install, '.update', 'prev', 'node_modules', 'electron', 'keep.txt'), 'utf8'), 'KEEP');
  assert.equal(readFileSync(join(f.install, '.update', 'prev', 'runtime', 'electron', 'electron.exe'), 'utf8'), 'old-electron');
  const j = readJournal(f.install);
  assert.equal(j?.state, 'awaiting-health');
  for (const n of j!.entries) assert.ok(FULL_PACKAGE_SET.includes(n), `${n} is in the full set`);
  assert.ok(j!.entries.includes('node_modules') && j!.entries.includes('runtime'));
  assert.deepEqual(snap(f.data), dataBefore, 'the data folder is never touched');
});

test('C17b: a kill during a full-package swap is recovered at the next start (the old tree and runtime come back)', async () => {
  const probe = fixture();
  const labels: string[] = [];
  await swapIn({ installDir: probe.install, stagedDir: probe.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET, step: (l) => labels.push(l) });
  assert.ok(labels.some((l) => l.startsWith('before-move:node_modules')), 'the swap moved the dependency tree');
  assert.ok(labels.some((l) => l.startsWith('before-move:runtime')), 'the swap moved the runtime');
  for (const label of labels) {
    const f = fixture();
    const before = snap(f.install);
    await assert.rejects(swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET, step: kill(label) }), /killed at/);
    assert.equal(await recoverInterrupted(f.install, { runningVersion: '1.0.0' }), 'rolled-back', label);
    assert.deepEqual(snap(f.install), before, `after a kill at ${label}`);
  }
});

test('C17: a kill at every step is recovered at the next start (live tree == the old tree again)', async () => {
  const probe = fixture();
  const labels: string[] = [];
  await swapIn({ installDir: probe.install, stagedDir: probe.staged, from: '1.0.0', to: '1.1.0', step: (l) => { labels.push(l); } });
  assert.ok(labels.length >= 10, `steps seen: ${labels.length}`);
  for (const label of labels) {
    const f = fixture();
    const before = snap(f.install);
    await assert.rejects(swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', step: kill(label) }), /killed at/);
    const res = await recoverInterrupted(f.install, { runningVersion: '1.0.0' });
    assert.equal(res, 'rolled-back', label);
    assert.deepEqual(snap(f.install), before, `after a kill at ${label}`);
    assert.equal(readJournal(f.install)?.state, 'rolled-back');
    assert.equal(readOutcome(f.install)?.result, 'rolled-back');
    assert.equal(await recoverInterrupted(f.install, { runningVersion: '1.0.0' }), 'none', 'recovery is idempotent');
  }
});
test('C17: a normal error in the middle rolls back by itself', async () => {
  const f = fixture();
  const before = snap(f.install);
  await assert.rejects(swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', step: (l) => { if (l === 'before-install:dist-ui') throw new Error('boom'); } }), /boom/);
  assert.deepEqual(snap(f.install), before);
});
test('C18c: on Windows a full-package commit unloads the helper first (re-exec) and the fresh process owns the swap', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const jobs: string[] = [];
  const d = deps({ f, newHealthy: true, reExec: (jf) => { jobs.push(jf); return { ok: true }; } });
  assert.equal(await runApply({ ...job(f), names: FULL_PACKAGE_SET }, d), 're-exec');
  assert.deepEqual(jobs, [process.argv[2] ?? '']);
  assert.ok((snap(f.install)['package.json'] ?? '').includes('1.0.0'), 'the first process swapped nothing');
  process.env.LEGION_APPLY_REEXEC = '1';
  try {
    assert.equal(await runApply({ ...job(f), names: FULL_PACKAGE_SET }, deps({ f, newHealthy: true })), 'ok', 'the env-guarded helper proceeds to the real swap');
  } finally { delete process.env.LEGION_APPLY_REEXEC; }
  assert.ok((snap(f.install)['package.json'] ?? '').includes('1.1.0'), 'the re-executed helper completed the swap');
});

test('C17: recoverInterrupted decisions (awaiting-health with the new build running, fresh helper, stale helper)', async () => {
  const f = fixture();
  await swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0' });
  const j = readJournal(f.install)!;
  assert.equal(await recoverInterrupted(f.install, { runningVersion: '1.1.0', nowMs: j.heartbeat + 10 * 60_000 }), 'awaiting-confirm');
  assert.equal(await recoverInterrupted(f.install, { runningVersion: '1.0.0', nowMs: j.heartbeat + 1000 }), 'none', 'the helper is still alive and deciding');
  assert.equal(await recoverInterrupted(f.install, { runningVersion: '1.0.0', nowMs: j.heartbeat + 10 * 60_000 }), 'rolled-back');
  assert.equal(snap(f.install)['dist/src/electron/main.js'], 'old-main');
  assert.equal(await recoverInterrupted(cleanupTemp('upd-empty-'), { runningVersion: '1.0.0' }), 'none');
});

function deps(over: Partial<ApplyDeps> & { f: ReturnType<typeof fixture>; newHealthy: boolean }): ApplyDeps & { spawned: number; killed: number[]; state: { newUp: boolean; oldUp: boolean } } {
  const state = { newUp: false, oldUp: false };
  const d = {
    spawned: 0, killed: [] as number[], state,
    isAlive: () => false,
    stopCore: async () => { /* no-op in tests */ },
    isCoreRunning: () => false,
    waitExit: async () => true,
    health: async () => (state.newUp ? { ok: true, version: '1.1.0' } : state.oldUp ? { ok: true, version: '1.0.0' } : null),
    spawnApp: () => { d.spawned++; const swapped = snap(over.f.install)['package.json']!.includes('1.1.0'); if (swapped && over.newHealthy) state.newUp = true; else if (swapped) state.oldUp = false; else state.oldUp = true; return { pid: 4242 }; },
    killTree: async (pid: number) => { d.killed.push(pid); state.newUp = false; },
    sleep: async () => undefined,
    log: () => undefined,
  } as ApplyDeps & { spawned: number; killed: number[]; state: typeof state };
  return Object.assign(d, over);
}
const job = (f: ReturnType<typeof fixture>): ApplyJob => ({ installDir: f.install, stagedDir: f.staged, parentPid: 1, port: 4747, from: '1.0.0', to: '1.1.0', relaunch: { cmd: 'x', args: [], cwd: f.install }, healthTimeoutMs: 40, parentWaitMs: 40, portFreeMs: 40, swapRetryMs: 10 });

test('C18b: runApply carries job.names through to the swap, so a full-package commit moves node_modules and runtime', async () => {
  const f = fixture();
  assert.equal(await runApply({ ...job(f), names: FULL_PACKAGE_SET }, deps({ f, newHealthy: true })), 'ok');
  assert.equal(snap(f.install)['node_modules/evil/x.js'], 'EVIL');
  assert.equal(snap(f.install)['runtime/electron/electron.exe'], 'new-electron');
  assert.equal(readJournal(f.install)?.state, 'committed');
});

test('C18: a healthy new build commits; an outcome ok is written; staging is cleaned', async () => {
  const f = fixture();
  assert.equal(await runApply(job(f), deps({ f, newHealthy: true })), 'ok');
  assert.equal(readJournal(f.install)?.state, 'committed');
  assert.equal(readOutcome(f.install)?.result, 'ok');
  assert.equal(snap(f.install)['dist/src/electron/main.js'], 'new-main');
  assert.equal(existsSync(join(f.install, '.update', 'staging')), false);
});
test('C18: an unhealthy new build is killed BY PID, rolled back, and the old build is started again', async () => {
  const f = fixture();
  const before = snap(f.install);
  const d = deps({ f, newHealthy: false });
  assert.equal(await runApply(job(f), d), 'rolled-back');
  assert.deepEqual(d.killed, [4242]);
  assert.equal(d.spawned, 2, 'new build then old build');
  assert.deepEqual(snap(f.install), before);
  const o = readOutcome(f.install)!;
  assert.equal(o.result, 'rolled-back'); assert.match(o.reason ?? '', /did not report healthy/);
});
test('C18: the app still running, or a core still answering: nothing is changed', async () => {
  const f = fixture();
  const before = snap(f.install);
  assert.equal(await runApply(job(f), deps({ f, newHealthy: true, isAlive: () => true })), 'failed');
  assert.deepEqual(snap(f.install), before);
  assert.equal(await runApply(job(f), deps({ f, newHealthy: true, health: async () => ({ ok: true, version: '1.0.0' }) })), 'failed');
  assert.deepEqual(snap(f.install), before);
});
test('C18: a failing swap leaves the old build in place and starts it', async () => {
  const f = fixture();
  const before = snap(f.install);
  const d = deps({ f, newHealthy: true, step: (l) => { if (l === 'before-install:assets') throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.equal(await runApply(job(f), d), 'failed');
  assert.deepEqual(snap(f.install), before);
  assert.match(readOutcome(f.install)?.reason ?? '', /files in use/);
  assert.equal(d.spawned, 1);
});

test('C16: removeOwned deletes only inside .update, never the folder itself, never a link, never outside', () => {
  const f = fixture();
  mkdirSync(join(f.install, '.update', 'prev', 'a'), { recursive: true });
  assert.throws(() => removeOwned(f.install, join(f.install, 'dist')), /outside/);
  assert.throws(() => removeOwned(f.install, join(f.install, '.update')), /outside/);
  assert.throws(() => removeOwned(f.install, join(f.install, '.update', '..', 'node_modules')), /outside/);
  assert.throws(() => removeOwned(f.install, f.data), /outside/);
  try {
    symlinkSync(f.data, join(f.install, '.update', 'prev', 'link'), 'dir');
    assert.throws(() => removeOwned(f.install, join(f.install, '.update', 'prev', 'link')), /link/);
    assert.ok(existsSync(join(f.data, 'state.json')));
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; }
  removeOwned(f.install, join(f.install, '.update', 'prev'));
  assert.equal(existsSync(join(f.install, '.update', 'prev')), false);
  assert.ok(existsSync(join(f.install, 'dist')));
});
test('C16: rollback with no journal does nothing', async () => {
  const f = fixture();
  const before = snap(f.install);
  await rollback(f.install, 'x');
  assert.deepEqual(snap(f.install), before);
});

// ---- hardening of the real Windows full swap (2026-10-14 full-install plan, risks 2, 4 and the prev folder)

test('H2: a failed re-exec is visible and nothing is swapped: outcome failed with the reason, the old app is started again', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const before = snap(f.install);
  const d = deps({ f, newHealthy: true, reExec: async () => ({ ok: false, error: 'the copy ran out of disk space' }) });
  assert.equal(await runApply({ ...job(f), names: FULL_PACKAGE_SET }, d), 'failed');
  assert.deepEqual(snap(f.install), before, 'the live tree is untouched');
  assert.equal(readJournal(f.install), null, 'no swap was journaled');
  const o = readOutcome(f.install)!;
  assert.equal(o.result, 'failed'); assert.match(o.reason ?? '', /ran out of disk space/);
  assert.equal(d.spawned, 1, 'the old app is started again');
});

test('H2b: stale legion-apply-* copies in the temp folder are removed on a later start; fresh ones and other names are kept', () => {
  const tmp = cleanupTemp('upd-tmp-');
  for (const n of ['legion-apply-111', 'legion-apply-222', 'legion-apply-notanumber', 'other-folder']) put(tmp, { [`${n}/x.txt`]: 'x' });
  const DAY = 86_400_000;
  const old = new Date(Date.now() - 3 * DAY);
  utimesSync(join(tmp, 'legion-apply-111'), old, old);
  const removed = cleanStaleApplyCopies(tmp, { maxAgeMs: DAY, nowMs: Date.now() });
  assert.deepEqual(removed, ['legion-apply-111']);
  assert.deepEqual(readdirSync(tmp).sort(), ['legion-apply-222', 'legion-apply-notanumber', 'other-folder']);
});

test('H3: a full swap gets a longer first-start window than a code-only one', () => {
  assert.ok(healthWindow({ names: FULL_PACKAGE_SET }).baseMs >= 180_000);
  assert.equal(healthWindow({}).baseMs, 60_000);
  assert.equal(healthWindow({ healthTimeoutMs: 40 }).baseMs, 40, 'an explicit job value wins');
});

test('H3: a slow first start that is still running gets one bounded extension instead of a rollback', async () => {
  const f = fixture();
  const t0 = Date.now();
  const d = deps({ f, newHealthy: true, isAlive: (pid: number) => pid === 4242, health: async () => {
    const swapped = snap(f.install)['package.json']!.includes('1.1.0');
    if (!swapped) return null;
    return Date.now() - t0 > 120 ? { ok: true, version: '1.1.0' } : null; // only healthy after the base window (40 ms) has passed
  } });
  // parentPid 1 must read as gone for the early waits
  d.isAlive = (pid: number) => pid === 4242;
  assert.equal(await runApply({ ...job(f), healthTimeoutMs: 40, healthExtensionMs: 3000 }, d), 'ok');
  assert.deepEqual(d.killed, []);
});

test('H3: if the new build has already died, the base window is all it gets (no extension) and it rolls back', async () => {
  const f = fixture();
  const before = snap(f.install);
  const d = deps({ f, newHealthy: false });
  const t0 = Date.now();
  assert.equal(await runApply({ ...job(f), healthTimeoutMs: 40, healthExtensionMs: 5000 }, d), 'rolled-back');
  assert.ok(Date.now() - t0 < 2500, 'it did not wait out the extension');
  assert.deepEqual(snap(f.install), before);
});

test('H5: after a healthy start the previous copy (.update/prev) is deleted; a rolled-back update keeps nothing to delete', async () => {
  const f = fixture();
  assert.equal(await runApply({ ...job(f), names: FULL_PACKAGE_SET }, deps({ f, newHealthy: true })), 'ok');
  assert.equal(existsSync(join(f.install, '.update', 'prev')), false, 'the old node_modules and runtime are gone');
  assert.equal(readOutcome(f.install)?.result, 'ok');
});

test('H5b: cleanPrev is safe to call twice, on a missing folder, and never touches anything outside .update/prev', async () => {
  const f = fixture();
  await swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET });
  markCommitted(f.install);
  await cleanPrev(f.install);
  await cleanPrev(f.install);
  assert.equal(existsSync(join(f.install, '.update', 'prev')), false);
  assert.equal(snap(f.install)['node_modules/evil/x.js'], 'EVIL', 'the live tree stays');
});

test('H5c: a new build that starts after the OLD helper committed (the old helper cannot clean prev) cleans it itself', async () => {
  const f = fixture();
  await swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET });
  markCommitted(f.install); // what an older helper does: it commits but knows nothing about prev
  assert.equal(existsSync(join(f.install, '.update', 'prev')), true);
  await settleAfterStart(f.install, '1.0.0');
  assert.equal(existsSync(join(f.install, '.update', 'prev')), true, 'a different running version leaves prev alone');
  await settleAfterStart(f.install, '1.1.0');
  assert.equal(existsSync(join(f.install, '.update', 'prev')), false);
  assert.equal(readJournal(f.install)?.state, 'committed');
});

test('H5c: a new build that starts while the journal still awaits health confirms itself and cleans prev', async () => {
  const f = fixture();
  await swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0' });
  await settleAfterStart(f.install, '1.1.0');
  assert.equal(readJournal(f.install)?.state, 'committed');
  assert.equal(readOutcome(f.install)?.result, 'ok');
  assert.equal(existsSync(join(f.install, '.update', 'prev')), false);
});

test('H5c: a rolled-back journal is left alone', async () => {
  const f = fixture();
  await swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0' });
  await rollback(f.install, 'test');
  await settleAfterStart(f.install, '1.1.0');
  assert.equal(readJournal(f.install)?.state, 'rolled-back');
});
