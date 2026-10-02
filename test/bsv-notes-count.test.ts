/**
 * The title-bar number ("<n> BSV notes") and its explanation, against a REAL Graph with the bundled pack (163 notes, version 8) and the bsv
 * scope enabled. Every way the number can differ from 163 is one test: deleted, merged, archived, superseded, held, moved out of scope, purged,
 * the pack not loaded or only partly, an older installed pack version, notes the owner added, a restore, a failed or malformed count.
 * The old figure (`stats.byScope.bsv`, which counts retired notes too) is compared side by side so the difference is visible.
 * Hermetic: temp folders and the module's own routes; no wallet, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applySeedPack, loadBsvSeed, summarizeBsvPack } from '../src/core/kg/seed.js';
import type { SeedPack } from '../src/core/kg/seed.js';
import { createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { knowledgeExplain, knowledgeShort, KNOWLEDGE_STALE_MS, overlayModel } from '../src/shared/bsv-view.js';
import type { KnowledgeSummary } from '../src/shared/bsv-view.js';
import { HUMAN, mkGraph } from './kg-helpers.js';
import { makeFakes, mkAgent } from './helpers-c.js';

const PACK = loadBsvSeed();
const IDS = PACK.nodes.map((n) => n.id);
const DAY = 86_400_000;

function fresh() {
  const clock = { t: Date.now() };
  const m = mkGraph({ now: () => new Date(clock.t) });
  m.bsv.on = true;
  return { ...m, clock };
}
const seeded = () => { const m = fresh(); applySeedPack(m.g, PACK); return m; };
const sum = (g: ReturnType<typeof mkGraph>['g']) => summarizeBsvPack(g);
const statsBsv = (g: ReturnType<typeof mkGraph>['g']) => g.stats(HUMAN).byScope.bsv ?? 0;
/** bundled = packActive + retired + moved + removed + notLoaded, always */
const identity = (s: KnowledgeSummary) => assert.equal(s.packActive + s.retired + s.moved + s.removed + s.notLoaded, s.bundled.count, JSON.stringify(s));
const PICK = (i: number) => IDS.filter((id) => id !== 'bsv-curriculum-index')[i]!;

test('the bundled pack is 163 notes, version 8 (the number the summary compares against)', () => {
  assert.equal(PACK.nodes.length, 163);
  assert.equal(PACK.version, 8);
  assert.equal(JSON.parse(readFileSync(new URL('../../src/core/kg/seeds/bsv.json', import.meta.url), 'utf8')).nodes.length, 163);
});

test('fresh seed: 163 live notes, nothing removed, added or missing; the old figure agrees', () => {
  const { g } = seeded();
  const s = sum(g);
  assert.deepEqual({ n: s.inGraph, b: s.bundled, a: s.removedOrMerged, add: s.added, miss: s.missing, v: s.loadedVersion }, { n: 163, b: { count: 163, version: 8 }, a: 0, add: 0, miss: 0, v: 8 });
  assert.equal(statsBsv(g), 163);
  identity(s);
  assert.equal(knowledgeShort(s.inGraph, s), '163 BSV notes');
  assert.match(knowledgeExplain(s), /^bundled pack: 163 notes \(version 8\); in your graph: 163; removed or merged by you or a bot: 0; added by you: 0; missing: 0$/);
});

test('the owner deletes pack notes: the number drops by exactly that many, the ids are on the missing list, and the explanation says so', () => {
  const { g } = seeded();
  const a = PICK(0); const b = PICK(1);
  g.deleteNode(HUMAN, a); g.deleteNode(HUMAN, b);
  const s = sum(g);
  assert.equal(s.inGraph, 161); assert.equal(statsBsv(g), 161);
  assert.deepEqual({ removed: s.removed, notLoaded: s.notLoaded, missing: s.missing, rm: s.removedOrMerged }, { removed: 2, notLoaded: 0, missing: 2, rm: 2 });
  assert.deepEqual([...s.missingIds].sort(), [a, b].sort());
  identity(s);
  assert.equal(knowledgeShort(161, s), '161 BSV notes (pack 163)');
  assert.match(knowledgeExplain(s), /in your graph: 161; removed or merged by you or a bot: 2; added by you: 0; missing: 2 \(2 deleted by you\)/);
});

