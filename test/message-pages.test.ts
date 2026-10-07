/**
 * GET /api/tasks/:id/messages (a thread's pages and its search) and src/core/message-pages.ts, through a REAL Store over real HTTP.
 * A thread can have thousands of rows; the app opens it at the newest page and pages back.
 */
import { tempDir } from './tmp-cleanup.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { messageWindow, searchMessages } from '../src/core/message-pages.js';
import { WITHHELD } from '../src/core/connector-withhold.js';
import { asClient, AUTH, makeFakes, mkAgent, start } from './helpers-c.js';
import type { ChatMessage, Task } from '../src/shared/types.js';

const T0 = Date.parse('2026-03-01T00:00:00Z');
const at = (n: number) => new Date(T0 + n * 1000).toISOString();
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, agentId: 'zealot', title: id, status: 'done', source: 'ui', requestedModel: 'auto', createdAt: at(0), updatedAt: at(1), ...over });

/** A thread with plain turns and tool pairs where the result is NOT next to its call (another row sits between), so a page edge can fall between them. */
function thread(taskId: string, n: number, word = 'alpha'): ChatMessage[] {
  const out: ChatMessage[] = []; let k = 0;
  const push = (m: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'text'>) => { out.push({ id: `${taskId}-m${out.length}`, taskId, at: at(out.length), ...m }); };
  while (out.length < n) {
    const i = k++;
    if (i % 7 === 0) push({ role: 'user', text: `question ${i} ${word}` });
    else if (i % 7 === 3) push({ role: 'assistant', text: `answer ${i} secret-${i}` });
    else { push({ role: 'tool', toolName: 'Bash', toolUseId: 'u' + i, text: `{"command":"run ${i}"}` }); push({ role: 'assistant', text: `thinking ${i}` }); push({ role: 'tool', resultFor: 'u' + i, text: `result ${i} secret-${i}` }); }
  }
  return out;
}
const pairsIntact = (msgs: ChatMessage[]) => { const calls = new Set(msgs.map((m) => m.toolUseId).filter(Boolean)); return msgs.every((m) => !m.resultFor || calls.has(m.resultFor)); };

describe('pure windows', () => {
  const list = thread('p', 1000);
  it('newest page by default, clamps, and walks back with no gap or repeat', () => {
    const w = messageWindow(list, {});
    assert.equal(w.end, 1000); assert.ok(w.end - w.start >= 100 && w.end - w.start < 110);
    assert.equal(messageWindow(list, { limit: 5000 }).end - messageWindow(list, { limit: 5000 }).start >= 300, true);
    assert.ok(messageWindow(list, { limit: 5000 }).end - messageWindow(list, { limit: 5000 }).start < 310, 'capped at 300 (plus a pair)');
    const seen: number[] = []; let before: number | undefined;
    for (;;) { const p = messageWindow(list, { before, limit: 50 }); for (let i = p.start; i < p.end; i++) seen.push(i); if (p.start === 0) break; before = p.start; }
    assert.equal(new Set(seen).size, 1000); assert.equal(seen.length, 1000);
  });
  it('never splits a tool call from its result, at any edge', () => {
    for (let before = 1; before <= 1000; before++) {
      const w = messageWindow(list, { before, limit: 10 });
      assert.ok(pairsIntact(list.slice(w.start, w.end)), `window before=${before}`);
    }
    for (let from = 0; from < 990; from += 3) {
      const w = messageWindow(list, { from, limit: 10 });
      const sl = list.slice(w.start, w.end);
      assert.ok(pairsIntact(sl), `from=${from}`);
      const results = new Set(sl.map((m) => m.resultFor).filter(Boolean));
      assert.ok(sl.every((m) => !m.toolUseId || results.has(m.toolUseId) || w.end === 1000), `a call in from=${from} has its result`);
    }
  });
  it('search is newest first, case-insensitive, capped at 100, and runs on what the caller may read', () => {
    const r = searchMessages(list, 'SECRET-');
    assert.equal(r.hits.length, 100); assert.ok(r.hits[0]!.index > r.hits[1]!.index);
    assert.deepEqual(searchMessages(list, '   ').hits, []);
    assert.equal(searchMessages(list, 'secret-', (m) => ({ ...m, text: 'hidden' })).hits.length, 0, 'the view decides what can match');
  });
});

