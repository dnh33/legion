/**
 * Shared fakes for the comms tests (engine, store, harness). Lives in a *.test.ts file only so it stays
 * inside the comms test namespace; it carries one small self-test of the fake engine.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { EngineError } from '../src/core/engine.js';
import { CommsHub } from '../src/core/comms/hub.js';
import type { CreateRoomInput, HubEngine, HubOptions, HubStore } from '../src/core/comms/hub.js';
import type { Room, RoomMessage, TaskOrigin } from '../src/shared/comms.js';
import type { AgentProfile, ApprovalMode, LegionEvent, Task } from '../src/shared/types.js';

export const mkAgent = (id: string, name: string, approval: ApprovalMode = 'ask'): AgentProfile => ({
  id, name, emoji: '●', description: `${name} agent`, systemPrompt: '', model: 'auto',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval, mcpServers: ['*'],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

export interface StartCall { agentId: string; prompt: string; source: string; continueTaskId?: string; origin?: TaskOrigin; taskId: string; model?: string; modelOverrideBy?: string }

export class FakeEngine implements HubEngine {
  tasks = new Map<string, Task>();
  starts: StartCall[] = [];
  cancels: string[] = [];
  /** Errors to throw from the next startTask calls (consumed in order). */
  failNext: Error[] = [];
  private n = 0;
  constructor(private readonly bus: EventBus) {}

  startTask(p: { agentId: string; prompt: string; source: string; continueTaskId?: string; origin?: TaskOrigin; model?: string; modelOverrideBy?: string }): Task {
    const err = this.failNext.shift();
    if (err) throw err;
    const now = new Date().toISOString();
    let t: Task;
    if (p.continueTaskId) {
      const prev = this.tasks.get(p.continueTaskId);
      if (!prev) throw new EngineError(`Unknown task: ${p.continueTaskId}`, 404);
      if (prev.status === 'queued' || prev.status === 'running') throw new EngineError('Task is still running', 409);
      t = { ...prev, status: 'running', source: 'bot', result: undefined, error: undefined, origin: p.origin, updatedAt: now };
    } else {
      t = {
        id: `task_${++this.n}`, agentId: p.agentId, title: p.prompt.slice(0, 40), status: 'running', source: 'bot', requestedModel: 'auto',
        createdAt: now, updatedAt: now, ...(p.origin ? { origin: p.origin } : {}),
      };
    }
    this.tasks.set(t.id, t);
    this.starts.push({ agentId: p.agentId, prompt: p.prompt, source: p.source, continueTaskId: p.continueTaskId, origin: p.origin, taskId: t.id, ...(p.model ? { model: p.model } : {}), ...(p.modelOverrideBy ? { modelOverrideBy: p.modelOverrideBy } : {}) });
    this.bus.emit({ type: 'task.updated', task: { ...t } });
    return { ...t };
  }

  cancel(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || (t.status !== 'running' && t.status !== 'queued')) return false;
    this.cancels.push(id);
    t.status = 'cancelled';
    this.bus.emit({ type: 'task.updated', task: { ...t } });
    return true;
  }

  /** Completes a task. `cost` is this run's cost; the task's costUsd is cumulative like the real engine's. */
  finish(taskId: string, result: string | undefined, o: { cost?: number; status?: Task['status']; error?: string } = {}): void {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`no task ${taskId}`);
    t.status = o.status ?? 'done';
    if (t.status === 'done') t.result = result;
    if (o.error) t.error = o.error;
    t.costUsd = (t.costUsd ?? 0) + (o.cost ?? 0.01);
    this.bus.emit({ type: 'task.updated', task: { ...t } });
  }

  /** The most recent start for an agent. */
  last(agentId: string): StartCall {
    const c = [...this.starts].reverse().find((s) => s.agentId === agentId);
    if (!c) throw new Error(`no start for ${agentId}`);
    return c;
  }
  startsFor(agentId: string): StartCall[] { return this.starts.filter((s) => s.agentId === agentId); }

  delta(taskId: string, text = 'x'): void {
    this.bus.emit({ type: 'message.delta', taskId, text });
  }
}

export const DEFAULT_AGENTS: Array<[string, string, ApprovalMode]> = [
  ['zealot', 'Zealot', 'ask'], ['scout', 'Scout', 'ask'], ['builder', 'Builder', 'full'], ['scribe', 'Scribe', 'full'],
  ['ranger', 'Ranger', 'ask'], ['warden', 'Warden', 'ask'], ['oracle', 'Oracle', 'ask'],
];

export function makeHarness(opts: { dir?: string; agents?: Array<[string, string, ApprovalMode]>; hub?: Partial<HubOptions> } = {}) {
  const dir = opts.dir ?? cleanupTemp('legion-comms-');
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const agents = new Map<string, AgentProfile>();
  for (const [id, name, ap] of opts.agents ?? DEFAULT_AGENTS) agents.set(id, mkAgent(id, name, ap));
  const engine = new FakeEngine(bus);
  const store: HubStore = {
    getAgent: (id) => agents.get(id),
    listAgents: () => [...agents.values()],
    getTask: (id) => { const t = engine.tasks.get(id); return t ? { ...t } : undefined; },
    listTasks: (_limit, agentId) => [...engine.tasks.values()].filter((t) => !agentId || t.agentId === agentId),
  };
  const clock = { t: 1_000_000 };
  const make = () => new CommsHub({ engine, store, bus, dataDir: dir, now: () => clock.t, ...(opts.hub ?? {}) });
  const h = {
    dir, bus, events, agents, engine, store, clock, hub: make(),
    /** A second hub over the same data dir (simulates a restart); the old one is disposed. */
    reopen(): CommsHub { h.hub.dispose(); h.hub = make(); return h.hub; },
    room(members: string[] = ['zealot', 'scout'], extra: Partial<CreateRoomInput> = {}): Room {
      return h.hub.createRoom({ name: 'Ops', members, ...extra });
    },
    messages(roomId: string): RoomMessage[] { return h.hub.roomWithMessages(roomId, 10_000).messages; },
    texts(roomId: string): string[] { return h.messages(roomId).map((m) => m.text); },
    guardMessages(roomId: string): RoomMessage[] { return h.messages(roomId).filter((m) => m.kind === 'guard'); },
    states(agentId: string): string[] {
      return events.filter((e) => e.type === 'comms.state' && e.agentId === agentId).map((e) => (e as Extract<LegionEvent, { type: 'comms.state' }>).state);
    },
  };
  return h;
}
export type Harness = ReturnType<typeof makeHarness>;

test('fake engine: continue semantics and cumulative cost mirror the real engine', () => {
  const h = makeHarness();
  const t = h.engine.startTask({ agentId: 'zealot', prompt: 'a', source: 'bot' });
  assert.throws(() => h.engine.startTask({ agentId: 'zealot', prompt: 'b', source: 'bot', continueTaskId: t.id }), /still running/);
  h.engine.finish(t.id, 'ok', { cost: 0.5 });
  const t2 = h.engine.startTask({ agentId: 'zealot', prompt: 'b', source: 'bot', continueTaskId: t.id });
  assert.equal(t2.id, t.id);
  h.engine.finish(t.id, 'ok2', { cost: 0.25 });
  assert.equal(h.engine.tasks.get(t.id)!.costUsd, 0.75);
});
