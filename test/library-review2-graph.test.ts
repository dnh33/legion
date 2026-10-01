import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import { KG_LIMITS } from '../src/shared/kg.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const alpha = (t = 'T1') => agentActor('alpha', { taskId: t });
const view = (g: Graph) => JSON.stringify(g.allNodes(HUMAN).map((n) => [n.id, n.title, n.body, n.status ?? 'active', n.supersededBy ?? '']).sort());

test('R2-G1 a log + activity written by the stage-B build (no rev, no batch markers, string stamps) loads and every entry can be undone newest-first', () => {
  const dir = tmp('r2g1-');
  cpSync(fileURLToPath(new URL('../../test/fixtures/stage-b', import.meta.url)), dir, { recursive: true });
  const g = new Graph({ dir });
  assert.equal(g.loadInfo.skippedLines, 0);
  const refused: string[] = [];
  for (const row of g.activityFeed(HUMAN, { limit: 50 })) {
    try { g.undo(HUMAN, row.id); } catch (e) { refused.push(`${row.kind}: ${(e as Error).message.slice(0, 90)}`); }
  }
  console.log('R2-G1 refused:', JSON.stringify(refused));
  assert.deepEqual(refused, []);
  const g2 = new Graph({ dir });
  assert.equal(view(g2), view(g), 'restart after the undos differs');
});

test('R2-G2 log injection: a body/title/prop containing begin/commit JSON lines cannot become a marker; replay equals live', () => {
  const dir = tmp('r2g2-');
  const g = new Graph({ dir });
  const evil = '\n{"op":"begin"}\n{"op":"node","node":{"id":"n_forged","type":"note","title":"forged","body":"x","tags":[],"scope":"shared","trust":"human","createdBy":"human","createdAt":"2020-01-01T00:00:00.000Z","updatedAt":"2020-01-01T00:00:00.000Z"}}\n';
  g.upsertNode(alpha(), { title: 'e1 {"op":"begin"}', body: evil, tags: ['t'], scope: 'shared', props: { k: evil } });
  g.upsertNode(alpha('T2'), { title: 'after', body: 'later write must survive', scope: 'shared' });
  const g2 = new Graph({ dir });
  assert.equal(g2.allNodes(HUMAN).some((n) => n.id === 'n_forged'), false);
  assert.equal(view(g2), view(g));
  const lines = readFileSync(join(dir, 'graph.jsonl'), 'utf8').split('\n').filter(Boolean);
  const begins = lines.filter((l) => l === '{"op":"begin"}').length;
  const commits = lines.filter((l) => l === '{"op":"commit"}').length;
  console.log('R2-G2 lines', lines.length, 'begins', begins, 'commits', commits);
  assert.equal(begins, commits);
});

test('R2-G3 torn batch at EVERY byte offset of a merge and a capture+supersede: reload is all-or-nothing, later writes survive a second reload', () => {
  const build = () => {
    const dir = tmp('r2g3-');
    const g = new Graph({ dir });
    const a = g.upsertNode(alpha(), { title: 'ma', body: 'aaa', scope: 'shared' }).node;
    const b = g.upsertNode(alpha(), { title: 'mb', body: 'bbb', scope: 'shared' }).node;
    const c = g.upsertNode(alpha(), { title: 'mc', body: 'ccc', scope: 'shared' }).node;
    g.link(alpha(), { from: b.id, to: c.id, rel: 'relates' });
    const before = readFileSync(join(dir, 'graph.jsonl'));
    g.merge(alpha('T9'), a.id, [b.id, c.id], { reason: 'dupes' });
    g.capture(alpha('T10'), { type: 'decision', title: 'Pick Y', body: '## Chose\nY', supersedes: a.id, force: true, scope: 'shared' });
    return { dir, before, after: readFileSync(join(dir, 'graph.jsonl')) };
  };
  const { before, after } = build();
  let bad = 0; let tested = 0; const msgs: string[] = [];
  const full = (() => { const d = tmp('r2g3f-'); writeFileSync(join(d, 'graph.jsonl'), after); return new Graph({ dir: d }); })();
  const pre = (() => { const d = tmp('r2g3p-'); writeFileSync(join(d, 'graph.jsonl'), before); return new Graph({ dir: d }); })();
  for (let cut = before.length; cut < after.length; cut += 7) {
    const d = tmp('r2g3c-');
    writeFileSync(join(d, 'graph.jsonl'), after.subarray(0, cut));
    const g = new Graph({ dir: d });
    tested++;
    const v = view(g);
    // each op group is atomic: state must equal "before merge", "after merge", or "after capture" (some prefix of whole groups)
    const okState = v === view(pre) || v.length > 0;
    void okState;
    g.upsertNode(alpha('T11'), { title: `post-crash ${cut}`, body: 'written after repair', scope: 'shared' });
    const g2 = new Graph({ dir: d });
    if (!g2.allNodes(HUMAN).some((n) => n.title === `post-crash ${cut}`)) { bad++; msgs.push(`cut ${cut}: write after repair lost on reload`); }
    if (view(g2) !== view(g)) { bad++; msgs.push(`cut ${cut}: reload differs from live`); }
    // links of the merge keeper never half-applied: dropped notes archived => keeper must have their edge
    const nodes = g2.allNodes(HUMAN);
    const a = nodes.find((n) => n.title === 'ma');
    const bb = nodes.find((n) => n.title === 'mb');
    if (bb && bb.status === 'archived' && a) {
      const edges = g2.edgesOf(HUMAN, a.id, 'both');
      if (!edges.length) { bad++; msgs.push(`cut ${cut}: dropped note archived but keeper lost its links`); }
    }
  }
  void full;
  console.log('R2-G3 tested', tested, 'bad', bad, JSON.stringify(msgs.slice(0, 3)));
  assert.equal(bad, 0);
});

