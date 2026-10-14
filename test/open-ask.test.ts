import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_QUEUE_MS, fallsToOldest, queuedAskStep, resolveAsk, unloadedBoards } from '../ui/src/projects/openAsk.js';

const waiting = [
  { taskId: 't-old', projectId: 'p1', at: '2026-10-14T10:00:00Z' },
  { taskId: 't-new', projectId: 'p2', at: '2026-10-14T11:00:00Z' },
];

test('a ref with a task opens that thread', () => {
  assert.deepEqual(resolveAsk({ projectId: 'p1', taskId: 't-x' }, waiting, ['p1']), { kind: 'thread', taskId: 't-x' });
});
test('a ref with only a project opens that project page; an unknown project falls back to the oldest waiting ask', () => {
  assert.deepEqual(resolveAsk({ projectId: 'p1' }, waiting, ['p1']), { kind: 'project', projectId: 'p1' });
  assert.deepEqual(resolveAsk({ projectId: 'gone' }, waiting, ['p1']), { kind: 'thread', taskId: 't-old' });
});
test('an empty ref (tray item, summary) opens the oldest ask waiting; with none waiting it only shows the window', () => {
  assert.deepEqual(resolveAsk({}, waiting, []), { kind: 'thread', taskId: 't-old' });
  assert.deepEqual(resolveAsk({}, [], []), { kind: 'none' });
});
test('a ref that is not an object, or carries odd values, is treated as empty', () => {
  assert.deepEqual(resolveAsk(null as never, waiting, []), { kind: 'thread', taskId: 't-old' });
  assert.deepEqual(resolveAsk({ taskId: 7, projectId: {} } as never, waiting, []), { kind: 'thread', taskId: 't-old' });
});

const props = [
  { id: 'wi-new', projectId: 'p1', agentId: 'forge', createdAt: '2026-10-14T12:00:00Z' },
  { id: 'wi-old', projectId: 'p1', agentId: 'forge', createdAt: '2026-10-14T09:00:00Z' },
  { id: 'wi-p2', projectId: 'p2', agentId: 'scout', createdAt: '2026-10-14T08:00:00Z' },
];
test('a ref that carries an itemId opens that proposal from the ids alone, board loaded or not', () => {
  assert.deepEqual(resolveAsk({ projectId: 'p1', itemId: 'wi-new', agentId: 'forge' }, waiting, ['p1'], []), { kind: 'proposal', projectId: 'p1', itemId: 'wi-new', agentId: 'forge' }, 'cold start: nothing loaded');
  assert.deepEqual(resolveAsk({ projectId: 'p1', itemId: 'wi-new' }, waiting, ['p1'], props), { kind: 'proposal', projectId: 'p1', itemId: 'wi-new', agentId: 'forge' }, 'an older core: the agent comes from the loaded Inbox');
  assert.deepEqual(resolveAsk({ projectId: 'p1', itemId: 'wi-new' }, [], ['p1'], []), { kind: 'proposal', projectId: 'p1', itemId: 'wi-new', agentId: '' }, 'no agent known: the Inbox entry');
});
test('a proposal that is gone is not swapped for another one: the same proposal action, so the chat says it was handled', () => {
  assert.deepEqual(resolveAsk({ projectId: 'p1', itemId: 'gone', agentId: 'forge' }, [], ['p1'], props), { kind: 'proposal', projectId: 'p1', itemId: 'gone', agentId: 'forge' });
});
test('a project-only ref (every notification kind) opens the project page, never a proposal', () => {
  // "N things need you in P", "N runs failed in P", "N runs finished in P" and "Budget reached in P" all send only {projectId}
  for (const kind of ['things need you', 'runs failed', 'runs finished', 'budget reached']) {
    assert.deepEqual(resolveAsk({ projectId: 'p1' }, [], ['p1', 'p2'], props), { kind: 'project', projectId: 'p1' }, kind);
  }
  assert.deepEqual(resolveAsk({ projectId: 'p1' }, [{ taskId: 't-a', projectId: 'p1', at: '2026-10-14T07:00:00Z' }], ['p1'], props), { kind: 'project', projectId: 'p1' });
  assert.deepEqual(resolveAsk({ projectId: 'gone' }, [], ['p1'], []), { kind: 'none' });
});
test('an empty ref opens the oldest of every ask and proposal', () => {
  assert.deepEqual(resolveAsk({}, [], [], props), { kind: 'proposal', projectId: 'p2', itemId: 'wi-p2', agentId: 'scout' });
  assert.deepEqual(resolveAsk({}, waiting, [], props), { kind: 'proposal', projectId: 'p2', itemId: 'wi-p2', agentId: 'scout' }, 'the proposal (08:00) is older than the oldest ask (10:00)');
  assert.deepEqual(resolveAsk({}, [{ taskId: 't-early', projectId: null, at: '2026-10-14T01:00:00Z' }], [], props), { kind: 'thread', taskId: 't-early' });
});

test('queuedAskStep: a click before the window has loaded waits, runs once loaded, and gives up after 15 s', () => {
  assert.equal(ASK_QUEUE_MS, 15_000);
  assert.equal(queuedAskStep(null, false, 1000), 'none');
  assert.equal(queuedAskStep(null, true, 1000), 'none');
  assert.equal(queuedAskStep(1000, false, 1000), 'wait');
  assert.equal(queuedAskStep(1000, false, 1000 + ASK_QUEUE_MS - 1), 'wait');
  assert.equal(queuedAskStep(1000, true, 2000), 'run');
  assert.equal(queuedAskStep(1000, false, 1000 + ASK_QUEUE_MS), 'expired');
  assert.equal(queuedAskStep(1000, true, 1000 + ASK_QUEUE_MS + 5), 'run', 'loaded just in time still runs');
});

test('round 4: a queued click is cancelled when the owner navigated by hand before it ran', () => {
  assert.equal(queuedAskStep(1000, true, 2000, 4, 4), 'run', 'no navigation: runs');
  assert.equal(queuedAskStep(1000, true, 2000, 4, 5), 'cancelled', 'the owner moved: the stale click does not yank them back');
  assert.equal(queuedAskStep(1000, false, 2000, 4, 5), 'cancelled', 'cancelled even before the window is ready');
  assert.equal(queuedAskStep(1000, false, 1000 + ASK_QUEUE_MS, 4, 5), 'cancelled', 'cancel wins over the expiry toast (nothing to apologise for)');
  assert.equal(queuedAskStep(null, true, 2000, 4, 5), 'none');
});

test('round 4: a ref that falls through to "the oldest anywhere" is told apart from one that names something', () => {
  assert.equal(fallsToOldest({}, ['p1']), true);
  assert.equal(fallsToOldest(null, ['p1']), true);
  assert.equal(fallsToOldest({ projectId: 'gone' }, ['p1']), true, 'an unknown project falls through as resolveAsk does');
  assert.equal(fallsToOldest({ projectId: 'p1' }, ['p1']), false);
  assert.equal(fallsToOldest({ taskId: 't1' }, []), false);
});

test('round 4: only active projects whose board has not loaded are fetched before routing the oldest', () => {
  assert.deepEqual(unloadedBoards([{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }, { id: 'c', status: 'archived' }], { a: {} }), ['b']);
  assert.deepEqual(unloadedBoards([], {}), []);
});
