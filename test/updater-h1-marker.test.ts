/** H1: the update marker is a lease (heartbeat), the helper writes it for real, and a start waits for a live one without ever waiting forever. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER_LEASE_MS, MARKER_MAX_MS, fileMarker, markerLeaseState } from '../src/core/updater/apply.js';
import { MARKER_FILE_NAME, isUpdateInProgress, judgeMarker, type MarkerDeps, type UpdateMarker } from '../src/core/updater/update-marker.js';
import { holdStartForUpdate } from '../src/core/updater/start-gate.js';
import { buildJob } from '../src/core/updater/main-logic.js';

const NOW = 10_000_000;
const m = (over: Partial<UpdateMarker> = {}): UpdateMarker => ({ pid: 4242, startTimeMs: 555, fromVersion: '1.0.0', toVersion: '1.1.0', startedAt: NOW - 60_000, heartbeat: NOW - 1000, ...over });

test('markerLeaseState: leased inside the lease, lapsed after it, capped after the hard cap whatever the heartbeat says', () => {
  assert.equal(markerLeaseState({ startedAt: NOW - 5000, heartbeat: NOW - 1000 }, NOW), 'leased');
  assert.equal(markerLeaseState({ startedAt: NOW - 5000, heartbeat: NOW - MARKER_LEASE_MS - 1 }, NOW), 'lapsed');
  assert.equal(markerLeaseState({ startedAt: NOW - MARKER_MAX_MS - 1, heartbeat: NOW - 1 }, NOW), 'capped');
  assert.equal(markerLeaseState({ startedAt: NOW - 5000 }, NOW), 'lapsed', 'no heartbeat recorded: no lease');
});

test('judgeMarker with a heartbeat: the lease keeps a chain of helper processes live; a lapsed lease and a dead pid does not', () => {
  const clock = { nowMs: NOW };
  assert.equal(judgeMarker(m(), { pidAlive: false, pidStartTimeMs: null }, clock).status, 'active', 'owner pid gone (the first helper exited at the re-exec) but the lease is fresh');
  const lapsed = m({ heartbeat: NOW - MARKER_LEASE_MS - 1 });
  assert.deepEqual(judgeMarker(lapsed, { pidAlive: false, pidStartTimeMs: null }, clock), { status: 'stale', marker: lapsed, reason: 'dead-pid' });
  assert.equal(judgeMarker(lapsed, { pidAlive: true, pidStartTimeMs: 555 }, clock).status, 'active', 'a lapsed lease but the process is still there');
  assert.equal(judgeMarker(m(), { pidAlive: true, pidStartTimeMs: 777 }, clock).status, 'active', 'a helper-written start time is advisory while the lease is fresh');
  const capped = judgeMarker(m({ startedAt: NOW - MARKER_MAX_MS - 1 }), { pidAlive: true, pidStartTimeMs: 555 }, clock);
  assert.equal(capped.status, 'stale');
  assert.equal((capped as { reason: string }).reason, 'expired', 'an orphaned marker never blocks forever, even with a live pid and a fresh beat');
});

test('judgeMarker without a clock or without a heartbeat keeps the old pid rule', () => {
  const old = m(); delete old.heartbeat;
  assert.equal(judgeMarker(old, { pidAlive: false, pidStartTimeMs: null }, { nowMs: NOW }).status, 'stale');
  assert.equal(judgeMarker(m(), { pidAlive: false, pidStartTimeMs: null }).status, 'stale');
});

function deps(files: Map<string, string>, over: { now?: () => number; alive?: boolean } = {}): MarkerDeps {
  return {
    markerPath: '/m.json', now: over.now ?? (() => NOW), isPidAlive: () => over.alive ?? false, getPidStartTime: () => null,
    createExclusive: (p, c) => { if (files.has(p)) throw new Error('EEXIST'); files.set(p, c); },
    read: (p) => files.get(p) ?? null, remove: (p) => { files.delete(p); }, log: () => undefined,
  };
}
test('isUpdateInProgress reads the lease: a fresh beat from a dead owner is in progress; a lapsed one is stale', () => {
  const files = new Map([['/m.json', JSON.stringify(m())]]);
  assert.equal(isUpdateInProgress(deps(files)).inProgress, true);
  const lapsed = new Map([['/m.json', JSON.stringify(m({ heartbeat: NOW - MARKER_LEASE_MS - 5 }))]]);
  const r = isUpdateInProgress(deps(lapsed));
  assert.equal(r.inProgress, false);
  assert.equal(r.stale, true);
});

// ---- the helper's own file marker (apply.ts is node-only, so it cannot import update-marker.ts)
test('fileMarker: begin writes the lease, the app-side judge reads it, touch keeps startedAt, end removes it', () => {
  const root = cleanupTemp('h1-marker-');
  let t = NOW;
  const fm = fileMarker(root, { now: () => t, isAlive: () => false });
  const file = join(root, '.update', MARKER_FILE_NAME);
  assert.deepEqual(fm.begin({ fromVersion: '1.0.0', toVersion: '1.1.0' }), { ok: true });
  const first = JSON.parse(readFileSync(file, 'utf8')) as UpdateMarker;
  assert.equal(first.pid, process.pid); assert.equal(first.startedAt, NOW); assert.equal(first.heartbeat, NOW);
  const appSide = (): boolean => isUpdateInProgress({ markerPath: file, now: () => t, isPidAlive: () => false, getPidStartTime: () => null, createExclusive: () => undefined, read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null), remove: () => undefined, log: () => undefined }).inProgress;
  assert.equal(appSide(), true);
  t = NOW + 90_000; fm.touch!();
  const second = JSON.parse(readFileSync(file, 'utf8')) as UpdateMarker;
  assert.equal(second.startedAt, NOW); assert.equal(second.heartbeat, NOW + 90_000);
  t = NOW + 90_000 + MARKER_LEASE_MS - 1; assert.equal(appSide(), true, 'the beat at +90 s still holds');
  t = NOW + 90_000 + MARKER_LEASE_MS + 1; assert.equal(appSide(), false, 'no beat for a lease: the owner is gone');
  assert.equal(fm.isInProgress(), false);
  fm.end();
  assert.equal(existsSync(file), false);
});

test('fileMarker: a live marker of another update refuses begin; a lapsed one is reclaimed', () => {
  const root = cleanupTemp('h1-marker-');
  const a = fileMarker(root, { now: () => NOW, isAlive: () => true });
  assert.deepEqual(a.begin({ fromVersion: '1.0.0', toVersion: '1.1.0' }), { ok: true });
  const b = fileMarker(root, { now: () => NOW + 1000, isAlive: () => true });
  assert.equal(b.begin({ fromVersion: '1.0.0', toVersion: '1.2.0' }).ok, false);
  const late = fileMarker(root, { now: () => NOW + MARKER_LEASE_MS + 5, isAlive: () => false });
  assert.deepEqual(late.begin({ fromVersion: '1.0.0', toVersion: '1.2.0' }), { ok: true });
});

test('fileMarker: adopt hands the marker to the re-exec process (same target), keeps startedAt, and refuses another update that is live', () => {
  const root = cleanupTemp('h1-marker-');
  const file = join(root, '.update', MARKER_FILE_NAME);
  mkdirSync(join(root, '.update'), { recursive: true });
  writeFileSync(file, JSON.stringify(m({ pid: 999_999, startedAt: NOW - 30_000, heartbeat: NOW - 2000 })));
  const fm = fileMarker(root, { now: () => NOW, isAlive: () => true });
  assert.deepEqual(fm.adopt!({ fromVersion: '1.0.0', toVersion: '1.1.0' }), { ok: true });
  const after = JSON.parse(readFileSync(file, 'utf8')) as UpdateMarker;
  assert.equal(after.pid, process.pid); assert.equal(after.startedAt, NOW - 30_000); assert.equal(after.heartbeat, NOW);
  assert.equal(fm.adopt!({ fromVersion: '1.0.0', toVersion: '9.9.9' }).ok, false, 'a live marker for a different target is not ours');
  const none = cleanupTemp('h1-marker-');
  assert.deepEqual(fileMarker(none, { now: () => NOW }).adopt!({ fromVersion: '1.0.0', toVersion: '1.1.0' }), { ok: true }, 'started straight from the prepared copy: nothing to adopt, the marker is created');
});

// ---- the start gate
const gateBase = (script: Array<'live' | 'clear' | 'stale'>) => {
  const log: string[] = []; let i = 0; let t = 0; let cleared = 0; let waits = 0; const slept: number[] = [];
  return {
    log, get cleared() { return cleared; }, get waits() { return waits; }, slept,
    opts: {
      check: () => { const s = script[Math.min(i++, script.length - 1)]; return s === 'live' ? { inProgress: true, marker: m() } : s === 'stale' ? { inProgress: false, stale: true, marker: m() } : { inProgress: false }; },
      sleep: async (ms: number) => { slept.push(ms); t += ms; }, now: () => t,
      clearStale: () => { cleared++; }, log: (l: string) => log.push(l), onWait: () => { waits++; },
    },
  };
};
test('holdStartForUpdate: no marker means no wait and no window', async () => {
  const g = gateBase(['clear']);
  const r = await holdStartForUpdate(g.opts);
  assert.equal(r.result, 'clear'); assert.equal(r.waited, false); assert.equal(g.waits, 0);
});
test('holdStartForUpdate: a live marker holds the start (window shown once) until it clears', async () => {
  const g = gateBase(['live', 'live', 'live', 'clear']);
  const r = await holdStartForUpdate(g.opts);
  assert.equal(r.result, 'clear'); assert.equal(r.waited, true); assert.equal(g.waits, 1);
  assert.equal(g.slept.length, 3);
});
test('holdStartForUpdate: a marker that goes stale while waiting is cleared, logged, and the start goes on', async () => {
  const g = gateBase(['live', 'stale']);
  const r = await holdStartForUpdate(g.opts);
  assert.equal(r.result, 'stale'); assert.equal(g.cleared, 1);
  assert.ok(g.log.some((l) => /stale/.test(l)));
});
test('holdStartForUpdate: an orphaned marker found at start (stale) is cleared and does not hold', async () => {
  const g = gateBase(['stale']);
  const r = await holdStartForUpdate(g.opts);
  assert.equal(r.waited, false); assert.equal(r.result, 'stale'); assert.equal(g.cleared, 1);
});
test('holdStartForUpdate: never waits forever: a marker that stays live is given up on at the hard cap, and that is logged', async () => {
  const g = gateBase(['live']);
  const r = await holdStartForUpdate({ ...g.opts, capMs: 10_000, pollMs: 1000 });
  assert.equal(r.result, 'capped'); assert.equal(r.waited, true);
  assert.ok(g.slept.length <= 11);
  assert.ok(g.log.some((l) => /cap/.test(l)));
});
test("holdStartForUpdate: the helper's own relaunch (handoff) is never held by its own marker", async () => {
  const g = gateBase(['live']);
  const r = await holdStartForUpdate({ ...g.opts, handoff: true });
  assert.equal(r.result, 'handoff'); assert.equal(g.waits, 0); assert.equal(g.slept.length, 0);
});

test("buildJob sets the handoff variable on the relaunch, so the new build is not held by the helper's marker", () => {
  const j = buildJob({ installDir: 'C:/i', stagedDir: 'C:/i/.update/staging/x', from: '1', to: '2' }, { parentPid: 1, port: 4747, execPath: 'C:/i/runtime/electron/electron.exe' });
  assert.equal(j.relaunch.env?.LEGION_UPDATE_HANDOFF, '1');
});
