/**
 * BSV mode v1: the pack is found by what it says, recall can be scoped, and a newer pack upgrades an install without ever
 * eating a human edit. Everything here is local: no model, no wallet, no network.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ASSAYER_ID, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import { applySeedPack, BSV_SEED_PATH, loadBsvSeed } from '../src/core/kg/seed.js';
import { buildKgToolsServer } from '../src/core/kg/tools.js';
import { agentActor, SYSTEM } from '../src/core/kg/types.js';
import type { CoreModule } from '../src/core/modules.js';
import type { Graph } from '../src/core/kg/graph.js';
import { makeFakes, mkAgent, start, TOKEN, AUTH } from './helpers-c.js';
import { HUMAN, mkGraph } from './kg-helpers.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

const ASSAYER = agentActor('assayer');

function bundledGraph(): { g: Graph; bsv: { on: boolean }; dir: string } {
  const m = mkGraph();
  m.bsv.on = true;
  applySeedPack(m.g, loadBsvSeed(BSV_SEED_PATH));
  return { g: m.g, bsv: m.bsv, dir: m.dir };
}

async function connect(g: Graph, agentId: string) {
  const cfg = buildKgToolsServer(g, agentId);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(st);
  const client = new Client({ name: 'bsv-pack-test', version: '0.0.0' });
  await client.connect(ct);
  closers.push(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n'), isError: r.isError === true };
  };
}

// ---------------------------------------------------------------- 3. the wallet-choice node is found

test('kg_search finds bsv-wallet-choice in the top 3 for "HandCash" and for "monthly limit"', async () => {
  const { g } = bundledGraph();
  for (const q of ['HandCash', 'monthly limit']) {
    const top = g.search(ASSAYER, q, { scope: 'bsv', limit: 3 }).map((h) => h.node.id);
    assert.ok(top.includes('bsv-wallet-choice'), `${q}: ${top.join(', ')}`);
  }
  // through the real tool as well
  const call = await connect(g, 'assayer');
  const r = await call('kg_search', { query: 'HandCash', scope: 'bsv', limit: 3 });
  assert.match(r.text, /bsv-wallet-choice/);
});

// ---------------------------------------------------------------- 4. scoped recall

test('kg_recall scope bsv: a decoy shared note linked to a pack node neither ranks nor shows up as related; a safety lesson is in the top 3', async () => {
  const { g } = bundledGraph();
  const decoy = g.upsertNode(agentActor('scout'), { title: 'Safe to let an agent pay small amounts without approval', body: 'Small payments by an agent are fine without any approval step.' }).node;
  // a bot can no longer link onto a pack node (review F9), so the decoy is wired in by the human, which is the case recall still has to resist
  assert.throws(() => g.link(agentActor('scout'), { from: decoy.id, to: 'bsv-safety-spend-caps-approval', rel: 'relates' }), /read-only for bots/);
  g.link(HUMAN, { from: decoy.id, to: 'bsv-safety-spend-caps-approval', rel: 'relates' });
  const q = 'is it safe to let an agent pay';
  const call = await connect(g, 'assayer');

  const open = await call('kg_recall', { query: q });
  assert.match(open.text, new RegExp(decoy.id), 'unscoped recall does let the decoy compete (this is why the scope exists)');

  const scoped = await call('kg_recall', { query: q, scope: 'bsv' });
  assert.equal(scoped.isError, false, scoped.text);
  assert.doesNotMatch(scoped.text, new RegExp(decoy.id));
  assert.doesNotMatch(scoped.text, /Safe to let an agent pay small amounts/);
  const ids = [...scoped.text.matchAll(/\(id (bsv-[A-Za-z0-9._:-]+),/g)].map((m) => m[1]!);
  assert.ok(ids.slice(0, 3).some((id) => /^bsv-(safety-|brc181-)/.test(id)), `top 3 hits: ${ids.slice(0, 3).join(', ')}`);
  // the graph-level API says the same, and neighbours are restricted too
  const r = g.recall(ASSAYER, q, { scope: 'bsv' });
  assert.ok(!r.nodeIds.includes(decoy.id));
  assert.ok(r.nodeIds.every((id) => g.getNode(ASSAYER, id)?.scope === 'bsv'), 'every hit and related line is in scope bsv');
});

test('kg_recall scope still respects visibility: bsv hidden while BSV is off, private scopes stay private, bad scope is refused', async () => {
  const { g, bsv } = bundledGraph();
  const call = await connect(g, 'assayer');
  assert.match((await call('kg_recall', { query: 'testnet wallet', scope: 'bsv' })).text, /bsv-/);
  bsv.on = false;
  assert.match((await call('kg_recall', { query: 'testnet wallet', scope: 'bsv' })).text, /No matching nodes/);
  bsv.on = true;
  g.upsertNode(agentActor('scout'), { title: 'Scout private plan about testnet wallet', scope: 'agent:scout' });
  g.upsertNode(ASSAYER, { title: 'Assayer private testnet wallet scratch', scope: 'agent:assayer' });
  const priv = await call('kg_recall', { query: 'testnet wallet scratch', scope: 'private' });
  assert.match(priv.text, /Assayer private/);
  assert.doesNotMatch(priv.text, /Scout private/);
  assert.equal(g.recall(ASSAYER, 'testnet wallet', { scope: 'agent:scout' }).nodeIds.length, 0, "another bot's private scope is empty");
  const bad = await call('kg_recall', { query: 'testnet', scope: 'everything' }).catch((e: unknown) => ({ text: String(e), isError: true }));
  assert.equal(bad.isError, true);
});

// ---------------------------------------------------------------- 6. the pack upgrade

const src = (id: string) => [{ ref: `https://docs.test/${id}`, licence: 'CC BY 4.0' }];
const node = (id: string, body: string, extra: Record<string, unknown> = {}) => ({ id, type: 'lesson', title: `Title ${id}`, body, tags: ['bsv'], sources: src(id), confidence: 0.8, ...extra });
const edge = (from: string, to: string, rel = 'relates') => ({ from, to, rel });

const packV1 = () => ({
  version: 1,
  nodes: [
    node('bsv-curriculum-index', 'index text v1', { type: 'concept', props: { module: 'index' } }),
    node('bsv-tx-fees', 'fees text v1'),
    node('bsv-utxo-model', 'utxo text v1'),
    node('bsv-dropped-later', 'this node leaves the pack in v2'),
  ],
  edges: [edge('bsv-tx-fees', 'bsv-curriculum-index', 'part_of'), edge('bsv-utxo-model', 'bsv-curriculum-index', 'part_of'), edge('bsv-dropped-later', 'bsv-curriculum-index', 'part_of')],
});
const packV2 = () => ({
  version: 2,
  nodes: [
    node('bsv-curriculum-index', 'index text v2', { type: 'concept', props: { module: 'index' } }),
    node('bsv-tx-fees', 'fees text v2'),
    node('bsv-utxo-model', 'utxo text v2'),
    node('bsv-brand-new', 'a node that only v2 has'),
  ],
  edges: [edge('bsv-tx-fees', 'bsv-curriculum-index', 'part_of'), edge('bsv-utxo-model', 'bsv-curriculum-index', 'part_of'), edge('bsv-brand-new', 'bsv-curriculum-index', 'part_of'), edge('bsv-brand-new', 'bsv-utxo-model')],
});

async function setup(seedPath: string) {
  const f = makeFakes();
  f.agents.set(ASSAYER_ID, { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' });
  const dataDir = cleanupTemp('legion-bsvpack-');
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port: 4747, authToken: 'x', workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {} }, null, 2));
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const bsvEnabled = () => state.enabled;
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled };
  const kg: CoreModule = createKnowledgeModule(deps, { debounceMs: 20, seedPath });
  const bsv = createBsvModule(deps, { state, kg });
  f.ctx.modules = [kg, bsv];
  f.ctx.bsvEnabled = bsvEnabled;
  const srv = await start(f.ctx);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.base + path, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  closers.push(async () => { await kg.dispose?.(); await srv.close(); });
  return { state, dataDir, call, toggle: async (on: boolean) => (await call('POST', '/api/bsv', { enabled: on })).body };
}
const getNode = async (s: Awaited<ReturnType<typeof setup>>, id: string) => (await s.call('GET', `/api/kg/nodes/${id}`)).body?.node;

test('upgrade: a human edit survives, new nodes arrive, an untouched node takes the new text, nothing is deleted, version 2 is stored on the index', async () => {
  const dir = cleanupTemp('legion-bsvpack-seed-');
  const path = join(dir, 'bsv.json');
  writeFileSync(path, JSON.stringify(packV1()));
  const s = await setup(path);

  const first = (await s.toggle(true)).seed;
  assert.equal(first.status, 'loaded');
  assert.deepEqual([first.from, first.to, first.created, first.skippedEdited], [0, 1, 4, []]);
  assert.equal((await getNode(s, 'bsv-curriculum-index')).props.seedVersion, 1);
  const stored = (await getNode(s, 'bsv-tx-fees')).props.seedHash;
  assert.match(stored, /^[0-9a-f]{16}$/, 'every seeded node carries the hash of what it was seeded with');

  // the human edits bsv-tx-fees
  const edit = await s.call('POST', '/api/kg/nodes', { id: 'bsv-tx-fees', body: 'MY OWN FEE NOTES' });
  assert.equal(edit.status, 200);

  // same version again (a plain re-seed, the Lattice button): nothing is written, the edit stays
  const plain = await s.call('POST', '/api/kg/seed/bsv');
  assert.equal(plain.body.status, 'already-loaded');
  assert.deepEqual([plain.body.created, plain.body.updated, plain.body.edges], [0, 0, 0]);
  assert.equal((await getNode(s, 'bsv-tx-fees')).body, 'MY OWN FEE NOTES');
  // even when the bundled text changed but the version did not, a re-seed does not touch anything
  const sameVersion = packV2(); sameVersion.version = 1;
  // (same text change, no new node: a node that is simply missing is repaired at the same version, see bsv-review-seed.test.ts)
  sameVersion.nodes = sameVersion.nodes.filter((n) => n.id !== 'bsv-brand-new');
  sameVersion.edges = sameVersion.edges.filter((e) => e.from !== 'bsv-brand-new');
  writeFileSync(path, JSON.stringify(sameVersion));
  assert.equal((await s.call('POST', '/api/kg/seed/bsv')).body.status, 'already-loaded');
  assert.equal((await getNode(s, 'bsv-utxo-model')).body, 'utxo text v1');

  // the bundled pack moves to version 2; toggle off and on
  writeFileSync(path, JSON.stringify(packV2()));
  await s.toggle(false);
  const up = (await s.toggle(true)).seed;
  assert.equal(up.status, 'upgraded');
  assert.deepEqual([up.from, up.to], [1, 2]);
  assert.deepEqual(up.skippedEdited, ['bsv-tx-fees']);
  assert.equal(up.added, 1);
  assert.ok(up.updated >= 2, `updated ${up.updated}`);
  assert.equal(up.edges, 2, 'two new edges; the existing ones were kept');

  assert.equal((await getNode(s, 'bsv-tx-fees')).body, 'MY OWN FEE NOTES', 'the human edit survived');
  assert.equal((await getNode(s, 'bsv-utxo-model')).body, 'utxo text v2', 'an untouched node took the v2 text');
  assert.equal((await getNode(s, 'bsv-curriculum-index')).body, 'index text v2');
  assert.equal((await getNode(s, 'bsv-brand-new')).body, 'a node that only v2 has');
  assert.equal((await getNode(s, 'bsv-curriculum-index')).props.seedVersion, 2);
  assert.ok(await getNode(s, 'bsv-dropped-later'), 'a node the new pack dropped is never deleted or archived');
  const brandNew = (await s.call('GET', '/api/kg/nodes/bsv-brand-new')).body;
  assert.equal(brandNew.edges.out.length, 2);
  assert.ok(readdirSync(join(s.dataDir, 'kg')).some((f) => /^graph\.jsonl\.bak-\d+$/.test(f)), 'a snapshot was taken before the upgrade wrote');

  // idempotent at the bundled version: the next toggle does nothing and the edit still stands
  await s.toggle(false);
  const again = (await s.toggle(true)).seed;
  assert.equal(again.status, 'already-loaded');
  assert.deepEqual([again.created, again.updated, again.edges], [0, 0, 0]);
  assert.equal((await getNode(s, 'bsv-tx-fees')).body, 'MY OWN FEE NOTES');
});

test('upgrade: an edited index node still moves to the new version (the upgrade does not repeat), and is listed as edited', async () => {
  const dir = cleanupTemp('legion-bsvpack-seed-');
  const path = join(dir, 'bsv.json');
  writeFileSync(path, JSON.stringify(packV1()));
  const s = await setup(path);
  await s.toggle(true);
  await s.call('POST', '/api/kg/nodes', { id: 'bsv-curriculum-index', body: 'my own index text' });
  writeFileSync(path, JSON.stringify(packV2()));
  const r = await s.call('POST', '/api/kg/seed/bsv');
  assert.equal(r.body.status, 'upgraded');
  assert.deepEqual(r.body.skippedEdited, ['bsv-curriculum-index']);
  assert.equal((await getNode(s, 'bsv-curriculum-index')).body, 'my own index text');
  assert.equal((await getNode(s, 'bsv-curriculum-index')).props.seedVersion, 2);
  assert.equal((await s.call('POST', '/api/kg/seed/bsv')).body.status, 'already-loaded');
});

test('a human note written to scope bsv first no longer blocks seeding', async () => {
  const dir = cleanupTemp('legion-bsvpack-seed-');
  const path = join(dir, 'bsv.json');
  writeFileSync(path, JSON.stringify(packV1()));
  const s = await setup(path);
  s.state.set(true); // on, but the pack is not loaded yet
  const note = await s.call('POST', '/api/kg/nodes', { title: 'My own BSV project note', body: 'written before the pack', scope: 'bsv', sources: [{ ref: 'https://me.test', licence: 'mine' }] });
  assert.equal(note.status, 200);
  const r = (await s.toggle(true)).seed;
  assert.equal(r.status, 'loaded', 'the human note does not make the pack look loaded');
  assert.equal(r.created, 4);
  assert.ok((await s.call('GET', `/api/kg/nodes/${note.body.node.id}`)).body.node, 'and the note is still there');
  assert.equal((await s.call('GET', '/api/kg/stats')).body.byScope.bsv, 5);
});

test('the bundled pack carries a seedHash on every node and seedVersion 9 on the index', () => {
  const { g } = bundledGraph();
  const pack = loadBsvSeed(BSV_SEED_PATH);
  assert.equal(pack.version, 9);
  for (const n of pack.nodes) assert.match(String(g.getNode(HUMAN, n.id)!.props?.seedHash), /^[0-9a-f]{16}$/, n.id);
  assert.equal(g.getNode(HUMAN, 'bsv-curriculum-index')!.props!.seedVersion, 9);
  assert.equal(applySeedPack(g, pack).status, 'already-loaded');
});

test('an install from before hashes: untouched nodes (even ones a system re-seed rewrote) upgrade, a human edit is skipped', () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../test/fixtures/bsv-v1-nodes.json', import.meta.url)), 'utf8')) as { nodes: Array<Record<string, any>> };
  const { g, bsv } = mkGraph();
  bsv.on = true;
  const input = (n: Record<string, any>) => ({ id: n.id, type: n.type, title: n.title, body: n.body, tags: n.tags, scope: 'bsv' as const, props: n.props, sources: n.sources, confidence: n.confidence });
  for (const n of fixture.nodes) g.upsertNode(SYSTEM, input(n)); // the version-1 install: no seedHash, no seedVersion
  // a system re-seed once rewrote this one without changing its text: rev 2, but never edited
  const tn = fixture.nodes.find((n) => n.id === 'bsv-teranode-networks')!;
  g.upsertNode(SYSTEM, { id: tn.id, props: { ...tn.props, touched: true } });
  assert.equal(g.getNode(HUMAN, tn.id)!.rev, 2);
  // and a human edits this one
  g.upsertNode(HUMAN, { id: 'bsv-safety-spend-caps-approval', body: 'my own take on spend caps' });

  const r = applySeedPack(g, loadBsvSeed(BSV_SEED_PATH));
  assert.equal(r.status, 'upgraded');
  assert.deepEqual([r.from, r.to], [1, 9]);
  assert.deepEqual(r.skippedEdited, ['bsv-safety-spend-caps-approval']);
  assert.match(g.getNode(HUMAN, tn.id)!.body, /Association's own release page confirms/, 'the rev-2 node was never edited, so it took the folded text');
  assert.doesNotMatch(g.getNode(HUMAN, tn.id)!.body, /Update \(/);
  assert.equal(g.getNode(HUMAN, 'bsv-safety-spend-caps-approval')!.body, 'my own take on spend caps');
  assert.ok(g.getNode(HUMAN, 'bsv-wallet-choice') && g.getNode(HUMAN, 'bsv-status-today'), 'new nodes were added');
  assert.equal(applySeedPack(g, loadBsvSeed(BSV_SEED_PATH)).status, 'already-loaded');
});

// ---------------------------------------------------------------- 7. pack v8: upgrade from a real v7 install (T4)

const V7_PATH = fileURLToPath(new URL('../../test/fixtures/bsv-pack-v7.json', import.meta.url));

test('v8 upgrade: from the shipped v7 pack, edited notes stay, untouched notes take the new text, six new notes arrive, no id is lost, the count is exactly the bundled count plus the owner\'s own', () => {
  const v7 = loadBsvSeed(V7_PATH);
  const v8 = loadBsvSeed(BSV_SEED_PATH);
  assert.equal(v7.version, 7);
  assert.equal(v7.nodes.length, 157, 'the fixture is the pack that shipped at version 7');
  assert.equal(v8.version, 9, 'the bundled pack (v9 since 2026-10-06) still upgrades a v7 install the same way');
  const v7ids = new Set(v7.nodes.map((n) => n.id));
  const v8ids = new Set(v8.nodes.map((n) => n.id));
  for (const id of v7ids) assert.ok(v8ids.has(id), `v8 dropped the node ${id}: an upgrade must never lose a note`);
  const added = [...v8ids].filter((id) => !v7ids.has(id)).sort();
  assert.deepEqual(added, ['bsv-safety-owner-checks', 'bsv-safety-real-wallet-facts', 'bsv-safety-spend-dialogs', 'bsv-safety-spend-flow', 'bsv-safety-spend-network-caps', 'bsv-safety-unknown-outcome']);
  assert.equal(v8.nodes.length, 163);
  assert.equal(v8.edges.length, 727);
  const v7edges = new Set(v7.edges.map((e) => `${e.from}|${e.rel}|${e.to}`));
  for (const e of v7.edges) assert.ok(v8.edges.some((x) => x.from === e.from && x.rel === e.rel && x.to === e.to), `v8 dropped a link ${e.from} ${e.rel} ${e.to}`);
  assert.equal(v7edges.size, v7.edges.length);

  const { g, bsv } = mkGraph();
  bsv.on = true;
  assert.equal(applySeedPack(g, v7).status, 'loaded');
  const bsvCount = () => g.stats(HUMAN).byScope.bsv ?? 0;
  assert.equal(bsvCount(), 157);
  // the owner edits two notes (one the v8 pack rewrites, one it does not) and adds a note of their own
  g.upsertNode(HUMAN, { id: 'bsv-status-today', body: 'MY STATUS NOTES (the owner wrote this)' });
  g.upsertNode(HUMAN, { id: 'bsv-safety-audit-freeze', body: 'my own audit and freeze notes' });
  g.upsertNode(HUMAN, { id: 'owner-bsv-note', title: 'My own BSV note', body: 'mine', scope: 'bsv', type: 'concept', tags: ['bsv'] });
  assert.equal(bsvCount(), 158);

  const r = applySeedPack(g, v8);
  assert.equal(r.status, 'upgraded');
  assert.deepEqual([r.from, r.to], [7, 9]);
  assert.equal(r.created, 6, 'exactly the new nodes');
  assert.deepEqual([...r.skippedEdited].sort(), ['bsv-safety-audit-freeze', 'bsv-status-today'], 'the owner\'s edits are reported and untouched');
  assert.equal(g.getNode(HUMAN, 'bsv-status-today')!.body, 'MY STATUS NOTES (the owner wrote this)');
  assert.equal(g.getNode(HUMAN, 'bsv-safety-audit-freeze')!.body, 'my own audit and freeze notes');
  assert.equal(bsvCount(), 163 + 1, 'the bundled count plus the owner\'s own note, nothing lost, nothing doubled');
  assert.ok(g.getNode(HUMAN, 'owner-bsv-note'));
  for (const id of v8ids) assert.ok(g.getNode(HUMAN, id), `${id} is in the graph after the upgrade`);
  // an untouched note takes the new truth (and no longer says there is no spend tool)
  const fees = g.getNode(HUMAN, 'bsv-tx-fees')!;
  assert.match(fees.body, /Legion's spend tool refuses a transaction whose fee/);
  assert.doesNotMatch(fees.body, /has no spend tool/);
  assert.equal(g.getNode(HUMAN, 'bsv-curriculum-index')!.props!.seedVersion, 9);
  // idempotent: the same pack again writes nothing and keeps the edits
  assert.equal(applySeedPack(g, v8).status, 'already-loaded');
  assert.equal(g.getNode(HUMAN, 'bsv-status-today')!.body, 'MY STATUS NOTES (the owner wrote this)');
});

test('v8 upgrade: a note the owner deleted at v7 stays deleted, and no v8 note says what v7 said about having no spend tool', () => {
  const v7 = loadBsvSeed(V7_PATH);
  const v8 = loadBsvSeed(BSV_SEED_PATH);
  const { g, bsv } = mkGraph();
  bsv.on = true;
  applySeedPack(g, v7);
  g.deleteNode(HUMAN, 'bsv-sound-events');
  const r = applySeedPack(g, v8);
  assert.deepEqual(r.skippedRemoved, ['bsv-sound-events']);
  assert.equal(g.getNode(HUMAN, 'bsv-sound-events'), undefined);
  // what the upgrade now carries
  const old = v7.nodes.filter((n) => /no spend tool|has no spend tool|no tool that signs|cannot sign|nothing consumes|no wallet connection beyond/i.test(n.body ?? '')).map((n) => n.id);
  assert.ok(old.length >= 4, `the v7 pack had the old claims in ${old.length} nodes: the check is exercising something`);
  for (const id of old) assert.doesNotMatch(v8.nodes.find((n) => n.id === id)!.body ?? '', /no spend tool|has no spend tool|no tool that signs|cannot sign|nothing consumes|no wallet connection beyond/i, `${id} still carries the old claim`);
});

// ---------------------------------------------------------------- 8. pack v9: upgrade from a real v8 install (the wallet's prompt is no longer stated as the last gate)

const V8_PATH = fileURLToPath(new URL('../../test/fixtures/bsv-pack-v8.json', import.meta.url));
const V9_REWRITTEN = ['bsv-safety-overview', 'bsv-safety-keys-never-in-legion', 'bsv-safety-mainnet-armed-native', 'bsv-antipattern-trust-chain-text', 'bsv-assayer-playbook', 'bsv-status-today', 'bsv-wallet-choice', 'bsv-safety-spend-flow', 'bsv-safety-spend-dialogs', 'bsv-safety-owner-checks', 'bsv-safety-real-wallet-facts', 'bsv-brc181-agent-spend-policy'];

test('v9 upgrade: from the shipped v8 pack, untouched notes take the new wallet-prompt text, an edited note stays, nothing is added or lost', () => {
  const v8 = loadBsvSeed(V8_PATH);
  const v9 = loadBsvSeed(BSV_SEED_PATH);
  assert.equal(v8.version, 8);
  assert.equal(v8.nodes.length, 163, 'the fixture is the pack that shipped at version 8');
  assert.equal(v9.version, 9);
  assert.deepEqual(v9.nodes.map((n) => n.id).sort(), v8.nodes.map((n) => n.id).sort(), 'v9 rewrites text only: same notes');
  assert.equal(v9.edges.length, v8.edges.length);
  for (const id of V9_REWRITTEN) assert.notEqual(v9.nodes.find((n) => n.id === id)!.body, v8.nodes.find((n) => n.id === id)!.body, `${id} has new text in v9`);
  assert.match(v8.nodes.find((n) => n.id === 'bsv-safety-spend-flow')!.body!, /the wallet shows its own prompt, which is the last gate/, 'the fixture carries the old claim: the upgrade check exercises something');

  const { g, bsv } = mkGraph();
  bsv.on = true;
  assert.equal(applySeedPack(g, v8).status, 'loaded');
  g.upsertNode(HUMAN, { id: 'bsv-safety-spend-dialogs', body: 'my own dialog notes' });
  const r = applySeedPack(g, v9);
  assert.equal(r.status, 'upgraded');
  assert.deepEqual([r.from, r.to], [8, 9]);
  assert.equal(r.created, 0);
  assert.deepEqual(r.skippedEdited, ['bsv-safety-spend-dialogs']);
  assert.equal(g.getNode(HUMAN, 'bsv-safety-spend-dialogs')!.body, 'my own dialog notes');
  const flow = g.getNode(HUMAN, 'bsv-safety-spend-flow')!;
  assert.match(flow.body, /These dialogs are the per-spend gate/);
  assert.doesNotMatch(flow.body, /last gate/);
  assert.doesNotMatch(flow.title, /wallet's prompt/);
  assert.match(g.getNode(HUMAN, 'bsv-wallet-choice')!.body, /the order depends on the wallet/);
  assert.match(g.getNode(HUMAN, 'bsv-brc181-agent-spend-policy')!.body, /BRC-204/);
  assert.equal(g.stats(HUMAN).byScope.bsv, 163);
  assert.equal(g.getNode(HUMAN, 'bsv-curriculum-index')!.props!.seedVersion, 9);
  assert.equal(applySeedPack(g, v9).status, 'already-loaded');
  assert.equal(g.getNode(HUMAN, 'bsv-safety-spend-dialogs')!.body, 'my own dialog notes');
});
