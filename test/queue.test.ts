/** Queue truth (0.3.0): why a task waits, who is held by "Pause new starts" and the budget, and "Queue after it". */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { AwayHooks, QueryFn } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { TaintedPaths } from '../src/core/tainted-paths.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ChatMessage, LegionEvent, QueueSnapshot, Task } from '../src/shared/types.js';

class FakeStore {
  agents = new Map<string, AgentProfile>();
  tasks = new Map<string, Task>();
  msgs: ChatMessage[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  listAgents() { return [...this.agents.values()]; }
  listTasks(limit = 500, agentId?: string, _all = false) { return [...this.tasks.values()].filter((t) => !agentId || t.agentId === agentId).slice(0, limit).map((t) => ({ ...t })); }
  upsertTask(t: Task) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: ChatMessage) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}
const mkAgent = (id: string): AgentProfile => ({
  id, name: id.toUpperCase(), emoji: 'A', description: '', systemPrompt: 'x', model: 'auto',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: ['*'], createdAt: '', updatedAt: '',
});
const ok = (text = 'done') => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, num_turns: 1, session_id: 's1' });

interface AwayState { paused: Set<string>; budget: Set<string>; spends: Array<Record<string, unknown>> }

function setup(opts: { maxConcurrent?: number; withAway?: boolean } = {}) {
  const root = cleanupTemp('legion-queue-');
  const store = new FakeStore();
  for (const id of ['a1', 'a2', 'a3']) store.agents.set(id, mkAgent(id));
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const config = defaultConfig();
  config.workspaceDir = join(root, 'data', 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const queryFn = ((params: { prompt: unknown }) => {
    const text = JSON.stringify(params.prompt);
    started.push(text);
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      await new Promise<void>((r) => gates.set(text, r));
      yield ok();
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}) });
  }) as unknown as QueryFn;
  const awayState: AwayState = { paused: new Set(), budget: new Set(), spends: [] };
  const away: AwayHooks = {
    isPaused: (pid) => awayState.paused.has(pid),
    budgetBlocked: (pid) => awayState.budget.has(pid),
    recordSpend: (e) => { awayState.spends.push(e as unknown as Record<string, unknown>); },
  };
  const engine = new Engine({
    store: store as never, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as never, approvals: new ApprovalBroker(bus), config, queryFn,
    boatConfigured: () => false, projects, taintedPaths: new TaintedPaths(join(root, 'tp.json')), maxConcurrent: opts.maxConcurrent,
    ...(opts.withAway === false ? {} : { away }),
  });
  const project = projects.setMembers(projects.create({ name: 'Shop', instructions: '' }).id, ['a1', 'a2', 'a3']);
  const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
  const release = (prompt: string) => { for (const [k, fn] of gates) if (k.includes(prompt)) fn(); };
  const start = (agentId: string, prompt: string, extra: Record<string, unknown> = {}) =>
    engine.startTask({ agentId, prompt, source: 'ui', projectId: project.id, ...extra } as never);
  const queueEvents = () => events.filter((e): e is Extract<LegionEvent, { type: 'queue.updated' }> => e.type === 'queue.updated');
  return { engine, bus, events, away: awayState, project, tick, release, start, started, queueEvents, store };
}

const reasonOf = (q: QueueSnapshot, taskId: string) => q.items.find((i) => i.taskId === taskId)?.reason;

test('a full slot set queues the next task with the reason "slot" and its place in line', async () => {
  const s = setup({ maxConcurrent: 1 });
  const a = s.start('a1', 'first');
  const b = s.start('a2', 'second');
  const c = s.start('a3', 'third');
  await s.tick();
  const q = s.engine.queueSnapshot();
  assert.equal(q.cap, 1);
  assert.equal(q.running, 1);
  assert.deepEqual(q.items, [{ taskId: b.id, reason: 'slot', position: 1 }, { taskId: c.id, reason: 'slot', position: 2 }]);
  s.release('first');
  await s.tick(60);
  const after = s.engine.queueSnapshot();
  assert.deepEqual(after.items, [{ taskId: c.id, reason: 'slot', position: 1 }]);
  assert.ok(a.id);
  s.release('second'); s.release('third');
  await s.tick(80);
  assert.deepEqual(s.engine.queueSnapshot().items, []);
});

