/**
 * The task index (src/core/task-index.ts) behind GET /api/tasks and the slim /api/state, through the real Store.
 * Each test compares the index with a brute-force reference computed from Store.listTasks (the old path), so a drift shows as a diff.
 */
import { tempDir } from './tmp-cleanup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { BadCursorError, decodeCursor, encodeCursor, tokenize } from '../src/core/task-index.js';
import type { Task } from '../src/shared/types.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (n: number) => new Date(T0 + n * 1000).toISOString();
const mk = (id: string, n: number, over: Partial<Task> = {}): Task => ({ id, agentId: 'zealot', title: `task ${id}`, status: 'done', source: 'ui', requestedModel: 'auto', createdAt: iso(n), updatedAt: iso(n), ...over });
const store = () => new Store(tempDir('legion-hist-'), { saveDebounceMs: 5 });

/** Every page of a query, followed through nextCursor. */
function walk(s: Store, q: Parameters<Store['pageTasks']>[0]): string[] {
  const ids: string[] = []; let cursor: string | undefined;
  for (let guard = 0; guard < 10000; guard++) {
    const p = s.pageTasks({ ...q, ...(cursor ? { cursor } : {}) });
    ids.push(...p.tasks.map((t) => t.id));
    if (!p.nextCursor) return ids;
    cursor = p.nextCursor;
  }
  throw new Error('cursor never ended');
}
/** The old way: sort everything, filter. */
const reference = (s: Store, f: (t: Task) => boolean): string[] =>
  s.listTasks(1e9, undefined, true).filter(f).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1)).map((t) => t.id);

test('paging walks the whole history once, newest first, with a total order on equal timestamps', async () => {
  const s = store();
  for (let i = 0; i < 230; i++) s.upsertTask(mk('t' + String(i).padStart(3, '0'), Math.floor(i / 4))); // four tasks share each timestamp
  const all = walk(s, { limit: 50, includeArchived: true });
  assert.equal(all.length, 230);
  assert.equal(new Set(all).size, 230, 'no duplicates');
  assert.deepEqual(all, reference(s, () => true));
  assert.equal(s.pageTasks({ limit: 50, includeArchived: true }).tasks.length, 50);
  assert.equal(s.pageTasks({ includeArchived: true }).tasks.length, 50, 'default page is 50');
  assert.equal(s.pageTasks({ limit: 5000, includeArchived: true }).tasks.length, 100, 'capped at 100');
  assert.equal(s.pageTasks({ limit: 0, includeArchived: true }).tasks.length, 50, 'a nonsense limit falls back to the default');
  await s.flush();
});

test('the index follows create, update and delete: archived, agent, project, title and time changes', async () => {
  const s = store();
  s.upsertTask(mk('a', 1)); s.upsertTask(mk('b', 2, { agentId: 'scout' })); s.upsertTask(mk('c', 3, { projectId: 'p1' }));
  assert.deepEqual(walk(s, { includeArchived: false }), ['c', 'b', 'a']);
  s.upsertTask({ ...s.getTask('a')!, updatedAt: iso(10) });                       // moves to the top
  assert.deepEqual(walk(s, { includeArchived: false }), ['a', 'c', 'b']);
  s.upsertTask({ ...s.getTask('a')!, archived: true });                           // closed: hidden unless asked
  assert.deepEqual(walk(s, { includeArchived: false }), ['c', 'b']);
  assert.deepEqual(walk(s, { includeArchived: true }), ['a', 'c', 'b']);
  s.upsertTask({ ...s.getTask('b')!, agentId: 'zealot' });                         // moved between agents
  assert.deepEqual(walk(s, { agentId: 'scout', includeArchived: true }), []);
  assert.deepEqual(walk(s, { agentId: 'zealot', includeArchived: true }), ['a', 'c', 'b']);
  assert.deepEqual(walk(s, { projectId: 'p1', includeArchived: true }), ['c']);
  s.upsertTask({ ...s.getTask('c')!, title: 'renamed to billing' });
  assert.deepEqual(walk(s, { q: 'task', includeArchived: true }), ['a', 'b'], 'the old title word no longer finds c');
  assert.deepEqual(walk(s, { q: 'billing', includeArchived: true }), ['c']);
  assert.equal(s.deleteTask('c'), true);
  assert.deepEqual(walk(s, { q: 'billing', includeArchived: true }), []);
  assert.deepEqual(walk(s, { includeArchived: true }), ['a', 'b']);
  assert.equal(s.snapshotTasks({ agentIds: ['zealot'], perAgent: 5, recent: 5, includeArchived: true }).length, 2);
  await s.flush();
});

