/** A resting bust wakes and sleeps through a readiness gate: the still never steps aside before the live bust has painted (no flash). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stillBox } from '../ui/src/mascot/stillsLogic.js';
import { wakeReduce, engineMounted, stillVisible, type WakePhase, type WakeEvent } from '../ui/src/mascot/bustWake.js';

const run = (start: WakePhase, ...evs: WakeEvent[]): WakePhase => evs.reduce(wakeReduce, start);

test('a resting bust has no engine and shows its still', () => {
  assert.equal(engineMounted('still'), false);
  assert.equal(stillVisible('still'), true);
});

test('waking mounts the engine but keeps the still visible until the engine has painted', () => {
  const p = run('still', 'wake');
  assert.equal(p, 'warming');
  assert.equal(engineMounted(p), true);
  assert.equal(stillVisible(p), true);
  assert.equal(stillVisible(run('still', 'wake', 'painted')), false);
});

test('a paint signal at rest or while sleeping changes nothing (no early step-aside)', () => {
  assert.equal(run('still', 'painted'), 'still');
  assert.equal(run('still', 'faded'), 'still');
  assert.equal(run('live', 'faded'), 'live');
});

test('leaving a live bust fades back to the still, and only then drops the engine', () => {
  const p = run('live', 'sleep');
  assert.equal(p, 'sleeping');
  assert.equal(engineMounted(p), true); // the live frame stays until the still is back
  assert.equal(stillVisible(p), true);
  assert.equal(run(p, 'faded'), 'still');
});

test('leaving before the live bust ever showed just drops it: the still was never hidden', () => {
  assert.equal(run('warming', 'sleep'), 'still');
});

test('pointing at the bust again while it fades out keeps the live bust (no remount)', () => {
  assert.equal(run('live', 'sleep', 'wake'), 'live');
  assert.equal(engineMounted(run('live', 'sleep', 'wake')), true);
});

test('the live resting bust is laid out exactly like the still it replaces (same box, scaled)', () => {
  const f = [120, 0, 400, 480]; // the Marshal's rail crop
  const b = stillBox(f, 34);
  // the still was painted with a host of round(400 * 80/480) = 67 by 80 px in an 80 px slot
  assert.equal(b.h, 34);
  assert.ok(Math.abs(b.w - (67 / 80) * 34) < 1e-9);
  assert.ok(Math.abs(stillBox(f, 80).w - 67) < 1e-9 && stillBox(f, 80).h === 80);
  // a wide crop is fitted by width, like the painter does
  const w = stillBox([0, 0, 600, 300], 40);
  assert.ok(Math.abs(w.w - 40) < 1e-9 && Math.abs(w.h - 20) < 1e-9);
});