test('queue.updated is sent when the queue changes, not when nothing did', async () => {
  const s = setup({ maxConcurrent: 1 });
  s.start('a1', 'first');
  s.start('a2', 'second');
  await s.tick();
  const n = s.queueEvents().length;
  assert.ok(n >= 1);
  const last = s.queueEvents().at(-1)!.queue;
  assert.deepEqual(last, s.engine.queueSnapshot());
  s.bus.emit({ type: 'away.updated' });   // nothing about the queue changed
  await s.tick();
  assert.equal(s.queueEvents().length, n, 'no new event for an unchanged queue');
  s.release('first'); s.release('second');
  await s.tick(80);
});

test('without an away module a core behaves as before: only the slot reason exists', async () => {
  const s = setup({ maxConcurrent: 1, withAway: false });
  s.start('a1', 'first');
  const b = s.start('a2', 'second');
  await s.tick();
  assert.equal(reasonOf(s.engine.queueSnapshot(), b.id), 'slot');
  s.release('first'); s.release('second');
  await s.tick(80);
});

test('Pause new starts holds the Marshal, and does NOT hold the owner\'s own start', async () => {
  const s = setup({ maxConcurrent: 4 });
  s.away.paused.add(s.project.id);
  const marshal = s.start('a1', 'marshal job', { trigger: 'marshal' });
  const owner = s.start('a2', 'owner job');
  const owner2 = s.start('a3', 'owner job two', { trigger: 'owner' });
  await s.tick();
  const q = s.engine.queueSnapshot();
  assert.equal(reasonOf(q, marshal.id), 'paused');
  assert.equal(reasonOf(q, owner.id), undefined, 'the owner\'s click runs');
  assert.equal(reasonOf(q, owner2.id), undefined);
  assert.equal(s.started.filter((t) => t.includes('owner job')).length, 2);
  assert.equal(s.started.filter((t) => t.includes('marshal job')).length, 0);
  // resume: the held start goes
  s.away.paused.clear();
  s.bus.emit({ type: 'away.updated' });
  await s.tick();
  assert.equal(s.started.filter((t) => t.includes('marshal job')).length, 1);
  assert.deepEqual(s.engine.queueSnapshot().items, []);
  for (const p of ['marshal job', 'owner job']) s.release(p);
  await s.tick(80);
});

test('schedule starts are held by a pause too; room wakes, delegations and continues are not', async () => {
  const s = setup({ maxConcurrent: 4 });
  s.away.paused.add(s.project.id);
  const sched = s.start('a1', 'scheduled', { trigger: 'schedule' });
  const room = s.start('a2', 'room wake', { trigger: 'room' });
  const bot = s.engine.startTask({ agentId: 'a3', prompt: 'bot wake', source: 'bot', projectId: s.project.id } as never);
  await s.tick();
  const q = s.engine.queueSnapshot();
  assert.equal(reasonOf(q, sched.id), 'paused');
  assert.equal(reasonOf(q, room.id), undefined);
  assert.equal(reasonOf(q, bot.id), undefined);
  s.away.paused.clear(); s.bus.emit({ type: 'away.updated' });
  await s.tick();
  for (const p of ['scheduled', 'room wake', 'bot wake']) s.release(p);
  await s.tick(80);
});

test('a budget holds every start in the project, the owner\'s too, with the reason "budget"', async () => {
  const s = setup({ maxConcurrent: 4 });
  s.away.budget.add(s.project.id);
  const owner = s.start('a1', 'owner job');
  const marshal = s.start('a2', 'marshal job', { trigger: 'marshal' });
  await s.tick();
  const q = s.engine.queueSnapshot();
  assert.equal(reasonOf(q, owner.id), 'budget');
  assert.equal(reasonOf(q, marshal.id), 'budget');
  assert.equal(s.started.length, 0);
  s.away.budget.clear(); s.bus.emit({ type: 'away.updated' });
  await s.tick();
  assert.equal(s.started.length, 2);
  s.release('owner job'); s.release('marshal job');
  await s.tick(80);
});

test('a task outside any project is never held by a project\'s pause or budget', async () => {
  const s = setup({ maxConcurrent: 4 });
  s.away.paused.add(s.project.id); s.away.budget.add(s.project.id);
  const free = s.engine.startTask({ agentId: 'a1', prompt: 'no project', source: 'ui' });
  await s.tick();
  assert.equal(reasonOf(s.engine.queueSnapshot(), free.id), undefined);
  assert.equal(s.started.length, 1);
  s.release('no project');
  await s.tick(60);
});

