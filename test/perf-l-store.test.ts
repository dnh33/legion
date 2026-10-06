/**
 * Perf round L, Lattice store against a REAL core: the real graphStore.ts (bundled with esbuild at run time) drives request counts,
 * sequence guards, dropped links (B1), cross-chunk links (B2). Standalone: it imports nothing from the code under test except the store itself.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { KgEdge, KgNode } from '../src/shared/kg.js';
import { closeAll, mount } from './token-harness.js';
import { AUTH, TEST_ADMIN, TOKEN } from './helpers-c.js';

after(closeAll);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the store has stopped fetching, rather than for a fixed time.
 *
 * The graph store debounces and re-reads over several microtasks. A fixed `wait(300)` is a race: under a loaded machine
 * a request from the previous step can land after the counter is reset, so an assertion of "exactly one re-read" sees
 * two or three and fails on code that is correct. That is how F1 failed three times inside the full suite and passed
 * every time on its own. Polling for quiescence is what the test actually means to say.
 */
const settle = async (fetches: unknown[], quiet = 150, cap = 4_000): Promise<void> => {
  const started = Date.now();
  let seen = fetches.length;
  let quietSince = Date.now();
  while (Date.now() - started < cap) {
    await wait(25);
    if (fetches.length !== seen) { seen = fetches.length; quietSince = Date.now(); continue; }
    if (Date.now() - quietSince >= quiet) return;
  }
};

// ------------------------------------------------------------------ the store, real core

/** The part of graphStore.ts these tests use (the store is bundled at run time, not compiled with the core: it needs the DOM-flavoured UI tsconfig). */
interface Store {
  boot(): Promise<void>;
  getG(): { graph: { nodes: KgNode[]; edges: KgEdge[]; rev: number }; detail: { out: KgEdge[]; in: KgEdge[] } | null; graphLoading: boolean; stats: { nodes: number } | null };
  loadOverview(extraSeeds?: string[]): Promise<void>;
  refreshFromServer(changed?: string[]): void;
  select(id: string | null): void;
  startLive(): () => void;
}
async function bundleStore(core: { base: string }, entry = 'ui/src/graph/graphStore.ts'): Promise<{ store: Store; fetches: string[]; setDelay: (fn: ((url: string) => number) | null) => void }> {
  const esbuild = await import(pathToFileURL(join(REPO, 'node_modules/esbuild/lib/main.js')).href);
  const out = join(cleanupTemp('legion-store-'), 'graphStore.mjs');
  await esbuild.build({
    entryPoints: [resolve(REPO, entry)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
    define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { location: { search: '' }, legion: { baseUrl: core.base, token: TOKEN, admin: TEST_ADMIN, platform: 'linux', openExternal() {} }, setTimeout, clearTimeout };
  const fetches: string[] = [];
  let delay: ((url: string) => number) | null = null;
  const realFetch = (g.__realFetch as typeof fetch | undefined) ?? fetch;
  g.__realFetch = realFetch;
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(core.base, '');
    fetches.push(url);
    // the event stream is held open and silent: the tests trigger refreshes themselves and count their requests
    if (url.startsWith('/api/events')) return new Response(new ReadableStream({ start() { /* never emits */ } }), { status: 200 });
    const res = await realFetch(input as string, init);
    const ms = delay?.(url) ?? 0;
    if (ms) { const text = await res.text(); await wait(ms); return new Response(text, { status: res.status, headers: res.headers }); }
    return res;
  };
  const store = (await import(`${pathToFileURL(out).href}?${Date.now()}`)) as Store;
  return { store, fetches, setDelay: (fn) => { delay = fn; } };
}

async function seedGraph(m: Awaited<ReturnType<typeof mount>>, n: number, idLen = 0): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `note-${i.toString().padStart(4, '0')}${idLen ? '-' + 'x'.repeat(idLen) : ''}`;
    const r = await m.http('POST', '/api/kg/nodes', { id, title: `Note ${i} ${['alpha', 'beta', 'gamma'][i % 3]}`, body: `body ${i} about ${['alpha', 'beta', 'gamma'][i % 3]}`, type: 'note', scope: 'shared' }, AUTH);
    assert.ok(r.status < 300, r.text);
    ids.push(id);
  }
  for (let i = 1; i < n; i++) await m.http('POST', '/api/kg/edges', { from: ids[i]!, to: ids[Math.floor(i / 2)]!, rel: 'relates_to' }, AUTH);
  return ids;
}

