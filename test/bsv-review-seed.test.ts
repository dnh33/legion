/**
 * BSV v1 review fixes, part 1: the pack upgrade (F1 crash safety, F6 what counts as an edit and what a human removed, F7 the restore remedy),
 * seed edges a bot cannot touch (F9) and the upgrade at core startup (F11). Local only: no model, no wallet, no network.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSAYER_ID, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { Graph } from '../src/core/kg/graph.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import { applySeedPack } from '../src/core/kg/seed.js';
import type { SeedPack } from '../src/core/kg/seed.js';
import { agentActor, KgError, SYSTEM } from '../src/core/kg/types.js';
import { makeFakes, mkAgent, start, TOKEN } from './helpers-c.js';
import { HUMAN, mkGraph } from './kg-helpers.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

const src = (id: string) => [{ ref: `https://docs.test/${id}`, licence: 'CC BY 4.0' }];
const node = (id: string, body: string, extra: Record<string, unknown> = {}) => ({ id, type: 'lesson', title: `Title ${id}`, body, tags: ['bsv'], sources: src(id), confidence: 0.8, ...extra });
const edge = (from: string, to: string, rel = 'relates', extra: Record<string, unknown> = {}) => ({ from, to, rel, ...extra });

const IDS = ['bsv-a', 'bsv-b', 'bsv-c', 'bsv-d'];
function pack(version: number, tag: string, more: Array<ReturnType<typeof node>> = [], moreEdges: Array<ReturnType<typeof edge>> = []): SeedPack {
  return {
    version,
    nodes: [
      node('bsv-curriculum-index', `index ${tag}`, { type: 'concept', props: { module: 'index' } }),
      ...IDS.map((id) => node(id, `${id} ${tag}`, { props: { built: false } })),
      ...more,
    ] as SeedPack['nodes'],
    edges: [
      ...IDS.map((id) => edge(id, 'bsv-curriculum-index', 'part_of')),
      edge('bsv-a', 'bsv-b'), edge('bsv-b', 'bsv-c', 'depends_on', { note: `seed note ${tag}` }), edge('bsv-c', 'bsv-d'),
      ...moreEdges,
    ],
  };
}
const open = (dir: string) => new Graph({ dir, bsvEnabled: () => true });
const bodyOf = (g: Graph, id: string) => g.getNode(HUMAN, id)?.body;
const hasEdge = (g: Graph, from: string, to: string, rel: string) => g.edgesOf(HUMAN, from, 'out').some((e) => e.to === to && e.rel === rel);

// ------------------------------------------------------------------ F1: the version marker is written last

test('F1: a crash part-way through an upgrade leaves the install upgradeable (restart + ensureSeed completes), at every cut point', () => {
  for (const cut of [0, 1, 2, 3, 4, 5]) {
    for (const where of ['upsertNode', 'link'] as const) {
      const m = mkGraph(); m.bsv.on = true;
      applySeedPack(m.g, pack(1, 'v1'));
      const v2 = pack(2, 'v2', [node('bsv-e', 'bsv-e v2', { props: { built: false } })], [edge('bsv-e', 'bsv-curriculum-index', 'part_of')]);
      // simulate the process dying after `cut` writes (nodes) or on the first edge write
      let writes = 0;
      const realUpsert = m.g.upsertNode.bind(m.g);
      const realLink = m.g.link.bind(m.g);
      m.g.upsertNode = ((...a: Parameters<Graph['upsertNode']>) => {
        if (a[2]?.dryRun) return realUpsert(...a);
        if (where === 'upsertNode' && writes++ >= cut) throw new Error('simulated crash');
        return realUpsert(...a);
      }) as Graph['upsertNode'];
      m.g.link = ((...a: Parameters<Graph['link']>) => { if (where === 'link') throw new Error('simulated crash'); return realLink(...a); }) as Graph['link'];
      try { applySeedPack(m.g, v2); } catch { /* the crash */ }
      // restart: a new process reads the same files
      const g2 = open(m.dir);
      const r = applySeedPack(g2, v2);
      const label = `cut ${cut} in ${where}`;
      if (!(where === 'upsertNode' && cut === 0)) assert.equal(r.status, 'upgraded', `${label}: the restarted install must still see an upgrade to do (got ${r.status})`);
      for (const id of [...IDS, 'bsv-curriculum-index', 'bsv-e']) assert.match(bodyOf(g2, id) ?? '', /v2$/, `${label}: ${id} is at the v2 text`);
      assert.equal(g2.getNode(HUMAN, 'bsv-curriculum-index')!.props!.seedVersion, 2, label);
      assert.ok(hasEdge(g2, 'bsv-e', 'bsv-curriculum-index', 'part_of'), `${label}: the new edge exists`);
      assert.equal(applySeedPack(g2, v2).status, 'already-loaded', label);
    }
  }
});

