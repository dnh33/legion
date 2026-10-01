/**
 * Library v1, stage C: the backend pieces the Library UI relies on: editing an edge (relation, note), retyping a
 * node through the existing node route, and the "why can't I undo" reason on Activity rows.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import { agentActor, HUMAN, KgError, SYSTEM } from '../src/core/kg/types.js';
import { makeFakes, start, TOKEN, AUTH } from './helpers-c.js';
import { mkGraph, note, tmpDir } from './kg-helpers.js';

const rejects = (fn: () => unknown, code: string, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof KgError && e.code === code && (!re || re.test(e.message)), `${code} ${re ?? ''}`);

const spin = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* node updatedAt uses the real clock */ } };

const open: Array<() => Promise<void>> = [];
after(async () => { for (const c of open) await c().catch(() => undefined); });

async function setup() {
  const f = makeFakes();
  const mod = createKnowledgeModule({ config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: tmpDir(), bsvEnabled: () => false }, { debounceMs: 20 });
  f.ctx.modules = [mod];
  const srv = await start(f.ctx);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.base + path, {
      method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const close = async () => { await mod.dispose?.(); await srv.close(); };
  open.push(close);
  return { call, close, graph: mod.graph() };
}

test('updateEdge: change relation and note, clear the note, keep one edge, survive a reload', () => {
  const { g, dir } = mkGraph();
  const a = note(g, 'Alpha');
  const b = note(g, 'Beta');
  const e = g.link(HUMAN, { from: a.id, to: b.id, rel: 'relates', note: 'first guess' }).edge;
  const r = g.updateEdge(HUMAN, e.id, { rel: 'Depends On', note: '  because of x ' });
  assert.equal(r.id, e.id);
  assert.equal(r.rel, 'depends_on', 'relation is normalised like link()');
  assert.equal(r.note, 'because of x');
  assert.equal(g.edgesOf(HUMAN, a.id).length, 1, 'no duplicate edge is left under the old relation');
  // the old relation is free again, and the new one is taken
  assert.equal(g.link(HUMAN, { from: a.id, to: b.id, rel: 'relates' }).created, true);
  assert.equal(g.link(HUMAN, { from: a.id, to: b.id, rel: 'depends_on' }).created, false);
  const cleared = g.updateEdge(HUMAN, e.id, { note: null });
  assert.equal(cleared.note, undefined);
  assert.equal(g.updateEdge(HUMAN, e.id, { note: '   ' }).note, undefined, 'blank note clears');
  // replay from disk gives the same graph
  const g2 = mkGraph({ dir }).g;
  const back = g2.edgesOf(HUMAN, a.id).find((x) => x.id === e.id)!;
  assert.equal(back.rel, 'depends_on');
  assert.equal(back.note, undefined);
  assert.equal(g2.edgesOf(HUMAN, a.id).length, 2);
});

test('updateEdge: refuses a clash, nothing-to-change, bad input, bots and the system; secrets in the note are scrubbed or refused', () => {
  const { g } = mkGraph();
  const a = note(g, 'Alpha');
  const b = note(g, 'Beta');
  const e1 = g.link(HUMAN, { from: a.id, to: b.id, rel: 'relates' }).edge;
  g.link(HUMAN, { from: a.id, to: b.id, rel: 'cites' });
  rejects(() => g.updateEdge(HUMAN, e1.id, { rel: 'cites' }), 'conflict', /already linked as "cites"/);
  assert.equal(g.edgesOf(HUMAN, a.id).find((x) => x.id === e1.id)!.rel, 'relates', 'a refused change leaves the edge as it was');
  rejects(() => g.updateEdge(HUMAN, e1.id, {}), 'invalid', /Nothing to change/);
  rejects(() => g.updateEdge(HUMAN, e1.id, { rel: '!!' }), 'invalid');
  rejects(() => g.updateEdge(HUMAN, e1.id, { note: 'x'.repeat(501) }), 'invalid');
  rejects(() => g.updateEdge(HUMAN, 'e_missing', { note: 'x' }), 'not_found');
  rejects(() => g.updateEdge(agentActor('alpha'), e1.id, { note: 'bot edit' }), 'forbidden', /Only the human/);
  rejects(() => g.updateEdge(SYSTEM, e1.id, { note: 'system edit' }), 'forbidden');
  assert.equal(g.edgesOf(HUMAN, a.id).find((x) => x.id === e1.id)!.note, undefined);
  const key = 'sk-ant-api03-' + 'a1B2c3D4e5'.repeat(5);
  const r = g.updateEdge(HUMAN, e1.id, { note: `uses ${key} here` });
  assert.ok(!r.note!.includes(key), 'a key in the note is redacted');
  rejects(() => g.updateEdge(HUMAN, e1.id, { note: 'seed phrase: abandon ability able about above absent absorb abstract absurd abuse access accident' }), 'invalid', /Refused/);
});

test('PATCH /api/kg/edges/:id: edits an edge, 400 on bad bodies, 404 on unknown ids, 409 on a clash; PATCH on nodes stays unrouted', async () => {
  const s = await setup();
  const mk = async (title: string) => (await s.call('POST', '/api/kg/nodes', { title })).body.node.id as string;
  const a = await mk('Alpha');
  const b = await mk('Beta');
  const e = (await s.call('POST', '/api/kg/edges', { from: a, to: b, rel: 'relates' })).body.edge;
  const r = await s.call('PATCH', `/api/kg/edges/${e.id}`, { rel: 'part_of', note: 'beta is part of alpha' });
  assert.equal(r.status, 200);
  assert.equal(r.body.edge.rel, 'part_of');
  assert.equal(r.body.edge.note, 'beta is part of alpha');
  const full = await s.call('GET', `/api/kg/nodes/${a}`);
  assert.equal(full.body.edges.out.length, 1);
  assert.equal(full.body.edges.out[0].rel, 'part_of');
  assert.equal((await s.call('PATCH', `/api/kg/edges/${e.id}`, { note: null })).body.edge.note, undefined);
  assert.equal((await s.call('PATCH', `/api/kg/edges/${e.id}`, {})).status, 400);
  assert.equal((await s.call('PATCH', `/api/kg/edges/${e.id}`, { rel: 5 })).status, 400);
  assert.equal((await s.call('PATCH', `/api/kg/edges/${e.id}`, { note: 5 })).status, 400);
  assert.equal((await s.call('PATCH', `/api/kg/edges/${e.id}`, { weight: 'x' })).status, 400);
  assert.equal((await s.call('PATCH', `/api/kg/edges/${e.id}`, 'nope')).status, 400);
  assert.equal((await s.call('PATCH', '/api/kg/edges/e_missing', { note: 'x' })).status, 404);
  await s.call('POST', '/api/kg/edges', { from: a, to: b, rel: 'cites' });
  assert.equal((await s.call('PATCH', `/api/kg/edges/${e.id}`, { rel: 'cites' })).status, 409);
  assert.equal((await s.call('PATCH', `/api/kg/nodes/${a}`, { title: 'x' })).status, 405);
  await s.close();
});

test('node retype and edit go through POST /api/kg/nodes with an id: only the given fields change, bad types are refused', async () => {
  const s = await setup();
  const c = await s.call('POST', '/api/kg/nodes', { title: 'Use JSONL', body: 'because append-only', tags: ['storage'], type: 'note' });
  const id = c.body.node.id as string;
  const r = await s.call('POST', '/api/kg/nodes', { id, type: 'decision' });
  assert.equal(r.status, 200);
  assert.equal(r.body.node.type, 'decision');
  assert.equal(r.body.node.body, 'because append-only', 'fields that were not sent are kept');
  assert.deepEqual(r.body.node.tags, ['storage']);
  for (const t of ['mistake', 'pattern', 'project', 'memory', 'idea', 'episode']) assert.equal((await s.call('POST', '/api/kg/nodes', { id, type: t })).body.node.type, t);
  assert.equal((await s.call('POST', '/api/kg/nodes', { id, type: 'bogus' })).status, 400);
  assert.equal((await s.call('GET', `/api/kg/nodes/${id}`)).body.node.type, 'episode');
  await s.close();
});

test('activity rows say why an undo would be refused: changed since, undone, too old', () => {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const { g } = mkGraph({ now: () => new Date(t) });
  const bot = agentActor('alpha', { taskId: 'tA' });
  const n = g.upsertNode(bot, { title: 'Bot note', body: 'one', scope: 'shared' }).node;
  g.upsertNode(bot, { title: 'Other note', body: 'two', scope: 'shared' });
  const rows = () => g.activityFeed(HUMAN);
  assert.equal(rows().every((r) => r.undoable && !r.blocked), true, 'fresh writes have no block');
  t += 1000;
  spin(5);
  g.upsertNode(HUMAN, { id: n.id, body: 'one, edited by the human' });
  const byNode = (id: string) => rows().find((r) => r.nodeId === id)!;
  assert.equal(byNode(n.id).blocked, 'changed');
  assert.equal(byNode(n.id).undoable, true, 'undoable keeps its documented meaning (window and not undone)');
  rejects(() => g.undo(HUMAN, byNode(n.id).id), 'conflict', /has changed since/);
  const other = rows().find((r) => r.nodeId !== n.id)!;
  g.undo(HUMAN, other.id);
  const done = rows().find((r) => r.id === other.id)!;
  assert.equal(done.undone, true);
  assert.equal(done.blocked, undefined, 'an undone row is not "blocked", it is done');
  t += 8 * 86_400_000;
  g.activityFeed(HUMAN);
  const aged = g.lintLite();
  assert.ok(aged.prunedActivity >= 1, 'old entries age out of the list');
});