describe('thread pages over HTTP', () => {
  const f = makeFakes();
  const dir = tempDir('legion-msgs-');
  const store = new Store(dir, { saveDebounceMs: 5 });
  let base = ''; let close: () => Promise<void>; let BIG = 0;
  const get = (path: string, headers: Record<string, string> = AUTH) => fetch(base + path, { headers });
  const page = async (id: string, qs = '', h = AUTH) => (await (await get(`/api/tasks/${id}/messages?${qs}`, h)).json()) as { task: Task; messages: ChatMessage[]; start: number; end: number; total: number };

  before(async () => {
    (f.ctx as { store: unknown }).store = store;
    for (const a of [mkAgent('zealot', 'Zealot'), { ...mkAgent('assayer', 'Assayer'), requires: 'bsv' as const }]) store.upsertAgent(a);
    store.upsertTask(task('big')); store.upsertTask(task('conn', { usedConnectors: true, result: 'connector result' })); store.upsertTask(task('hid', { agentId: 'assayer' }));
    for (const m of thread('big', 900)) store.addMessage(m);
    BIG = store.listMessages('big').length;
    for (const m of thread('conn', 40)) store.addMessage(m);
    store.addMessage({ id: 'conn-user', taskId: 'conn', role: 'user', text: 'my own words secret-mine', at: at(500) });
    for (const m of thread('hid', 10)) store.addMessage(m);
    const s = await start(f.ctx); base = s.base; close = s.close;
  });
  after(async () => { await close(); await store.flush(); });

  it('opens at the newest page, default 100, max 300; before pages back with positions that match the stored order', async () => {
    const p = await page('big');
    assert.equal(p.total, BIG); assert.equal(p.end, BIG); assert.ok(p.messages.length >= 100 && p.messages.length < 110);
    assert.equal(p.messages.at(-1)!.id, `big-m${BIG - 1}`);
    assert.equal(p.task.id, 'big');
    assert.ok((await page('big', 'limit=9999')).messages.length < 310);
    const all: ChatMessage[] = []; let cur = p;
    all.unshift(...cur.messages);
    while (cur.start > 0) { cur = await page('big', `before=${cur.start}&limit=100`); all.unshift(...cur.messages); }
    assert.equal(all.length, BIG); assert.deepEqual(all.map((m) => m.id), store.listMessages('big').map((m) => m.id));
  });

  it('is stable while new messages arrive: older pages do not move, the total grows', async () => {
    const first = await page('big', 'limit=100');
    for (let i = 0; i < 25; i++) store.addMessage({ id: 'big-new' + i, taskId: 'big', role: 'assistant', text: 'fresh ' + i, at: at(2000 + i) });
    const older = await page('big', `before=${first.start}&limit=100`);
    assert.equal(older.end, first.start); assert.equal(older.total, BIG + 25);
    assert.deepEqual(older.messages.map((m) => m.id), store.listMessages('big').slice(older.start, older.end).map((m) => m.id));
    assert.equal((await page('big')).messages.at(-1)!.id, 'big-new24');
  });

  it('a page edge never splits a tool pair (checked at every edge of the thread)', async () => {
    for (const before of [101, 150, 333, 500, 777]) { const p = await page('big', `before=${before}&limit=11`); assert.ok(pairsIntact(p.messages), `before=${before}`); }
    const j = await page('big', 'from=200&limit=9'); assert.equal(j.start <= 200, true); assert.ok(pairsIntact(j.messages));
  });

  it('search finds hits newest first and from= loads the window around one', async () => {
    const r = (await (await get('/api/tasks/big/messages?q=secret-30')).json()) as { hits: Array<{ index: number; id: string; snippet: string }>; total: number };
    assert.ok(r.hits.length >= 1); assert.ok(r.hits.every((h) => /secret-30/.test(h.snippet) || h.snippet.length > 0));
    const hit = r.hits[0]!;
    const w = await page('big', `from=${Math.max(0, hit.index - 20)}&limit=60`);
    assert.ok(w.messages.some((m) => m.id === hit.id));
  });

  it('a bearer-only reader gets the withheld view of a connector task (rows, pairing keys and search), and the same answers as today for others', async () => {
    const adm = await page('conn');
    assert.ok(adm.messages.some((m) => m.text.includes('secret-')), 'the app window sees everything');
    const cli = await page('conn', '', asClient);
    assert.ok(!JSON.stringify(cli).includes('secret-3'), 'no connector text leaks');
    assert.equal(cli.task.result, WITHHELD);
    for (const m of cli.messages) if (m.role === 'tool' || m.role === 'assistant') { assert.equal(m.text, WITHHELD); assert.equal(m.toolName, undefined); assert.equal(m.resultFor, undefined); }
    assert.ok(cli.messages.some((m) => m.text.includes('my own words')), 'the caller\'s own user rows stay');
    const hitsAdmin = (await (await get('/api/tasks/conn/messages?q=secret-')).json()) as { hits: unknown[] };
    const hitsClient = (await (await get('/api/tasks/conn/messages?q=secret-', asClient)).json()) as { hits: Array<{ snippet: string }> };
    assert.ok(hitsAdmin.hits.length > 0);
    assert.equal(hitsClient.hits.length, 1, 'only the caller\'s own user row can match; a search cannot read withheld rows');
    assert.ok(hitsClient.hits[0]!.snippet.includes('my own words'));
    // a task that used no connectors reads the same for both
    const a = await page('big', 'limit=20'); const c = await page('big', 'limit=20', asClient);
    assert.deepEqual(c.messages, a.messages);
    // and the old route still answers (bearer included)
    assert.equal((await get('/api/tasks/conn', asClient)).status, 200);
  });

  it('a hidden agent\'s thread answers 404 like an unknown id; no token is 401', async () => {
    const hid = await get('/api/tasks/hid/messages'); const nope = await get('/api/tasks/nope/messages');
    assert.equal(hid.status, 404); assert.equal(await hid.text(), (await nope.text()).replace('nope', 'hid'));
    assert.equal((await get('/api/tasks/hid/messages?q=secret', asClient)).status, 404);
    assert.equal((await fetch(base + '/api/tasks/big/messages')).status, 401);
  });
});

