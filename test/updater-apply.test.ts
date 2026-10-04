/** C16, C17, C18: the swap touches only the code set, keeps one previous, recovers from a kill at any step, rolls back an unhealthy build. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CODE_SET, markCommitted, readJournal, readOutcome, recoverInterrupted, removeOwned, rollback, runApply, swapIn, type ApplyDeps, type ApplyJob } from '../src/core/updater/apply.js';

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
const OLD = { 'package.json': '{"version":"1.0.0"}', 'dist/src/electron/main.js': 'old-main', 'dist/src/bin/legion-core.js': 'old-core', 'dist-ui/index.html': 'old-ui', 'assets/icon.png': 'old-icon', 'node_modules/electron/keep.txt': 'KEEP', 'uninstall.cmd': 'UNINSTALL', 'extra-user-file.txt': 'mine' };
const NEW = { 'package.json': '{"version":"1.1.0"}', 'dist/src/electron/main.js': 'new-main', 'dist/src/bin/legion-core.js': 'new-core', 'dist-ui/index.html': 'new-ui', 'assets/icon.png': 'new-icon', 'node_modules/evil/x.js': 'EVIL', 'uninstall.cmd': 'EVIL-UNINSTALL', 'not-in-set.txt': 'x' };

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
    health: async () => (state.newUp ? { ok: true, version: '1.1.0' } : state.oldUp ? { ok: true, version: '1.0.0' } : null),
    spawnApp: () => { d.spawned++; const swapped = snap(over.f.install)['package.json']!.includes('1.1.0'); if (swapped && over.newHealthy) state.newUp = true; else if (swapped) state.oldUp = false; else state.oldUp = true; return { pid: 4242 }; },
    killTree: async (pid: number) => { d.killed.push(pid); state.newUp = false; },
    sleep: async () => undefined,
    log: () => undefined,
  } as ApplyDeps & { spawned: number; killed: number[]; state: typeof state };
  return Object.assign(d, over);
}
const job = (f: ReturnType<typeof fixture>): ApplyJob => ({ installDir: f.install, stagedDir: f.staged, parentPid: 1, port: 4747, from: '1.0.0', to: '1.1.0', relaunch: { cmd: 'x', args: [], cwd: f.install }, healthTimeoutMs: 40, parentWaitMs: 40, portFreeMs: 40, swapRetryMs: 10 });

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
