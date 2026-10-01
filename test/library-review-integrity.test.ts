/** Adversarial review, category 6 (data integrity): replay, torn writes, atomicity, undo, compaction. Asserts the SECURE behaviour. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import type { Actor } from '../src/core/kg/types.js';
import type { KgEdge, KgNode } from '../src/shared/kg.js';

const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v;
const snap = (g: Graph) => ({
  nodes: g.allNodes(HUMAN).sort((a, b) => a.id.localeCompare(b.id)).map((n) => sortKeys(n)),
  edges: g.subgraph(HUMAN, g.allNodes(HUMAN).map((n) => n.id), { depth: 0, maxNodes: 500 }).edges.sort((a: KgEdge, b: KgEdge) => a.id.localeCompare(b.id)).map((e: KgEdge) => sortKeys(e)),
});
const searches = (g: Graph) => ['alpha', 'beta note', 'zebra', 'idea', 'decision rule', 'merge'].map((q) => g.search(HUMAN, q, { limit: 50, includeInactive: true }).map((h) => `${h.node.id}:${h.score}`));

test('R6.1 replay fidelity: after a long random mix of human / clean / ask-woken / tainted writes, accepts, rejects, undos, compaction and lint-lite, a restarted Graph equals the live one (nodes, edges, search scores, inbox)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = rng(seed * 7919);
    const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
    const g = new Graph({ dir, compactMinBytes: 20_000 });
    let task = 0;
    const clean = () => agentActor('alpha', { taskId: `T${++task}`, taint: () => false });
    const askw = () => agentActor('beta', { taskId: `T${++task}`, origin: { roomId: 'r', fromAgentId: 'alpha', hop: 1, approvalCeiling: 'ask' } });
    const taint = () => agentActor('gamma', { taskId: `T${++task}`, taint: () => true });
    const archivist = () => agentActor('archivist', { taskId: `T${++task}` });
    const actors: Array<() => Actor> = [clean, clean, askw, taint, archivist];
    const ids = (): string[] => g.allNodes(HUMAN).map((n) => n.id);
    const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)];
    const words = ['alpha', 'beta', 'zebra', 'idea', 'decision', 'rule', 'merge', 'note', 'marmalade'];
    const txt = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(words)).join(' ');
    const safe = (f: () => unknown) => { try { f(); } catch { /* refusals are fine */ } };
    for (let i = 0; i < 400; i++) {
      const op = Math.floor(r() * 22);
      const a = pick(actors)!();
      const target = pick(ids());
      const t2 = pick(ids());
      safe(() => {
        switch (op) {
          case 0: case 1: g.upsertNode(a, { title: txt() + i, body: txt(), tags: r() < 0.3 ? ['trigger:always'] : [txt().split(' ')[0]!], scope: r() < 0.3 ? `agent:${(a as { id: string }).id}` as never : 'shared', confidence: r() < 0.3 ? r() : undefined, props: r() < 0.3 ? { k: txt(), proposal: 'merge', n: 1 } : undefined }); break;
          case 2: case 3: if (target) g.upsertNode(a, { id: target, body: txt(), ...(r() < 0.3 ? { title: txt() + i } : {}) }); break;
          case 4: g.upsertNode(HUMAN, { title: 'human ' + txt() + i, body: txt(), type: pick(['note', 'decision', 'idea']) as never, tags: r() < 0.4 ? ['trigger:alpha'] : [] }); break;
          case 5: g.capture(a, { type: pick(['decision', 'idea', 'pattern']) as never, title: txt() + i, body: `## Chose\n${txt()}`, supersedes: r() < 0.4 ? target : undefined, links: r() < 0.5 && t2 ? [{ to: t2, rel: 'relates' }] : undefined, force: true, scope: r() < 0.3 ? `agent:${(a as { id: string }).id}` as never : 'shared' }); break;
          case 6: if (target && t2) g.supersede(a, target, t2, { reason: txt() }); break;
          case 7: if (target && t2) g.merge(a, target, [t2], { reason: txt() }); break;
          case 8: if (target && t2) g.link(a, { from: target, to: t2, rel: pick(['relates', 'supersedes', 'depends_on'])!, weight: r() < 0.3 ? r() : undefined, note: r() < 0.3 ? txt() : undefined }); break;
          case 9: if (target && t2) g.unlink(a, { from: target, to: t2, rel: 'relates' }); break;
          case 10: if (target) g.deleteNode(a, target); break;
          case 11: g.setWorkingMemory(a, { active: txt(), archiveAppend: r() < 0.5 ? txt() : undefined }); break;
          case 12: { const row = pick(g.inbox(HUMAN)); if (row) g.acceptPending(HUMAN, row.id, r() < 0.3 ? { edit: { body: txt() } } : {}); break; }
          case 13: { const row = pick(g.inbox(HUMAN)); if (row) g.rejectPending(HUMAN, row.id); break; }
          case 14: g.acceptMany(HUMAN, { overrideUntrusted: r() < 0.5 }); break;
          case 15: { const act = pick(g.activityFeed(HUMAN, { limit: 30 })); if (act) g.undo(HUMAN, act.id); break; }
          case 16: g.lintLite(); break;
          case 17: if (target) g.setStatus(HUMAN, target, pick(['active', 'archived', 'superseded'])!, r() < 0.3 ? { trust: 'human' } : {}); break;
          case 18: if (target) g.deleteNode(HUMAN, target); break;
          case 19: g.recordEpisode({ taskId: `E${i % 7}`, agentId: 'alpha', title: txt(), status: 'done', turns: 9, costUsd: 1, prompt: txt(), result: txt(), tainted: r() < 0.5 }); break;
          case 20: g.compact(); break;
          case 21: if (target && t2) g.upsertNode(HUMAN, { id: target, scope: pick(['shared', 'agent:alpha'])! as never }); break;
        }
      });
      if (i % 100 === 99) {
        const live = JSON.stringify({ s: snap(g), q: searches(g), inbox: g.inbox(HUMAN).map((x) => [x.id, x.kind]) });
        const g2 = new Graph({ dir });
        const re = JSON.stringify({ s: snap(g2), q: searches(g2), inbox: g2.inbox(HUMAN).map((x) => [x.id, x.kind]) });
        if (live !== re) {
          const A = snap(g); const B = snap(g2);
          const diff = (A.nodes as KgNode[]).filter((n, k) => JSON.stringify(n) !== JSON.stringify((B.nodes as KgNode[])[k])).slice(0, 2).map((n) => JSON.stringify(n));
          assert.fail(`seed ${seed} step ${i}: reloaded graph differs from live. nodes ${A.nodes.length}/${B.nodes.length} edges ${A.edges.length}/${B.edges.length}; first diffs: ${diff.join(' | ')}`);
        }
      }
    }
  }
});

