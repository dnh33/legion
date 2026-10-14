/** "Pause new starts" and the start trigger at the Marshal: the loop waits, the owner's click does not. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BoardStore, createBoardModule } from '../src/core/projects/board/index.js';
import type { BoardModule } from '../src/core/projects/board/index.js';
import { ProjectStore } from '../src/core/projects/index.js';
import { AUTH, makeFakes, start } from './helpers-c.js';
import type { Task } from '../src/shared/types.js';

const J = { 'Content-Type': 'application/json' };
type Started = { p: Record<string, unknown>; t: Task };

async function boot(o: { away?: boolean } = {}) {
  const root = cleanupTemp('legion-away-marshal-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const board = new BoardStore(join(data, 'board'));
  const f = makeFakes({ holdRuns: true });
  const started: Started[] = [];
  const realStart = f.ctx.engine.startTask.bind(f.ctx.engine);
  f.ctx.engine.startTask = (args: any) => { const t = realStart(args) as Task; started.push({ p: args as Record<string, unknown>, t }); return t; };
  (f.ctx as { projects?: unknown }).projects = projects;
  (f.ctx as { board?: unknown }).board = board;
  const p = projects.create({ name: 'Order' });
  projects.setMembers(p.id, ['zealot', 'scout']);
  board.setMarshal(projects.get(p.id)!, { enabled: true, waveSize: 1, stallMinutes: 8 });
  const paused = new Set<string>();
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const bmod: BoardModule = createBoardModule(deps, { projects, board, ...(o.away === false ? {} : { away: { isPaused: (id: string) => paused.has(id) } }), marshalSchedule: () => () => undefined });
  (f.ctx as { modules?: unknown }).modules = [bmod];
  const s = await start(f.ctx);
  const call = (m: string, path: string, body?: unknown) => fetch(s.base + path, { method: m, headers: { ...AUTH, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { bmod, projects, board, f, pid: p.id, started, paused, call, close: s.close };
}

async function matcherTask(started: Started[], after = 0): Promise<Started> {
  for (let n = 0; n < 400; n++) {
    const hit = started.slice(after).find((s) => String(s.p.prompt).startsWith('Route this work item'));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the matcher never asked through the engine');
}

test('a paused project: the loop asks for nothing and starts nothing; resumed, it goes on', async () => {
  const r = await boot();
  try {
    const item = r.board.create({ id: r.pid, members: ['zealot', 'scout'], status: 'active' }, { title: 'Write the parser' });
    await r.call('PUT', `/api/projects/${r.pid}/board/items/${item.id}/dispatch`, { doneWhen: ['it parses'] });
    r.paused.add(r.pid);
    await r.bmod.marshal.tick(r.pid);
    assert.equal(r.started.length, 0, 'not even the matching run starts while new starts are paused');
    assert.equal(r.board.get(r.pid, item.id)!.status, 'backlog');
    r.paused.clear();
    const pass = r.bmod.marshal.tick(r.pid);
    const ask = await matcherTask(r.started);
    assert.equal(ask.p.trigger, 'marshal', 'the matching run is the loop\'s too');
    ask.t.status = 'done'; ask.t.result = 'PICK scout\nWHY best fit';
    r.f.bus.emit({ type: 'task.updated', task: ask.t });
    await pass;
    const dispatch = r.started.find((s) => String(s.p.prompt).startsWith('Goal:'))!;
    assert.equal(dispatch.p.trigger, 'marshal');
    assert.equal(r.board.get(r.pid, item.id)!.status, 'doing');
  } finally { await r.close(); }
});

test('the owner\'s "Run this item" is a manual start: no marshal trigger, and a pause does not touch it', async () => {
  const r = await boot();
  try {
    const item = r.board.create({ id: r.pid, members: ['zealot', 'scout'], status: 'active' }, { title: 'Ship it', assignee: { kind: 'agent', id: 'scout' } });
    r.paused.add(r.pid);
    const res = await r.call('POST', `/api/projects/${r.pid}/board/items/${item.id}/run`, {});
    assert.equal(res.status, 201);
    assert.equal(r.started.length, 1);
    assert.equal(r.started[0]!.p.trigger, undefined, 'the engine reads that as the owner');
    assert.equal(r.started[0]!.p.source, 'ui');
  } finally { await r.close(); }
});

test('without an away module the loop is never paused', async () => {
  const r = await boot({ away: false });
  try {
    const item = r.board.create({ id: r.pid, members: ['zealot', 'scout'], status: 'active' }, { title: 'Write the parser' });
    await r.call('PUT', `/api/projects/${r.pid}/board/items/${item.id}/dispatch`, { doneWhen: ['it parses'] });
    r.paused.add(r.pid);   // nothing is listening to this set
    const pass = r.bmod.marshal.tick(r.pid);
    const ask = await matcherTask(r.started);
    assert.equal(ask.p.trigger, 'marshal');
    ask.t.status = 'done'; ask.t.result = 'PICK scout\nWHY best fit';
    r.f.bus.emit({ type: 'task.updated', task: ask.t });
    await pass;
  } finally { await r.close(); }
});
