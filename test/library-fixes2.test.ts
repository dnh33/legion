/** Second fix round: held rewrite keeps the clean note live, lock timing, counted batches, tainted paths, Legion tool names, seed edge cases. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN, KgError } from '../src/core/kg/types.js';
import { TaintedPaths } from '../src/core/tainted-paths.js';
import { isLegionTool } from '../src/core/approvals.js';
import { findForbiddenSecret } from '../src/core/comms/scrub.js';
import { BIP39_ENGLISH } from '../src/core/comms/bip39-words.js';
import { setup, init, ok, toolUse, waitDone } from './library-fakes.js';

const tmp = (p: string) => cleanupTemp(p);

test('the BIP-39 list is the official one: 2048 distinct lowercase words, first and last as published', () => {
  assert.equal(BIP39_ENGLISH.length, 2048);
  assert.equal(new Set(BIP39_ENGLISH).size, 2048);
  assert.ok(BIP39_ENGLISH.every((w) => /^[a-z]{3,8}$/.test(w)));
  assert.equal(BIP39_ENGLISH[0], 'abandon');
  assert.equal(BIP39_ENGLISH[2047], 'zoo');
});

test('seed detection: tolerance rules (a 24-word phrase with two wrong words, an all-different-word window, prose with list words)', () => {
  const p24 = 'void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold';
  const typo = p24.split(' ').map((w, i) => (i === 3 || i === 17 ? 'zzzzz' : w)).join(' ');
  assert.equal(findForbiddenSecret(typo), 'seed phrase', 'two strangers among 24 words');
  const typo12 = 'army van defense carry jealous true garbage claim echo media make crunchy';
  assert.equal(findForbiddenSecret(typo12), undefined, 'a 12-word phrase with one wrong word is not recognised (documented limit)');
  assert.equal(findForbiddenSecret('We can cost much more than a plain payment, so verify the build time and the current minimum fee before you start.'), undefined);
  assert.equal(findForbiddenSecret('correct horse battery staple correct horse battery staple correct horse battery staple'), undefined, 'one repeated phrase is not a key');
});

test('R2-L2 held rewrite: the rewrite waits in the inbox as an edit, the clean text stays live with its links, accept swaps them, undo restores', () => {
  const g = new Graph({ dir: tmp('fx2-') });
  let tainted = false;
  const bot = agentActor('alpha', { taskId: 'T1', taint: () => tainted });
  const other = g.upsertNode(HUMAN, { title: 'Hub' }).node;
  const n = g.upsertNode(bot, { title: 'Deploy checklist', body: 'clean knowledge', scope: 'shared' }).node;
  g.link(bot, { from: n.id, to: other.id, rel: 'relates' });
  tainted = true;
  g.upsertNode(bot, { id: n.id, body: 'rewrite with web text' });
  const beta = agentActor('beta', { taskId: 'B' });
  const live = g.allNodes(beta).filter((x) => x.title === 'Deploy checklist');
  assert.equal(live.length, 1);
  assert.equal(live[0]!.body, 'clean knowledge');
  assert.notEqual(live[0]!.id, n.id);
  assert.equal(g.edgesOf(HUMAN, live[0]!.id, 'both').filter((e) => e.rel === 'relates').length, 1, 'the clean copy keeps the links');
  const rows = g.inbox(HUMAN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'edit');
  // undo of the rewrite removes the copy and restores the note
  const entry = g.activityFeed(HUMAN, { limit: 1 })[0]!;
  g.undo(HUMAN, entry.id);
  assert.equal(g.getNode(HUMAN, n.id)!.body, 'clean knowledge');
  assert.equal(g.getNode(HUMAN, n.id)!.status, undefined);
  assert.equal(g.allNodes(beta).filter((x) => x.title === 'Deploy checklist').length, 1);
  // do it again and accept
  g.upsertNode(bot, { id: n.id, body: 'rewrite with web text' });
  g.acceptPending(HUMAN, n.id);
  const after = g.allNodes(beta).filter((x) => x.title === 'Deploy checklist' && x.status === undefined);
  assert.equal(after.length, 1, 'the old text is superseded, only the accepted rewrite is live');
  assert.equal(after[0]!.body, 'rewrite with web text');
  assert.equal(after[0]!.id, n.id);
});

test('R2-G10 a live lock held by another process fails fast with a clear message, not after 5 seconds', () => {
  const dir = tmp('fx2-lock-');
  const g = new Graph({ dir });
  writeFileSync(join(dir, 'graph.jsonl.lock'), `${process.ppid} ${Date.now()}`); // our parent is alive and not us (pid 1 only exists on Linux)
  const t0 = Date.now();
  assert.throws(() => g.upsertNode(agentActor('alpha', { taskId: 'T' }), { title: 'x', scope: 'shared' }), (e: unknown) => e instanceof KgError && e.code === 'unavailable' && /graph\.jsonl\.lock/.test(e.message));
  assert.ok(Date.now() - t0 < 3000, `waited ${Date.now() - t0} ms`);
});

test('counted batches: a batch whose count does not match its lines is dropped, later writes survive; uncounted old batches still apply', () => {
  const dir = tmp('fx2-batch-');
  const g = new Graph({ dir });
  const a = agentActor('alpha', { taskId: 'T' });
  const n = g.upsertNode(a, { title: 'base', body: 'v1', scope: 'shared' }).node;
  const file = join(dir, 'graph.jsonl');
  const patch = (body: string) => JSON.stringify({ op: 'patch', id: n.id, fields: { body, updatedAt: '2026-01-01T00:00:00.000Z' } });
  appendFileSync(file, ['{"op":"begin","n":3}', patch('half'), patch('half2'), '{"op":"commit","n":3}', patch('after')].join('\n') + '\n');
  const g2 = new Graph({ dir });
  assert.equal(g2.getNode(HUMAN, n.id)!.body, 'after', 'the short batch was dropped, the later write applied');
  // an old uncounted batch that did commit applies as a whole
  appendFileSync(file, ['{"op":"begin"}', patch('old-1'), patch('old-2'), '{"op":"commit"}'].join('\n') + '\n');
  assert.equal(new Graph({ dir }).getNode(HUMAN, n.id)!.body, 'old-2');
  assert.match(readFileSync(file, 'utf8'), /"op":"begin","n":3/);
});

test('tainted paths: mark, read back, a clean rewrite takes the mark off, restart keeps it, searching a tree that holds one counts', () => {
  const dir = tmp('fx2-tp-');
  const file = join(dir, 'tp.json');
  const tp = new TaintedPaths(file);
  const p = TaintedPaths.resolvePath(dir, 'ws/notes.txt');
  assert.equal(tp.has(p), false);
  tp.mark(p);
  assert.equal(tp.has(p), true);
  assert.equal(new TaintedPaths(file).has(p), true, 'persisted');
  assert.equal(tp.touches(join(dir, 'ws')), true);
  assert.equal(tp.touches(join(dir, 'other')), false);
  tp.unmark(p);
  assert.equal(new TaintedPaths(file).has(p), false);
  let t = 1000;
  const aging = new TaintedPaths(undefined, () => t);
  aging.mark(p);
  t += 31 * 24 * 3600 * 1000;
  assert.equal(aging.has(p), false, 'marks expire after 30 days');
});

test('tainted paths in the engine: Grep over a tree holding a tainted file taints; a clean Write of the same file clears it', async () => {
  const states: boolean[] = [];
  let step = 0;
  const s = setup((c) => c.agent !== 'alpha' ? undefined : (async function* () {
    yield init('s' + step);
    if (step === 0) { yield toolUse('WebFetch'); yield toolUse('Write', 'w1', { file_path: 'a.txt', content: 'web' }); }
    else if (step === 1) { yield toolUse('Grep', 'g1', { pattern: 'x' }); }
    else if (step === 2) { yield toolUse('Write', 'w2', { file_path: 'a.txt', content: 'mine' }); }
    else { yield toolUse('Grep', 'g3', { pattern: 'x' }); }
    yield ok('done', 's' + step);
  })());
  for (step = 0; step < 4; step++) {
    const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'run' + step, source: 'ui' }));
    states.push(t.tainted === true);
  }
  assert.deepEqual(states, [true, true, false, false]);
});

test('R2-T2 Legion tool names: the exact in-process servers pass, look-alike servers do not', () => {
  for (const t of ['mcp__legion__ask', 'mcp__legion__vm_start', 'mcp__legion_comms__room_read', 'mcp__legion_kg__kg_capture']) assert.equal(isLegionTool(t), true, t);
  for (const t of ['mcp__legion__x__run', 'mcp__legion_kg__a__b', 'mcp__legionx__ask', 'mcp__legion__', 'mcp__legion__Ask', 'Read', 'mcp__github__x']) assert.equal(isLegionTool(t), false, t);
});
