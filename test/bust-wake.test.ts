/** A resting bust wakes and sleeps through a readiness gate: the still never steps aside before the live bust has painted (no flash). */
import test from 'node:test';
import assert from 'node:assert/strict';
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
