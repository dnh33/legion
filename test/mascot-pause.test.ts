/**
 * A task paused at the turn limit must not make the mascots show a fault: the Paused card says the work is kept, and a bust
 * playing "Fault detected" (or the Relic flashing it) would say the opposite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { latestFinished } from '../ui/src/mascot/finished.js';
import { TURN_LIMIT_PREFIX } from '../src/shared/continue.js';

const paused = { agentId: 'a1', status: 'error', error: `${TURN_LIMIT_PREFIX} (200 turns this run) before finishing.`, updatedAt: '2026-10-05T20:00:02Z' };

test('the bust does not count a turn-limit pause as a failed task', () => {
  assert.equal(latestFinished([paused], 'a1'), '');
  // an older real finish is still what counts, so a pause never turns a recent victory into a fault
  assert.equal(latestFinished([{ agentId: 'a1', status: 'done', updatedAt: '2026-10-05T20:00:00Z' }, paused], 'a1'), 'done|2026-10-05T20:00:00Z');
});

test('a real error still shows as a fault, and other agents\' tasks are ignored', () => {
  const failed = { agentId: 'a1', status: 'error', error: 'Invalid API key', updatedAt: '2026-10-05T20:00:03Z' };
  assert.equal(latestFinished([paused, failed], 'a1'), 'error|2026-10-05T20:00:03Z');
  assert.equal(latestFinished([failed], 'a2'), '');
});
