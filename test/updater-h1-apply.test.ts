/** H1: recovery waits for a live swap, the swap beats its heartbeat, the marker follows the helper through the re-exec, teardown uses the job's port. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { FULL_PACKAGE_SET, readJournal, recoverAfterLiveSwap, recoverInterrupted, realDeps, runApply, swapIn, swapInFlight, type ApplyDeps, type ApplyJob } from '../src/core/updater/apply.js';

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
const OLD = { 'package.json': '{"version":"1.0.0"}', 'dist/a.js': 'old', 'dist-ui/index.html': 'old-ui', 'node_modules/x/y.js': 'old-dep', 'runtime/electron/electron.exe': 'old-exe' };
const NEW = { 'package.json': '{"version":"1.1.0"}', 'dist/a.js': 'new', 'dist-ui/index.html': 'new-ui', 'node_modules/x/y.js': 'new-dep', 'runtime/electron/electron.exe': 'new-exe' };
function fixture(): { install: string; staged: string } {
  const root = cleanupTemp('h1-apply-');
  const install = join(root, 'install');
  put(install, OLD);
  const staged = join(install, '.update', 'staging', '1.1.0', 'x', 'legion-1.1.0');
  put(staged, NEW);
  return { install, staged };
}
const killAt = (label: string) => (l: string) => { if (l === label) throw Object.assign(new Error(`killed at ${l}`), { kill: true }); };

// ---- item 2: recovery must not race a live swap
test('H1 item 2: a swapping journal with a fresh heartbeat is left alone; a stale one is rolled back', async () => {
  const f = fixture();
  const before = snap(f.install);
  await assert.rejects(swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET, step: killAt('before-install:node_modules') }), /killed at/);
  const j = readJournal(f.install)!;
  assert.equal(j.state, 'swapping');
  const midSwap = snap(f.install);
  assert.notDeepEqual(midSwap, before, 'the swap really is half done');
  assert.equal(swapInFlight(f.install, { nowMs: j.heartbeat + 1000 }), true);
  assert.equal(await recoverInterrupted(f.install, { runningVersion: '1.0.0', nowMs: j.heartbeat + 1000 }), 'none', 'a live helper is mid-swap: do not rename its files back');
  assert.deepEqual(snap(f.install), midSwap, 'nothing moved');
  assert.equal(readJournal(f.install)?.state, 'swapping');
  assert.equal(swapInFlight(f.install, { nowMs: j.heartbeat + 10 * 60_000 }), false);
  assert.equal(await recoverInterrupted(f.install, { runningVersion: '1.0.0', nowMs: j.heartbeat + 10 * 60_000 }), 'rolled-back', 'a helper that stopped beating is dead: recover');
  assert.deepEqual(snap(f.install), before);
});

test('H1 item 2: the swap beats its heartbeat between entries, so a long swap stays fresh', async () => {
  const f = fixture();
  const beats: number[] = [];
  await swapIn({
    installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET,
    step: (l) => {
      if (l === 'journaled') { const end = Date.now() + 8; while (Date.now() < end) { /* make the clock move */ } }
      if (l.startsWith('after-install:')) { beats.push(readJournal(f.install)!.heartbeat); const end = Date.now() + 3; while (Date.now() < end) { /* */ } }
    },
  });
  assert.ok(beats.length >= 5);
  assert.ok(new Set(beats).size >= 3, `the heartbeat moved during the swap: ${beats.join(',')}`);
});

test('H1 item 2: the start waits out a live swap, then recovers once the helper stops beating (never held for long)', async () => {
  const f = fixture();
  const before = snap(f.install);
  await assert.rejects(swapIn({ installDir: f.install, stagedDir: f.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET, step: killAt('before-install:node_modules') }), /killed at/);
  const hb = readJournal(f.install)!.heartbeat;
  let t = hb + 1000; const slept: number[] = [];
  const r = await recoverAfterLiveSwap(f.install, { runningVersion: '1.0.0', now: () => t, sleep: async (ms) => { slept.push(ms); t += 30_000; } });
  assert.equal(r, 'rolled-back');
  assert.ok(slept.length >= 3 && slept.length <= 5, `waited ${slept.length} polls for the lease to lapse`);
  assert.deepEqual(snap(f.install), before);
  // a helper that beats forever does not hold the start beyond the cap, and its swap is still not undone
  const g = fixture();
  await assert.rejects(swapIn({ installDir: g.install, stagedDir: g.staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET, step: killAt('before-install:node_modules') }), /killed at/);
  const mid = snap(g.install);
  let u = readJournal(g.install)!.heartbeat + 1000;
  const r2 = await recoverAfterLiveSwap(g.install, { runningVersion: '1.0.0', now: () => u, maxWaitMs: 10_000, pollMs: 1000, staleMs: 1_000_000, sleep: async () => { u += 1000; } });
  assert.equal(r2, 'none');
  assert.deepEqual(snap(g.install), mid);
});