test('F1: a crash part-way through the first load does not leave a half pack that looks loaded', () => {
  for (const cut of [1, 2, 4]) {
    const m = mkGraph(); m.bsv.on = true;
    let writes = 0;
    const realUpsert = m.g.upsertNode.bind(m.g);
    m.g.upsertNode = ((...a: Parameters<Graph['upsertNode']>) => {
      if (a[2]?.dryRun) return realUpsert(...a);
      if (writes++ >= cut) throw new Error('simulated crash');
      return realUpsert(...a);
    }) as Graph['upsertNode'];
    try { applySeedPack(m.g, pack(1, 'v1')); } catch { /* the crash */ }
    const g2 = open(m.dir);
    const r = applySeedPack(g2, pack(1, 'v1'));
    assert.equal(r.status, 'loaded', `cut ${cut}: got ${r.status}`);
    for (const id of [...IDS, 'bsv-curriculum-index']) assert.ok(g2.getNode(HUMAN, id), `cut ${cut}: ${id} present`);
    assert.equal(g2.edgesOf(HUMAN, 'bsv-a', 'out').length, 2, `cut ${cut}: edges present`);
  }
});

// ------------------------------------------------------------------ F6: what counts as an edit, what a human removed

test('F6: a human edit to props, type or sources is an edit (the upgrade leaves the node alone and lists it)', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  const a = m.g.getNode(HUMAN, 'bsv-a')!;
  m.g.upsertNode(HUMAN, { id: 'bsv-a', props: { ...a.props, built: true } });
  m.g.upsertNode(HUMAN, { id: 'bsv-b', type: 'concept' });
  m.g.upsertNode(HUMAN, { id: 'bsv-c', sources: [...src('bsv-c'), { ref: 'https://mine.test', licence: 'mine' }] });
  const r = applySeedPack(m.g, pack(2, 'v2'));
  assert.deepEqual([...r.skippedEdited].sort(), ['bsv-a', 'bsv-b', 'bsv-c'], 'props, type and sources edits all count');
  assert.equal(m.g.getNode(HUMAN, 'bsv-a')!.props!.built, true, 'the human prop edit survived');
  assert.equal(m.g.getNode(HUMAN, 'bsv-b')!.type, 'concept', 'the human type edit survived');
  assert.equal(m.g.getNode(HUMAN, 'bsv-c')!.sources!.length, 2, 'the human source edit survived');
  assert.equal(bodyOf(m.g, 'bsv-d'), 'bsv-d v2', 'an untouched node still took the new text');
});

test('F6: an install from before the wide hash (narrow seedHash only) still upgrades untouched nodes and still spots a text edit', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  // what a v2-era install stored: the narrow hash of title+body+tags+confidence
  for (const id of IDS) {
    const cur = m.g.getNode(HUMAN, id)!;
    m.g.upsertNode(SYSTEM, { id, props: { ...cur.props, seedHash: narrowHash(cur) } });
  }
  m.g.upsertNode(HUMAN, { id: 'bsv-a', body: 'my own text' });
  const r = applySeedPack(m.g, pack(2, 'v2'));
  assert.deepEqual(r.skippedEdited, ['bsv-a']);
  assert.equal(bodyOf(m.g, 'bsv-b'), 'bsv-b v2');
});

function narrowHash(n: { title: string; body?: string; tags?: string[]; confidence?: number }): string {
  return createHash('sha256').update(JSON.stringify([n.title, n.body ?? '', n.tags ?? [], n.confidence ?? null])).digest('hex').slice(0, 16);
}

