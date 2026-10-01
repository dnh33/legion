import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KG_LIMITS, KG_RELS } from '../src/shared/kg.js';
import type { KgEdge, KgNode } from '../src/shared/kg.js';

// Tests run from dist/test, so the seed is resolved from the repo root: dist/test -> repo -> src/core/kg/seeds.
const SEED_URL = new URL('../../src/core/kg/seeds/bsv.json', import.meta.url);

interface Seed { version: number; generatedAt: string; nodes: KgNode[]; edges: KgEdge[] }
const seed: Seed = JSON.parse(readFileSync(SEED_URL, 'utf8'));
const ids = new Set(seed.nodes.map((n) => n.id));
const words = (s: string) => s.trim().split(/\s+/).length;

test('bsv seed parses with the expected envelope and size', () => {
  assert.equal(seed.version, 4);
  assert.ok(!Number.isNaN(Date.parse(seed.generatedAt)));
  assert.ok(Array.isArray(seed.nodes) && Array.isArray(seed.edges));
  assert.ok(seed.nodes.length >= 45 && seed.nodes.length <= 220, `node count ${seed.nodes.length}`);
  assert.ok(seed.edges.length > seed.nodes.length - 1);
});

test('bsv seed ids are unique and edges are not dangling', () => {
  assert.equal(ids.size, seed.nodes.length, 'duplicate node id');
  const edgeIds = new Set(seed.edges.map((e) => e.id));
  assert.equal(edgeIds.size, seed.edges.length, 'duplicate edge id');
  for (const e of seed.edges) {
    assert.ok(ids.has(e.from), `dangling from in ${e.id}`);
    assert.ok(ids.has(e.to), `dangling to in ${e.id}`);
    assert.notEqual(e.from, e.to, `self loop ${e.id}`);
    assert.ok((KG_RELS as readonly string[]).includes(e.rel), `rel outside vocabulary: ${e.rel}`);
    assert.equal(e.createdBy, 'system');
  }
});

test('every bsv node is scoped, sourced, sized and attributed to the system', () => {
  const titles = new Set<string>();
  for (const n of seed.nodes) {
    assert.equal(n.scope, 'bsv', n.id);
    assert.equal(n.createdBy, 'system', n.id);
    assert.ok(['lesson', 'concept', 'source', 'entity'].includes(n.type), `${n.id} type ${n.type}`);
    assert.ok(Array.isArray(n.sources) && n.sources.length >= 1, `${n.id} has no sources`);
    for (const s of n.sources!) {
      assert.ok(s.ref && s.ref.length > 0, `${n.id} empty source ref`);
      assert.ok(s.licence && s.licence.length > 0, `${n.id} source without licence note`);
    }
    assert.ok(n.title.length > 0 && n.title.length <= KG_LIMITS.titleChars, `${n.id} title length`);
    assert.ok(n.body.length > 0 && n.body.length <= KG_LIMITS.bodyChars, `${n.id} body length`);
    const w = words(n.body);
    assert.ok(w >= 55 && w <= 240, `${n.id} body has ${w} words`);
    assert.ok(n.tags.includes('bsv'), `${n.id} missing bsv tag`);
    assert.ok(typeof n.confidence === 'number' && n.confidence >= 0.6 && n.confidence <= 0.9, `${n.id} confidence`);
    assert.ok(!Number.isNaN(Date.parse(n.createdAt)) && !Number.isNaN(Date.parse(n.updatedAt)), `${n.id} dates`);
    assert.ok(!titles.has(n.title), `duplicate title ${n.title}`);
    titles.add(n.title);
  }
});

test('bsv seed has no orphans and is one connected component', () => {
  const adj = new Map<string, Set<string>>();
  for (const id of ids) adj.set(id, new Set());
  for (const e of seed.edges) { adj.get(e.from)!.add(e.to); adj.get(e.to)!.add(e.from); }
  const orphans = [...ids].filter((id) => adj.get(id)!.size === 0);
  assert.deepEqual(orphans, []);
  const start = seed.nodes[0]!.id;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur)!) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  }
  assert.equal(seen.size, ids.size, `unreachable: ${[...ids].filter((i) => !seen.has(i)).join(', ')}`);
});