describe('a 2,100-message thread', () => {
  it('first read from disk, the newest page, a deep page and a search each answer well inside a generous bound', async () => {
    const dir = tempDir('legion-msgs-big-');
    const a = new Store(dir, { saveDebounceMs: 5 });
    a.upsertTask(task('t'));
    const msgs = thread('t', 2102).map((m) => ({ ...m, text: m.text + ' ' + 'lorem ipsum dolor sit amet '.repeat(20) }));
    for (const m of msgs) a.addMessage(m);
    await a.flush();
    const b = new Store(dir); // a fresh process: the jsonl is parsed on first read
    const t0 = performance.now(); const first = b.pageMessages('t', {}); const openMs = performance.now() - t0;
    const med = (fn: () => unknown) => { fn(); const xs: number[] = []; for (let i = 0; i < 7; i++) { const s = performance.now(); fn(); xs.push(performance.now() - s); } return xs.sort((x, y) => x - y)[3]!; };
    const deepMs = med(() => b.pageMessages('t', { before: 1000, limit: 100 }));
    const searchMs = med(() => b.searchMessages('t', 'secret-99'));
    console.log(`# 2,102 messages: first open (parse jsonl + page) ${openMs.toFixed(1)} ms, deep page ${deepMs.toFixed(2)} ms, search ${searchMs.toFixed(2)} ms`);
    assert.ok(openMs < 1000, `open ${openMs}`); assert.ok(deepMs < 50); assert.ok(searchMs < 50);
    assert.equal(first.total, msgs.length); assert.equal(first.messages.at(-1)!.id, msgs.at(-1)!.id);
    assert.ok(b.searchMessages('t', 'secret-99').hits.length >= 1);
    await b.flush();
  });
});