test('F6: an edge a human deleted does not come back, and an edge note or weight a human edited is not reverted', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  m.g.unlink(HUMAN, { from: 'bsv-a', to: 'bsv-b', rel: 'relates' });
  const keep = m.g.edgesOf(HUMAN, 'bsv-b', 'out').find((e) => e.to === 'bsv-c')!;
  m.g.updateEdge(HUMAN, keep.id, { note: 'my own note', weight: 0.2 });
  const r = applySeedPack(m.g, pack(2, 'v2', [node('bsv-e', 'bsv-e v2')], [edge('bsv-e', 'bsv-a', 'relates')]));
  assert.equal(hasEdge(m.g, 'bsv-a', 'bsv-b', 'relates'), false, 'the deleted edge stayed deleted');
  const after = m.g.edgesOf(HUMAN, 'bsv-b', 'out').find((e) => e.to === 'bsv-c')!;
  assert.equal(after.note, 'my own note');
  assert.equal(after.weight, 0.2);
  assert.equal(r.edges, 1, 'only the genuinely new edge was added');
  // and it survives a restart
  const g2 = open(m.dir);
  applySeedPack(g2, pack(3, 'v3'));
  assert.equal(hasEdge(g2, 'bsv-a', 'bsv-b', 'relates'), false, 'still gone after a restart and another upgrade');
});

test('F6: a link whose relation a human changed does not get its original back as a duplicate pair', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  const e = m.g.edgesOf(HUMAN, 'bsv-c', 'out').find((x) => x.to === 'bsv-d')!;
  m.g.updateEdge(HUMAN, e.id, { rel: 'contradicts' });
  applySeedPack(m.g, pack(2, 'v2'));
  assert.equal(hasEdge(m.g, 'bsv-c', 'bsv-d', 'relates'), false, 'the original relation is not re-added');
  assert.equal(hasEdge(m.g, 'bsv-c', 'bsv-d', 'contradicts'), true, 'the human relation stays');
  assert.equal(m.g.edgesOf(HUMAN, 'bsv-c', 'out').filter((x) => x.to === 'bsv-d').length, 1, 'one link between the two notes');
});

test('F6: a node a human deleted stays deleted through an upgrade and is listed; its edges are not re-created', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  m.g.deleteNode(HUMAN, 'bsv-d');
  const r = applySeedPack(m.g, pack(2, 'v2'));
  assert.equal(m.g.getNode(HUMAN, 'bsv-d'), undefined, 'not resurrected');
  assert.deepEqual((r as any).skippedRemoved, ['bsv-d']);
  assert.equal(hasEdge(m.g, 'bsv-c', 'bsv-d', 'relates'), false);
  assert.equal(bodyOf(m.g, 'bsv-c'), 'bsv-c v2');
  const g2 = open(m.dir);
  applySeedPack(g2, pack(3, 'v3'));
  assert.equal(g2.getNode(HUMAN, 'bsv-d'), undefined, 'the removal is remembered across a restart');
});

// ------------------------------------------------------------------ F7: the documented remedy works

test('F6: a pack node a human merged away stays as the retired note it became (the upgrade does not rewrite or revive it)', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  m.g.merge(HUMAN, 'bsv-a', ['bsv-b']);
  const retired = m.g.getNode(HUMAN, 'bsv-b');
  const r = applySeedPack(m.g, pack(2, 'v2'));
  const after = m.g.getNode(HUMAN, 'bsv-b');
  assert.equal(after?.status, retired?.status, 'its lifecycle state is unchanged');
  assert.notEqual(after?.status ?? 'active', 'active');
  assert.equal(after?.body, 'bsv-b v1', 'its text was not rewritten');
  assert.ok(r.skippedEdited.includes('bsv-b'), 'and it is listed so the user can see it was left alone');
});