test('merging notes (by the owner) retires the dropped ones: the old figure still says 163, the live count says 161', () => {
  const { g } = seeded();
  g.merge(HUMAN, PICK(0), [PICK(1), PICK(2)]);
  const s = sum(g);
  assert.equal(statsBsv(g), 163, 'the old figure counts retired notes: this is how the title bar could look unchanged and then drop later');
  assert.equal(s.inGraph, 161);
  assert.deepEqual({ retired: s.retired, removed: s.removed, missing: s.missing, rm: s.removedOrMerged }, { retired: 2, removed: 0, missing: 0, rm: 2 });
  identity(s);
});

test('a retired (merged, archived) note is purged after 30 days: the old figure drops by itself then; the pack note moves to "deleted" and stays off until restored', () => {
  const { g, clock } = seeded();
  g.merge(HUMAN, PICK(0), [PICK(1)]);
  g.setStatus(HUMAN, PICK(3), 'archived');
  assert.equal(statsBsv(g), 163);
  clock.t += 31 * DAY;
  assert.equal(g.purgeTombstones(), 2);
  assert.equal(statsBsv(g), 161, 'the figure fell with no action by the owner that day');
  const s = sum(g);
  assert.deepEqual({ n: s.inGraph, retired: s.retired, removed: s.removed, miss: s.missing }, { n: 161, retired: 0, removed: 2, miss: 2 });
  identity(s);
  assert.match(knowledgeExplain(s), /2 deleted by you/);
});

test('archive, supersede and a note held for review are retired, not live, and listed as such', () => {
  const { g } = seeded();
  g.setStatus(HUMAN, PICK(0), 'archived');
  g.setStatus(HUMAN, PICK(1), 'pending');
  g.upsertNode(HUMAN, { id: 'my-new', title: 'Mine', scope: 'bsv' });
  g.supersede(HUMAN, PICK(2), 'my-new');
  const s = sum(g);
  assert.equal(s.retired, 3);
  assert.equal(s.inGraph, 160 + 1, '163 - 3 retired + the owner\'s live note');
  assert.equal(s.added, 1);
  identity(s);
  assert.match(knowledgeExplain(s), /3 still in the graph but retired/);
});

test('moving a pack note out of the bsv scope: not counted, not offered for restore (a restore would overwrite it)', () => {
  const { g } = seeded();
  g.upsertNode(HUMAN, { id: PICK(0), scope: 'shared' });
  const s = sum(g);
  assert.equal(s.inGraph, 162); assert.equal(statsBsv(g), 162);
  assert.equal(s.moved, 1);
  assert.ok(!s.missingIds.includes(PICK(0)), 'it exists, so it is not "missing"');
  assert.equal(s.missing, 0);
  identity(s);
  assert.match(knowledgeExplain(s), /1 moved out of the BSV scope/);
});

test('notes the owner added with scope bsv make the number HIGHER than the pack (the owner may have seen 190)', () => {
  const { g } = seeded();
  for (let i = 0; i < 27; i++) g.upsertNode(HUMAN, { id: `mine-${i}`, title: `My BSV note ${i}`, scope: 'bsv' });
  const s = sum(g);
  assert.equal(s.inGraph, 190); assert.equal(statsBsv(g), 190);
  assert.equal(s.added, 27);
  assert.equal(knowledgeShort(190, s), '190 BSV notes (pack 163)');
  assert.match(knowledgeExplain(s), /in your graph: 190; removed or merged by you or a bot: 0; added by you: 27; missing: 0/);
  identity(s);
});

test('the pack was never loaded: 0 live notes, 163 not loaded (not "deleted"); a restore of the missing ids loads all of them', () => {
  const { g } = fresh();
  const s = sum(g);
  assert.deepEqual({ n: s.inGraph, nl: s.notLoaded, rm: s.removed, miss: s.missing, v: s.loadedVersion }, { n: 0, nl: 163, rm: 0, miss: 163, v: 0 });
  identity(s);
  assert.equal(knowledgeShort(0, s), '0 BSV notes (pack 163)');
  applySeedPack(g, PACK, { restore: s.missingIds });
  assert.equal(sum(g).inGraph, 163);
});

