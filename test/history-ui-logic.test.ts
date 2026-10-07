/** The history list's pure logic (ui/src/history/historyLogic.ts): page merging, live events, windowing, status text, what a refresh keeps. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/shared/types.js';
import {
  ROW_H, applyLiveEvent, emptyHistory, historyStatus, keepTasks, mergePage, needsMore, scrollToRow, windowRange, type HistoryState,
} from '../ui/src/history/historyLogic.js';

const t = (id: string, over: Partial<Task> = {}): Task => ({ id, agentId: 'zealot', title: id, status: 'done', source: 'ui', requestedModel: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over });
const ids = (s: HistoryState) => s.rows.map((r) => r.id);

test('mergePage appends, drops a row that is already shown, and replace starts over', () => {
  let s = mergePage(emptyHistory(), { tasks: [t('a'), t('b')], nextCursor: 'c1' }, true);
  assert.deepEqual(ids(s), ['a', 'b']); assert.equal(s.nextCursor, 'c1'); assert.equal(s.loaded, true);
  s = mergePage(s, { tasks: [t('b'), t('c')], nextCursor: null }, false);
  assert.deepEqual(ids(s), ['a', 'b', 'c'], 'b was updated between pages and arrived twice: shown once');
  assert.equal(s.nextCursor, null);
  s = mergePage(s, { tasks: [t('z')], nextCursor: null }, true);
  assert.deepEqual(ids(s), ['z']);
});

test('applyLiveEvent: updates in place, drops deleted and (unless closed ones are shown) closed rows, ignores unknown tasks', () => {
  const s0 = mergePage(emptyHistory(), { tasks: [t('a'), t('b'), t('c')], nextCursor: null }, true);
  const upd = applyLiveEvent(s0, { type: 'task.updated', task: t('b', { title: 'renamed', status: 'running', result: 'long text' }) }, true);
  assert.deepEqual(ids(upd), ['a', 'b', 'c']);
  assert.equal(upd.rows[1]!.title, 'renamed'); assert.equal(upd.rows[1]!.result, undefined, 'the final text is not kept in the list');
  assert.deepEqual(ids(applyLiveEvent(s0, { type: 'task.deleted', taskId: 'a' }, true)), ['b', 'c']);
  assert.deepEqual(ids(applyLiveEvent(s0, { type: 'task.updated', task: t('c', { archived: true }) }, false)), ['a', 'b']);
  assert.deepEqual(ids(applyLiveEvent(s0, { type: 'task.updated', task: t('c', { archived: true }) }, true)), ['a', 'b', 'c']);
  assert.equal(applyLiveEvent(s0, { type: 'task.updated', task: t('nope') }, true), s0, 'a task the list has not loaded changes nothing');
  assert.equal(applyLiveEvent(s0, { type: 'mascot' }, true), s0);
});

test('windowRange draws only what is visible plus a margin, and costs the same at any list length', () => {
  assert.deepEqual(windowRange(0, 240, 10000), { start: 0, end: 8 + 4 });
  const mid = windowRange(ROW_H * 500, 240, 10000);
  assert.equal(mid.start, 496); assert.equal(mid.end, 500 + 8 + 4);
  assert.deepEqual(windowRange(0, 240, 3), { start: 0, end: 3 }, 'a short list is drawn whole');
  assert.deepEqual(windowRange(ROW_H * 9990, 240, 10000), { start: 9986, end: 10000 }, 'clamped at the end');
  assert.deepEqual(windowRange(-50, 240, 100), { start: 0, end: 12 }, 'overscroll bounce');
});

test('needsMore asks for the next page near the end, once, and not while loading, failed, or finished', () => {
  const rows = Array.from({ length: 50 }, (_, i) => t('t' + i));
  const base: HistoryState = { rows, nextCursor: 'c', loading: false, error: null, loaded: true };
  assert.equal(needsMore(base, 12), false, 'far from the end');
  assert.equal(needsMore(base, 40), true);
  assert.equal(needsMore({ ...base, loading: true }, 50), false);
  assert.equal(needsMore({ ...base, error: 'x' }, 50), false, 'no retry loop on an error');
  assert.equal(needsMore({ ...base, nextCursor: null }, 50), false);
});

test('scrollToRow moves the least that shows the row', () => {
  assert.equal(scrollToRow(2, 0, 240), 0);
  assert.equal(scrollToRow(10, 0, 240), 11 * ROW_H - 240);
  assert.equal(scrollToRow(1, 5 * ROW_H, 240), ROW_H);
});

test('historyStatus says what a screen reader needs: loading, error, empty, count, more to come', () => {
  assert.equal(historyStatus(emptyHistory(), ''), 'Loading…');
  assert.match(historyStatus({ ...emptyHistory(), error: 'Cannot reach Legion core' }, ''), /Could not load: Cannot reach/);
  assert.equal(historyStatus({ ...emptyHistory(), loaded: true }, ''), 'No tasks yet.');
  assert.equal(historyStatus({ ...emptyHistory(), loaded: true }, 'zzz'), 'No tasks match.');
  assert.equal(historyStatus({ rows: [t('a')], nextCursor: null, loading: false, error: null, loaded: true }, ''), '1 task');
  assert.equal(historyStatus({ rows: [t('a'), t('b')], nextCursor: 'c', loading: true, error: null, loaded: true }, 'a'), '2+ tasks match, loading more…');
});

test('keepTasks: a refresh keeps the open task (and others asked for) that the slim snapshot left out, without duplicating', () => {
  const prev = [t('open'), t('other'), t('in')];
  const out = keepTasks(prev, [t('in', { title: 'fresh' }), t('new')], new Set(['open', 'in']));
  assert.deepEqual(out.map((x) => x.id), ['in', 'new', 'open']);
  assert.equal(out[0]!.title, 'fresh', 'the snapshot wins for tasks it has');
  assert.deepEqual(keepTasks(prev, [], new Set()).map((x) => x.id), []);
});
