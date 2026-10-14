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
