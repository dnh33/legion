/**
 * Pressing Deny on an approval card must not make the agent's bust show "Executing": that reads as "it ran anyway". The call row
 * is stored before the card opens and the denial comes back as a tool result, so both must stop counting as tool activity, for a
 * user Deny and for the timeout's auto-deny alike. An allowed call still counts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastToolAt, moodAfterDecision, noteDenial } from '../ui/src/mascot/toolActivity.js';

const user = { role: 'user', at: '2026-10-06T10:00:00.000Z' };
const call = { role: 'tool', at: '2026-10-06T10:00:01.000Z', toolUseId: 'tu_1' };
const card = { taskId: 'task_1', at: '2026-10-06T10:00:01.005Z' };
const result = (at: string) => ({ role: 'tool', at, resultFor: 'tu_1' });

test('an allowed call counts as tool activity: the call, then its result', () => {
  assert.equal(lastToolAt([user, call]), call.at);
  const denials = noteDenial({}, card, true);
  assert.deepEqual(denials, {});
  assert.equal(lastToolAt([user, call], denials[card.taskId]), call.at);
  assert.equal(lastToolAt([user, call, result('2026-10-06T10:00:03.000Z')], denials[card.taskId]), '2026-10-06T10:00:03.000Z');
});

test('a user Deny: neither the denied call (before its result lands) nor the denial result counts', () => {
  const denials = noteDenial({}, card, false);
  assert.equal(denials[card.taskId], card.at);
  assert.equal(lastToolAt([user, call], denials[card.taskId]), '', 'the gap between Deny and the result');
  assert.equal(lastToolAt([user, call, result('2026-10-06T10:00:02.000Z')], denials[card.taskId]), '', 'the stored denial result');
});

test('the timeout auto-deny (approval.resolved, allowed false) is treated the same way', () => {
  const late = { taskId: 'task_1', at: card.at };
  const denials = noteDenial({ other: '2026-10-06T09:00:00.000Z' }, late, false);
  assert.equal(denials.other, '2026-10-06T09:00:00.000Z', 'other tasks keep their record');
  assert.equal(lastToolAt([user, call, result('2026-10-06T10:10:01.100Z')], denials.task_1), '');
});

test('after a deny, a later call that is allowed counts again', () => {
  const denials = noteDenial({}, card, false);
  const call2 = { role: 'tool', at: '2026-10-06T10:00:09.000Z', toolUseId: 'tu_2' };
  const res2 = { role: 'tool', at: '2026-10-06T10:00:10.000Z', resultFor: 'tu_2' };
  const msgs = [user, call, result('2026-10-06T10:00:02.000Z'), { role: 'assistant', at: '2026-10-06T10:00:08.000Z' }, call2];
  assert.equal(lastToolAt(msgs, denials.task_1), call2.at);
  assert.equal(lastToolAt([...msgs, res2], denials.task_1), res2.at);
});

test('noteDenial keeps the newest denied card and ignores an unknown card', () => {
  const newer = { taskId: 'task_1', at: '2026-10-06T10:05:00.000Z' };
  const d = noteDenial(noteDenial({}, newer, false), card, false);
  assert.equal(d.task_1, newer.at);
  assert.deepEqual(noteDenial({}, undefined, false), {});
});

test('the Relic: Deny moves the shared mood off hacking at once; Allow, a missing card or another mood leave it', () => {
  const hacking = { mood: 'hacking', note: 'Bash', at: 1 };
  const bash = { toolName: 'Bash' };
  assert.deepEqual(moodAfterDecision(hacking, bash, false, 5), { mood: 'thinking', note: 'Bash denied', at: 5 });
  assert.equal(moodAfterDecision(hacking, bash, true, 5), hacking);
  assert.equal(moodAfterDecision(hacking, undefined, false, 5), hacking);
  const success = { mood: 'success', at: 1 };
  assert.equal(moodAfterDecision(success, bash, false, 5), success);
});

test('no tool row last, no activity', () => {
  assert.equal(lastToolAt(undefined), '');
  assert.equal(lastToolAt([]), '');
  assert.equal(lastToolAt([call, { role: 'assistant', at: '2026-10-06T10:00:02.000Z' }]), '');
});