test('reason precedence: budget, then paused, then after, then slot', async () => {
  const s = setup({ maxConcurrent: 1 });
  const first = s.start('a1', 'running');       // takes the only slot
  await s.tick();
  s.away.paused.add(s.project.id);
  const both = s.start('a1', 'both', { trigger: 'marshal', startAfter: true });
  const pausedAfter = s.start('a1', 'paused after', { trigger: 'marshal', startAfter: true });
  const afterOnly = s.start('a1', 'after only', { startAfter: true });
  const slotOnly = s.start('a2', 'slot only');
  await s.tick();
  let q = s.engine.queueSnapshot();
  assert.equal(reasonOf(q, both.id), 'paused', 'paused beats after');
  assert.equal(reasonOf(q, pausedAfter.id), 'paused');
  assert.equal(reasonOf(q, afterOnly.id), 'after', 'after beats slot');
  assert.equal(reasonOf(q, slotOnly.id), 'slot');
  s.away.budget.add(s.project.id);
  s.bus.emit({ type: 'away.updated' });
  await s.tick();
  q = s.engine.queueSnapshot();
  for (const id of [both.id, pausedAfter.id, afterOnly.id, slotOnly.id]) assert.equal(reasonOf(q, id), 'budget', 'budget beats everything');
  assert.ok(first.id);
  s.away.budget.clear(); s.away.paused.clear(); s.bus.emit({ type: 'away.updated' });
  s.release('running');
  await s.tick(100);
  for (const p of ['both', 'paused after', 'after only', 'slot only']) { s.release(p); await s.tick(60); }
  await s.tick(100);
});

test('Queue after it: a second run of the same agent in the same project waits for the first, other agents do not', async () => {
  const s = setup({ maxConcurrent: 4 });
  s.start('a1', 'builder one');
  await s.tick();
  const queued = s.start('a1', 'builder two', { startAfter: true });
  const other = s.start('a2', 'scribe', { startAfter: true });
  const plain = s.start('a1', 'builder three');   // "Run anyway": both at once
  await s.tick();
  const q = s.engine.queueSnapshot();
  assert.equal(reasonOf(q, queued.id), 'after');
  assert.equal(reasonOf(q, other.id), undefined, 'nothing of a2 to wait for');
  assert.equal(reasonOf(q, plain.id), undefined);
  assert.equal(s.started.filter((t) => t.includes('builder two')).length, 0);
  s.release('builder one'); s.release('builder three');
  await s.tick(100);
  assert.equal(s.started.filter((t) => t.includes('builder two')).length, 1, 'it starts when the others finish');
  s.release('builder two'); s.release('scribe');
  await s.tick(80);
});

test('a delegated child of a live run bypasses the cap and every hold', async () => {
  const s = setup({ maxConcurrent: 1 });
  const parent = s.start('a1', 'parent');
  await s.tick();
  s.away.budget.add(s.project.id); s.away.paused.add(s.project.id);
  const child = s.engine.startTask({ agentId: 'a2', prompt: 'child', source: 'agent', projectId: s.project.id, bridge: { fromAgentId: 'a1', parentTaskId: parent.id } } as never);
  await s.tick();
  assert.equal(reasonOf(s.engine.queueSnapshot(), child.id), undefined);
  assert.equal(s.started.filter((t) => t.includes('child')).length, 1, 'it runs although the cap is full and the budget is reached');
  assert.equal(s.engine.queueSnapshot().running, 2, 'the app shows min(running, cap)');
  s.away.budget.clear(); s.away.paused.clear();
  s.release('child'); s.release('parent');
  await s.tick(80);
});

test('cancelling a queued task removes it from the snapshot at once', async () => {
  const s = setup({ maxConcurrent: 1 });
  s.start('a1', 'first');
  const b = s.start('a2', 'second');
  await s.tick();
  assert.equal(reasonOf(s.engine.queueSnapshot(), b.id), 'slot');
  assert.equal(s.engine.cancel(b.id), true);
  assert.deepEqual(s.engine.queueSnapshot().items, []);
  assert.deepEqual(s.queueEvents().at(-1)!.queue.items, []);
  s.release('first');
  await s.tick(60);
});
