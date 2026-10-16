/** Shared rig for the away tests: a real Engine over a fake store, a real ProjectStore, a gated scripted model and a stub away module. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { QuestionBroker } from '../src/core/questions.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { AwayHooks, QueryFn } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { TaintedPaths } from '../src/core/tainted-paths.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ChatMessage, LegionEvent, Task } from '../src/shared/types.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import type { ModeResolver } from '../src/core/gates-settings/index.js';

export class FakeStore {
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
export const mkAgent = (id: string, approval: AgentProfile['approval'] = 'full'): AgentProfile => ({
  id, name: id.toUpperCase(), emoji: 'A', description: '', systemPrompt: 'x', model: 'auto',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval, mcpServers: ['*'], createdAt: '', updatedAt: '',
});
export const ok = (text = 'done') => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, num_turns: 1, session_id: 's1' });

export interface AwayState { paused: Set<string>; budget: Set<string>; spends: Array<Record<string, unknown>>; rollsAt: Map<string, number> }

export function setup(opts: { maxConcurrent?: number; withAway?: boolean; approval?: AgentProfile['approval']; approvalTimeoutMs?: number; modes?: ModeResolver; /** a real gates core (store + resolver) over the rig's project store, signing with a fixed test key; it replaces `modes` */ gatesCore?: boolean; script?: (params: { prompt: unknown; options: Record<string, unknown> }) => AsyncGenerator<unknown, void> } = {}) {
  const root = cleanupTemp('legion-queue-');
  const store = new FakeStore();
  for (const id of ['a1', 'a2', 'a3']) store.agents.set(id, mkAgent(id, opts.approval ?? 'full'));
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const config = defaultConfig();
  config.workspaceDir = join(root, 'data', 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const queryFn = ((params: { prompt: unknown; options: Record<string, unknown> }) => {
    const text = JSON.stringify(params.prompt);
    started.push(text);
    calls.push(params);
    if (opts.script) return Object.assign(opts.script(params), { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}) });
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      await new Promise<void>((r) => gates.set(text, r));
      yield ok();
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}) });
  }) as unknown as QueryFn;
  const awayState: AwayState = { paused: new Set(), budget: new Set(), spends: [], rollsAt: new Map() };
  const approvals = new ApprovalBroker(bus, { timeoutMs: opts.approvalTimeoutMs });
  const questions = new QuestionBroker(bus);
  const away: AwayHooks = {
    isPaused: (pid) => awayState.paused.has(pid),
    budgetBlocked: (pid) => awayState.budget.has(pid),
    budgetRollsAt: (pid) => awayState.rollsAt.get(pid),
    recordSpend: (e) => { awayState.spends.push(e as unknown as Record<string, unknown>); },
  };
  const core = opts.gatesCore ? createGatesCore({ dataDir: join(root, 'data'), projects, keyring: { get: () => Buffer.alloc(32, 7) } as never }) : undefined;
  const engine = new Engine({
    store: store as never, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as never, approvals, questions, config, queryFn,
    boatConfigured: () => false, projects, taintedPaths: new TaintedPaths(join(root, 'tp.json')), maxConcurrent: opts.maxConcurrent,
    ...(opts.withAway === false ? {} : { away }),
    ...(core ? { modes: core.resolver } : opts.modes ? { modes: opts.modes } : {}),
  });
  const project = projects.setMembers(projects.create({ name: 'Shop', instructions: '' }).id, ['a1', 'a2', 'a3']);
  const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
  const release = (prompt: string) => { for (const [k, fn] of gates) if (k.includes(prompt)) fn(); };
  const start = (agentId: string, prompt: string, extra: Record<string, unknown> = {}) =>
    engine.startTask({ agentId, prompt, source: 'ui', projectId: project.id, ...extra } as never);
  const queueEvents = () => events.filter((e): e is Extract<LegionEvent, { type: 'queue.updated' }> => e.type === 'queue.updated');
  return { engine, bus, events, away: awayState, approvals, questions, calls, config, project, projects, core, tick, release, start, started, queueEvents, store };
}

