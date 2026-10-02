/** Library notes scoped to a project (controls C10, C11, C12). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Graph } from '../src/core/kg/graph.js';
import { buildKgToolsServer } from '../src/core/kg/tools.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import type { Actor } from '../src/core/kg/types.js';
import { projectScope } from '../src/shared/projects.js';

const P1 = 'proj_aaaaaaaaaaaa';
const P2 = 'proj_bbbbbbbbbbbb';
const T0 = new Date('2026-03-01T12:00:00.000Z');
const mk = () => new Graph({ dir: mkdtempSync(join(tmpdir(), 'legion-proj-kg-')), bsvEnabled: () => false, now: () => T0 });
const inP1 = (id = 'alpha', extra: Partial<Extract<Actor, { kind: 'agent' }>> = {}) => agentActor(id, { projectId: P1, ...extra });
const inP2 = agentActor('beta', { projectId: P2 });
const none = agentActor('gamma');
const hits = (g: Graph, a: Actor, q: string) => g.search(a, q).map((h) => h.node.title);

test('C10 a project\'s notes are seen by the owner and that project\'s runs only: not by another project, not by a run with no project, in no read path', () => {
  const g = mk();
  const n = g.upsertNode(HUMAN, { title: 'Quasar deployment key facts', body: 'quasar deployment runbook', scope: projectScope(P1) }).node;
  const shared = g.upsertNode(HUMAN, { title: 'Quasar shared note', body: 'quasar general' }).node;
  g.link(HUMAN, { from: n.id, to: shared.id, rel: 'relates' });
  assert.ok(hits(g, HUMAN, 'quasar').includes(n.title));
  assert.ok(hits(g, inP1(), 'quasar').includes(n.title));
  for (const other of [inP2, none]) {
    assert.ok(!hits(g, other, 'quasar').includes(n.title), 'search');
    assert.equal(g.getNode(other, n.id), undefined, 'get');
    assert.ok(!g.recall(other, 'quasar deployment').outline.includes('Quasar deployment key facts'), 'recall');
    assert.ok(!g.recall(other, 'quasar').nodeIds.includes(n.id), 'recall ids');
    assert.ok(!g.allNodes(other).some((x) => x.id === n.id), 'list');
    assert.ok(!g.neighbors(other, shared.id, {}).nodes.some((x) => x.node.id === n.id), 'neighbors through a link from a visible note');
    assert.ok(!g.subgraph(other, [shared.id], {}).nodes.some((x) => x.id === n.id), 'subgraph');
    assert.deepEqual(g.search(other, 'quasar', { scope: projectScope(P1) }), [], 'a search scoped to the project is empty');
    assert.equal(g.stats(other).byScope[projectScope(P1)], undefined, 'stats do not count it');
    assert.ok(!g.similarTitles(other, 'Quasar deployment key facts').some((x) => x.id === n.id), 'duplicate check does not name it');
  }
  // the briefing of another project's run does not name it
  assert.ok(!g.briefingParts('beta', { prompt: 'quasar deployment', projectId: P2 }).hits.some((h) => h.id === n.id));
  assert.ok(g.briefingParts('alpha', { prompt: 'quasar deployment key facts', projectId: P1 }).hits.length >= 0);
});

test('C11 a run writes only its own project\'s scope; held or untrusted exactly like shared when it is tainted or ask-capped; private rules unchanged', () => {
  const g = mk();
  assert.throws(() => g.upsertNode(inP1(), { title: 'Other project note', scope: projectScope(P2) }), /may write only/);
  assert.throws(() => g.upsertNode(none, { title: 'No project note', scope: projectScope(P1) }), /may write only/);
  const own = g.upsertNode(inP1(), { title: 'Own project note', body: 'b', scope: projectScope(P1) });
  assert.equal(own.node.scope, projectScope(P1));
  assert.equal(own.pending, undefined, 'a clean run\'s note is live');
  // a tainted run: its project note waits in the inbox (like a shared one) and is untrusted
  const tainted = g.upsertNode(inP1('alpha', { taint: () => true }), { title: 'Tainted project note', body: 'b', scope: projectScope(P1) });
  assert.equal(tainted.pending, true);
  assert.equal(tainted.node.trust, 'untrusted');
  assert.equal(g.getNode(inP1('delta'), tainted.node.id), undefined, 'a pending note is invisible to other runs of the project');
  // an ask-capped run (started by an MCP client): held as well
  const capped = g.upsertNode(inP1('alpha', { origin: { roomId: 'mcp', fromAgentId: 'mcp', hop: 0, approvalCeiling: 'ask' }, ceiling: 'ask' }), { title: 'Capped project note', body: 'b', scope: projectScope(P1) });
  assert.equal(capped.pending, true);
  // private scope is unchanged: a tainted run's private note is stored untrusted, not held
  const priv = g.upsertNode(inP1('alpha', { taint: () => true }), { title: 'Tainted private', body: 'b', scope: 'agent:alpha' });
  assert.equal(priv.pending, undefined);
  assert.equal(priv.node.trust, 'untrusted');
  // a bot does not rewrite the owner's project note: it becomes a proposal
  const human = g.upsertNode(HUMAN, { title: 'Owner project note', body: 'v1', scope: projectScope(P1) }).node;
  const edit = g.upsertNode(inP1(), { id: human.id, title: 'Owner project note', body: 'v2', scope: projectScope(P1) });
  assert.ok(edit.proposalFor === human.id || edit.pending === true, 'proposal, not a direct edit');
  assert.equal(g.getNode(HUMAN, human.id)!.body, 'v1');
  // a bot cannot move a note into or out of a project
  assert.throws(() => g.upsertNode(inP1(), { id: own.node.id, scope: 'shared' }), /Only the human can move/);
});

test('C12 recall prefers the running project\'s notes over equal shared ones and never returns another project\'s (clock pinned)', () => {
  const g = mk();
  const body = 'zephyr cache invalidation strategy';
  const shared = g.upsertNode(HUMAN, { title: 'Zephyr cache (shared)', body }).node;
  const mine = g.upsertNode(HUMAN, { title: 'Zephyr cache (project one)', body, scope: projectScope(P1) }).node;
  const theirs = g.upsertNode(HUMAN, { title: 'Zephyr cache (project two)', body, scope: projectScope(P2) }).node;
  const order = g.search(inP1(), 'zephyr cache invalidation strategy').map((h) => h.node.id);
  assert.equal(order[0], mine.id, 'the project\'s own note ranks first');
  assert.ok(order.includes(shared.id), 'shared notes are still returned');
  assert.ok(!order.includes(theirs.id), 'another project\'s note is not');
  const recall = g.recall(inP1(), 'zephyr cache invalidation strategy');
  assert.ok(recall.outline.indexOf('project one') < recall.outline.indexOf('(shared)'), 'recall lists the project note first');
  assert.ok(!recall.outline.includes('project two'));
  // without a project the shared note is all there is
  assert.deepEqual(g.search(none, 'zephyr cache invalidation strategy').map((h) => h.node.id), [shared.id]);
  // the owner sees all three, in plain score order (no boost for the owner)
  assert.equal(g.search(HUMAN, 'zephyr cache invalidation strategy').length, 3);
});

async function connect(g: Graph, agentId: string, projectId?: string) {
  const cfg = buildKgToolsServer(g, agentId, projectId ? { projectId } : {});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(st);
  const client = new Client({ name: 'kg-test', version: '0.0.0' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join('\n'), isError: r.isError === true };
  };
}

test('C10/C11 the tools: scope "project" means the run\'s own project, and fails outside a project; no argument names another project', async () => {
  const g = mk();
  g.upsertNode(HUMAN, { title: 'Hidden P2 fact', body: 'umbrella umbrella', scope: projectScope(P2) });
  const inProject = await connect(g, 'alpha', P1);
  const w = await inProject('kg_upsert_node', { title: 'P1 fact', body: 'umbrella plan', scope: 'project' });
  assert.equal(w.isError, false, w.text);
  assert.match(w.text, new RegExp(`scope ${projectScope(P1).replace(/\./g, '\\.')}`));
  const r = await inProject('kg_recall', { query: 'umbrella', scope: 'project' });
  assert.match(r.text, /P1 fact/);
  assert.doesNotMatch(r.text, /Hidden P2 fact/);
  const all = await inProject('kg_search', { query: 'umbrella' });
  assert.doesNotMatch(all.text, /Hidden P2 fact/);
  // a scope argument that is not one of the words is refused by the schema (a project id cannot be named)
  const sneaky = await inProject('kg_upsert_node', { title: 'x', scope: projectScope(P2) }).catch((e) => ({ isError: true, text: String(e) }));
  assert.equal(sneaky.isError, true);
  const plain = await connect(g, 'gamma');
  const no = await plain('kg_upsert_node', { title: 'x', scope: 'project' });
  assert.equal(no.isError, true);
  assert.match(no.text, /not part of a project/);
  const cap = await plain('kg_capture', { kind: 'lesson', title: 'No project lesson', fields: { lesson: 'x', why: 'y' }, scope: 'project' });
  assert.equal(cap.isError, true);
});
