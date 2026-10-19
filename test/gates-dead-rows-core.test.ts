/** Gates PR 2, dead rows, through the real parts: budget stop over the real away core and spend ledger, and the stall ladder over the board module with a real activity log. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BoardStore, createBoardModule } from '../src/core/projects/board/index.js';
import { ProjectStore } from '../src/core/projects/index.js';
import { createActivityLog } from '../src/core/activity/index.js';
import { createAwayCore } from '../src/core/away/index.js';
import type { AwayCore } from '../src/core/away/index.js';
import { makeFakes } from './helpers-c.js';
import { setup } from './away-rig.js';
import { tempDir } from './tmp-cleanup.js';
import type { Task } from '../src/shared/types.js';

// ---- budget stop over the real away core ----

function budgetRig() {
  let away!: AwayCore;
  const s = setup({ maxConcurrent: 4, gatesCore: true, awayFactory: (c) => { away = createAwayCore({ dataDir: c.dataDir, bus: c.bus, tasks: c.store, projects: c.projects }); return away.service; } });
  const pid = s.project.id;
  away.store.patchProject(pid, { budget: { limit: 1, period: 'day' } });
  away.service.recordSpend({ taskId: 'earlier', agentId: 'a1', projectId: pid, usd: 5 });
  const reason = (taskId: string) => s.engine.queueSnapshot().items.find((i) => i.taskId === taskId)?.reason;
  return { s, away, pid, reason };
}

test('real budget: spent past the limit, a start waits with the reason budget while Stop at the budget is on', async () => {
  const { s, away, pid, reason } = budgetRig();
  assert.equal(away.service.status(pid).reached, true, 'the real ledger says the budget is reached');
  const t = s.start('a1', 'held job');
  await s.tick();
  assert.equal(reason(t.id), 'budget');
  assert.equal(s.started.length, 0);
  s.core!.store.patchProject(pid, { overrides: { 'budget-stop': false } });
  s.bus.emit({ type: 'gates.updated' });
  await s.tick();
  assert.equal(s.started.length, 1, 'switched off while it waited: it starts');
  s.release('held job'); await s.tick(60);
});

test('real budget: Stop at the budget off, the run starts and the budget is still reached and still shown', async () => {
  const { s, away, pid, reason } = budgetRig();
  s.core!.store.patchProject(pid, { overrides: { 'budget-stop': false } });
  const t = s.start('a1', 'free job');
  await s.tick();
  assert.equal(s.started.length, 1, 'it started');
  assert.equal(reason(t.id), undefined);
  const st = away.service.status(pid);
  assert.equal(st.limited, true, 'the budget is still set');
  assert.equal(st.reached, true, 'and still reached: the page keeps showing it');
  assert.equal(away.service.budgetBlocked(pid), true, 'the away core itself still says blocked; only the engine hold is off');
  s.release('free job'); await s.tick(60);
});

// ---- stall ladder over the board module, the real activity log ----

async function boardRig() {
  const root = tempDir('legion-stall-board-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const board = new BoardStore(join(data, 'board'));
  const f = makeFakes({ holdRuns: true });
  const started: Array<{ p: Record<string, unknown>; t: Task }> = [];
  const realStart = f.ctx.engine.startTask.bind(f.ctx.engine);
  f.ctx.engine.startTask = (args: any) => { const t = realStart(args) as Task; started.push({ p: args as Record<string, unknown>, t }); return t; };
  const p = projects.create({ name: 'Order' });
  projects.setMembers(p.id, ['zealot', 'scout']);
  const proj = projects.get(p.id)!;
  board.setMarshal(proj, { enabled: true, waveSize: 1, stallMinutes: 8 });
  const activity = createActivityLog({ dataDir: data });
  const gate = { on: false };
  const clock = { t: Date.now() };
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const bmod = createBoardModule(deps, { projects, board, activity, stallLadder: () => gate.on, marshalNow: () => clock.t, marshalSchedule: () => () => undefined });
  const item = board.create(proj, { title: 'Write the parser' });
  bmod.marshal.marshalFor(p.id)!.writeDoneWhen(item.id, ['it parses']);
  // one dispatch: the matching run answers, the work run starts and stays running
  const pass = bmod.marshal.tick(p.id);
  let ask: (typeof started)[number] | undefined;
  for (let n = 0; n < 400 && !ask; n++) { ask = started.find((s) => String(s.p.prompt).startsWith('Route this work item')); if (!ask) await new Promise((r) => setTimeout(r, 5)); }
  assert.ok(ask, 'the matcher asked through the engine');
  ask!.t.status = 'done'; ask!.t.result = 'PICK scout\nWHY best fit';
  f.bus.emit({ type: 'task.updated', task: ask!.t });
  await pass;
  const work = started.find((s) => String(s.p.prompt).startsWith('Goal:'))!;
  assert.ok(work, 'the work run started');
  return { bmod, board, f, activity, gate, clock, pid: p.id, itemId: item.id, work };
}

test('stall ladder off, through the board module: the run is not cancelled and one real activity line says so', async () => {
  const r = await boardRig();
  r.clock.t += 9 * 60_000; // past the 8-minute limit with no sign of life
  await r.bmod.marshal.tick(r.pid);
  assert.deepEqual(r.f.calls.cancel, [], 'not stopped');
  assert.equal(r.board.get(r.pid, r.itemId)!.status, 'doing');
  const lines = r.activity.read({ projectId: r.pid, kinds: ['note'] });
  assert.equal(lines.length, 1, 'one line');
  assert.match(lines[0]!.text, /Write the parser/);
  assert.match(lines[0]!.text, /8 minutes/);
  assert.match(lines[0]!.text, /not stopped, because Stop runs that stall is off/);
  assert.equal(lines[0]!.taskId, r.work.t.id);
  r.clock.t += 5 * 60_000;
  await r.bmod.marshal.tick(r.pid);
  assert.equal(r.activity.read({ projectId: r.pid, kinds: ['note'] }).length, 1, 'still one line on the next pass');
  assert.deepEqual(r.f.calls.cancel, []);
});

test('stall ladder on, through the board module: the same silent run is stopped and no "not stopped" line is written', async () => {
  const r = await boardRig();
  r.gate.on = true;
  r.clock.t += 9 * 60_000;
  await r.bmod.marshal.tick(r.pid);
  assert.deepEqual(r.f.calls.cancel, [r.work.t.id]);
  assert.deepEqual(r.activity.read({ projectId: r.pid, kinds: ['note'] }), []);
});