// ---- item 1/3: the marker follows the helper
type Calls = string[];
function fakeMarker(calls: Calls): NonNullable<ApplyDeps['marker']> {
  return {
    begin: () => { calls.push('begin'); return { ok: true }; },
    adopt: () => { calls.push('adopt'); return { ok: true }; },
    touch: () => { calls.push('touch'); },
    end: () => { calls.push('end'); },
    isInProgress: () => false,
  };
}
function deps(f: { install: string }, over: Partial<ApplyDeps> = {}): ApplyDeps {
  const state = { newUp: false, oldUp: false };
  const d: ApplyDeps = {
    isAlive: () => false,
    health: async () => (state.newUp ? { ok: true, version: '1.1.0' } : state.oldUp ? { ok: true, version: '1.0.0' } : null),
    spawnApp: () => { const swapped = snap(f.install)['package.json']!.includes('1.1.0'); if (swapped) state.newUp = true; else state.oldUp = true; return { pid: 4242 }; },
    killTree: async () => undefined,
    sleep: async () => undefined,
    log: () => undefined,
  };
  return Object.assign(d, over);
}
const job = (f: { install: string; staged: string }): ApplyJob => ({ installDir: f.install, stagedDir: f.staged, parentPid: 1, port: 4747, from: '1.0.0', to: '1.1.0', relaunch: { cmd: 'x', args: [], cwd: f.install }, healthTimeoutMs: 40, parentWaitMs: 40, portFreeMs: 40, swapRetryMs: 10 });

test('H1 item 3: a finished update ends the marker and the helper beat it while it worked', async () => {
  const f = fixture();
  const calls: Calls = [];
  assert.equal(await runApply({ ...job(f), names: FULL_PACKAGE_SET }, deps(f, { marker: fakeMarker(calls) })), 'ok');
  assert.equal(calls[0], process.env.LEGION_APPLY_REEXEC === '1' ? 'adopt' : 'begin');
  assert.ok(calls.includes('touch'), 'the marker heartbeat was refreshed');
  assert.equal(calls[calls.length - 1], 'end');
});

test('H1 item 3: the process started by the re-exec adopts the marker instead of being refused by its own parent', async () => {
  const f = fixture();
  const calls: Calls = [];
  process.env.LEGION_APPLY_REEXEC = '1';
  try { await runApply({ ...job(f), names: FULL_PACKAGE_SET }, deps(f, { marker: fakeMarker(calls) })); } finally { delete process.env.LEGION_APPLY_REEXEC; }
  assert.equal(calls[0], 'adopt');
  assert.ok(!calls.includes('begin'));
});

test('H1 item 3: handing over to the re-exec does NOT end the marker (it must survive the 36 s copy window)', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const calls: Calls = [];
  assert.equal(await runApply({ ...job(f), names: FULL_PACKAGE_SET }, deps(f, { marker: fakeMarker(calls), reExec: () => ({ ok: true }) })), 're-exec');
  assert.deepEqual(calls.filter((c) => c === 'end'), []);
  assert.ok(calls.includes('begin'));
});

test('H1 item 3: every non-ok exit still ends the marker (a failed update must not leave a marker that blocks the next start)', async () => {
  const f = fixture();
  const calls: Calls = [];
  const r = await runApply({ ...job(f), names: FULL_PACKAGE_SET }, deps(f, { marker: fakeMarker(calls), isAlive: () => true }));
  assert.equal(r, 'failed');
  assert.equal(calls[calls.length - 1], 'end');
});

// ---- item 5: the job's port
test('H1 item 5: gracefulTeardown watches the job port, not 4747', async () => {
  const hits: string[] = [];
  const srv: Server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.statusCode = 200; res.end('{"ok":true}'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const d = realDeps(cleanupTemp('h1-port-'), { port });
    const r = await d.gracefulTeardown!(600);
    assert.equal(r.ok, false, 'a core still answers on the job port: not safe to swap');
    assert.ok(hits.some((h) => h.startsWith('GET /health')), 'health was asked on the job port');
  } finally { await new Promise<void>((r) => srv.close(() => r())); }
  const gone = await realDeps(cleanupTemp('h1-port-'), { port }).gracefulTeardown!(600);
  assert.equal(gone.ok, true, 'nothing answers on the job port any more');
});