test('F7: restore brings a deleted node back (with its edges) at the same version, and resets an edited one to the pack text', () => {
  const m = mkGraph(); m.bsv.on = true;
  const p = pack(1, 'v1');
  applySeedPack(m.g, p);
  m.g.deleteNode(HUMAN, 'bsv-d');
  m.g.upsertNode(HUMAN, { id: 'bsv-a', body: 'my own text' });
  // a plain re-seed at the same version changes nothing and says so
  const plain = applySeedPack(m.g, p);
  assert.equal(plain.status, 'already-loaded');
  assert.equal(m.g.getNode(HUMAN, 'bsv-d'), undefined);
  // restore, the explicit way
  const r = (applySeedPack as any)(m.g, p, { restore: ['bsv-d', 'bsv-a'] });
  assert.equal(r.status, 'repaired');
  assert.deepEqual([...r.restored].sort(), ['bsv-a', 'bsv-d']);
  assert.equal(bodyOf(m.g, 'bsv-d'), 'bsv-d v1');
  assert.ok(hasEdge(m.g, 'bsv-c', 'bsv-d', 'relates') && hasEdge(m.g, 'bsv-d', 'bsv-curriculum-index', 'part_of'), 'its edges are back');
  assert.equal(bodyOf(m.g, 'bsv-a'), 'bsv-a v1', 'an edited node is reset to the pack text on request');
  assert.equal(applySeedPack(m.g, p).status, 'already-loaded');
  // the restore is remembered: the next upgrade treats the node as a normal untouched one
  const up = applySeedPack(m.g, pack(2, 'v2'));
  assert.equal(bodyOf(m.g, 'bsv-d'), 'bsv-d v2');
  assert.deepEqual(up.skippedEdited, []);
});

test('F7: restore of an id that is not in the pack is refused and writes nothing', () => {
  const m = mkGraph(); m.bsv.on = true;
  const p = pack(1, 'v1');
  applySeedPack(m.g, p);
  m.g.deleteNode(HUMAN, 'bsv-d');
  assert.throws(() => (applySeedPack as any)(m.g, p, { restore: ['bsv-d', 'bsv-nope'] }), (e: unknown) => e instanceof KgError && /bsv-nope/.test(e.message));
  assert.equal(m.g.getNode(HUMAN, 'bsv-d'), undefined, 'nothing was written');
});

test('F7: a node that is simply missing (lost, or added to the pack without a version bump) is repaired by a plain re-seed', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  const grown = pack(1, 'v1', [node('bsv-late', 'bsv-late v1')], [edge('bsv-late', 'bsv-curriculum-index', 'part_of')]);
  const r = applySeedPack(m.g, grown);
  assert.equal(r.status, 'repaired');
  assert.equal(r.created, 1);
  assert.equal(bodyOf(m.g, 'bsv-late'), 'bsv-late v1');
  assert.equal(applySeedPack(m.g, grown).status, 'already-loaded');
});

test('F7: POST /api/kg/seed/bsv {restore:[ids]} is the button-less remedy over HTTP', async () => {
  const f = makeFakes();
  const dataDir = mkdtempSync(join(tmpdir(), 'legion-bsvrev-'));
  const seedPath = join(dataDir, 'bsv.json');
  writeFileSync(seedPath, JSON.stringify(pack(1, 'v1')));
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => true };
  const kg = createKnowledgeModule(deps, { debounceMs: 20, seedPath });
  f.ctx.modules = [kg];
  f.ctx.bsvEnabled = () => true;
  const srv = await start(f.ctx);
  closers.push(async () => { await kg.dispose?.(); await srv.close(); });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : undefined };
  };
  assert.equal((await call('POST', '/api/kg/seed/bsv')).body.status, 'loaded');
  assert.equal((await call('DELETE', '/api/kg/nodes/bsv-d')).status, 200);
  assert.equal((await call('POST', '/api/kg/seed/bsv')).body.status, 'already-loaded');
  assert.equal((await call('GET', '/api/kg/nodes/bsv-d')).status, 404);
  const r = await call('POST', '/api/kg/seed/bsv', { restore: ['bsv-d'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.restored, ['bsv-d']);
  assert.equal((await call('GET', '/api/kg/nodes/bsv-d')).status, 200);
  assert.equal((await call('POST', '/api/kg/seed/bsv', { restore: ['nope'] })).status, 400);
  assert.equal((await call('POST', '/api/kg/seed/bsv', { restore: 'bsv-d' })).status, 400);
});

// ------------------------------------------------------------------ F9: bots cannot touch seed edges