test('R6.2 torn append: a crash in the middle of a multi-line append (capture+supersede, merge) must leave a consistent graph (all or nothing)', () => {
  const build = () => {
    const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
    const g = new Graph({ dir });
    const a = agentActor('alpha', { taskId: 'T' });
    const nodes = ['one', 'two', 'three', 'keep'].map((t) => g.upsertNode(a, { title: `note ${t}`, body: t }).node);
    const other = g.upsertNode(a, { title: 'other', body: 'o' }).node;
    for (const n of nodes.slice(0, 3)) g.link(a, { from: n.id, to: other.id, rel: 'relates' });
    return { dir, g, a, nodes, other };
  };
  // merge: keep <- one,two,three. The whole merge is ONE appended string; cut the file at every line boundary inside it.
  const { dir, g, a, nodes } = build();
  const before = readFileSync(join(dir, 'graph.jsonl'), 'utf8');
  g.merge(a, nodes[3]!.id, nodes.slice(0, 3).map((n) => n.id));
  const after = readFileSync(join(dir, 'graph.jsonl'), 'utf8');
  const added = after.slice(before.length).split('\n').filter(Boolean);
  assert.ok(added.length >= 6);
  const bad: string[] = [];
  for (let cut = 1; cut < added.length; cut++) {
    const d2 = mkdtempSync(join(tmpdir(), 'rev-i-'));
    writeFileSync(join(d2, 'graph.jsonl'), before + added.slice(0, cut).join('\n') + '\n');
    const g2 = new Graph({ dir: d2 });
    const hid = nodes.slice(0, 3).filter((n) => g2.getNode(HUMAN, n.id)!.status === 'archived');
    const keepEdges = g2.edgesOf(HUMAN, nodes[3]!.id).filter((e) => e.rel === 'relates').length;
    // all-or-nothing: either nothing was archived, or all three were AND keep owns the three rewired links
    const consistent = hid.length === 0 || (hid.length === 3 && keepEdges >= 1);
    if (!consistent) bad.push(`cut after ${cut}/${added.length} lines: ${hid.length} dropped notes archived, keep has ${keepEdges} relates-links (their links are stranded on archived notes)`);
  }
  assert.deepEqual(bad, []);
});