test('curriculum prerequisites (depends_on) form an acyclic graph', () => {
  const deps = new Map<string, string[]>();
  for (const e of seed.edges) if (e.rel === 'depends_on') (deps.get(e.from) ?? deps.set(e.from, []).get(e.from)!).push(e.to);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 2) return;
    assert.notEqual(state.get(id), 1, `depends_on cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of deps.keys()) visit(id, []);
  assert.ok(deps.size > 20, 'spine should have many prerequisite edges');
});

test('every lesson is reachable from the safety overview or the orientation lesson via prerequisites', () => {
  // Every lesson except the orientation root has at least one prerequisite.
  const hasDep = new Set(seed.edges.filter((e) => e.rel === 'depends_on').map((e) => e.from));
  for (const n of seed.nodes.filter((x) => x.type === 'lesson' && x.id !== 'bsv-orientation')) {
    assert.ok(hasDep.has(n.id), `${n.id} has no prerequisite`);
  }
});

test('safety lessons exist for each required rule and every one is linked to what it protects', () => {
  const required = [
    'bsv-safety-keys-never-in-legion',
    'bsv-safety-external-wallet',
    'bsv-safety-spend-caps-approval',
    'bsv-safety-untrusted-chain-data',
    'bsv-safety-no-blind-retries',
    'bsv-safety-mainnet-armed-native',
    'bsv-safety-testnet-default',
  ];
  for (const id of required) assert.ok(ids.has(id), `missing safety lesson ${id}`);
  const safety = seed.nodes.filter((n) => n.type === 'lesson' && n.tags.includes('safety'));
  assert.ok(safety.length >= required.length);
  const byId = new Map(seed.nodes.map((n) => [n.id, n]));
  for (const n of safety) {
    const out = seed.edges.filter((e) => e.from === n.id);
    const protects = out.filter((e) => e.rel === 'relates' && e.note === 'protects' && !byId.get(e.to)!.tags.includes('safety'));
    assert.ok(protects.length >= 1, `${n.id} is not linked to anything it protects`);
    assert.ok(out.some((e) => e.rel === 'part_of' && e.to === 'bsv-mod-safety'), `${n.id} not in the safety module`);
    assert.ok(out.some((e) => e.rel === 'depends_on'), `${n.id} has no prerequisite`);
    assert.ok(out.some((e) => e.rel === 'cites'), `${n.id} cites no source`);
  }
  // The non-safety curriculum is reachable from the safety overview by traversing prerequisites backwards.
  const dependents = new Map<string, string[]>();
  for (const e of seed.edges) if (e.rel === 'depends_on') (dependents.get(e.to) ?? dependents.set(e.to, []).get(e.to)!).push(e.from);
  const reach = new Set<string>(['bsv-orientation']);
  const queue = ['bsv-orientation'];
  while (queue.length) for (const d of dependents.get(queue.shift()!) ?? []) if (!reach.has(d)) { reach.add(d); queue.push(d); }
  for (const n of seed.nodes.filter((x) => x.type === 'lesson')) assert.ok(reach.has(n.id), `${n.id} not downstream of orientation`);
});

test('source nodes are cited, and licence caveats are carried', () => {
  const cited = new Set(seed.edges.filter((e) => e.rel === 'cites').map((e) => e.to));
  const sources = seed.nodes.filter((n) => n.type === 'source');
  assert.ok(sources.length >= 8);
  for (const s of sources) assert.ok(cited.has(s.id), `${s.id} is never cited`);
  const credits = seed.nodes.find((n) => n.id === 'bsv-src-1sat-university')!;
  assert.match(credits.body, /CC BY 4\.0/);
  assert.match(credits.body, /b-open-io/);
  assert.equal(credits.sources![0]!.licence, 'CC BY 4.0');
  // Anything whose structure derives from 1Sat University (it cites that source) must carry the attribution text.
  const citingUniv = new Set(seed.edges.filter((e) => e.rel === 'cites' && e.to === 'bsv-src-1sat-university').map((e) => e.from));
  const mustAttribute = ['bsv-orientation', 'bsv-tx-anatomy', 'bsv-1sat-ordinals', 'bsv-bap-identity', 'bsv-curriculum-index'];
  for (const id of mustAttribute) {
    assert.ok(citingUniv.has(id), `${id} should cite 1sat-university`);
    assert.match(seed.nodes.find((n) => n.id === id)!.body, /1Sat University by b-open-io.*CC BY 4\.0/s, `${id} lacks attribution text`);
  }
  const toolbox = seed.nodes.find((n) => n.id === 'bsv-wallet-toolbox')!;
  assert.match(toolbox.body, /Open BSV License/);
  assert.match(toolbox.body, /BSV blockchain and its testnets/);
  const unverified = seed.nodes.filter((n) => n.sources!.some((s) => /unverified/i.test(s.licence ?? '')));
  assert.ok(unverified.length >= 5, 'unverified licences should be labelled as such');
});

test('supersedes and contradicts edges are used, and the bodies contain no key-like secrets', () => {
  assert.ok(seed.edges.some((e) => e.rel === 'supersedes'));
  assert.ok(seed.edges.some((e) => e.rel === 'contradicts'));
  assert.ok(seed.edges.some((e) => e.rel === 'teaches'));
  const wif = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/;
  for (const n of seed.nodes) {
    assert.ok(!wif.test(n.body), `${n.id} contains a WIF-like string`);
    assert.ok(!/BEGIN (?:RSA |EC )?PRIVATE KEY/.test(n.body), `${n.id} contains a PEM key`);
  }
});

// ---------------------------------------------------------------- BSV mode v1: a truthful pack

const MARKER = 'Design, not built in v0.';
const byIdMap = new Map(seed.nodes.map((n) => [n.id, n]));

test('truthful pack: every built:false node starts with the design marker, has confidence 0.6, and the set is not empty', () => {
  const design = seed.nodes.filter((n) => n.props?.built === false);
  assert.ok(design.length >= 12, `only ${design.length} design nodes`);
  for (const n of design) {
    assert.ok(n.body.startsWith(MARKER), `${n.id} is built:false but does not start with the marker`);
    assert.equal(n.confidence, 0.6, `${n.id} confidence`);
  }
  // and the other way round: the marker is only ever used together with built:false
  for (const n of seed.nodes.filter((x) => x.body.startsWith(MARKER))) assert.equal(n.props?.built, false, `${n.id} has the marker but not built:false`);
  // the controls that do not exist today are all marked
  for (const id of ['bsv-safety-spend-caps-approval', 'bsv-safety-audit-freeze', 'bsv-safety-mainnet-armed-native', 'bsv-safety-external-wallet',
    'bsv-safety-vm-boundary', 'bsv-safety-overview', 'bsv-safety-untrusted-chain-data', 'bsv-mod-safety', 'bsv-mod-wallets', 'bsv-desktop-wallet', 'bsv-src-legion-kit', 'bsv-wallet-choice']) {
    assert.equal(byIdMap.get(id)!.props?.built, false, `${id} must be marked built:false`);
  }
});

test('truthful pack: no body claims a control that does not exist (one-click Freeze, "the owner has", "is awaited inside")', () => {
  for (const n of seed.nodes) assert.doesNotMatch(n.body, /one-click Freeze|owner has|is awaited inside/, n.id);
});

test('truthful pack: a node that is not marked as design never describes a missing control as present', () => {
  // Phrases that only make sense for the wallet phase. They may appear in design nodes and in the status node (which says they do not exist).
  const unbuilt = /approval card|plan card|spend card|approval broker|one-click|Freeze control|armed network|Arm mainnet action|native confirmation|per-session|rolling 24|Legion-owned|bsv wrapper|release gate|tool handler|Only the Assayer gets/i;
  for (const n of seed.nodes) {
    if (n.props?.built === false || n.id === 'bsv-status-today') continue;
    assert.doesNotMatch(n.body, unbuilt, `${n.id} describes an unbuilt control without the design marker`);
  }
});

test('status node: says what BSV mode is today, is reachable from the index, every hub and the orientation lesson', () => {
  const s = byIdMap.get('bsv-status-today');
  assert.ok(s, 'bsv-status-today exists');
  assert.equal(s!.type, 'lesson');
  assert.notEqual(s!.props?.built, false, 'the status node is the truth, not a design');
  for (const phrase of [/testnet only/i, /knowledge only|read-only knowledge pack/i, /no wallet/, /no spend caps/, /no Freeze/, /no approval card/, /advisory bot with no BSV tools/, /shell commands and file edits wait for your approval/, /Bots cannot edit this pack's notes or links/]) assert.match(s!.body, phrase);
  const rel = (from: string, to: string, rels = ['relates', 'part_of', 'depends_on']) => seed.edges.some((e) => e.from === from && e.to === to && rels.includes(e.rel));
  assert.ok(rel('bsv-curriculum-index', 'bsv-status-today'), 'index links to it');
  for (const hub of ['safety', 'foundations', 'wallets', 'network', 'ordinals', 'identity', 'sdks', 'extras']) assert.ok(rel(`bsv-mod-${hub}`, 'bsv-status-today'), `hub ${hub} links to it`);
  assert.ok(rel('bsv-status-today', 'bsv-orientation', ['depends_on']), 'it is a lesson downstream of orientation');
  assert.match(byIdMap.get('bsv-curriculum-index')!.body, /bsv-status-today/);
});

test('folded notes: no Update/Correction/Addendum paragraph markers are left in any body', () => {
  for (const n of seed.nodes) assert.doesNotMatch(n.body, /Update \(|Correction \(|Addendum \(|Update\/Correction/, n.id);
});

test('folded notes: a node never says both unconfirmed and activated about Chronicle (teranode-networks, chronicle-upgrade, timeline)', () => {
  for (const id of ['bsv-teranode-networks', 'bsv-chronicle-upgrade', 'bsv-teranode-status-timeline']) {
    const b = byIdMap.get(id)!.body;
    assert.doesNotMatch(b, /did not confirm|could not confirm/i, id);
    assert.match(b, /press/i, `${id} keeps the honest status: activation is press-sourced`);
  }
  assert.match(byIdMap.get('bsv-teranode-networks')!.body, /Association's own release page confirms/);
  assert.match(byIdMap.get('bsv-chronicle-upgrade')!.body, /Association's own release page/);
  assert.doesNotMatch(byIdMap.get('bsv-chronicle-upgrade')!.body, /secondary press only/);
  assert.doesNotMatch(byIdMap.get('bsv-teranode-status-timeline')!.body, /Chronicle upgrade activated in April/);
});

test('wallet-choice node: the plan, the red flags and the never-list, as a design lesson wired into the safety and wallet nodes', () => {
  const w = byIdMap.get('bsv-wallet-choice')!;
  assert.ok(w, 'bsv-wallet-choice exists');
  assert.equal(w.props?.built, false);
  assert.equal(w.confidence, 0.6);
  for (const phrase of [/BSV Desktop first/, /HandCash BRC wallet second/, /beta/, /BSV Browser later/, /Yours Wallet/, /Panda/, /Metanet Desktop/, /bsv-mcp/, /never grant a monthly limit or auto-pay/,
    /originator legion\.local/, /@bsv\/sdk WalletClient only, not wallet-toolbox/, /3321/, /self-declared/, /indefinitely/, /10 USD per 24 hours/, /two-stage/, /Legion's card first, then the wallet's own prompt/]) assert.match(w.body, phrase);
  const out = seed.edges.filter((e) => e.from === w.id);
  assert.ok(out.some((e) => e.rel === 'depends_on' && e.to === 'bsv-safety-external-wallet'));
  assert.ok(out.some((e) => e.rel === 'relates' && e.to === 'bsv-desktop-wallet' && e.note === 'protects'));
  assert.ok(out.some((e) => e.rel === 'part_of' && e.to === 'bsv-mod-wallets'));
  assert.ok(out.some((e) => e.rel === 'part_of' && e.to === 'bsv-mod-safety'));
  assert.ok(out.some((e) => e.rel === 'cites'));
});