test('a task changed in place and then upserted is moved from its OLD position (no ghost entry)', async () => {
  const s = store();
  for (let i = 0; i < 20; i++) s.upsertTask(mk('t' + i, i));
  const live = s.getTask('t3')!;        // the very object in the store
  live.updatedAt = iso(100); live.status = 'running'; live.title = 'mutated words';
  s.upsertTask(live);
  const all = walk(s, { includeArchived: true });
  assert.equal(all.length, 20); assert.equal(new Set(all).size, 20);
  assert.equal(all[0], 't3');
  assert.deepEqual(walk(s, { q: 'mutated', includeArchived: true }), ['t3']);
  assert.ok(s.snapshotTasks({ agentIds: [], perAgent: 0, recent: 0, includeArchived: true }).some((t) => t.id === 't3'), 'running tasks are always in the snapshot');
  await s.flush();
});

test('recoverInterrupted (which edits tasks in place) keeps the index right', async () => {
  const s = store();
  s.upsertTask(mk('r1', 1, { status: 'running' })); s.upsertTask(mk('d1', 2));
  assert.deepEqual(s.snapshotTasks({ agentIds: [], perAgent: 0, recent: 0, includeArchived: true }).map((t) => t.id), ['r1']);
  assert.equal(s.recoverInterrupted(), 1);
  assert.deepEqual(s.snapshotTasks({ agentIds: [], perAgent: 0, recent: 0, includeArchived: true }).map((t) => t.id), [], 'no longer live');
  assert.equal(walk(s, { includeArchived: true })[0], 'r1', 'its updatedAt moved to now');
  await s.flush();
});

test('a deleted task leaves no ghost: a page is still full and the walk still ends', async () => {
  const s = store();
  for (let i = 0; i < 120; i++) s.upsertTask(mk('t' + String(i).padStart(3, '0'), i));
  s.deleteTask('t119'); s.deleteTask('t100');
  const p = s.pageTasks({ limit: 50, includeArchived: true });
  assert.equal(p.tasks.length, 50, 'a page is full when more exist');
  assert.equal(walk(s, { limit: 50, includeArchived: true }).length, 118);
  await s.flush();
});

test('a reloaded Store rebuilds the same index from state.json', async () => {
  const dir = tempDir('legion-hist-');
  const a = new Store(dir, { saveDebounceMs: 5 });
  for (let i = 0; i < 60; i++) a.upsertTask(mk('t' + i, i % 7, { title: i % 2 ? 'odd billing' : 'even report' }));
  await a.flush();
  const b = new Store(dir);
  assert.deepEqual(walk(b, { includeArchived: true }), walk(a, { includeArchived: true }));
  assert.deepEqual(walk(b, { q: 'bill', includeArchived: true }), walk(a, { q: 'bill', includeArchived: true }));
  assert.equal(walk(b, { q: 'bill', includeArchived: true }).length, 30);
  await b.flush();
});

test('cursor: tasks added, updated or removed between pages cause no duplicate and no gap in what is older than the cursor', async () => {
  const s = store();
  for (let i = 0; i < 120; i++) s.upsertTask(mk('t' + String(i).padStart(3, '0'), i));
  const first = s.pageTasks({ limit: 50, includeArchived: true });
  const seen = first.tasks.map((t) => t.id);
  const olderThanCursor = reference(s, () => true).slice(50);
  // between pages: a brand-new task, an update of an unseen old one, a delete of an unseen one, an update of an already-seen one
  s.upsertTask(mk('new', 500));
  s.upsertTask({ ...s.getTask('t010')!, updatedAt: iso(900) });
  s.deleteTask('t020');
  s.upsertTask({ ...s.getTask(seen[3]!)!, updatedAt: iso(901) });
  const rest: string[] = [];
  let cursor = first.nextCursor;
  while (cursor) { const p = s.pageTasks({ limit: 50, cursor, includeArchived: true }); rest.push(...p.tasks.map((t) => t.id)); cursor = p.nextCursor; }
  assert.equal(new Set([...seen, ...rest]).size, seen.length + rest.length, 'no duplicates');
  // everything that was older than the cursor and still sits there appears exactly once; the moved task jumped above the cursor (SSE carries it)
  const expected = olderThanCursor.filter((id) => id !== 't020' && id !== 't010');
  assert.deepEqual(rest, expected, 'no gaps');
  await s.flush();
});