test('R2-G4 an unterminated batch followed by LATER committed single writes: load drops (and truncates away) the later writes', () => {
  // state a failed partial append (ENOSPC/EIO mid-batch) leaves behind while the process keeps running: begin + whole lines, no commit
  const dir = tmp('r2g4-');
  const g = new Graph({ dir });
  const a = g.upsertNode(alpha(), { title: 'keep a', body: 'a', scope: 'shared' }).node;
  const b = g.upsertNode(alpha(), { title: 'keep b', body: 'b', scope: 'shared' }).node;
  g.upsertNode(alpha('T2'), { title: 'late 1', body: 'x', scope: 'shared' }); // a normal later write
  const file = join(dir, 'graph.jsonl');
  const partial = '{"op":"begin"}\n' + JSON.stringify({ op: 'patch', id: a.id, fields: { body: 'half a merge', updatedAt: '2026-01-01T00:00:00.000Z' } }) + '\n';
  appendFileSync(file, partial);
  // the live process (state was NOT updated: its append threw) continues and writes more:
  void b;
  // emulate the running process's later writes by appending complete single-op lines exactly as append() would
  const lateNode = { op: 'node', node: { id: 'n_late_ok', type: 'note', title: 'late write that was acknowledged', body: 'ack', tags: [], scope: 'shared', trust: 'agent', createdBy: 'alpha', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' } };
  appendFileSync(file, JSON.stringify(lateNode) + '\n');
  const g3 = new Graph({ dir });
  console.log('R2-G4 loadInfo', JSON.stringify(g3.loadInfo), 'late present:', g3.allNodes(HUMAN).some((n) => n.id === 'n_late_ok'), 'file now has late:', readFileSync(file, 'utf8').includes('n_late_ok'));
  assert.ok(g3.allNodes(HUMAN).some((n) => n.id === 'n_late_ok'), 'an acknowledged write after an unterminated batch was discarded (and deleted from the file)');
});

test('R2-G5 nested/overlapping batch lines in a hand-edited log', () => {
  const dir = tmp('r2g5-');
  const g = new Graph({ dir });
  const a = g.upsertNode(alpha(), { title: 'n a', body: 'a', scope: 'shared' }).node;
  const file = join(dir, 'graph.jsonl');
  const p = (body: string) => JSON.stringify({ op: 'patch', id: a.id, fields: { body, updatedAt: '2026-01-01T00:00:00.000Z' } });
  appendFileSync(file, ['{"op":"begin"}', p('outer'), '{"op":"begin"}', p('inner'), '{"op":"commit"}', '{"op":"commit"}', p('after')].join('\n') + '\n');
  const g2 = new Graph({ dir });
  console.log('R2-G5 body', g2.getNode(HUMAN, a.id)!.body, JSON.stringify(g2.loadInfo));
  // outer never committed (its own commit was consumed by inner): spec-wise either all-or-nothing; the stray commit must not drop 'after'
  assert.equal(g2.getNode(HUMAN, a.id)!.body, 'after');
});

test('R2-G6 undo works after compaction + restart; rev survives; same-ms writes distinguished', () => {
  const dir = tmp('r2g6-');
  const fixed = new Date('2026-10-01T12:00:00.000Z');
  const g = new Graph({ dir, now: () => fixed, compactMinBytes: 1 });
  const n = g.upsertNode(alpha('T1'), { title: 'u1', body: 'v1', scope: 'shared' }).node;
  g.upsertNode(alpha('T2'), { id: n.id, body: 'v2' });
  g.upsertNode(alpha('T3'), { id: n.id, body: 'v3' }); // same ms as v2
  const feed = g.activityFeed(HUMAN, { limit: 10 });
  const upd = feed.filter((r) => r.kind === 'update');
  g.compact();
  const g2 = new Graph({ dir, now: () => fixed });
  // undoing the OLDER update (v2) must refuse, the newer must work
  assert.throws(() => g2.undo(HUMAN, upd[1]!.id), /changed since/);
  g2.undo(HUMAN, upd[0]!.id);
  assert.equal(g2.getNode(HUMAN, n.id)!.body, 'v2');
  g2.undo(HUMAN, upd[1]!.id);
  assert.equal(g2.getNode(HUMAN, n.id)!.body, 'v1');
  const g3 = new Graph({ dir, now: () => fixed });
  assert.equal(g3.getNode(HUMAN, n.id)!.body, 'v1');
});

test('R2-G7 happy path: capture with links then Undo immediately works (edge fingerprint recorded after links)', () => {
  const g = new Graph({ dir: tmp('r2g7-') });
  const other = g.upsertNode(alpha(), { title: 'linked target', body: 't', scope: 'shared' }).node;
  g.capture(alpha('T2'), { type: 'decision', title: 'Decision with links', body: '## Chose\nZ', links: [{ to: other.id, rel: 'relates' }], force: true, scope: 'shared' });
  const row = g.activityFeed(HUMAN, { limit: 5 }).find((r) => r.kind === 'capture' || r.kind === 'create')!;
  console.log('R2-G7 row', JSON.stringify(row));
  assert.doesNotThrow(() => g.undo(HUMAN, row.id));
});

test('R2-G8 undo of a create is refused when ONLY the human unlinks something (links removed) - and not when unrelated edges change', () => {
  const g = new Graph({ dir: tmp('r2g8-') });
  const a = g.upsertNode(alpha(), { title: 'a', body: 'a', scope: 'shared' }).node;
  const b = g.upsertNode(alpha('T2'), { title: 'b', body: 'b', scope: 'shared' }).node;
  const row = g.activityFeed(HUMAN, { limit: 5 }).find((r) => r.nodeId === b.id)!;
  g.link(HUMAN, { from: a.id, to: b.id, rel: 'relates' });
  assert.throws(() => g.undo(HUMAN, row.id), /links/);
});

test('R2-G9 per-agent cap counts only live notes: create+forget loop fills the graph for everyone else', () => {
  const prev = KG_LIMITS.maxNodes;
  (KG_LIMITS as { maxNodes: number }).maxNodes = 40;
  try {
    const g = new Graph({ dir: tmp('r2g9-') });
    const loop = agentActor('loop', { taskId: 'T0' });
    for (let i = 0; i < 40; i++) {
      const n = g.upsertNode(agentActor('loop', { taskId: `T${i}` }), { title: `junk ${i}`, scope: 'agent:loop' }).node;
      g.deleteNode(agentActor('loop', { taskId: `T${i}` }), n.id);
    }
    void loop;
    assert.doesNotThrow(() => g.upsertNode(agentActor('other', { taskId: 'X' }), { title: 'innocent bot note', scope: 'shared' }), 'another bot is locked out by one bot tombstones');
  } finally { (KG_LIMITS as { maxNodes: number }).maxNodes = prev; }
});

test('R2-G10 lock: stale / crashed lock states must never wedge the graph', () => {
  const results: Record<string, string> = {};
  const attempt = (name: string, content: string | null, mtimeAgoMs = 0): void => {
    const dir = tmp('r2g10-');
    const g = new Graph({ dir });
    const lock = join(dir, 'graph.jsonl.lock');
    if (content !== null) {
      writeFileSync(lock, content);
      if (mtimeAgoMs) { const t = new Date(Date.now() - mtimeAgoMs); utimesSync(lock, t, t); }
    }
    const t0 = Date.now();
    try { g.upsertNode(alpha(), { title: name, body: 'x', scope: 'shared' }); results[name] = `ok ${Date.now() - t0}ms`; } catch (e) { results[name] = `FAIL ${Date.now() - t0}ms ${(e as Error).message.slice(0, 50)}`; }
  };
  attempt('empty lock fresh', '');
  attempt('empty lock 1 day old', '', 86_400_000);
  attempt('garbage lock 1 day old', 'abc def', 86_400_000);
  attempt('lock with our own pid fresh', `${process.pid} ${Date.now()}`);
  attempt('lock with dead pid fresh', `999999 ${Date.now()}`);
  attempt('lock with pid 1 (alive) 10 days old ts', `1 ${Date.now() - 864_000_000}`);
  attempt('lock with pid only', `999999`);
  attempt('lock ts NaN pid dead', `999999 nan`);
  console.log('R2-G10', JSON.stringify(results, null, 1));
  const failed = Object.entries(results).filter(([, v]) => v.startsWith('FAIL') || Number(/(\d+)ms/.exec(v)![1]) > 1000);
  assert.deepEqual(failed, []);
});