test('R6.3 undo: a later change to a node\'s LINKS (by the human or another bot) is not silently wiped by undoing the node\'s creation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const g = new Graph({ dir });
  const alpha = agentActor('alpha', { taskId: 'T' });
  const mine = g.upsertNode(alpha, { title: 'bot created note' }).node;
  const human = g.upsertNode(HUMAN, { title: 'human note' }).node;
  g.link(HUMAN, { from: human.id, to: mine.id, rel: 'depends_on', note: 'the human wired this up by hand' });
  const act = g.activityFeed(HUMAN, { limit: 5 }).find((x) => x.kind === 'create')!;
  let refused = false;
  try { g.undo(HUMAN, act.id); } catch { refused = true; }
  const humanEdges = g.edgesOf(HUMAN, human.id).length;
  assert.ok(refused || humanEdges === 1, `undo of the create deleted the node AND the human's hand-made link (human note now has ${humanEdges} links)`);
});

const tick = () => { const t = Date.now(); while (Date.now() === t) { /* spin to the next millisecond */ } };

test('R6.4b undo guard: two writes to one node inside the same millisecond (parallel tool calls) still make the earlier undo refuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const g = new Graph({ dir });
  const alpha = agentActor('alpha', { taskId: 'T' });
  const n = g.upsertNode(alpha, { title: 'same ms target', body: 'v0' }).node;
  let collided = 0;
  let silentlyReverted = 0;
  for (let i = 0; i < 300; i++) {
    tick();
    g.upsertNode(alpha, { id: n.id, body: `a${i}` });
    const stamp1 = g.getNode(HUMAN, n.id)!.updatedAt;
    const u1 = g.activityFeed(HUMAN, { limit: 1 })[0]!;
    g.upsertNode(alpha, { id: n.id, body: `b${i}` });
    if (g.getNode(HUMAN, n.id)!.updatedAt !== stamp1) continue;     // different millisecond: the guard works
    collided++;
    try { g.undo(HUMAN, u1.id); if (g.getNode(HUMAN, n.id)!.body !== `b${i}`) silentlyReverted++; } catch { /* refused: good */ }
  }
  assert.ok(collided > 0, 'precondition: found same-millisecond writes');
  assert.equal(silentlyReverted, 0, `${silentlyReverted}/${collided} same-ms writes: undo of the earlier write silently reverted the later one`);
});

test('R6.4 undo refuses after any later edit of the same node, restores exactly otherwise (update, supersede, merge, forget, capture)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const g = new Graph({ dir });
  const alpha = agentActor('alpha', { taskId: 'T' });
  const n = g.upsertNode(alpha, { title: 'undo target', body: 'v1', tags: ['a'] }).node;
  const m = g.upsertNode(alpha, { title: 'undo second', body: 'm1' }).node;
  const pre = JSON.stringify(sortKeys(g.getNode(HUMAN, n.id)));
  tick(); g.upsertNode(alpha, { id: n.id, body: 'v2' });
  const u1 = g.activityFeed(HUMAN, { limit: 1 })[0]!;
  tick(); g.upsertNode(alpha, { id: n.id, body: 'v3' });
  assert.throws(() => g.undo(HUMAN, u1.id), /changed since/);
  const u2 = g.activityFeed(HUMAN, { limit: 1 })[0]!;
  g.undo(HUMAN, u2.id);
  g.undo(HUMAN, u1.id);
  assert.equal(JSON.stringify(sortKeys(g.getNode(HUMAN, n.id))), pre, 'two undos restore the exact original node');
  // supersede then undo
  g.supersede(alpha, n.id, m.id);
  const us = g.activityFeed(HUMAN, { limit: 1 })[0]!;
  g.undo(HUMAN, us.id);
  assert.equal(g.getNode(HUMAN, n.id)!.status, undefined);
  assert.equal(g.getNode(HUMAN, n.id)!.supersededBy, undefined);
  assert.equal(g.edgesOf(HUMAN, n.id).length, 0);
  // survives a restart
  const g2 = new Graph({ dir });
  assert.equal(JSON.stringify(sortKeys(g2.getNode(HUMAN, n.id))), pre);
});

test('R6.5 compaction does not break Activity undo (before-images live in activity.jsonl) and keeps a snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const g = new Graph({ dir, compactMinBytes: 5_000 });
  const alpha = agentActor('alpha', { taskId: 'T' });
  const n = g.upsertNode(alpha, { title: 'compaction target', body: 'v0' }).node;
  g.upsertNode(alpha, { id: n.id, body: 'v1' });
  const act = g.activityFeed(HUMAN, { limit: 1 })[0]!;
  const before = g.logInfo().bytes;
  for (let i = 0; i < 80; i++) g.upsertNode(HUMAN, { id: n.id, body: 'filler '.repeat(60) + i });
  assert.ok(g.logInfo().bytes < before + 80 * 500 + 50_000, 'compaction ran');
  g.upsertNode(HUMAN, { id: n.id, body: 'v1' }); // human restores the stamped content? no: updatedAt differs, undo must refuse
  assert.throws(() => g.undo(HUMAN, act.id), /changed since/);
});

