/** The core must be down before any rename (the blank-renderer bug), and exactly one pure judge decides recovery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gracefulTeardown, judgeRecovery, type TeardownDeps, type RecoveryVerdict } from '../src/core/updater/teardown.js';
import type { Journal, JournalState } from '../src/core/updater/apply.js';

const journal = (state: JournalState, to = '1.1.0', from = '1.0.0'): Journal => ({ state, from, to, entries: ['dist', 'package.json'], stagedDir: 'S', at: 1, heartbeat: 2 });

function makeDeps(opts: { running: boolean; exits?: boolean; stopFails?: boolean; waitFails?: boolean }): { deps: TeardownDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: TeardownDeps = {
    isCoreRunning: () => opts.running,
    stopCore: async () => { calls.push('stopCore'); if (opts.stopFails) throw new Error('stopCore exploded'); },
    waitExit: async (ms: number) => { calls.push(`waitExit(${ms})`); if (opts.waitFails) throw new Error('waitExit exploded'); return opts.exits ?? true; },
    log: (msg: string) => { calls.push(`log(${msg})`); },
    sleep: async (ms: number) => { calls.push(`sleep(${ms})`); },
  };
  return { deps, calls };
}

test('T1: gracefulTeardown: core not running — ok at once and nothing is called', async () => {
  const { deps, calls } = makeDeps({ running: false });
  assert.deepEqual(await gracefulTeardown(deps), { ok: true });
  assert.deepEqual(calls, [], 'no stop, no wait, no sleep');
});

test('T2: gracefulTeardown: core running — stopCore first, then waitExit(timeoutMs); an observed exit is ok', async () => {
  const { deps, calls } = makeDeps({ running: true, exits: true });
  assert.deepEqual(await gracefulTeardown(deps, 1234), { ok: true });
  assert.ok(calls.includes('stopCore'), `stopCore was called: ${calls.join(' -> ')}`);
  assert.ok(calls.includes('waitExit(1234)'), 'waitExit gets the caller timeout');
  assert.ok(calls.indexOf('stopCore') < calls.indexOf('waitExit(1234)'), 'the core is asked to stop before its exit is awaited');
});

test('T2b: gracefulTeardown: the default timeout is 5000 ms', async () => {
  const { deps, calls } = makeDeps({ running: true, exits: true });
  await gracefulTeardown(deps);
  assert.ok(calls.includes('waitExit(5000)'));
});

test('T3: gracefulTeardown: the core does not exit in time — ok:false, fail-closed (never swap under it)', async () => {
  const { deps, calls } = makeDeps({ running: true, exits: false });
  const r = await gracefulTeardown(deps, 50);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /did not exit/);
  assert.ok(calls.includes('waitExit(50)'), 'the exit was awaited within the timeout');
});

test('T4: gracefulTeardown: a failing stopCore or waitExit is reported as ok:false with the message', async () => {
  const s = await gracefulTeardown(makeDeps({ running: true, stopFails: true }).deps);
  assert.equal(s.ok, false);
  if (!s.ok) assert.match(s.error, /stopCore exploded/);
  const w = await gracefulTeardown(makeDeps({ running: true, waitFails: true }).deps);
  assert.equal(w.ok, false);
  if (!w.ok) assert.match(w.error, /waitExit exploded/);
});

function assertVerdict(j: Journal | null, running: string, action: RecoveryVerdict['action'], label: string): void {
  const v = judgeRecovery(j, running);
  assert.equal(v.action, action, `${label} (running ${running}): got "${v.reason}"`);
  assert.equal(typeof v.reason, 'string');
  assert.ok(v.reason.length > 0, 'every verdict explains itself');
}

test('J1: judgeRecovery: no journal — clean', () => {
  assertVerdict(null, '1.0.0', 'clean', 'no journal');
});

test('J2: judgeRecovery: swapping — the interrupted swap is swapped back, whatever is running (the journal never confirmed the swap landed)', () => {
  assertVerdict(journal('swapping'), '1.0.0', 'swap-back', 'swapping + mismatch');
  assertVerdict(journal('swapping'), '1.1.0', 'swap-back', 'swapping + match: the entry loop may be half-done, so fail closed');
});

test('J3: judgeRecovery: awaiting-health — the running new build is completed, anything else is swapped back', () => {
  assertVerdict(journal('awaiting-health'), '1.1.0', 'complete', 'awaiting-health + match');
  assertVerdict(journal('awaiting-health'), '1.0.0', 'swap-back', 'awaiting-health + mismatch');
});

test('J4: judgeRecovery: committed — the update is done; clean either way', () => {
  assertVerdict(journal('committed'), '1.1.0', 'clean', 'committed + match');
  assertVerdict(journal('committed'), '1.0.0', 'clean', 'committed + mismatch');
});

test('J5: judgeRecovery: rolled-back is always clean — recovery is idempotent, never re-runs repair', () => {
  assertVerdict(journal('rolled-back'), '1.0.0', 'clean', 'rolled-back + mismatch');
  assertVerdict(journal('rolled-back'), '1.1.0', 'clean', 'rolled-back + match');
});

test('J6: judgeRecovery: an unrecognised state is clean, and the journal is never mutated', () => {
  const j = { ...journal('swapping'), state: 'weird' as JournalState };
  const before = JSON.stringify(j);
  assertVerdict(j, '1.0.0', 'clean', 'unrecognised state');
  assert.equal(JSON.stringify(j), before, 'judgeRecovery is pure: it does not touch the journal');
});
