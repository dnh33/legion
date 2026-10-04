/**
 * Agent access to the board, as one list of guards (control C21). Rules that apply now:
 *  - member agents (not the owner) may: create, edit text, due date, priority, labels, move/reorder (backlog, doing, review, blocked), claim/assign to a member agent, note, link project notes;
 *  - owner only: mark Done, assign to the owner, change items assigned to the owner (agents add notes only), accept/reject suggestions, mark reviewed, run an item, choose the leader, delete done/owner items;
 *  - delete: the owner-chosen leader only, with an owner approval card each time;
 *  - a tainted run, or a run another bot or an MCP client started under `ask`, may not assign or delete;
 *  - everything an agent writes as text is `untrusted` until the owner marks it reviewed.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
const code = (fn: () => unknown, status: number, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof BoardError && e.status === status && (!re || re.test(e.message)), `expected BoardError ${status}`);

function setup(opts: { approve?: (summary: string) => Promise<boolean> | boolean } = {}) {
  const root = cleanupTemp('legion-board-access-');
  const clock = { now: 0 };
  const graph = new Graph({ dir: join(root, 'kg'), bsvEnabled: () => false, now: () => new Date('2026-03-01T12:00:00.000Z') });
  const projects = new ProjectStore(join(root, 'd'), join(root, 'w'));
  const board = new BoardStore(join(root, 'd', 'board'), () => clock.now);
  const A = projects.setMembers(projects.create({ name: 'Alpha' }).id, ['scout', 'zealot']);
  const B = projects.setMembers(projects.create({ name: 'Beta' }).id, ['scout']);
  const cards: string[] = [];
  const approvals = { request: async (_t: string, _a: string, _tool: string, _i: unknown, _o: unknown, o: { summary: string }) => { cards.push(o.summary); return opts.approve ? opts.approve(o.summary) : true; } };
  const mod = createBoardModule({ config: {} as any, store: { getAgent: (id: string) => ({ id, name: id }) } as any, bus: new EventBus(), engine: {} as any, approvals: approvals as any, dataDir: root, bsvEnabled: () => false }, { projects, board, notes: graphNotes(() => graph) });
  const routes = new Map<string, (c: any) => any>();
  mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  return { root, clock, graph, projects, board, A, B, cards, mod, routes };
}
type S = ReturnType<typeof setup>;
async function as(s: S, agent: string, project: string, o: { tainted?: boolean; ceiling?: 'ask'; taskId?: string } = {}) {
  const origin = o.ceiling ? { roomId: 'mcp', fromAgentId: 'mcp', hop: 0, approvalCeiling: 'ask' as const } : undefined;
  const cfg = s.mod.mcpServers!({ id: agent, name: agent } as any, { taskId: o.taskId ?? 'task_1', taint: () => !!o.tainted, projectId: project, ...(origin ? { origin, ceiling: 'ask' } : {}) } as any).legion_board as any;
  if (!cfg) return undefined;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(b);
  const c = new Client({ name: 't', version: '0' }); await c.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => { const r: any = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content[0].text as string, json: r.isError ? undefined : JSON.parse(r.content[0].text) }; };
  return { c, call, tools: async () => (await c.listTools()).tools };
}

test('G1 the tool set: what an agent can reach, and nothing that belongs to the owner', async () => {
  const s = setup();
  const t = (await as(s, 'scout', s.A.id))!;
  const tools = await t.tools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['create', 'get', 'list', 'propose', 'update']);
  const props = new Set(tools.flatMap((x) => Object.keys((x.inputSchema as any).properties ?? {})));
  for (const owner of ['trust', 'proposal', 'createdBy', 'updatedBy', 'activeRun', 'lastRun', 'taskIds', 'roomIds', 'project', 'projectId', 'leader']) assert.ok(!props.has(owner), `no tool argument "${owner}"`);
  const statusEnum = (tools.find((x) => x.name === 'update')!.inputSchema as any).properties.status.enum;
  assert.ok(!statusEnum.includes('done')); assert.deepEqual([...statusEnum].sort(), ['backlog', 'blocked', 'doing', 'review']);
  for (const owner of ['delete', 'accept', 'reject', 'run', 'review', 'set_leader']) assert.equal((await t.c.callTool({ name: owner, arguments: {} }) as any).isError, true, `${owner} is not an agent tool`);
});

test('G2 untrusted by construction: items an agent creates, tainted or not, and any text edit of a reviewed item', async () => {
  const s = setup();
  const clean = (await as(s, 'scout', s.A.id))!; const dirty = (await as(s, 'zealot', s.A.id, { tainted: true, taskId: 'task_2' }))!;
  const c1 = await clean.call('create', { title: 'clean agent item' }); const c2 = await dirty.call('create', { title: 'tainted agent item' });
  assert.equal(s.board.get(s.A.id, c1.json.id)!.trust, 'untrusted'); assert.equal(s.board.get(s.A.id, c2.json.id)!.trust, 'untrusted');
  assert.deepEqual(s.board.get(s.A.id, c2.json.id)!.createdBy, { kind: 'agent', id: 'zealot', tainted: true });
  assert.match(s.board.get(s.A.id, c2.json.id)!.activity[0]!.text, /outside content/);
  // the owner reviewed an item; a text edit by an agent (clean or tainted) makes it unreviewed; metadata edits do not
  for (const [who, taint] of [['scout', false], ['zealot', true]] as const) {
    const it = s.board.create(s.A, { title: `owner ${who}`, description: 'reviewed text' });
    const t = who === 'scout' ? clean : dirty;
    await t.call('update', { id: it.id, priority: 'high', labels: ['x'], status: 'doing', note: 'n' });
    assert.equal(s.board.get(s.A.id, it.id)!.trust, 'human', `${who}: metadata is not text`);
    await t.call('update', { id: it.id, description: 'rewritten by an agent' });
    assert.equal(s.board.get(s.A.id, it.id)!.trust, 'untrusted', `${who}${taint ? ' (tainted)' : ''}: text edit clears the owner's review`);
    s.clock.now += 11 * 60_000;
  }
  // a note from a tainted run carries the mark for other agents
  const it = s.board.create(s.A, { title: 'x' }); await dirty.call('update', { id: it.id, note: 'from a tainted run' });
  assert.equal((await clean.call('get', { id: it.id })).json.item.activity.at(-1).fromTaintedRun, true);
});

test('G3 another project is out of reach for every tool and for the notes link', async () => {
  const s = setup();
  s.board.setLeader(s.A, 'zealot');
  const inB = s.board.create(s.B, { title: 'in B' });
  const privB = s.graph.upsertNode(HUMAN, { title: 'B note', body: 'b', scope: projectScope(s.B.id) }).node;
  const z = (await as(s, 'zealot', s.A.id))!;
  assert.equal((await z.call('get', { id: inB.id })).err, true);
  assert.equal((await z.call('update', { id: inB.id, note: 'x' })).err, true);
  assert.equal((await z.call('delete', { id: inB.id })).err, true); assert.equal(s.cards.length, 0, 'not even a card for another project\'s item');
  const mine = s.board.create(s.A, { title: 'mine' });
  assert.equal((await z.call('update', { id: mine.id, noteIds: [privB.id] })).err, true, 'a note of another project cannot be linked');
  assert.ok(!(await z.call('list')).json.items.some((i: any) => i.id === inB.id));
  assert.equal(s.board.get(s.B.id, inB.id)!.activity.length, 1); assert.deepEqual(s.board.get(s.B.id, inB.id)!.noteIds, []);
  // a member of A only has no board at all in B
  assert.equal(await as(s, 'zealot', s.B.id), undefined);
});

test('G4 owner-only rules hold: Done, assigning the owner, owner-assigned items, closed items', async () => {
  const s = setup();
  const t = (await as(s, 'scout', s.A.id))!;
  const mine = s.board.create(s.A, { title: 'm' }); const owners = s.board.create(s.A, { title: 'o', assignee: { kind: 'owner' } }); const closed = s.board.create(s.A, { title: 'c', status: 'done' });
  assert.equal((await t.c.callTool({ name: 'update', arguments: { id: mine.id, status: 'done' } }) as any).isError, true, 'Done: rejected by the schema');
  assert.equal((await t.c.callTool({ name: 'create', arguments: { title: 'x', status: 'done' } }) as any).isError, true);
  code(() => s.board.botUpdate(s.A, 'scout', mine.id, { status: 'done' }, { tainted: false }), 403);
  code(() => s.board.botCreate(s.A, 'scout', { title: 'x', status: 'done' }, { tainted: false }), 403);
  code(() => s.board.botUpdate(s.A, 'scout', mine.id, { assignee: { kind: 'owner' } }, { tainted: false }), 403);
  assert.equal((await t.call('update', { id: owners.id, title: 'mine now' })).err, true); assert.equal((await t.call('update', { id: owners.id, status: 'doing' })).err, true);
  assert.equal((await t.call('update', { id: owners.id, note: 'fyi' })).err, false, 'a note on an owner item is allowed');
  assert.equal((await t.call('update', { id: closed.id, note: 'late' })).err, true); assert.equal((await t.call('update', { id: closed.id, status: 'doing' })).err, true);
  assert.equal(s.board.get(s.A.id, owners.id)!.title, 'o'); assert.equal(s.board.get(s.A.id, closed.id)!.status, 'done');
  // no agent route to the owner's actions: the module's HTTP routes are admin-gated (see the http test); the tool server has no engine
  const tools = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'core', 'projects', 'board', 'tools.ts'), 'utf8') + readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'core', 'projects', 'board', 'store.ts'), 'utf8');
  assert.ok(!/startTask|deps\.engine|continueTaskId|child_process|spawn\(|fetch\(/.test(tools), 'agent paths start no run, no process and no request');
});

test('G5 what agents MAY do now: due dates, priority, labels, claiming, moving, reordering, noting (stated rules, with their limits)', async () => {
  const s = setup();
  const t = (await as(s, 'scout', s.A.id))!;
  const i = s.board.create(s.A, { title: 'x', due: '2026-12-01' });
  assert.equal((await t.call('update', { id: i.id, due: '2027-01-15', priority: 'high', labels: ['a', 'b'], assignee: 'scout', status: 'doing', index: 0 })).err, false);
  const got = s.board.get(s.A.id, i.id)!;
  assert.equal(got.due, '2027-01-15'); assert.equal(got.priority, 'high'); assert.deepEqual(got.labels, ['a', 'b']); assert.deepEqual(got.assignee, { kind: 'agent', id: 'scout' }); assert.equal(got.status, 'doing');
  assert.equal((await t.call('update', { id: i.id, due: null })).err, false); assert.equal(s.board.get(s.A.id, i.id)!.due, undefined);
  for (const bad of [{ due: '2027-02-30' }, { due: 'soon' }, { priority: 'urgent' }, { assignee: 'ghost' }, { labels: ['<script>'] }, { labels: ['1', '2', '3', '4', '5', '6'] }]) assert.equal((await t.call('update', { id: i.id, ...bad })).err, true, JSON.stringify(bad));
  assert.equal(s.board.get(s.A.id, i.id)!.priority, 'high', 'a bad call changed nothing');
});

test('G6 limited runs (tainted, or started by another bot / an MCP client under ask) may create, edit and move but never assign or delete', async () => {
  const s = setup();
  s.board.setLeader(s.A, 'scout');
  const item = s.board.create(s.A, { title: 'victim' });
  for (const o of [{ tainted: true }, { ceiling: 'ask' as const }]) {
    const t = (await as(s, 'scout', s.A.id, o))!;
    assert.equal((await t.call('create', { title: `limited ${JSON.stringify(o)}` })).err, false);
    assert.equal((await t.call('update', { id: item.id, status: 'review', note: 'ok' })).err, false);
    const asg = await t.call('update', { id: item.id, assignee: 'zealot' }); assert.equal(asg.err, true); assert.match(asg.text, /limited|outside content/);
    const cr = await t.call('create', { title: 'with assignee', assignee: 'zealot' }); assert.equal(cr.err, true);
    const del = await t.call('delete', { id: item.id }); assert.equal(del.err, true);
    s.clock.now += 11 * 60_000;
  }
  assert.equal(s.cards.length, 0, 'a limited run never gets as far as asking the owner'); assert.ok(s.board.get(s.A.id, item.id)); assert.equal(s.board.get(s.A.id, item.id)!.assignee, null);
  const ok = (await as(s, 'scout', s.A.id))!;
  assert.equal((await ok.call('update', { id: item.id, assignee: 'zealot' })).err, false, 'the same agent in a clean run may assign');
});

test('G7 delete: leader only, an owner card each time, re-checked after the card, never Done/owner items', async () => {
  let before: (() => void) | undefined;
  const s = setup({ approve: async () => { before?.(); return true; } });
  const z = (await as(s, 'zealot', s.A.id))!; const sc = (await as(s, 'scout', s.A.id))!;
  const victim = s.board.create(s.A, { title: 'victim' }); const keep = s.board.create(s.A, { title: 'keep' });
  assert.ok(!(await z.tools()).some((x) => x.name === 'delete'), 'no leader: nobody has the tool');
  s.board.setLeader(s.A, 'scout');
  assert.ok(!(await (await as(s, 'zealot', s.A.id))!.tools()).some((x) => x.name === 'delete'), 'a non-leader still does not');
  const lead = (await as(s, 'scout', s.A.id))!;
  assert.equal((await z.call('delete', { id: victim.id })).err, true);
  // the board changes while the card is open: the item is closed by the owner
  before = () => { s.board.patch(s.A, victim.id, { status: 'done' }); };
  const r = await lead.call('delete', { id: victim.id });
  assert.equal(r.err, true); assert.match(r.text, /Done/); assert.ok(s.board.get(s.A.id, victim.id), 'the re-check after the card refused');
  before = undefined;
  assert.equal((await lead.call('delete', { id: keep.id })).json.deleted, true); assert.equal(s.board.get(s.A.id, keep.id), undefined);
  assert.equal(s.cards.length, 2); assert.ok(s.cards.every((c) => /wants to delete the work item/.test(c)));
  void sc;
});

test('G8 abuse limits: write rate, create rate, the owner\'s reserve, and open items per agent', () => {
  const clock = { now: 0 };
  const s = new BoardStore(cleanupTemp('legion-board-lim-'), () => clock.now);
  const members = Array.from({ length: 24 }, (_, k) => `a${k}`);
  const P: ProjectRef = { id: 'proj_aaaaaaaaaaaa', members, status: 'active' };
  const run = { tainted: false };
  // per-agent open cap
  for (let k = 0; k < BOARD_LIMITS.botOpenPerAgent; k++) { if (k % BOARD_LIMITS.botCreatesPerWindow === 0) clock.now += 11 * 60_000; s.botCreate(P, 'a0', { title: `o${k}` }, run); }
  clock.now += 11 * 60_000;
  code(() => s.botCreate(P, 'a0', { title: 'one too many' }, run), 409, /already have 50 open/);
  // the owner's reserve: agents together cannot fill the board
  let n = 0;
  for (const m of members.slice(1)) for (let k = 0; k < 8 && s.count(P.id) < BOARD_LIMITS.itemsPerProject - BOARD_LIMITS.botReserve; k++, n++) { clock.now += 3 * 60_000; try { s.botCreate(P, m, { title: `${m}-${k}` }, run); } catch { clock.now += 11 * 60_000; } }
  assert.equal(s.count(P.id), BOARD_LIMITS.itemsPerProject - BOARD_LIMITS.botReserve);
  clock.now += 11 * 60_000;
  code(() => s.botCreate(P, 'a23', { title: 'into the reserve' }, run), 409, /nearly full/);
  for (let k = 0; k < BOARD_LIMITS.botReserve; k++) s.create(P, { title: `owner ${k}` });
  assert.equal(s.count(P.id), BOARD_LIMITS.itemsPerProject, 'the owner still has the reserved places');
  // write rate
  const s2 = new BoardStore(cleanupTemp('legion-board-lim2-'), () => 0);
  const it = s2.create(P, { title: 'x' });
  for (let k = 0; k < BOARD_LIMITS.botWritesPerWindow; k++) s2.botUpdate(P, 'a1', it.id, { note: `n${k}` }, run);
  code(() => s2.botUpdate(P, 'a1', it.id, { note: 'too many' }, run), 429, /Too many board writes/);
  s2.botUpdate(P, 'a2', it.id, { note: 'another agent has its own budget' }, run);
});

test('G9 secrets: an agent cannot put a key, seed phrase or credential on the board by any text path', () => {
  const s = new BoardStore(cleanupTemp('legion-board-sec-'), () => 0);
  const P: ProjectRef = { id: 'proj_aaaaaaaaaaaa', members: ['scout'], status: 'active' };
  const run = { tainted: false };
  const it = s.create(P, { title: 'x', assignee: { kind: 'agent', id: 'scout' } });
  for (const bad of [KEY, SEED, `wif ${'a1'.repeat(32)}`.replace('wif', 'private key:')]) {
    code(() => s.botCreate(P, 'scout', { title: 'ok', description: bad }, run), 400, /secret|key|seed/i);
    code(() => s.botUpdate(P, 'scout', it.id, { description: bad }, run), 400); code(() => s.botUpdate(P, 'scout', it.id, { note: bad }, run), 400); code(() => s.botUpdate(P, 'scout', it.id, { title: bad.slice(0, 100) }, run), 400);
    code(() => s.propose(P, 'scout', { title: 'p', description: bad }, run), 400);
  }
  const red = s.botUpdate(P, 'scout', it.id, { note: 'token sk-ant-api03-' + 'x'.repeat(40) + ' and url https://desk.boat.dev/x' }, run);
  assert.ok(!JSON.stringify(red).includes('sk-ant-api03-xxxx'), 'credential shapes are redacted');
  assert.equal(s.get(P.id, it.id)!.description, '', 'refused writes changed nothing');
  // a run result kept on the item is redacted too
  s.beginRun(P, it.id, 't1');
  const ended = s.endRun(P.id, 't1', { status: 'done', isError: false, text: 'done; key sk-ant-api03-' + 'y'.repeat(40), tainted: true })!;
  assert.ok(!ended.lastRun!.preview.includes('sk-ant-api03-yyyy'));
});

test('G10 Save what we learned cannot write a secret, seed phrase or key into the Library, in the title or the body', () => {
  const s = setup();
  const item = s.board.create(s.A, { title: 'Ship it', status: 'done' });
  const save = (title: string, body: string) => s.routes.get('POST /api/projects/:id/board/items/:iid/note')!({ params: [s.A.id, item.id], body: { title, body }, req: {} });
  for (const [t, b] of [['ok', KEY], ['ok', SEED], [SEED, 'fine'], ['ok', 'private key: ' + 'ab'.repeat(32)], [KEY.split('\n')[0]!, 'fine']] as const) {
    assert.throws(() => save(t, b), (e: any) => e.status === 400, `${t.slice(0, 20)} / ${b.slice(0, 20)}`);
  }
  assert.deepEqual(s.board.get(s.A.id, item.id)!.noteIds, [], 'nothing was linked');
  assert.equal(s.graph.search(HUMAN, 'sausage').filter((h) => h.node.scope === projectScope(s.A.id)).length, 0, 'nothing reached the Library');
  const r = save('Token note', 'we used sk-ant-api03-' + 'z'.repeat(40) + ' once');
  const body = s.graph.getNode(HUMAN, r.note.id)!.body;
  assert.ok(!body.includes('sk-ant-api03-zzzz'), 'a credential shape is redacted in the stored note');
  void agentActor;
});
