/** Board run-state fixes: restart reconcile, stale-save guard, Done run guard, delete and claim guards while a run is live. */
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { BoardStore, BoardError, createBoardModule } from '../src/core/projects/board/index.js';
import { changedFields, formOf, rebaseForm, runHint } from '../ui/src/projects/board/boardLogic.js';
import { defaultConfig } from '../src/shared/config.js';
import type { Task } from '../src/shared/types.js';

function setup(tasks: Record<string, Partial<Task>> = {}) {
  const root = tempDir('legion-board-runstate-');
  const config = defaultConfig(); config.workspaceDir = join(root, 'data', 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const board = new BoardStore(join(root, 'data', 'board'), () => 0);
  const proj = projects.setMembers(projects.create({ name: 'P' }).id, ['a2', 'a3']);
  const store = { getTask: (id: string) => (tasks[id] ? ({ id, agentId: 'a2', ...tasks[id] } as Task) : undefined), getAgent: () => undefined };
  const engine = { startTask: () => { throw new Error('must not start'); } };
  const mod = createBoardModule({ config, store: store as any, bus: new EventBus(), engine: engine as any, approvals: {} as any, dataDir: root, bsvEnabled: () => false }, { projects, board });
  const routes = new Map<string, (c: any) => any>();
  mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  const call = (key: string, iid: string, body: unknown = {}) => routes.get(key)!({ params: [proj.id, iid], body, req: {} });
  return { board, proj, call, tasks };
}
const assignA2 = { kind: 'agent', id: 'a2' } as const;
const status = (e: unknown) => (e as { status?: number }).status;

test('restart: an item whose run task died is reconciled to Blocked when the board module starts', () => {
  const root = tempDir('legion-board-restart-');
  const config = defaultConfig(); config.workspaceDir = join(root, 'data', 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const proj = projects.setMembers(projects.create({ name: 'P' }).id, ['a2']);
  const first = new BoardStore(join(root, 'data', 'board'), () => 0);
  const it = first.create(proj, { title: 'x', assignee: assignA2 });
  first.beginRun(proj, it.id, 't_dead');
  const live = first.create(proj, { title: 'y', assignee: assignA2 });
  first.beginRun(proj, live.id, 't_live');
  // a new process: tasks were recovered ('error'), the board is read fresh from disk
  const board = new BoardStore(join(root, 'data', 'board'), () => 0);
  const store = { getTask: (id: string) => ({ t_dead: { id, status: 'error' }, t_live: { id, status: 'running' } } as Record<string, unknown>)[id], getAgent: () => undefined };
  createBoardModule({ config, store: store as any, bus: new EventBus(), engine: {} as any, approvals: {} as any, dataDir: root, bsvEnabled: () => false }, { projects, board });
  const a = board.get(proj.id, it.id)!;
  assert.equal(a.activeRun, undefined); assert.equal(a.status, 'blocked');
  assert.equal(a.lastRun?.taskId, 't_dead'); assert.match(a.lastRun!.preview, /Legion restarted during this run/);
  assert.ok(a.activity.some((x) => x.kind === 'run' && /restarted/.test(x.text)));
  const b = board.get(proj.id, live.id)!;
  assert.equal(b.activeRun, 't_live'); assert.equal(b.status, 'doing', 'a genuinely running task is left alone');
});

test('stale save: PATCH with an old ifUpdatedAt is refused with 409; the current one or none is accepted; the UI sends only changed fields', async () => {
  const s = setup();
  const it = s.board.create(s.proj, { title: 'x', assignee: assignA2 });
  const opened = it.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  s.board.patch(s.proj, it.id, { priority: 'high' }); // something changed since the dialog opened
  assert.throws(() => s.call('PATCH /api/projects/:id/board/items/:iid', it.id, { title: 'y', ifUpdatedAt: opened }), (e) => status(e) === 409 && /changed since/i.test((e as Error).message));
  assert.equal(s.board.get(s.proj.id, it.id)!.title, 'x');
  const cur = s.board.get(s.proj.id, it.id)!.updatedAt;
  assert.equal(s.call('PATCH /api/projects/:id/board/items/:iid', it.id, { title: 'y', ifUpdatedAt: cur }).title, 'y');
  assert.equal(s.call('PATCH /api/projects/:id/board/items/:iid', it.id, { title: 'z' }).title, 'z', 'backward compatible: the field is optional');
  // client side: only what the owner changed is sent
  const item = s.board.get(s.proj.id, it.id)!;
  const form = { title: 'z', description: item.description, status: item.status, assignee: item.assignee, priority: item.priority, due: item.due ?? null, labels: item.labels };
  assert.deepEqual(changedFields(item, form), {});
  assert.deepEqual(changedFields(item, { ...form, title: 'new', status: 'done' }), { title: 'new', status: 'done' });
});

test('run guard: running an item in Done is refused with 409; the UI shows a plain hint', () => {
  const s = setup();
  const it = s.board.create(s.proj, { title: 'x', assignee: assignA2, status: 'done' });
  assert.throws(() => s.call('POST /api/projects/:id/board/items/:iid/run', it.id), (e) => status(e) === 409 && /Move it out of Done/.test((e as Error).message));
  assert.equal(runHint({ ...it, status: 'done' }, true), 'Move it out of Done to run it again.');
  assert.match(runHint({ ...it, status: 'doing', activeRun: 't1' }, false), /run is in progress/i);
  assert.match(runHint({ ...it, status: 'backlog', assignee: null }, false), /assign it to a member agent/i);
});

test('delete guard: an item with a live run cannot be deleted (owner and leader); a dead run does not block', () => {
  const s = setup({ t1: { status: 'running' } });
  const it = s.board.create(s.proj, { title: 'x', assignee: assignA2 });
  s.board.beginRun(s.proj, it.id, 't1');
  assert.throws(() => s.call('DELETE /api/projects/:id/board/items/:iid', it.id), (e) => status(e) === 409 && /Stop the run first/.test((e as Error).message));
  s.board.setLeader(s.proj, 'a2');
  assert.throws(() => s.board.checkBotDelete(s.proj, 'a2', it.id, { tainted: false }), (e) => e instanceof BoardError && e.status === 409);
  assert.ok(s.board.get(s.proj.id, it.id));
  s.tasks.t1!.status = 'done';
  s.call('DELETE /api/projects/:id/board/items/:iid', it.id);
  assert.equal(s.board.get(s.proj.id, it.id), undefined);
});

test('claim race: another agent cannot change the assignee or status of an item with a live run; the running agent and notes are fine', () => {
  const s = setup({ t1: { status: 'running' } });
  const it = s.board.create(s.proj, { title: 'x', assignee: assignA2 });
  s.board.beginRun(s.proj, it.id, 't1');
  const run = { tainted: false };
  assert.throws(() => s.board.botUpdate(s.proj, 'a3', it.id, { assignee: { kind: 'agent', id: 'a3' } }, run), (e) => e instanceof BoardError && e.status === 409);
  assert.throws(() => s.board.botUpdate(s.proj, 'a3', it.id, { status: 'review' }, run), (e) => e instanceof BoardError && e.status === 409);
  assert.equal(s.board.get(s.proj.id, it.id)!.assignee && (s.board.get(s.proj.id, it.id)!.assignee as any).id, 'a2');
  s.board.botUpdate(s.proj, 'a3', it.id, { note: 'fyi' }, run);
  s.board.botUpdate(s.proj, 'a2', it.id, { status: 'review' }, run);
  assert.equal(s.board.get(s.proj.id, it.id)!.status, 'review');
});

test('reviewed: marking an item reviewed needs the version the owner read; newer agent text is refused with 409', async () => {
  const s = setup();
  const it = s.board.botCreate(s.proj, 'a2', { title: 'agent text' }, { tainted: false });
  assert.equal(it.trust, 'untrusted');
  const opened = it.updatedAt;
  assert.throws(() => s.call('PATCH /api/projects/:id/board/items/:iid', it.id, { trust: 'human' }), (e) => status(e) === 409 && /read its current text/.test((e as Error).message));
  await new Promise((r) => setTimeout(r, 5));
  s.board.botUpdate(s.proj, 'a2', it.id, { description: 'new instructions the owner never saw' }, { tainted: false });
  assert.throws(() => s.call('PATCH /api/projects/:id/board/items/:iid', it.id, { trust: 'human', ifUpdatedAt: opened }), (e) => status(e) === 409);
  assert.equal(s.board.get(s.proj.id, it.id)!.trust, 'untrusted', 'unseen text stays unreviewed');
  const cur = s.board.get(s.proj.id, it.id)!.updatedAt;
  assert.equal(s.call('PATCH /api/projects/:id/board/items/:iid', it.id, { trust: 'human', ifUpdatedAt: cur }).trust, 'human');
});

test('restart keeps taint: a tainted run stays tainted after reconcile; a task that is gone counts as tainted', () => {
  const root = tempDir('legion-board-taint-');
  const config = defaultConfig(); config.workspaceDir = join(root, 'data', 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const proj = projects.setMembers(projects.create({ name: 'P' }).id, ['a2']);
  const first = new BoardStore(join(root, 'data', 'board'), () => 0);
  const a = first.create(proj, { title: 'a', assignee: assignA2 }); first.beginRun(proj, a.id, 't_taint');
  const b = first.create(proj, { title: 'b', assignee: assignA2 }); first.beginRun(proj, b.id, 't_gone');
  const c = first.create(proj, { title: 'c', assignee: assignA2 }); first.beginRun(proj, c.id, 't_clean');
  const board = new BoardStore(join(root, 'data', 'board'), () => 0);
  const tasks: Record<string, unknown> = { t_taint: { id: 't_taint', status: 'error', tainted: true }, t_clean: { id: 't_clean', status: 'error' } };
  createBoardModule({ config, store: { getTask: (id: string) => tasks[id], getAgent: () => undefined } as any, bus: new EventBus(), engine: {} as any, approvals: {} as any, dataDir: root, bsvEnabled: () => false }, { projects, board });
  assert.equal(board.get(proj.id, a.id)!.lastRun?.tainted, true);
  assert.equal(board.get(proj.id, b.id)!.lastRun?.tainted, true);
  assert.equal(board.get(proj.id, c.id)!.lastRun?.tainted, false);
});

test('no guess: when the task store cannot be read, a run counts as live and is neither reconciled nor deletable', () => {
  const root = tempDir('legion-board-guess-');
  const config = defaultConfig(); config.workspaceDir = join(root, 'data', 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const proj = projects.setMembers(projects.create({ name: 'P' }).id, ['a2']);
  const board = new BoardStore(join(root, 'data', 'board'), () => 0);
  const it = board.create(proj, { title: 'x', assignee: assignA2 }); board.beginRun(proj, it.id, 't1');
  createBoardModule({ config, store: { getTask: () => { throw new Error('store unreadable'); }, getAgent: () => undefined } as any, bus: new EventBus(), engine: {} as any, approvals: {} as any, dataDir: root, bsvEnabled: () => false }, { projects, board });
  const after = board.get(proj.id, it.id)!;
  assert.equal(after.activeRun, 't1'); assert.equal(after.status, 'doing');
  assert.throws(() => board.remove(proj, it.id), (e) => e instanceof BoardError && e.status === 409);
});

test('dialog rebase: after a refused save, untouched fields take the new values and the owner edits are kept', () => {
  const s = setup();
  const old = s.board.create(s.proj, { title: 'old title', description: 'old text', assignee: assignA2 });
  const fresh = { ...old, description: 'agent rewrote this', priority: 'high' as const, updatedAt: 'later' };
  const f = rebaseForm(old, fresh, { ...formOf(old), title: 'my new title' });
  assert.equal(f.title, 'my new title', 'the owner edit is kept');
  assert.equal(f.description, 'agent rewrote this', 'an untouched field shows the new text');
  assert.equal(f.priority, 'high');
});
