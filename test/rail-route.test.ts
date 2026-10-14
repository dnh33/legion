import test from 'node:test';
import assert from 'node:assert/strict';
import { askTarget, inboxFocusPlan, pickAskCard, proposalsFor, railRowTarget } from '../ui/src/projects/railRoute.js';

test('a proposal row opens that item in its project Inbox', () => {
  assert.deepEqual(railRowTarget({ kind: 'proposal', id: 'wi1', taskId: '', projectId: 'p2' }), { kind: 'inbox', projectId: 'p2', itemId: 'wi1' });
  assert.deepEqual(railRowTarget({ kind: 'proposal', id: 'wi1', taskId: '', projectId: null }), { kind: 'none' });
});
test('an approval or question row opens the thread and names the card', () => {
  assert.deepEqual(railRowTarget({ kind: 'approval', id: 'ap1', taskId: 't9', projectId: 'p2' }), { kind: 'thread', taskId: 't9', askId: 'ap1' });
  assert.deepEqual(railRowTarget({ kind: 'question', id: 'q1', taskId: 't9', projectId: null }), { kind: 'thread', taskId: 't9', askId: 'q1' });
});
test('a row with no task falls back to the project, else nothing', () => {
  assert.deepEqual(railRowTarget({ kind: 'approval', id: 'ap1', taskId: '', projectId: 'p2' }), { kind: 'project', projectId: 'p2' });
  assert.deepEqual(railRowTarget({ kind: 'approval', id: 'ap1', taskId: '', projectId: null }), { kind: 'none' });
});
test('pickAskCard prefers the named card, then the first approval, then the first question', () => {
  const ap = [{ id: 'a1', taskId: 't1' }, { id: 'a2', taskId: 't1' }, { id: 'a3', taskId: 't2' }];
  const qs = [{ id: 'q1', taskId: 't1' }];
  assert.deepEqual(pickAskCard('t1', 'a2', ap, qs), { kind: 'approval', id: 'a2' });
  assert.deepEqual(pickAskCard('t1', 'q1', ap, qs), { kind: 'question', id: 'q1' });
  assert.deepEqual(pickAskCard('t1', 'gone', ap, qs), { kind: 'approval', id: 'a1' });
  assert.deepEqual(pickAskCard('t1', null, [], qs), { kind: 'question', id: 'q1' });
  assert.equal(pickAskCard('t9', 'a1', ap, qs), null);
});
test('inboxFocusPlan: other project ignored, unloaded board waits, found shows, loaded without it is gone', () => {
  const req = { projectId: 'p2', itemId: 'wi1' };
  assert.equal(inboxFocusPlan(null, 'p2', [], true), 'ignore');
  assert.equal(inboxFocusPlan(req, 'p3', [{ id: 'wi1' }], true), 'ignore');
  assert.equal(inboxFocusPlan(req, 'p2', [], false), 'wait');
  assert.equal(inboxFocusPlan(req, 'p2', [{ id: 'wi1' }], true), 'show');
  assert.equal(inboxFocusPlan(req, 'p2', [{ id: 'other' }], true), 'gone');
});

test('askTarget is the one map for every kind of waiting item (rail row, elsewhere row, digest)', () => {
  assert.deepEqual(askTarget({ kind: 'proposal', id: 'wi1', projectId: 'p1' }), { kind: 'inbox', projectId: 'p1', itemId: 'wi1' });
  assert.deepEqual(askTarget({ kind: 'approval', id: 'a1', taskId: 't1', projectId: null }), { kind: 'thread', taskId: 't1', askId: 'a1' });
  assert.deepEqual(askTarget({ kind: 'parked', id: 'k1', taskId: 't2', projectId: 'p1' }), { kind: 'thread', taskId: 't2', askId: 'k1' });
  assert.deepEqual(askTarget({ kind: 'question', id: 'q1', projectId: 'p1' }), { kind: 'project', projectId: 'p1' });
});
test('proposalsFor keeps only the proposals this agent made, oldest first', () => {
  const mk = (id: string, by: { kind: string; id?: string }, at: string) => ({ id, createdAt: at, createdBy: by });
  const list = [mk('b', { kind: 'agent', id: 'forge' }, '2026-10-14T12:00:00Z'), mk('x', { kind: 'agent', id: 'other' }, '2026-10-14T09:00:00Z'), mk('a', { kind: 'agent', id: 'forge' }, '2026-10-14T10:00:00Z'), mk('o', { kind: 'owner' }, '2026-10-14T08:00:00Z')];
  assert.deepEqual(proposalsFor('forge', list).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(proposalsFor('nobody', list), []);
});