test('search: every word must match, a word matches the start of a title word or of an agent name, case and punctuation do not matter', async () => {
  const s = store();
  s.upsertTask(mk('a', 1, { title: 'Refactor the Billing-module', agentId: 'builder' }));
  s.upsertTask(mk('b', 2, { title: 'Write docs for billing', agentId: 'scout' }));
  s.upsertTask(mk('c', 3, { title: 'Ændre faktura', agentId: 'builder' }));
  const names = new Map([['builder', 'Builder'], ['scout', 'Scout']]);
  const f = (q: string) => walk(s, { q, includeArchived: true, agentNames: names });
  assert.deepEqual(f('billing'), ['b', 'a']);
  assert.deepEqual(f('BILL'), ['b', 'a'], 'prefix, any case');
  assert.deepEqual(f('refac bill'), ['a'], 'AND');
  assert.deepEqual(f('billing zzz'), []);
  assert.deepEqual(f('scout'), ['b'], 'the agent name finds its tasks');
  assert.deepEqual(f('builder bill'), ['a'], 'agent name AND title word');
  assert.deepEqual(f('ændre'), ['c'], 'non-ASCII letters');
  assert.deepEqual(f('  '), ['c', 'b', 'a'], 'blank query: no filter');
  assert.deepEqual(f('"module"'), ['a'], 'punctuation is ignored');
  assert.deepEqual(tokenize('A-b_c 12'), ['a', 'b', 'c', '12']);
  await s.flush();
});

test('bad cursors are refused, good ones round-trip', () => {
  const s = store();
  s.upsertTask(mk('a', 1));
  for (const bad of ['!!!', 'bm90LWEtY3Vyc29y', Buffer.from('no-separator').toString('base64url'), Buffer.from('|id').toString('base64url'), 'a'.repeat(5000)]) {
    assert.throws(() => s.pageTasks({ cursor: bad }), BadCursorError, bad.slice(0, 20));
  }
  const k = { updatedAt: iso(5), id: 'x|y' };
  assert.deepEqual(decodeCursor(encodeCursor(k)), k);
});

test('20,000 tasks: a page and a search each answer in under 50 ms and return the right rows', async () => {
  const s = store();
  const words = ['refactor', 'billing', 'module', 'flaky', 'test', 'review', 'migrate', 'database', 'docs', 'summarise', 'report', 'pull'];
  const N = 20000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    // updatedAt in a scrambled order, like a real history where old tasks get touched again
    const n = (i * 7919) % N;
    s.upsertTask(mk('t' + String(i).padStart(5, '0'), n, { agentId: ['zealot', 'builder', 'scout', 'a4'][i % 4]!, title: [0, 1, 2].map((k) => words[(i * 5 + k * 3) % words.length]).join(' ') + ' #' + i, ...(i % 5 === 0 ? { archived: true } : {}) }));
  }
  const fill = Date.now() - t0;
  const med = (f: () => unknown) => { f(); const xs: number[] = []; for (let r = 0; r < 7; r++) { const a = performance.now(); f(); xs.push(performance.now() - a); } return xs.sort((x, y) => x - y)[3]!; };
  const pageMs = med(() => s.pageTasks({ limit: 50 }));
  const deepCursor = s.pageTasks({ limit: 100, includeArchived: true }).nextCursor!;
  const deepMs = med(() => s.pageTasks({ limit: 50, cursor: deepCursor, agentId: 'builder' }));
  const searchMs = med(() => s.pageTasks({ limit: 50, q: 'flaky refac' }));
  const rareMs = med(() => s.pageTasks({ limit: 50, q: '19999' }));
  const snapMs = med(() => s.snapshotTasks({ agentIds: ['zealot', 'builder', 'scout', 'a4'], perAgent: 14, recent: 12, includeArchived: false }));
  console.log(`# 20k: fill ${fill} ms, page ${pageMs.toFixed(2)} ms, deep+agent page ${deepMs.toFixed(2)} ms, search ${searchMs.toFixed(2)} ms, rare search ${rareMs.toFixed(2)} ms, snapshot ${snapMs.toFixed(2)} ms`);
  for (const [name, ms] of Object.entries({ pageMs, deepMs, searchMs, rareMs, snapMs })) assert.ok(ms < 50, `${name} took ${ms} ms`);

  const p = s.pageTasks({ limit: 50 });
  assert.equal(p.tasks.length, 50);
  assert.ok(p.tasks.every((t) => !t.archived));
  assert.deepEqual(p.tasks.map((t) => t.id), reference(s, (t) => !t.archived).slice(0, 50));
  const q = s.pageTasks({ limit: 50, q: 'flaky refac' });
  const want = reference(s, (t) => !t.archived && /\bflaky\b/i.test(t.title) && /\brefac/i.test(t.title));
  assert.ok(want.length > 50, 'the query matches many tasks');
  assert.deepEqual(q.tasks.map((t) => t.id), want.slice(0, 50));
  assert.equal(s.pageTasks({ limit: 50, q: '19999', includeArchived: true }).tasks.map((t) => t.id)[0], 't19999');
  await s.flush();
});