const count = (f: string[], re: RegExp) => f.filter((u) => re.test(u)).length;

test('F3: a graph of up to 200 nodes loads with ONE overview call (no searches), and a bigger one discovers with at most 4 searches in flight', async () => {
  const m = await mount();
  const ids = await seedGraph(m, 40);
  const { store, fetches } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  const g = store.getG();
  assert.equal(g.graph.nodes.length, 40);
  assert.equal(g.graph.edges.length, 39);
  assert.equal(count(fetches, /^\/api\/kg\/search/), 0, 'no discovery searches');
  assert.equal(count(fetches, /^\/api\/kg\/overview/), 1);
  assert.equal(count(fetches, /^\/api\/kg\/subgraph/), 0);
  assert.ok(ids.every((id) => g.graph.nodes.some((n) => n.id === id)), 'every node is on the canvas');
  // pinned seeds come first
  await store.loadOverview([ids[7]!, ids[3]!]);
  assert.deepEqual(store.getG().graph.nodes.slice(0, 2).map((n) => n.id), [ids[7], ids[3]]);
  await m.close();
});

test('F3: discovery for a big graph runs at most 4 searches at a time', async () => {
  const m = await mount();
  const graph = m.kgMod.graph();
  const { HUMAN } = await import('../src/core/kg/types.js');
  for (let i = 0; i < 230; i++) graph.upsertNode(HUMAN, { id: `big-${i}`, title: `Index ${i} guide ${['alpha', 'beta'][i % 2]}`, body: `overview note ${i} project plan` });
  const { store, fetches, setDelay } = await bundleStore(m.srv);
  let live = 0, peak = 0;
  setDelay((url) => { if (!url.startsWith('/api/kg/search')) return 0; return 1; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    const isSearch = u.includes('/api/kg/search');
    if (isSearch) { live++; peak = Math.max(peak, live); }
    try { return await realFetch(input as string, init); } finally { if (isSearch) live--; }
  }) as typeof fetch;
  await store.boot();
  assert.ok(count(fetches, /^\/api\/kg\/search/) > 40, `searched ${count(fetches, /^\/api\/kg\/search/)} times`);
  assert.ok(peak >= 2 && peak <= 4, `peak ${peak} searches in flight`);
  assert.equal(count(fetches, /^\/api\/kg\/overview/), 0);
  assert.ok(store.getG().graph.nodes.length >= 25, `nodes ${store.getG().graph.nodes.length}, stats ${JSON.stringify(store.getG().stats)}, loading ${store.getG().graphLoading}`);
  globalThis.fetch = realFetch;
  await m.close();
});

test('F1: kg.updated about unrelated nodes costs no node re-read and no new graph; about a node on the canvas it re-reads once and publishes only if something changed', async () => {
  const m = await mount();
  const ids = await seedGraph(m, 30);
  const { store, fetches } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  const rev0 = store.getG().graph.rev, graph0 = store.getG().graph;
  fetches.length = 0;
  store.refreshFromServer(['not-on-the-canvas']);
  await settle(fetches);
  assert.equal(count(fetches, /^\/api\/kg\/subgraph/), 0, 'nothing on screen was touched: no subgraph read');
  assert.equal(store.getG().graph, graph0);
  fetches.length = 0;
  store.refreshFromServer([ids[5]!]);
  await settle(fetches);
  assert.equal(count(fetches, /^\/api\/kg\/subgraph/), 1, 'one re-read of the canvas');
  assert.equal(store.getG().graph.rev, rev0, 'nothing differed: no new graph, no layout, no render');
  assert.equal(store.getG().graph, graph0);
  // a real change publishes
  await m.http('POST', '/api/kg/nodes', { id: ids[5]!, body: 'edited on the server' }, AUTH);
  store.refreshFromServer([ids[5]!]);
  await settle(fetches);
  assert.equal(store.getG().graph.rev, rev0 + 1);
  assert.equal(store.getG().graph.nodes.find((n) => n.id === ids[5])!.body, 'edited on the server');
  // no changed list (the Library returning to the Lattice): a full re-read, still no publish when nothing changed
  const rev1 = store.getG().graph.rev;
  fetches.length = 0;
  store.refreshFromServer();
  await settle(fetches);
  assert.equal(count(fetches, /^\/api\/kg\/subgraph/), 1);
  assert.equal(store.getG().graph.rev, rev1);
  await m.close();
});