test('a partly loaded pack (a crash half way, or an old small pack) shows the gap as "not loaded", and the plain seed fills it', () => {
  const { g } = fresh();
  const half: SeedPack = { ...PACK, version: 1, nodes: PACK.nodes.slice(0, 84), edges: [] };
  applySeedPack(g, half);
  const s = sum(g);
  assert.equal(s.inGraph, 84, 'the very first pack had 84 notes: an install that stopped there shows 84');
  assert.deepEqual({ nl: s.notLoaded, rm: s.removed, v: s.loadedVersion }, { nl: 79, rm: 0, v: 1 });
  identity(s);
  assert.match(knowledgeExplain(s), /installed pack version: 1.*79 not loaded yet/);
  applySeedPack(g, PACK);
  assert.equal(sum(g).inGraph, 163);
  assert.equal(sum(g).loadedVersion, 8);
});

test('an older installed pack version with all notes present: the count is 163 but the explanation names the version', () => {
  const { g } = fresh();
  applySeedPack(g, { ...PACK, version: 5 });
  const s = sum(g);
  assert.equal(s.inGraph, 163);
  assert.equal(s.loadedVersion, 5);
  assert.match(knowledgeExplain(s), /installed pack version: 5/);
});

test('restore: only notes that are not in the graph at all are named, so an edited note keeps the owner\'s text; the number returns to 163', () => {
  const { g } = seeded();
  const gone = PICK(0); const edited = PICK(1);
  g.deleteNode(HUMAN, gone);
  g.upsertNode(HUMAN, { id: edited, body: 'my own words that I wrote myself about this' });
  g.merge(HUMAN, PICK(2), [PICK(3)]); // retired: not offered
  const s = sum(g);
  assert.deepEqual(s.missingIds, [gone]);
  const r = applySeedPack(g, PACK, { restore: s.missingIds });
  assert.deepEqual(r.restored, [gone]);
  assert.equal(g.getNode(HUMAN, edited)!.body, 'my own words that I wrote myself about this');
  const after = sum(g);
  assert.equal(after.inGraph, 162, 'the merged note is still retired');
  assert.equal(after.removed, 0);
  assert.equal(after.retired, 1);
  identity(after);
});

test('BSV mode off: the bsv scope is hidden, so the old figure has no bsv entry; the module reports no summary', async () => {
  const m = fresh(); applySeedPack(m.g, PACK);
  m.bsv.on = false;
  assert.equal(m.g.stats(HUMAN).byScope.bsv, undefined);
});

// ---- a failed, malformed or slow count is unknown (null), never 0

async function statusWith(kgRoute: (() => unknown) | 'missing', enabled = true) {
  const f = makeFakes();
  f.agents.set('assayer', { ...mkAgent('assayer', 'Assayer'), requires: 'bsv' });
  const dataDir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'legion-bsvn-'));
  const cfg = f.ctx.config as any; if (enabled) cfg.bsv = { enabled: true, network: 'testnet' };
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => state.enabled };
  const kg = kgRoute === 'missing' ? undefined : ({ name: 'kg', routes: (add: any) => { add('GET', '/api/kg/seed/bsv', () => kgRoute()); } } as any);
  const bsv = createBsvModule(deps, { state, kg });
  const handlers = new Map<string, any>();
  bsv.routes?.((method: string, pattern: string, h: any) => { handlers.set(`${method} ${pattern}`, h); });
  const h = handlers.get('GET /api/bsv');
  return h({ req: { headers: {} }, res: undefined, url: new URL('http://127.0.0.1/api/bsv'), params: [], body: undefined });
}
const good = (over: Record<string, unknown> = {}) => ({ bundled: { count: 157, version: 7 }, inGraph: 84, packActive: 84, retired: 0, moved: 0, removed: 0, notLoaded: 73, removedOrMerged: 0, added: 0, addedRetired: 0, missing: 73, missingIds: ['a'], loadedVersion: 7, ...over });

