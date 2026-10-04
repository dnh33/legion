/** Adversarial review, category 3 (quota / DoS) and parts of 6 (tombstones, timers). Asserts the SECURE behaviour. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph, MAX_PENDING_PER_AGENT } from '../src/core/kg/graph.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import { TaskQuota } from '../src/core/kg/quota.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import { scrubSecrets, findForbiddenSecret } from '../src/core/comms/scrub.js';
import { KG_LIMITS } from '../src/shared/kg.js';
import { connect, idOf, init, kg, ok, setup, toolUse, waitDone } from './library-fakes.js';

const fresh = () => { const dir = cleanupTemp('rev-q-'); return { dir, g: new Graph({ dir }) }; };

test('R3.1 per-task quota: capture, supersede, merge, link, unlink, wm_set and reads all count; parallel calls cannot exceed it', async () => {
  const { g } = fresh();
  const quota = new TaskQuota();
  const c = await connect(g, 'alpha', { taskId: 'T1', quota });
  // 100 parallel reads: only 60 may run
  const reads = await Promise.all(Array.from({ length: 100 }, () => c.call('kg_stats')));
  assert.equal(reads.filter((r) => !r.isError).length, 60, 'call quota under parallel load');
  assert.equal(quota.calls, 60);

  // fresh task: mix of writes; node-write budget is 40 whatever the tool
  const q2 = new TaskQuota();
  const c2 = await connect(g, 'alpha', { taskId: 'T2', quota: q2 });
  const ids: string[] = [];
  let okWrites = 0;
  // kg_capture with force x 14
  for (let i = 0; i < 14; i++) { const r = await c2.call('kg_capture', { kind: 'idea', title: `idea number ${i} unique${i}`, fields: { pitch: 'p', status: 's', score: i }, force: true, scope: 'private' }); if (!r.isError) { okWrites++; ids.push(idOf(r.text)); } }
  // kg_supersede x 13 (each counts as a node write)
  for (let i = 0; i < 13; i++) { const r = await c2.call('kg_supersede', { oldId: ids[i]!, newId: ids[i + 1]! }); if (!r.isError) okWrites++; }
  // kg_merge x 10 drops in one call counts as 10
  const extra: string[] = [];
  for (let i = 0; i < 5; i++) { const r = await c2.call('kg_upsert_node', { title: `merge fodder ${i} q${i}`, scope: 'private' }); if (!r.isError) { okWrites++; extra.push(idOf(r.text)); } }
  const m = await c2.call('kg_merge', { keep: extra[0]!, drop: extra.slice(1) });
  if (!m.isError) okWrites += 4;
  assert.equal(q2.nodeWrites, okWrites, 'every successful write op charged the node quota');
  assert.ok(q2.nodeWrites <= 40);
  // try to exceed through the cheapest op (no-change upsert) and wm_set
  for (let i = 0; i < 40; i++) await c2.call('kg_wm_set', { active: `state ${i}` });
  assert.ok(q2.nodeWrites <= 40, `node writes ${q2.nodeWrites}`);
  const refused = await c2.call('kg_capture', { kind: 'idea', title: 'one more unique zzz', fields: { pitch: 'p', status: 's', score: 1 }, scope: 'private', force: true });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Quota reached/);
  // edge ops
  const q3 = new TaskQuota();
  const c3 = await connect(g, 'alpha', { taskId: 'T3', quota: q3 });
  const a = idOf((await c3.call('kg_upsert_node', { title: 'edge a', scope: 'private' })).text);
  const b = idOf((await c3.call('kg_upsert_node', { title: 'edge b', scope: 'private' })).text);
  let edgeOk = 0;
  for (let i = 0; i < 60; i++) { if (!(await c3.call('kg_link', { from: a, to: b, rel: `rel_${i}` })).isError) edgeOk++; if (!(await c3.call('kg_unlink', { from: a, to: b, rel: `rel_${i}` })).isError) edgeOk++; }
  assert.ok(q3.edgeOps <= 100, `edge ops ${q3.edgeOps}`);
  assert.equal(q3.edgeOps, edgeOk);
});

test('R3.2 no tool argument can change identity, task, quota, trust, origin or status', async () => {
  const { g } = fresh();
  const c = await connect(g, 'alpha', { taskId: 'T1' });
  const { tools } = await c.client.listTools();
  assert.equal(tools.length, 16);
  const forbiddenArgs = /^(taskId|task|agent|agentId|actor|trust|origin|status|taint|tainted|quota|createdBy|supersededBy|via|ceiling)$/i;
  for (const t of tools) for (const k of Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})) assert.doesNotMatch(k, forbiddenArgs, `${t.name}.${k}`);
  // and no tool is an accept / reject / undo / restore / scope-change
  assert.deepEqual(tools.map((t) => t.name).sort(), ['kg_capture', 'kg_forget', 'kg_get', 'kg_link', 'kg_lint', 'kg_merge', 'kg_neighbors', 'kg_path', 'kg_recall', 'kg_search', 'kg_stats', 'kg_subgraph', 'kg_supersede', 'kg_unlink', 'kg_upsert_node', 'kg_wm_set']);
  // extra unknown keys in the arguments are ignored, not honoured
  const r = await c.call('kg_upsert_node', { title: 'spoof', scope: 'shared', trust: 'human', status: 'active', origin: { taskId: 'x', tainted: false }, createdBy: 'human' });
  const n = g.getNode(HUMAN, idOf(r.text))!;
  assert.equal(n.trust, 'agent');
  assert.equal(n.createdBy, 'alpha');
  assert.equal(n.origin?.taskId, 'T1');
});

test('R3.3 pending cap: every path that makes a pending note is refused at 50, other agents are unaffected, private writes still work', () => {
  const { g } = fresh();
  const human = g.upsertNode(HUMAN, { title: 'human note to propose against', body: 'orig' }).node;
  const other = g.upsertNode(HUMAN, { title: 'second human note' }).node;
  const run = (id: string, n: number) => agentActor(id, { taskId: `T${n}`, taint: () => true });
  let n = 0;
  for (let i = 0; i < MAX_PENDING_PER_AGENT; i++) g.upsertNode(run('zed', ++n), { title: `held ${i}`, scope: 'shared' });
  const z = run('zed', ++n);
  const tries: Array<[string, () => unknown]> = [
    ['upsert create', () => g.upsertNode(z, { title: 'x', scope: 'shared' })],
    ['upsert edit-proposal', () => g.upsertNode(z, { id: human.id, body: 'changed' })],
    ['capture', () => g.capture(z, { type: 'idea', title: 'c', body: 'b', force: true })],
    ['capture supersedes', () => g.capture(z, { type: 'idea', title: 'c2', body: 'b', supersedes: human.id })],
    ['supersede proposal', () => g.supersede(z, human.id, other.id)],
    ['merge proposal', () => g.merge(z, human.id, [other.id])],
  ];
  for (const [name, f] of tries) assert.throws(f, /waiting for the human/, `${name} must be refused at the cap`);
  // private still fine, other agents unaffected
  assert.doesNotThrow(() => g.upsertNode(z, { title: 'private ok', scope: 'agent:zed' }));
  assert.doesNotThrow(() => g.upsertNode(run('yan', 999), { title: 'yan held', scope: 'shared' }));
  // forgetting an own pending note frees a slot (tombstone) -- but quota still bounds the churn per task
  const mine = g.inbox(HUMAN, { agentId: 'zed' })[0]!.id;
  g.deleteNode(z, mine);
  assert.doesNotThrow(() => g.upsertNode(z, { title: 'slot freed', scope: 'shared' }));
});

test('R3.4 secret scrubbing and key detection scale linearly on hostile inputs (event loop stays free)', () => {
  // Machine independent: the same input at N and 4N characters. A linear scrub takes ~4x as long, a quadratic one ~16x, on every machine and
  // under any load, so the guard is the RATIO (median of three at each size: the minimum is optimistic at the small size and inflated the ratio on a loaded CPU, one slow run does not decide a median).
  // The small time is floored at 2 ms so a sub-millisecond case cannot fail on timer noise; a case that is that fast at N is not a stall risk.
  const N = 20_000;
  const cases = (n: number): Record<string, string> => ({
    token: 'token'.repeat(n / 5), secret_eq: 'secret_'.repeat(n / 7), http: 'http://'.repeat(n / 7), boat: 'https://boat.dev/'.repeat(n / 17),
    seed: 'seed phrase '.repeat(n / 12), seedwords: 'seed phrase: ' + 'abc '.repeat(n / 4), mnemonic: 'mnemonic ' + 'abcde, '.repeat(n / 7),
    pem: '-----BEGIN PRIVATE KEY-----'.repeat(n / 27), bearer: 'Bearer '.repeat(n / 7), eyJ: 'eyJabcdefghi.'.repeat(n / 13),
    sk: 'sk-'.repeat(n / 3), key_assign: 'api_key = '.repeat(n / 10), a: 'a'.repeat(n), hex: 'f'.repeat(n), base58: '5' + '1'.repeat(n),
    priv: 'private key '.repeat(n / 12), words: 'word '.repeat(n / 5), ws: ' '.repeat(n) + 'x', nl: '\n'.repeat(n), under: 'a_'.repeat(n / 2) + '=',
    colon: 'password:'.repeat(n / 9), quote: '"'.repeat(n), tokenquote: 'token"'.repeat(n / 6), tokenws: 'token' + ' '.repeat(n),
  });
  const median = (s: string): number => {
    const runs: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      scrubSecrets(s, { keepHex: true, exact: ['abcdefghijkl'] });
      findForbiddenSecret(s);
      runs.push(performance.now() - t0);
    }
    return runs.sort((a, b) => a - b)[1]!;
  };
  const small = cases(N);
  const big = cases(4 * N);
  for (const s of Object.values(small)) median(s); // warm up the regex engine and the JIT
  const slow: string[] = [];
  for (const name of Object.keys(small)) {
    const t1 = Math.max(median(small[name]!), 2);
    const t4 = median(big[name]!);
    // a ratio of two millisecond timings is noise: only call it slow when the big input also takes a visible time (the old quadratic shapes took 1.7 s here)
    if (t4 / t1 > 8 && t4 > 150) slow.push(`${name}: ${t1.toFixed(1)} ms at ${N} chars, ${t4.toFixed(1)} ms at ${4 * N} (x${(t4 / t1).toFixed(1)}; linear is x4, quadratic x16)`);
  }
  assert.deepEqual(slow, []);
});

test('R3.5 activity.jsonl: a steady stream of writes must not rewrite the whole activity file on every write', () => {
  const { g, dir } = fresh();
  const alpha = agentActor('alpha');
  const n = g.upsertNode(alpha, { title: 'churn target', body: 'x'.repeat(19_000), scope: 'agent:alpha' }).node;
  const body = (i: number) => String.fromCharCode(97 + (i % 26)).repeat(19_000) + i;
  for (let i = 0; i < 520; i++) g.upsertNode(alpha, { id: n.id, body: body(i) });
  const f = join(dir, 'activity.jsonl');
  const ino0 = statSync(f).ino;
  const size0 = statSync(f).size;
  let renames = 0;
  let last = ino0;
  const t0 = performance.now();
  for (let i = 520; i < 560; i++) { g.upsertNode(alpha, { id: n.id, body: body(i) }); const ino = statSync(f).ino; if (ino !== last) renames++; last = ino; }
  const per = (performance.now() - t0) / 40;
  assert.ok(size0 < 40e6);
  assert.ok(renames < 4, `activity file was rewritten (rename) on ${renames}/40 writes at ${(size0 / 1e6).toFixed(1)} MB, ${per.toFixed(1)} ms per write`);
});

test('R3.6 lint-lite timer: dispose clears it, a late callback after dispose does not reschedule, no timer survives', () => {
  const timers = { sets: [] as Array<{ fn: () => void; ms: number; cleared: boolean }>, set(fn: () => void, ms: number) { const t = { fn, ms, cleared: false }; this.sets.push(t); return t; }, clear(h: unknown) { (h as { cleared: boolean }).cleared = true; } };
  const s = setup(() => undefined, { kg: { timers } });
  assert.equal(timers.sets.length, 1, 'one nightly timer at creation');
  assert.ok(timers.sets[0]!.ms > 0 && timers.sets[0]!.ms <= 24 * 3_600_000 + 1);
  timers.sets[0]!.fn(); // fires: runs lint-lite and re-arms exactly one more
  assert.equal(timers.sets.length, 2);
  s.kg.dispose?.();
  assert.equal(timers.sets[1]!.cleared, true, 'dispose cleared the pending timer');
  timers.sets[1]!.fn(); // a callback that was already in flight when dispose ran
  assert.equal(timers.sets.length, 2, 'no reschedule after dispose');
});

test('R3.7 tombstone purge only removes nodes that were forgotten/rejected/merged/retired more than 30 days ago; live data and their live neighbours survive', () => {
  const dir = cleanupTemp('rev-q-');
  let offset = 0;
  const g = new Graph({ dir, now: () => new Date(Date.now() + offset) });
  const alpha = agentActor('alpha', { taskId: 'T' });
  const live = g.upsertNode(HUMAN, { title: 'live human note' }).node;
  const priv = g.upsertNode(alpha, { title: 'private to forget', scope: 'agent:alpha' }).node;
  g.link(HUMAN, { from: live.id, to: priv.id, rel: 'relates' });
  g.deleteNode(alpha, priv.id); // tombstone
  const keepN = g.upsertNode(alpha, { title: 'keep me', scope: 'shared' }).node;
  const dropN = g.upsertNode(alpha, { title: 'drop me', scope: 'shared' }).node;
  g.merge(alpha, keepN.id, [dropN.id]);
  const ids = () => new Set(g.allNodes(HUMAN).map((n) => n.id));
  offset = 31 * 86_400_000;
  const r = g.lintLite();
  assert.equal(r.purgedTombstones, 2);
  assert.ok(ids().has(live.id) && ids().has(keepN.id));
  assert.ok(!ids().has(priv.id) && !ids().has(dropN.id));
  // the live human note lost its link to the purged private note, nothing else
  assert.equal(g.edgesOf(HUMAN, live.id).length, 0);
  // snapshot exists whenever more than 5 go
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('graph.jsonl.bak-')).length, 0, 'fewer than 6 purged: no snapshot needed');
});

test('R3.8 one bot looping across tasks can fill the graph to the node cap and block every writer including the human', () => {
  const dir = cleanupTemp('rev-q-');
  const prev = KG_LIMITS.maxNodes;
  (KG_LIMITS as { maxNodes: number }).maxNodes = 60;
  try {
    const g = new Graph({ dir });
    for (let i = 0; i < 60; i++) g.upsertNode(agentActor('loop', { taskId: `T${i}` }), { title: `junk ${i}`, scope: 'agent:loop' });
    assert.doesNotThrow(() => g.upsertNode(HUMAN, { title: 'the human wants to write a note' }), 'a single bot filled the cap with private junk; human blocked');
  } finally { (KG_LIMITS as { maxNodes: number }).maxNodes = prev; }
});

test('R3.9 snapshot exists after a bulk delete (6+ deletes in a window), keeps at most 5, and no .pre-delete is left behind', () => {
  const dir = cleanupTemp('rev-q-');
  const g = new Graph({ dir });
  const alpha = agentActor('alpha');
  const ids = Array.from({ length: 7 }, (_, i) => g.upsertNode(alpha, { title: `bulk ${i}`, scope: 'agent:alpha' }).node.id);
  for (const id of ids) g.deleteNode(alpha, id);
  const baks = readdirSync(dir).filter((f) => f.startsWith('graph.jsonl.bak-'));
  assert.ok(baks.length >= 1 && baks.length <= 5);
  assert.equal(existsSync(join(dir, 'graph.jsonl.pre-delete')), false);
  // the snapshot holds every note as it was BEFORE the deletes
  const g2 = new Graph({ dir: (() => { const d = cleanupTemp('rev-q-'); copyFileSync(join(dir, baks[0]!), join(d, 'graph.jsonl')); return d; })() });
  assert.equal(g2.allNodes(HUMAN).filter((n) => n.status === undefined).length, 7);
});
