/**
 * GET /api/tasks (the history list's pages and search) and GET /api/state?slim=1, over real HTTP with a REAL Store (the shared fake store has no index).
 * The visibility tests are the important ones: a hidden agent (requires: 'bsv' while BSV mode is off) must be in no page, no search and no snapshot,
 * and asking for it by id must answer exactly like an id that never existed.
 */
import { tempDir } from './tmp-cleanup.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { asClient, AUTH, makeFakes, mkAgent, start } from './helpers-c.js';
import type { Task } from '../src/shared/types.js';

const T0 = Date.parse('2026-02-01T00:00:00Z');
const iso = (n: number) => new Date(T0 + n * 1000).toISOString();
const mk = (id: string, n: number, over: Partial<Task> = {}): Task => ({ id, agentId: 'zealot', title: `task ${id}`, status: 'done', source: 'ui', requestedModel: 'auto', createdAt: iso(n), updatedAt: iso(n), result: 'FINAL TEXT ' + id, ...over });

describe('history pages over HTTP', () => {
  const f = makeFakes();
  const store = new Store(tempDir('legion-histhttp-'), { saveDebounceMs: 5 });
  let base = ''; let close: () => Promise<void>;
  const get = (path: string, headers: Record<string, string> = AUTH) => fetch(base + path, { headers });
  const page = async (qs: string) => (await (await get('/api/tasks?' + qs)).json()) as { tasks: Task[]; nextCursor: string | null };
  const ids = async (qs: string) => (await page(qs)).tasks.map((t) => t.id);

  before(async () => {
    (f.ctx as { store: unknown }).store = store;
    for (const a of [mkAgent('zealot', 'Zealot'), mkAgent('scout', 'Scout'), { ...mkAgent('assayer', 'Assayer'), requires: 'bsv' as const }]) store.upsertAgent(a);
    for (let i = 0; i < 130; i++) store.upsertTask(mk('z' + String(i).padStart(3, '0'), i, { title: i % 10 === 0 ? `ship the billing report ${i}` : `routine ${i}` }));
    for (let i = 0; i < 20; i++) store.upsertTask(mk('s' + String(i).padStart(2, '0'), 200 + i, { agentId: 'scout', title: `scout note ${i}` }));
    // the hidden agent: newer than everything, with title words and an agent name a visible user might search for
    for (let i = 0; i < 25; i++) store.upsertTask(mk('x' + String(i).padStart(2, '0'), 500 + i, { agentId: 'assayer', title: `secret wallet audit ${i} billing`, ...(i % 2 ? { archived: true } : {}) }));
    store.upsertTask(mk('run1', 1, { status: 'running' }));
    store.upsertTask(mk('arch1', 2, { archived: true, title: 'old closed thing' }));
    const s = await start(f.ctx); base = s.base; close = s.close;
  });
  after(async () => { await close(); await store.flush(); });

  it('pages newest first, defaults to 50, caps at 100, follows nextCursor to the end with no repeats', async () => {
    const first = await page('');
    assert.equal(first.tasks.length, 50);
    assert.ok(first.nextCursor);
    assert.equal(first.tasks[0]!.id, 's19', 'newest visible first (the hidden agent is newer and absent)');
    assert.equal((await page('limit=1000')).tasks.length, 100);
    assert.equal((await page('limit=abc')).tasks.length, 50);
    const seen: string[] = []; let cursor: string | null = '';
    while (cursor !== null) { const p = await page(`limit=40${cursor ? '&cursor=' + cursor : ''}`); seen.push(...p.tasks.map((t) => t.id)); cursor = p.nextCursor; }
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 130 + 20 + 1, 'visible, open tasks only (closed and hidden-agent ones are not in it)');
    assert.ok(!seen.includes('arch1'));
  });

  it('rows carry no final text, and archived=1 includes closed tasks', async () => {
    const p = await page('limit=100');
    assert.ok(p.tasks.every((t) => t.result === undefined));
    assert.ok((await ids('archived=1&q=closed')).includes('arch1'));
    assert.ok(!(await ids('q=closed')).includes('arch1'));
  });

  it('filters by agent and by search text (title words by prefix, and the agent name)', async () => {
    assert.ok((await ids('agentId=scout&limit=100')).every((id) => id.startsWith('s')));
    const billing = await ids('q=billing&limit=100');
    assert.deepEqual(billing, ['z120', 'z110', 'z100', 'z090', 'z080', 'z070', 'z060', 'z050', 'z040', 'z030', 'z020', 'z010', 'z000']);
    assert.deepEqual(await ids('q=bill%20repo&limit=100'), billing, 'two words, both prefixes');
    assert.equal((await ids('q=scout&limit=100')).length, 20, 'the agent name matches all of its tasks');
    assert.deepEqual(await ids('q=zzzz'), []);
  });

  it('a hidden agent\'s tasks are in no page, no search, no agent filter and no snapshot', async () => {
    const everything: string[] = []; let cursor: string | null = '';
    while (cursor !== null) { const p = await page(`archived=1&limit=100${cursor ? '&cursor=' + cursor : ''}`); everything.push(...p.tasks.map((t) => t.id)); cursor = p.nextCursor; }
    assert.ok(everything.length > 100);
    assert.ok(!everything.some((id) => id.startsWith('x')), 'no hidden task in any page');
    for (const q of ['secret', 'wallet', 'audit', 'assayer', 'secret%20wallet%20billing']) assert.deepEqual(await ids(`q=${q}&archived=1`), [], `search "${q}" finds nothing of the hidden agent`);
    assert.ok(!(await ids('q=billing&archived=1&limit=100')).some((id) => id.startsWith('x')), 'a word that hidden titles share still returns only visible tasks');
    const snap: any = await (await get('/api/state?slim=1&archived=1')).json();
    assert.ok(!snap.tasks.some((t: Task) => t.agentId === 'assayer'));
    const full: any = await (await get('/api/state')).json();
    assert.ok(!full.tasks.some((t: Task) => t.agentId === 'assayer'));
  });

  it('asking for a hidden agent answers exactly like an agent id that never existed', async () => {
    const hidden = await (await get('/api/tasks?agentId=assayer&archived=1')).text();
    const never = await (await get('/api/tasks?agentId=nobody-here&archived=1')).text();
    assert.equal(hidden, never);
    assert.deepEqual(JSON.parse(hidden), { tasks: [], nextCursor: null });
    const hiddenSearch = await (await get('/api/tasks?agentId=assayer&q=secret&archived=1')).text();
    assert.equal(hiddenSearch, never);
  });

  it('a bad cursor is a 400, and the route is admin-only (a token-only client is refused)', async () => {
    const bad = await get('/api/tasks?cursor=not-a-cursor');
    assert.equal(bad.status, 400);
    const client = await get('/api/tasks', asClient);
    assert.equal(client.status, 403);
    assert.equal((await fetch(base + '/api/tasks')).status, 401);
  });

  it('/api/state?slim=1 keeps running tasks and a bounded newest set; plain /api/state is unchanged (newest 200)', async () => {
    const slim: any = await (await get('/api/state?slim=1')).json();
    const sIds = (slim.tasks as Task[]).map((t) => t.id);
    assert.ok(sIds.includes('run1'), 'a running task is always in the snapshot, however old');
    assert.ok(sIds.length < 60, `slim snapshot is small (${sIds.length})`);
    assert.ok((slim.tasks as Task[]).every((t) => t.result === undefined && !t.archived));
    assert.equal(sIds[0], 's19');
    // tabs show the newest 12 by creation of each agent: all of them are there
    for (let i = 129; i > 129 - 12; i--) assert.ok(sIds.includes('z' + String(i).padStart(3, '0')));
    const full: any = await (await get('/api/state')).json();
    assert.equal((full.tasks as Task[]).length, 151, 'all visible open tasks (fewer than 200)');
    assert.ok((full.tasks as Task[]).every((t) => t.result === undefined));
  });
});