test('count failures show unknown (null), never 0: the route throws, the answer is malformed, the kg module is absent', async () => {
  const ok = await statusWith(() => good());
  assert.equal(ok.knowledgeNodes, 84); assert.equal(ok.knowledge.bundled.count, 157);
  for (const [what, route] of [['throws', () => { throw new Error('boom'); }], ['null', () => null], ['string', () => 'x'], ['no bundled', () => ({ ...good(), bundled: undefined })], ['negative', () => good({ inGraph: -1 })], ['float', () => good({ inGraph: 1.5 })], ['text', () => good({ inGraph: '84' })], ['no ids', () => good({ missingIds: undefined })], ['bad id', () => good({ missingIds: [5] })]] as const) {
    const r = await statusWith(route);
    assert.equal(r.knowledgeNodes, null, what); assert.equal(r.knowledge, null, what); assert.equal(r.knowledgeLoaded, false, what);
  }
  const none = await statusWith('missing');
  assert.equal(none.knowledgeNodes, null, 'no kg module: unknown, not 0');
  const off = await statusWith(() => good(), false);
  assert.equal(off.knowledgeNodes, 0, 'BSV off: nothing is counted'); assert.equal(off.knowledge, null);
});

test('the real kg route returns the summary and refuses while BSV is off', async () => {
  const src = readFileSync(new URL('../../src/core/kg/routes.ts', import.meta.url), 'utf8');
  assert.match(src, /add\('GET', '\/api\/kg\/seed\/bsv'/);
  const route = src.slice(src.indexOf("add('GET', '/api/kg/seed/bsv'"), src.indexOf("add('POST', '/api/kg/seed/bsv'"));
  assert.match(route, /bsvEnabled\(\)/); assert.match(route, /summarizeBsvPack/);
  assert.doesNotMatch(route, /applySeedPack|upsertNode|link\(/, 'read only: no write path');
});

// ---- the words

test('title-bar words: a number with the pack count when they differ; unknown for null, junk or an old reading; the overlay never shows a bare 0 for unknown', () => {
  const k = good() as unknown as KnowledgeSummary;
  assert.equal(knowledgeShort(157, { ...k, bundled: { count: 157, version: 7 } }), '157 BSV notes');
  assert.equal(knowledgeShort(1, undefined), '1 BSV note');
  assert.equal(knowledgeShort(84, k), '84 BSV notes (pack 157)');
  for (const bad of [null, undefined, -1, 1.5, NaN, '84' as unknown as number]) assert.equal(knowledgeShort(bad, k), 'BSV notes: unknown');
  assert.equal(knowledgeShort(84, k, false), 'BSV notes: unknown', 'too old');
  const NOW = 1_000_000_000;
  const base = { enabled: true, policy: null, wallet: null, knowledge: k, now: NOW };
  assert.deepEqual(overlayModel({ ...base, nodes: 84, knowledgeLoaded: true, knowledgeAt: NOW - 1000 }).tiers[0]!.slice(1), ['84 BSV notes (pack 157)']);
  assert.deepEqual(overlayModel({ ...base, nodes: null, knowledgeLoaded: false, knowledgeAt: NOW - 1000 }).tiers[0]!.slice(1), ['BSV notes: unknown']);
  assert.deepEqual(overlayModel({ ...base, nodes: 157, knowledgeLoaded: true, knowledgeAt: NOW - KNOWLEDGE_STALE_MS - 1 }).tiers[0]!.slice(1), ['BSV notes: unknown'], 'a stale number is not shown');
  assert.deepEqual(overlayModel({ ...base, nodes: 0, knowledgeLoaded: false, knowledgeAt: NOW }).tiers[0]!.slice(1), ['0 BSV notes (pack 157)'], 'a real zero is shown as a zero, with the pack count');
});

test('the store: a failed or slow status read clears the count to unknown; the restore goes through the existing seed route and names only missing ids; the panel shows the explanation and a restore button only when notes are missing', () => {
  const store = readFileSync(new URL('../../ui/src/bsv/bsvStore.ts', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../../ui/src/bsv/BsvPanel.tsx', import.meta.url), 'utf8');
  assert.match(store, /catch \{[^}]*set\(\{ knowledgeNodes: null, knowledge: null, knowledgeLoaded: false \}\)/s);
  assert.match(store, /Promise\.race\(\[request<BsvStatus>\('GET', '\/api\/bsv'\)/);
  assert.match(store, /request<[^>]*>\('POST', '\/api\/kg\/seed\/bsv', \{ restore: ids \}\)/);
  assert.match(store, /const ids = state\.knowledge\?\.missingIds/);
  assert.match(panel, /k\.missing > 0/);
  assert.match(panel, /knowledgeExplain\(k\)/);
  assert.match(panel, /BSV notes: unknown\. The count could not be read just now; it is not zero\./);
  assert.doesNotMatch(panel + store, /X-Legion-Native|nativeSecret/);
});
