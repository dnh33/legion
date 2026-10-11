/** The relaunch waiter: a detached helper that waits until the old app is really gone (PID-reuse guarded) and only then starts the new build. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWaiter, shouldRelaunch, startWaiter, type WaiterDeps, type WaiterJob, type WaiterOpts, type WaiterRunDeps } from '../src/core/updater/relaunch-waiter.js';

const OLD_PID = 4242;
const OLD_START = 1_700_000_000_000;

// ---- the pure verdict (no processes, no files)
test('W1: shouldRelaunch — the same pid with the same start time is the old app still running (waiting)', () => {
  assert.equal(shouldRelaunch(OLD_PID, OLD_START, () => true, () => OLD_START), 'waiting');
});
test('W2: shouldRelaunch — a dead pid is genuinely gone (ready)', () => {
  assert.equal(shouldRelaunch(OLD_PID, OLD_START, () => false, () => null), 'ready');
});
test('W3: shouldRelaunch — a live pid with a different start time is a recycled pid: effectively gone (ready)', () => {
  assert.equal(shouldRelaunch(OLD_PID, OLD_START, () => true, () => OLD_START + 1), 'ready');
});
test('W4: shouldRelaunch — a live pid whose start time cannot be read is unidentifiable (pid-reused), never assumed gone', () => {
  assert.equal(shouldRelaunch(OLD_PID, OLD_START, () => true, () => null), 'pid-reused');
});

// ---- the parent side
function pdeps(over: Partial<WaiterDeps> = {}): WaiterDeps & { spawned: { script: string; args: string[] }[]; killed: number[] } {
  const d = {
    spawned: [] as { script: string; args: string[] }[],
    killed: [] as number[],
    spawnWaiter: (script: string, args: string[]) => { d.spawned.push({ script, args }); return { pid: 777 }; },
    killPid: (pid: number) => { d.killed.push(pid); },
    isPidAlive: () => false,
    getPidStartTime: () => null,
    fileExists: () => true,
    now: () => 0,
    sleep: async () => undefined,
    log: () => undefined,
  } as WaiterDeps & { spawned: { script: string; args: string[] }[]; killed: number[] };
  return Object.assign(d, over);
}
const OPTS: WaiterOpts = { oldPid: OLD_PID, oldStartTimeMs: OLD_START, newCmd: 'C:/legion/legion.exe', newArgs: ['--updated'], readyFile: 'C:/legion/.update/run/relaunch-ready.pid' };

test('W5: startWaiter — spawns this module as the waiter, confirms on the ready file, returns a cancelable handle', async () => {
  let checks = 0;
  const d = pdeps({ fileExists: () => ++checks >= 3 });
  const r = await startWaiter(d, { ...OPTS, handshakeTimeoutMs: 10_000 });
  if (!r.ok) assert.fail(`expected ok, got: ${r.error}`);
  assert.equal(d.spawned.length, 1, 'exactly one waiter is spawned');
  assert.match(d.spawned[0].script, /relaunch-waiter\.[cm]?js$/, 'the waiter is this module itself');
  assert.deepEqual(JSON.parse(d.spawned[0].args[0]), { oldPid: OLD_PID, oldStartTimeMs: OLD_START, newCmd: OPTS.newCmd, newArgs: OPTS.newArgs, readyFile: OPTS.readyFile }, 'the whole job travels as one JSON argv');
  assert.equal(r.handle.waiterPid, 777);
  assert.deepEqual(d.killed, [], 'a confirmed handshake kills nothing');
});
test('W6: startWaiter — no ready file within the handshake window cancels (kills) the waiter and fails', async () => {
  let t = 0;
  const d = pdeps({ fileExists: () => false, now: () => (t += 5_000) });
  const r = await startWaiter(d, { ...OPTS, handshakeTimeoutMs: 10_000 });
  if (r.ok) assert.fail('expected a failed handshake');
  assert.match(r.error, /confirm/i);
  assert.deepEqual(d.killed, [777], 'the handshake timed out: the waiter is cancelled');
});
test('W7: startWaiter.cancel — kills the waiter', async () => {
  const d = pdeps();
  const r = await startWaiter(d, OPTS);
  if (!r.ok) assert.fail(`expected ok, got: ${r.error}`);
  await r.handle.cancel();
  assert.deepEqual(d.killed, [777]);
});
test('W8: startWaiter — a waiter that cannot be spawned is an error, not a throw', async () => {
  const d = pdeps({ spawnWaiter: (): { pid: number } => { throw new Error('no permission'); } });
  const r = await startWaiter(d, OPTS);
  if (r.ok) assert.fail('expected a spawn failure');
  assert.match(r.error, /no permission/);
  assert.deepEqual(d.killed, [], 'there is nothing to cancel');
});

// ---- the waiter loop
function rdeps(over: Partial<WaiterRunDeps> = {}): WaiterRunDeps & { written: string[]; launched: { cmd: string; args: string[] }[]; calls: string[] } {
  const d = {
    written: [] as string[],
    launched: [] as { cmd: string; args: string[] }[],
    calls: [] as string[],
    writeReady: (p: string) => { d.calls.push('ready'); d.written.push(p); },
    isPidAlive: () => false,
    getPidStartTime: () => null,
    launch: (cmd: string, args: string[]) => { d.calls.push('launch'); d.launched.push({ cmd, args }); return { pid: 999 }; },
    now: () => 0,
    sleep: async () => undefined,
    log: () => undefined,
  } as WaiterRunDeps & { written: string[]; launched: { cmd: string; args: string[] }[]; calls: string[] };
  return Object.assign(d, over);
}
const JOB: WaiterJob = { oldPid: OLD_PID, oldStartTimeMs: OLD_START, newCmd: 'new.exe', newArgs: ['--x'], readyFile: 'ready.pid', maxWaitMs: 900_000, pollMs: 500 };

test('W9: runWaiter — the ready file is written first, then the new build is launched once the old app is dead', async () => {
  let polls = 0;
  const d = rdeps({ isPidAlive: () => ++polls <= 2, getPidStartTime: () => OLD_START });
  assert.equal(await runWaiter(JOB, d), 'relaunched');
  assert.deepEqual(d.written, ['ready.pid']);
  assert.deepEqual(d.launched, [{ cmd: 'new.exe', args: ['--x'] }], 'exactly one launch of the new build');
  assert.equal(d.calls[0], 'ready', 'the handshake file exists before the first poll');
  assert.equal(d.calls.at(-1), 'launch');
});
test('W10: runWaiter — a recycled pid (start-time mismatch) counts as gone: no 900 s wait, the new build starts', async () => {
  const d = rdeps({ isPidAlive: () => true, getPidStartTime: () => OLD_START + 5_000 });
  assert.equal(await runWaiter(JOB, d), 'relaunched');
  assert.deepEqual(d.launched, [{ cmd: 'new.exe', args: ['--x'] }]);
});
test('W11: runWaiter — an unidentifiable alive pid is never assumed gone: at the cap nothing is launched', async () => {
  let t = 0;
  const d = rdeps({ isPidAlive: () => true, getPidStartTime: () => null, now: () => (t += 60_000) });
  assert.equal(await runWaiter(JOB, d), 'gave-up');
  assert.deepEqual(d.launched, [], 'the new build is never started while the old one may be running');
});
test('W12: runWaiter — the old app never exits: give up at the max wait without a relaunch', async () => {
  let t = 0;
  const d = rdeps({ isPidAlive: () => true, getPidStartTime: () => OLD_START, now: () => (t += 60_000) });
  assert.equal(await runWaiter(JOB, d), 'gave-up');
  assert.deepEqual(d.launched, []);
});
test('W13: runWaiter — a launch that fails is reported, never swallowed', async () => {
  const d = rdeps({ launch: (): { pid?: number } | null => { throw new Error('locked'); } });
  assert.equal(await runWaiter(JOB, d), 'launch-failed');
});
