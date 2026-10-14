import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAsk } from '../ui/src/projects/openAsk.js';

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
test('a ref that names a proposal opens that proposal', () => {
  assert.deepEqual(resolveAsk({ projectId: 'p1', itemId: 'wi-new' }, waiting, ['p1'], props), { kind: 'proposal', projectId: 'p1', itemId: 'wi-new', agentId: 'forge' });
  assert.deepEqual(resolveAsk({ projectId: 'p1', itemId: 'gone' }, [], ['p1'], props), { kind: 'proposal', projectId: 'p1', itemId: 'wi-old', agentId: 'forge' }, 'a proposal that is gone falls back to the oldest one waiting in its project');
});
test('a project-only ref opens the oldest proposal waiting in that project, else the project page', () => {
  assert.deepEqual(resolveAsk({ projectId: 'p1' }, [], ['p1', 'p2'], props), { kind: 'proposal', projectId: 'p1', itemId: 'wi-old', agentId: 'forge' });
  assert.deepEqual(resolveAsk({ projectId: 'p1' }, [{ taskId: 't-a', projectId: 'p1', at: '2026-10-14T07:00:00Z' }], ['p1'], []), { kind: 'project', projectId: 'p1' }, 'only asks: the project page, as before');
  assert.deepEqual(resolveAsk({ projectId: 'p3' }, [], ['p3'], props), { kind: 'project', projectId: 'p3' }, 'nothing waiting there: the project page');
});
test('an empty ref opens the oldest of every ask and proposal', () => {
  assert.deepEqual(resolveAsk({}, [], [], props), { kind: 'proposal', projectId: 'p2', itemId: 'wi-p2', agentId: 'scout' });
  assert.deepEqual(resolveAsk({}, waiting, [], props), { kind: 'proposal', projectId: 'p2', itemId: 'wi-p2', agentId: 'scout' }, 'the proposal (08:00) is older than the oldest ask (10:00)');
  assert.deepEqual(resolveAsk({}, [{ taskId: 't-early', projectId: null, at: '2026-10-14T01:00:00Z' }], [], props), { kind: 'thread', taskId: 't-early' });
});