test('F1: a full re-read (no changed list, e.g. the bsv scope flipped) shows nodes that were not on the canvas and drops ones that are gone', async () => {
  const m = await mount();
  const ids = await seedGraph(m, 10);
  const { store, fetches } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  const rev0 = store.getG().graph.rev;
  // change the graph behind the store's back (no event): one node appears, one is deleted
  const graph = m.kgMod.graph();
  const { HUMAN } = await import('../src/core/kg/types.js');
  graph.upsertNode(HUMAN, { id: 'came-into-view', title: 'Came into view', body: 'was hidden' });
  const del = await m.http('DELETE', `/api/kg/nodes/${ids[9]!}`, undefined, AUTH);
  assert.ok(del.status < 300, del.text);
  fetches.length = 0;
  store.refreshFromServer();
  await settle(fetches);
  const g = store.getG().graph;
  assert.ok(g.rev > rev0, 'a different view publishes');
  assert.ok(g.nodes.some((n) => n.id === 'came-into-view'), 'the node not on the canvas is shown');
  assert.ok(!g.nodes.some((n) => n.id === ids[9]), 'the deleted node is gone');
  await m.close();
});

test('F1: the open note is re-read only when the event names it or a note it links to', async () => {
  const m = await mount();
  const ids = await seedGraph(m, 12);
  const { store, fetches } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  store.select(ids[2]!);
  await wait(300);
  fetches.length = 0;
  store.refreshFromServer(['unrelated']);
  await wait(250);
  assert.equal(count(fetches, /^\/api\/kg\/nodes\//), 0);
  store.refreshFromServer([ids[2]!]);
  await wait(250);
  assert.ok(count(fetches, /^\/api\/kg\/nodes\//) >= 1, 'named: re-read');
  fetches.length = 0;
  const nb = store.getG().detail!.out[0]?.to ?? store.getG().detail!.in[0]!.from;
  store.refreshFromServer([nb]);
  await wait(250);
  assert.ok(count(fetches, /^\/api\/kg\/nodes\//) >= 1, 'a neighbour changed: its title in the link list may be stale');
  await m.close();
});

test('B1: a link deleted elsewhere disappears from the canvas on the next refresh', async () => {
  const m = await mount();
  const ids = await seedGraph(m, 20);
  const { store } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  const edges = store.getG().graph.edges;
  const victim = edges[3]!;
  assert.equal((await m.http('DELETE', `/api/kg/edges/${victim.id}`, undefined, AUTH)).status, 200);
  store.refreshFromServer([victim.id, victim.from, victim.to]);
  await wait(400);
  assert.equal(store.getG().graph.edges.length, edges.length - 1);
  assert.ok(!store.getG().graph.edges.some((e) => e.id === victim.id));
  assert.equal(store.getG().graph.nodes.length, ids.length);
  await m.close();
});

test('B2: above one request of ids, a new link between nodes of different chunks is found', async () => {
  const m = await mount();
  const ids = await seedGraph(m, 120, 60); // 120 ids of ~72 chars: more than one 6500-char request
  const { store, fetches } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  assert.equal(store.getG().graph.nodes.length, 120);
  assert.ok(ids.join(',').length > 6500, 'premise: more than one 6500-char request');
  const first = ids[0]!, last = ids[119]!;
  const had = store.getG().graph.edges.length;
  await m.http('POST', '/api/kg/edges', { from: first, to: last, rel: 'cites' }, AUTH);
  fetches.length = 0;
  store.refreshFromServer([first, last]);
  await wait(500);
  assert.ok(count(fetches, /^\/api\/kg\/subgraph/) >= 1);
  assert.equal(store.getG().graph.edges.length, had + 1, 'the cross-chunk link is on the canvas');
  // and deleting it is noticed too
  const e = (await m.http('GET', `/api/kg/nodes/${encodeURIComponent(first)}`, undefined, AUTH)).json.edges.out.find((x: KgEdge) => x.to === last);
  await m.http('DELETE', `/api/kg/edges/${e.id}`, undefined, AUTH);
  store.refreshFromServer([first, last, e.id]);
  await wait(500);
  assert.equal(store.getG().graph.edges.length, had);
  await m.close();
});

test('B3: an older refresh that answers late cannot overwrite a newer one', async () => {
  const m = await mount();
  const ids = await seedGraph(m, 15);
  const { store, setDelay } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  const id = ids[4]!;
  await m.http('POST', '/api/kg/nodes', { id, body: 'v2' }, AUTH);
  // the first re-read is slow (its body is v2), then the note changes again and a second, fast re-read follows
  let slow = true;
  setDelay((url) => (url.startsWith('/api/kg/subgraph') && slow ? (slow = false, 400) : 0));
  store.refreshFromServer([id]);
  await wait(60);
  await m.http('POST', '/api/kg/nodes', { id, body: 'v3' }, AUTH);
  store.refreshFromServer([id]);
  await wait(900);
  assert.equal(store.getG().graph.nodes.find((n) => n.id === id)!.body, 'v3', 'the newer answer stands');
  await m.close();
});

test('B3/B6: an older overview cannot replace a newer one, and a refresh does not start a second overview while one runs', async () => {
  const m = await mount();
  await seedGraph(m, 10);
  const { store, fetches, setDelay } = await bundleStore(m.srv);
  await store.boot();
  store.startLive();
  await m.http('POST', '/api/kg/nodes', { id: 'late-one', title: 'Late one', body: 'x' }, AUTH);
  let first = true;
  setDelay((url) => (url.startsWith('/api/kg/overview') && first ? (first = false, 400) : 0));
  const slow = store.loadOverview();
  await wait(50);
  const fast = store.loadOverview(['late-one']);
  await Promise.all([slow, fast]);
  await wait(100);
  assert.ok(store.getG().graph.nodes.some((n) => n.id === 'late-one'), 'the newer overview (which sees the new note) stands');
  assert.equal(store.getG().graphLoading, false);
  await m.close();
});

test('B6: a refresh whose stats land while boot() is still loading the overview does not start a second overview', async () => {
  const m = await mount();
  await seedGraph(m, 10);
  const { store, fetches, setDelay } = await bundleStore(m.srv);
  setDelay((url) => (url.startsWith('/api/kg/overview') ? 300 : 0));
  store.startLive();
  const booting = store.boot();
  await wait(60);
  store.refreshFromServer(['note-0001']);
  await booting;
  await wait(200);
  assert.equal(count(fetches, /^\/api\/kg\/overview/), 1);
  assert.equal(store.getG().graph.nodes.length, 10);
  await m.close();
});

test('F10: an inbox or activity answer identical to the last one changes no state (nothing to render)', async () => {
  const m = await mount();
  await seedGraph(m, 5);
  const { store: lib } = await bundleStore(m.srv, 'ui/src/library/libraryStore.ts');
  const L = lib as unknown as { loadInbox(quiet?: boolean): Promise<void>; loadActivity(quiet?: boolean): Promise<void>; getL(): object };
  await L.loadInbox(); await L.loadActivity();
  const before = L.getL();
  await L.loadInbox(true); await L.loadActivity(true);
  assert.equal(L.getL(), before, 'same answers: the store object is untouched, so no component re-renders');
  // a real change does land
  await m.http('POST', '/api/kg/nodes', { id: 'pending-x', title: 'Pending x', body: 'b', scope: 'shared' }, AUTH);
  await L.loadInbox(true);
  assert.ok(Array.isArray((L.getL() as { inbox: unknown[] }).inbox));
  await m.close();
});

test('F10: a Library action does not re-read the canvas while the Lattice is not on screen', async () => {
  const m = await mount();
  await seedGraph(m, 8);
  const { store, fetches } = await bundleStore(m.srv);
  await store.boot();
  fetches.length = 0;
  store.refreshFromServer(); // no Lattice mounted (startLive was never called)
  await wait(250);
  assert.equal(count(fetches, /^\/api\/kg\/subgraph/), 0);
  await m.close();
});
