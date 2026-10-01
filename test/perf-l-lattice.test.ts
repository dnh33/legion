/**
 * Perf round L, Lattice half: the pure logic of the refresh/overview path (ui/src/graph/viewsync.ts) and the layout's re-heat and
 * position-restore rules (ui/src/graph/layout.ts). The store itself is tested against a real core in perf-l-store.test.ts.
 * Docs: /home/claude/council/perf/ui-lattice.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KgEdge, KgNode, KgSubgraph } from '../src/shared/kg.js';
import {
  chunkIds, mapPool, orderOverview, reconcileView, sameEdge, sameHits, sameNode, seedGroups, touchesDetail, touchesView,
} from '../ui/src/graph/viewsync.js';
import { ALPHA_MIN, edgeSig, Sim } from '../ui/src/graph/layout.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const node = (id: string, o: Partial<KgNode> = {}): KgNode => ({ id, type: 'note', title: id, body: `body of ${id}`, tags: [], scope: 'shared', createdBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1, ...o });
const edge = (id: string, from: string, to: string, o: Partial<KgEdge> = {}): KgEdge => ({ id, from, to, rel: 'relates_to', createdBy: 'human', createdAt: '2026-01-01T00:00:00.000Z', ...o });
const view = (nodes: KgNode[], edges: KgEdge[]) => ({ nodes: new Map(nodes.map((n) => [n.id, n])), edges: new Map(edges.map((e) => [e.id, e])) });
const sub = (nodes: KgNode[], edges: KgEdge[], truncated = false): KgSubgraph => ({ nodes, edges, truncated });
const clone = <T,>(x: T): T => structuredClone(x);

// ------------------------------------------------------------------ viewsync

test('F1: an identical re-read is "same", any visible change is not', () => {
  const a = node('a', { tags: ['x'], sources: [{ ref: 'r', untrusted: true }], props: { k: 1 } });
  assert.equal(sameNode(a, clone(a)), true);
  for (const patch of ([{ title: 'b' }, { body: 'new' }, { rev: 2 }, { updatedAt: '2026-02-01T00:00:00.000Z' }, { tags: ['y'] }, { tags: ['x', 'z'] }, { type: 'lesson' as const }, { scope: 'bsv' as const }, { status: 'archived' as const }, { sources: [{ ref: 'r' }] }, { props: { k: 2 } }, { props: {} }, { confidence: 0.3 }] as Partial<KgNode>[])) {
    assert.equal(sameNode(a, { ...clone(a), ...patch }), false, JSON.stringify(patch));
  }
  const e = edge('e', 'a', 'b', { note: 'n', weight: 2 });
  assert.equal(sameEdge(e, clone(e)), true);
  for (const patch of [{ rel: 'cites' as const }, { note: 'm' }, { weight: 3 }, { to: 'c' }]) assert.equal(sameEdge(e, { ...e, ...patch }), false);
});

test('F1: reconcileView reports no change for an unchanged re-read and keeps the old objects', () => {
  const ns = [node('a'), node('b'), node('c')], es = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
  const v = view(ns, es);
  const before = [...v.nodes.values()];
  const r = reconcileView(v, ['a', 'b', 'c'], [sub(clone(ns), clone(es))], true);
  assert.deepEqual([r.changed, r.topology], [false, false]);
  assert.deepEqual([...v.nodes.values()].map((n, i) => n === before[i]), [true, true, true], 'old objects kept: nothing downstream sees a change');
});

test('F1: a content change is a change but not a topology change; added or removed nodes and links are topology', () => {
  const ns = [node('a'), node('b')], es = [edge('e1', 'a', 'b')];
  let v = view(ns, es);
  let r = reconcileView(v, ['a', 'b'], [sub([node('a', { body: 'edited', rev: 2 }), node('b')], clone(es))], true);
  assert.deepEqual([r.changed, r.topology], [true, false]);
  assert.equal(v.nodes.get('a')!.body, 'edited');
  v = view(ns, es);
  r = reconcileView(v, ['a', 'b'], [sub(clone(ns), [edge('e1', 'a', 'b', { rel: 'cites' })])], true);
  assert.deepEqual([r.changed, r.topology], [true, false], 'a relabelled link is content');
  v = view(ns, es);
  r = reconcileView(v, ['a', 'b'], [sub(clone(ns), [...clone(es), edge('e9', 'b', 'a', { rel: 'cites' })])], true);
  assert.deepEqual([r.changed, r.topology], [true, true], 'a new link is topology');
  v = view(ns, es);
  r = reconcileView(v, ['a', 'b'], [sub([node('a')], [])], true);
  assert.deepEqual([r.changed, r.topology], [true, true], 'a node gone from the server is dropped');
  assert.equal(v.nodes.has('b'), false);
  assert.equal(v.edges.size, 0, 'and its links with it');
});

test('B1: a link deleted on the server is dropped from the view when both its ends were re-read', () => {
  const ns = [node('a'), node('b'), node('c')], es = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
  const v = view(ns, es);
  const r = reconcileView(v, ['a', 'b', 'c'], [sub(clone(ns), [es[1]!])], true, undefined, new Set(['e1', 'e2']));
  assert.equal(v.edges.has('e1'), false, 'e1 is gone server-side');
  assert.equal(v.edges.has('e2'), true);
  assert.deepEqual([r.changed, r.topology], [true, true]);
});

test('B1: ...but a link is kept when the answer was cut short, when an end was not re-read, when it was merged after the request, or without dropMissing', () => {
  const ns = [node('a'), node('b'), node('c')], es = [edge('e1', 'a', 'b')];
  let v = view(ns, es);
  reconcileView(v, ['a', 'b', 'c'], [sub(clone(ns), [], true)], true);
  assert.equal(v.edges.has('e1'), true, 'truncated: edges may be missing from the answer');
  v = view(ns, es);
  reconcileView(v, ['a', 'b', 'c'], [sub([node('a'), node('c')], [])], false);
  assert.equal(v.edges.has('e1'), true, 'dropMissing off (expand, after a local merge)');
  v = view(ns, es);
  reconcileView(v, ['a', 'b', 'c'], [sub(clone(ns), [])], true, undefined, new Set());
  assert.equal(v.edges.has('e1'), true, 'e1 was not on the canvas when the request was sent: the answer is older than it');
  v = view(ns, es);
  reconcileView(v, ['a', 'b', 'c'], [sub([node('a'), node('c')], [])], true);
  assert.equal(v.nodes.has('b'), false);
  assert.equal(v.edges.has('e1'), false, 'dangling link of a dropped node goes with it');
});

test('B2: seedGroups covers every pair of nodes of a big view, each request fits a URL; small views are one request', () => {
  const small = Array.from({ length: 150 }, (_, i) => `n:${i.toString().padStart(8, '0')}`);
  assert.deepEqual(seedGroups(small), [small]);
  assert.deepEqual(seedGroups([]), []);
  const big = Array.from({ length: 400 }, (_, i) => `note-${i.toString().padStart(4, '0')}-${'x'.repeat(20)}`);
  assert.ok(chunkIds(big).length >= 2, 'the premise: more than one URL of ids');
  const groups = seedGroups(big);
  assert.ok(groups.length >= 1 && groups.length <= 10, `${groups.length} requests`);
  for (const g of groups) assert.ok(g.join(',').length <= 6500, `a request of ${g.join(',').length} chars`);
  const where = new Map<string, Set<number>>();
  groups.forEach((g, gi) => g.forEach((id) => (where.get(id) ?? where.set(id, new Set()).get(id)!).add(gi)));
  for (const id of big) assert.ok(where.has(id), `${id} is in some request`);
  for (let i = 0; i < big.length; i += 7) for (let j = i + 1; j < big.length; j += 11) {
    const a = where.get(big[i]!)!, b = where.get(big[j]!)!;
    assert.ok([...a].some((g) => b.has(g)), `${big[i]} and ${big[j]} share a request, so a link between them is returned`);
  }
});

test('touchesView / touchesDetail: only events about what is on screen need a re-read', () => {
  const v = view([node('a'), node('b')], [edge('e1', 'a', 'b')]);
  assert.equal(touchesView(undefined, v), true);
  assert.equal(touchesView([], v), true);
  assert.equal(touchesView(['zzz'], v), false);
  assert.equal(touchesView(['zzz', 'b'], v), true);
  assert.equal(touchesView(['e1'], v), true);
  assert.equal(touchesDetail(['x'], ['a', 'b']), false);
  assert.equal(touchesDetail(['x', 'b'], ['a', 'b']), true);
  assert.equal(touchesDetail(undefined, ['a']), true);
});

test('mapPool runs at most `limit` at once and keeps result order', async () => {
  let live = 0, peak = 0;
  const out = await mapPool(Array.from({ length: 25 }, (_, i) => i), 4, async (i) => { live++; peak = Math.max(peak, live); await wait(3 + (i % 3)); live--; return i * 2; });
  assert.equal(peak, 4);
  assert.deepEqual(out, Array.from({ length: 25 }, (_, i) => i * 2));
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});

test('orderOverview puts the pinned nodes first and keeps the core\'s order for the rest', () => {
  const s = sub([node('a'), node('b'), node('c'), node('d')], []);
  assert.deepEqual(orderOverview(s, ['c', 'a', 'zzz']).nodes.map((n) => n.id), ['c', 'a', 'b', 'd']);
  assert.equal(orderOverview(s, []), s);
  assert.equal(orderOverview(s, ['zzz']), s);
});

test('sameHits ignores a re-run with the same answer', () => {
  const h = (id: string, score = 1, snippet = 's') => ({ node: { id, type: 'note' as const, title: id, tags: [], scope: 'shared' as const, updatedAt: 'u', snippet }, score });
  assert.equal(sameHits([h('a'), h('b')], [h('a'), h('b')]), true);
  assert.equal(sameHits(null, []), false);
  assert.equal(sameHits([h('a')], [h('a', 2)]), false);
  assert.equal(sameHits([h('a')], [h('a', 1, 't')]), false);
  assert.equal(sameHits([h('a')], [h('a'), h('b')]), false);
});

// ------------------------------------------------------------------ layout

function ring(n: number): { nodes: KgNode[]; edges: KgEdge[] } {
  const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`));
  const edges = nodes.map((x, i) => edge(`e${i}`, x.id, nodes[(i + 1) % n]!.id));
  return { nodes, edges };
}

test('F1/F2: re-setting the same graph, or changing only content, does not re-heat the layout; adding or removing does', () => {
  const { nodes, edges } = ring(30);
  const sim = new Sim();
  assert.equal(sim.setData(nodes, edges), true, 'first data is a new shape');
  assert.equal(sim.alpha, 1);
  sim.settle(2000);
  assert.ok(sim.alpha <= ALPHA_MIN);
  const at = sim.nodes.map((n) => [n.x, n.y]);
  assert.equal(sim.setData(clone(nodes), clone(edges)), false);
  assert.ok(sim.alpha <= ALPHA_MIN, 'same data: still at rest');
  assert.equal(sim.setData(nodes.map((n, i) => (i === 3 ? { ...n, body: 'changed', rev: 2 } : n)), edges.map((e, i) => (i === 2 ? { ...e, rel: 'cites' as const } : e))), false);
  assert.ok(sim.alpha <= ALPHA_MIN, 'content only: still at rest');
  assert.deepEqual(sim.nodes.map((n) => [n.x, n.y]), at, 'no node moved');
  assert.equal(sim.byId.get('n3')!.node.body, 'changed', 'but the node carries the new content');
  assert.equal(sim.setData(nodes, [...edges, edge('extra', 'n0', 'n5')]), true);
  assert.equal(sim.alpha, 0.55);
  sim.settle(2000);
  assert.equal(sim.setData(nodes, edges), true, 'a link removed');
  assert.equal(sim.alpha, 0.55);
  sim.settle(2000);
  assert.equal(sim.setData(nodes.slice(1), edges), true, 'a node removed');
  assert.equal(sim.alpha, 0.55);
  sim.settle(2000);
  assert.equal(sim.setData([...nodes.slice(1), node('new')], edges), true, 'a node added');
  sim.settle(2000);
  // one link swapped for another with the same count
  assert.equal(sim.setData([...nodes.slice(1), node('new')], [...edges.slice(1), edge('swap', 'n2', 'n9')]), true);
});

test('F1: edge indices on SimEdge point at the ends in sim.nodes', () => {
  const { nodes, edges } = ring(12);
  const sim = new Sim(); sim.setData(nodes, edges);
  for (const e of sim.edges) { assert.equal(sim.nodes[e.si], e.s); assert.equal(sim.nodes[e.ti], e.t); }
});

test('F2: restored positions start a re-opened Lattice at rest (same links) or heated (changed links), never from scratch', async () => {
  const { nodes, edges } = ring(40);
  const a = new Sim(); a.setData(nodes, edges); a.settle(3000);
  const { savePositions, loadPositions, clearPositions } = await import('../ui/src/graph/layout.js');
  savePositions(a);
  const cache = loadPositions()!;
  assert.equal(cache.settled, true);
  assert.equal(cache.sig, a.sig);
  // same data: positions identical, nothing to do
  const b = new Sim();
  assert.equal(b.restore(cache, nodes), true);
  assert.equal(b.setData(nodes, edges, cache.sig), false);
  assert.equal(b.alpha, 0);
  assert.deepEqual(b.nodes.map((n) => [n.x, n.y]), a.nodes.map((n) => [n.x, n.y]));
  // one link more: same positions, heated to finish the layout
  const c = new Sim(); c.restore(cache, nodes);
  assert.equal(c.setData(nodes, [...edges, edge('x', 'n0', 'n20')], cache.sig), true);
  assert.equal(c.alpha, 0.55);
  // a different graph (under 90% known) is not restored
  const d = new Sim();
  assert.equal(d.restore(cache, Array.from({ length: 40 }, (_, i) => node(i < 10 ? `n${i}` : `other${i}`))), false);
  assert.equal(new Sim().restore(null, nodes), false);
  // a cache saved mid-layout is flagged
  const hot = new Sim(); hot.setData(nodes, edges); hot.settle(5);
  savePositions(hot);
  assert.equal(loadPositions()!.settled, false);
  clearPositions();
  assert.equal(loadPositions(), null);
  assert.equal(edgeSig(edges), edgeSig([...edges].reverse()), 'the signature does not depend on order');
  assert.notEqual(edgeSig(edges), edgeSig(edges.slice(1)));
});
