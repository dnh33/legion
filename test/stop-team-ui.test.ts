import test from 'node:test';
import assert from 'node:assert/strict';
import { startedLive, stopTeamLabel } from '../ui/src/chat/team.js';
import type { Task } from '../src/shared/types.js';

const t = (id: string, status: Task['status'], parentTaskId?: string): Task => ({ id, status, ...(parentTaskId ? { parentTaskId } : {}) } as Task);

test('startedLive: the live tasks a task started, through the ones it started, never itself or other branches', () => {
  const tasks = [t('lead', 'running'), t('a', 'running', 'lead'), t('b', 'done', 'lead'), t('a1', 'queued', 'a'), t('b1', 'running', 'b'), t('other', 'running'), t('o1', 'running', 'other')];
  assert.deepEqual(startedLive(tasks, 'lead').map((x) => x.id).sort(), ['a', 'a1', 'b1']);
  assert.deepEqual(startedLive(tasks, 'other').map((x) => x.id), ['o1']);
  assert.deepEqual(startedLive(tasks, 'a1'), []);
});

test('startedLive survives a parent loop', () => {
  assert.deepEqual(startedLive([t('x', 'running', 'y'), t('y', 'running', 'x')], 'x').map((q) => q.id), ['y']);
});

test('stopTeamLabel counts in plain words', () => {
  assert.equal(stopTeamLabel(2), 'Stop this and the 2 tasks it started');
  assert.equal(stopTeamLabel(1), 'Stop this and the 1 task it started');
});