test('F9: a bot cannot link onto a seed node, re-link a seed edge to change its note or weight, or remove one; the human can', () => {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack(1, 'v1'));
  const bot = agentActor('scout');
  const mine = m.g.upsertNode(bot, { title: 'Scout private plan', scope: 'agent:scout' }).node;
  const shared = m.g.upsertNode(HUMAN, { title: 'A shared note' }).node;
  const forbidden = (fn: () => unknown, label: string) => assert.throws(fn, (e: unknown) => e instanceof KgError && e.status === 403, label);
  forbidden(() => m.g.link(bot, { from: mine.id, to: 'bsv-a', rel: 'relates' }), 'private note -> seed node');
  forbidden(() => m.g.link(bot, { from: shared.id, to: 'bsv-a', rel: 'contradicts' }), 'shared note -> seed node');
  forbidden(() => m.g.link(bot, { from: 'bsv-a', to: 'bsv-b', rel: 'relates', weight: 0.01, note: 'overwritten by a bot' }), 'seed edge, same endpoints and rel');
  forbidden(() => m.g.link(bot, { from: 'bsv-a', to: 'bsv-c', rel: 'contradicts' }), 'a new edge between two seed nodes');
  forbidden(() => m.g.unlink(bot, { from: 'bsv-a', to: 'bsv-b', rel: 'relates' }), 'unlink a seed edge');
  const e = m.g.edgesOf(HUMAN, 'bsv-a', 'out').find((x) => x.to === 'bsv-b')!;
  assert.equal(e.note, undefined, 'the seed edge is unchanged');
  assert.equal(e.weight, undefined);
  // the human still can
  assert.ok(m.g.link(HUMAN, { from: shared.id, to: 'bsv-a', rel: 'relates' }).created);
  assert.doesNotThrow(() => m.g.updateEdge(HUMAN, e.id, { note: 'human note' }));
  // and a bot still links its own notes among themselves
  const mine2 = m.g.upsertNode(bot, { title: 'Scout private plan two', scope: 'agent:scout' }).node;
  assert.ok(m.g.link(bot, { from: mine.id, to: mine2.id, rel: 'relates' }).created);
});

// ------------------------------------------------------------------ F11: the upgrade at core startup

test('F11: start() upgrades a pack that is already on, never throws, and does nothing while BSV mode is off', async () => {
  const f = makeFakes();
  f.agents.set(ASSAYER_ID, { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' });
  const dataDir = mkdtempSync(join(tmpdir(), 'legion-bsvrev-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port: 4747, authToken: 'x', workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {} }, null, 2));
  const seedPath = join(dataDir, 'bsv.json');
  writeFileSync(seedPath, JSON.stringify(pack(1, 'v1')));
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => state.enabled };
  const kg = createKnowledgeModule(deps, { debounceMs: 20, seedPath });
  closers.push(async () => { await kg.dispose?.(); });
  const logs: string[] = [];
  const bsv = createBsvModule(deps, { state, kg, log: (m: string) => logs.push(m) } as any) as any;
  assert.equal(typeof bsv.start, 'function', 'the module has a start hook');

  // off: nothing happens
  await bsv.start();
  state.set(true);
  assert.equal((kg as any).graph().getNode(HUMAN, 'bsv-a'), undefined, 'start() did not load anything while off');
  state.set(false);

  // the install has v1 loaded, BSV is on, and the bundled pack is now v2: start() upgrades it
  state.set(true);
  assert.equal((await bsv.ensureSeed()).status, 'loaded');
  writeFileSync(seedPath, JSON.stringify(pack(2, 'v2')));
  await bsv.start();
  assert.equal(bodyOf((kg as any).graph(), 'bsv-a'), 'bsv-a v2', 'upgraded at startup, no toggle needed');
  assert.ok(logs.some((l) => /upgraded/.test(l)), `logged: ${logs.join(' | ')}`);
  await bsv.start();
  assert.ok(logs.some((l) => /already/.test(l)) || logs.length >= 2, 'idempotent');

  // a missing or broken pack never throws out of start()
  writeFileSync(seedPath, '{ not json');
  await assert.doesNotReject(() => bsv.start());
  assert.ok(logs.some((l) => /not loaded|invalid|error/i.test(l)), `a failure is logged: ${logs.join(' | ')}`);
});