test('R6.6 two Graph instances on one directory (second process, a restart before the old one exits) must not silently lose each other\'s writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const a = new Graph({ dir, compactMinBytes: 1 });
  const b = new Graph({ dir, compactMinBytes: 1 });
  a.upsertNode(HUMAN, { title: 'written by A' });
  b.upsertNode(HUMAN, { title: 'written by B' });
  for (let i = 0; i < 6; i++) { a.upsertNode(HUMAN, { id: a.allNodes(HUMAN)[0]!.id, body: 'x'.repeat(100) + i }); }
  a.compact();
  const c = new Graph({ dir });
  assert.equal(c.allNodes(HUMAN).length, 2, 'B\'s note was lost by A\'s compaction (no lock file / single-writer guard)');
});

test('R6.7 a hand-damaged or hostile log line cannot inject trust/status/origin onto a node through patch replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const g = new Graph({ dir });
  const alpha = agentActor('alpha', { taskId: 'T' });
  const n = g.upsertNode(alpha, { title: 'victim' }).node;
  appendFileSync(join(dir, 'graph.jsonl'), JSON.stringify({ op: 'patch', id: n.id, fields: { createdBy: 'human', id: 'other', trust: 'god', status: 'weird', origin: { taskId: 5 }, scope: 'agent:../x', type: 'nope', props: 'str', tags: 'notarray', sources: [1], confidence: 'x', supersededBy: 7, __proto__: { polluted: true }, constructor: { x: 1 } } }) + '\n');
  const g2 = new Graph({ dir });
  const x = g2.getNode(HUMAN, n.id)!;
  assert.equal(x.createdBy, 'alpha');
  assert.equal(x.id, n.id);
  assert.notEqual(x.trust, 'human');
  assert.ok(x.status === undefined || ['pending', 'superseded', 'archived'].includes(x.status));
  assert.equal(x.type, 'note');
  assert.ok(Array.isArray(x.tags));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('R6.8 edge relation / edge ids are not a secret channel: rel is not scrubbed (max 40 lowercase chars)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const secret = 'abcdef0123456789abcdef0123456789abcdef01'; // 40 hex: a truncated bearer token
  const g = new Graph({ dir, secrets: () => [secret + '23456789'] });
  const a = agentActor('alpha', { taskId: 'T' });
  const n1 = g.upsertNode(a, { title: 'e1' }).node; const n2 = g.upsertNode(a, { title: 'e2' }).node;
  let stored = false;
  try { g.link(a, { from: n1.id, to: n2.id, rel: secret }); stored = true; } catch { /* ok */ }
  const text = readFileSync(join(dir, 'graph.jsonl'), 'utf8') + readFileSync(join(dir, 'activity.jsonl'), 'utf8');
  assert.ok(!(stored && text.includes(secret)), 'a 40-char token prefix was stored in an edge relation and in activity.jsonl');
});

test('R6.9 tombstone and pending visibility are enforced identically for every read path (get, search, recall, neighbors, subgraph, path, lint, stats)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-i-'));
  const g = new Graph({ dir });
  const alpha = agentActor('alpha', { taskId: 'T1' });
  const held = agentActor('alpha', { taskId: 'T2', taint: () => true });
  const beta = agentActor('beta');
  const live = g.upsertNode(alpha, { title: 'live zebra' }).node;
  const pend = g.upsertNode(held, { title: 'pending zebra', scope: 'shared' }).node;
  const gone = g.upsertNode(alpha, { title: 'gone zebra', scope: 'agent:alpha' }).node;
  g.deleteNode(alpha, gone.id);
  g.link(alpha, { from: live.id, to: pend.id, rel: 'relates' });
  for (const [who, sees] of [[beta, false], [alpha, true]] as const) {
    assert.equal(!!g.getNode(who, pend.id), sees);
    assert.equal(g.search(who, 'zebra').some((h) => h.node.id === pend.id), sees);
    assert.equal(g.recallEntries(who, 'zebra').some((e) => e.id === pend.id), sees);
    assert.equal(g.neighbors(who, live.id).nodes.some((x) => x.node.id === pend.id), sees);
    assert.equal(g.subgraph(who, [live.id]).nodes.some((x) => x.id === pend.id), sees);
    assert.equal(g.overview(who).nodes.some((x) => x.id === pend.id), sees);
    assert.equal(g.lint(who).orphans.includes(pend.id), false);
    assert.equal(g.getNode(who, gone.id), undefined, 'tombstones never visible to agents');
    assert.equal(g.stats(who).nodes, sees ? 2 : 1);
  }
});
