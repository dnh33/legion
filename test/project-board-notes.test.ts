/** Notes linked to items: owner links, agent links, automatic linking at run end, and "Save what we learned" (control C19). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventBus } from '../src/core/bus.js';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import { BoardError, BoardStore, createBoardModule, graphNotes } from '../src/core/projects/board/index.js';
import type { ProjectRef } from '../src/core/projects/board/store.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { BOARD_LIMITS } from '../src/shared/board.js';
import { projectScope } from '../src/shared/projects.js';

const code = (fn: () => unknown, status: number) => assert.throws(fn, (e: unknown) => e instanceof BoardError && e.status === status);
const T0 = new Date('2026-03-01T12:00:00.000Z');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'legion-board-notes-'));
  const graph = new Graph({ dir: join(root, 'kg'), bsvEnabled: () => false, now: () => T0 });
  const projects = new ProjectStore(join(root, 'd'), join(root, 'w'));
  const board = new BoardStore(join(root, 'd', 'board'), () => 0);
  const P = projects.setMembers(projects.create({ name: 'P' }).id, ['alpha', 'beta']);
  const Q = projects.setMembers(projects.create({ name: 'Q' }).id, ['alpha']);
  const notes = graphNotes(() => graph);
  const mod = createBoardModule({ config: {} as any, store: { getAgent: (id: string) => ({ id, name: id }) } as any, bus: new EventBus(), engine: {} as any, approvals: { request: async () => true } as any, dataDir: root, bsvEnabled: () => false }, { projects, board, notes });
  const routes = new Map<string, (c: any) => any>();
  mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  const call = (m: string, p: string, params: string[], body?: unknown) => routes.get(`${m} ${p}`)!({ params, body, req: {} });
  return { graph, projects, board, P, Q, notes, mod, call };
}
async function tool(s: ReturnType<typeof setup>, agent: string, project: string, taskId = 'task_1') {
  const cfg = s.mod.mcpServers!({ id: agent, name: agent } as any, { taskId, taint: () => false, projectId: project } as any).legion_board as any;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(b);
  const c = new Client({ name: 't', version: '0' }); await c.connect(a);
  return async (name: string, args: Record<string, unknown>) => { const r: any = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content[0].text as string }; };
}

test('C19 store: owner sets note links (shape, cap, dedupe); an agent adds; link is idempotent, capped and survives a reload', () => {
  const d = mkdtempSync(join(tmpdir(), 'legion-board-notes2-'));
  const P: ProjectRef = { id: 'proj_aaaaaaaaaaaa', members: ['scout'], status: 'active' };
  const s = new BoardStore(d, () => 0);
  const i = s.create(P, { title: 'x', assignee: { kind: 'agent', id: 'scout' } });
  assert.deepEqual(i.noteIds, []);
  assert.deepEqual(s.patch(P, i.id, { noteIds: ['n:1', 'n:1', 'n_2'] }).noteIds, ['n:1', 'n_2']);
  code(() => s.patch(P, i.id, { noteIds: ['bad id'] }), 400); code(() => s.patch(P, i.id, { noteIds: 'n1' }), 400);
  code(() => s.patch(P, i.id, { noteIds: Array.from({ length: BOARD_LIMITS.noteLinks + 1 }, (_, k) => `n${k}`) }), 400);
  assert.deepEqual(s.botUpdate(P, 'scout', i.id, { noteIds: ['n_2', 'n_3'] }, { tainted: false }).noteIds, ['n:1', 'n_2', 'n_3'], 'a union, never a removal');
  const again = s.linkNotes(P.id, i.id, ['n_3', 'n_4'], { kind: 'system' })!;
  assert.deepEqual(again.noteIds, ['n:1', 'n_2', 'n_3', 'n_4']);
  assert.equal(s.linkNotes(P.id, i.id, ['n_4'], { kind: 'system' })!.activity.filter((a) => a.kind === 'note-link').length, 2, 'linking the same note again adds nothing');
  const many = s.linkNotes(P.id, i.id, Array.from({ length: 15 }, (_, k) => `m${k}`), { kind: 'system' })!;
  assert.equal(many.noteIds.length, BOARD_LIMITS.noteLinks); assert.equal(many.noteIds.at(-1), 'm14');
  assert.deepEqual(new BoardStore(d).get(P.id, i.id)!.noteIds, many.noteIds);
  assert.equal(s.linkNotes(P.id, 'wi_000000000000', ['n1'], { kind: 'system' }), undefined);
  s.beginRun(P, i.id, 'task_5');
  assert.deepEqual(s.itemsForTask(P.id, 'task_5').map((x) => x.id), [i.id]); assert.deepEqual(s.itemsForTask(P.id, 'task_nope'), []);
});

test('C19 an agent links only notes that exist in THIS project\'s Library: not another project\'s, not a private note, not an invented id', async () => {
  const s = setup();
  const mine = s.graph.upsertNode(agentActor('alpha', { projectId: s.P.id }), { title: 'Pricing decision', body: 'three tiers', scope: projectScope(s.P.id) }).node;
  const other = s.graph.upsertNode(agentActor('alpha', { projectId: s.Q.id }), { title: 'Other project note', body: 'secret roadmap', scope: projectScope(s.Q.id) }).node;
  const priv = s.graph.upsertNode(agentActor('alpha'), { title: 'My private thought', body: 'x', scope: 'agent:alpha' }).node;
  const item = s.board.create(s.P, { title: 'Pricing page', assignee: { kind: 'agent', id: 'alpha' } });
  const t = await tool(s, 'alpha', s.P.id);
  assert.equal((await t(' update'.trim(), { id: item.id, noteIds: [mine.id] })).err, false);
  assert.deepEqual(s.board.get(s.P.id, item.id)!.noteIds, [mine.id]);
  for (const bad of [other.id, priv.id, 'invented-id']) {
    const r = await t('update', { id: item.id, noteIds: [bad] });
    assert.equal(r.err, true, bad); assert.match(r.text, /not a note in this project/);
  }
  assert.deepEqual(s.board.get(s.P.id, item.id)!.noteIds, [mine.id], 'nothing else was linked');
});

test('C19 automatic: notes a run saved in the project Library are linked to the item it worked on; automatic episodes and other projects\' notes are not', () => {
  const s = setup();
  const owner = s.board.create(s.P, { title: 'Owner run', assignee: { kind: 'agent', id: 'alpha' } });
  s.board.beginRun(s.P, owner.id, 'task_run');
  const agentItem = s.board.create(s.P, { title: 'Agent item', assignee: { kind: 'agent', id: 'beta' } });
  s.board.botUpdate(s.P, 'beta', agentItem.id, { note: 'on it' }, { taskId: 'task_agent', tainted: false });
  const run = (taskId: string, agent: string, project: string) => agentActor(agent, { projectId: project, taskId });
  const n1 = s.graph.upsertNode(run('task_run', 'alpha', s.P.id), { title: 'Learned A', body: 'a', scope: projectScope(s.P.id) }).node;
  const n2 = s.graph.upsertNode(run('task_agent', 'beta', s.P.id), { title: 'Learned B', body: 'b', scope: projectScope(s.P.id) }).node;
  s.graph.upsertNode(run('task_run', 'alpha', s.Q.id), { title: 'Wrong project', body: 'c', scope: projectScope(s.Q.id) });
  s.graph.upsertNode(run('task_run', 'alpha', s.P.id), { title: 'Private', body: 'd', scope: 'agent:alpha' });
  s.graph.recordEpisode({ taskId: 'task_run', agentId: 'alpha', title: 't', status: 'done', turns: 12, costUsd: 1, prompt: 'p', result: 'r', tainted: false, projectId: s.P.id });
  const end = (id: string, agent: string) => s.mod.onTaskEnd!({ id, projectId: s.P.id, status: 'done', result: 'ok' } as any, { id: agent } as any, { status: 'done', isError: false, tainted: false });
  end('task_run', 'alpha'); end('task_agent', 'beta');
  assert.deepEqual(s.board.get(s.P.id, owner.id)!.noteIds, [n1.id]);
  assert.deepEqual(s.board.get(s.P.id, agentItem.id)!.noteIds, [n2.id]);
  assert.ok(s.board.get(s.P.id, owner.id)!.activity.some((a) => a.kind === 'note-link' && a.by.kind === 'system'));
  end('task_nothing', 'alpha'); // a task that saved nothing, or worked on no item, changes nothing and does not throw
});

test('C19 Save what we learned: the owner\'s note lands in the project scope (members see it, other projects do not), is linked, and archived or empty requests are refused', () => {
  const s = setup();
  const item = s.board.create(s.P, { title: 'Ship pricing', status: 'done' });
  const r = s.call('POST', '/api/projects/:id/board/items/:iid/note', [s.P.id, item.id], { title: 'Pricing: what we learned', body: 'Three tiers worked; annual toggle confused people.' });
  assert.equal(r.note.title, 'Pricing: what we learned'); assert.deepEqual(r.item.noteIds, [r.note.id]);
  const node = s.graph.getNode(HUMAN, r.note.id)!;
  assert.equal(node.scope, projectScope(s.P.id)); assert.equal(node.trust, 'human'); assert.equal(node.props?.boardItem, item.id); assert.ok(node.tags.includes('learned'));
  assert.ok(s.graph.search(agentActor('beta', { projectId: s.P.id }), 'annual toggle').some((h) => h.node.id === r.note.id), 'a member run finds it');
  assert.equal(s.graph.getNode(agentActor('alpha', { projectId: s.Q.id }), r.note.id), undefined, 'another project does not');
  assert.deepEqual(s.call('GET', '/api/projects/:id/board/notes/:nid', [s.P.id, r.note.id]), { id: r.note.id, title: 'Pricing: what we learned' });
  assert.throws(() => s.call('GET', '/api/projects/:id/board/notes/:nid', [s.Q.id, r.note.id]), /Unknown note/);
  assert.throws(() => s.call('POST', '/api/projects/:id/board/items/:iid/note', [s.P.id, item.id], { title: '', body: 'x' }), /title and body/);
  assert.throws(() => s.call('POST', '/api/projects/:id/board/items/:iid/note', [s.P.id, item.id], { title: 'k', body: 'private key: ' + 'ab'.repeat(32) }), (e: any) => e.status === 400);
  assert.throws(() => s.call('POST', '/api/projects/:id/board/items/:iid/note', [s.P.id, 'wi_000000000000'], { title: 'a', body: 'b' }), /Unknown item/);
  s.projects.update(s.P.id, { status: 'archived' });
  assert.throws(() => s.call('POST', '/api/projects/:id/board/items/:iid/note', [s.P.id, item.id], { title: 'a', body: 'b' }), /archived/);
});
