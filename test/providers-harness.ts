/** A real Engine with the provider runtime pointed at a fake server; only the Claude query() is scripted (and counted). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import type { chatTurn } from '../src/core/providers/openai-compat.js';
import type { HttpLimits } from '../src/core/providers/http.js';
import type { ProviderEntry } from '../src/core/providers/types.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ChatMessage, LegionEvent, Task } from '../src/shared/types.js';
import { entryFor, provCfg, memKeys } from './providers-fakes.js';
import type { Fake } from './providers-fakes.js';

export class FakeStore {
  agents = new Map<string, AgentProfile>();
  tasks = new Map<string, Task>();
  msgs: ChatMessage[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  listAgents() { return [...this.agents.values()]; }
  listTasks() { return [...this.tasks.values()]; }
  upsertTask(t: Task) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: ChatMessage) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}

export const mkAgent = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'a1', name: 'Alpha', emoji: 'A', description: '', systemPrompt: 'Be nice.', model: 'fake:test-model',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'ask', mcpServers: ['*'], createdAt: '', updatedAt: '', ...over,
});

export interface Opts {
  agent?: Partial<AgentProfile>;
  entry?: Partial<ProviderEntry>;
  noEntry?: boolean;
  maxTurns?: number; maxToolCallsPerTurn?: number;
  vm?: boolean;
  limits?: Partial<HttpLimits>;
  turn?: typeof chatTurn;
  approvalTimeoutMs?: number;
  claude?: (params: any) => AsyncGenerator<any, void>;
}

export function setup(fake: Fake, o: Opts = {}) {
  const store = new FakeStore();
  const agent = mkAgent({ ...(o.vm ? { vm: { enabled: true, size: 'default', idleStopMinutes: 15 } } : {}), ...o.agent });
  store.agents.set(agent.id, agent);
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const config = defaultConfig();
  config.workspaceDir = join(mkdtempSync(join(tmpdir(), 'legion-prov-')), 'ws');
  config.providers = provCfg(o.noEntry ? {} : { fake: entryFor(fake, o.entry) });
  if (o.maxTurns) config.providers.maxTurns = o.maxTurns;
  if (o.maxToolCallsPerTurn) config.providers.maxToolCallsPerTurn = o.maxToolCallsPerTurn;
  const keys = memKeys(mkdtempSync(join(tmpdir(), 'legion-pk-')));
  const providers = new ProviderRuntime({ config, keys, limits: o.limits, turn: o.turn });
  const approvals = new ApprovalBroker(bus, { timeoutMs: o.approvalTimeoutMs });
  const claudeCalls: any[] = [];
  const queryFn = ((params: any) => {
    claudeCalls.push(params);
    const gen = o.claude ? o.claude(params) : (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'claude says hi', total_cost_usd: 0.01, num_turns: 1 }; })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const vmCalls: string[] = [];
  const vms = {
    touch() {}, ensureRunning: async () => ({}),
    exec: async (_id: string, cmd: string) => { vmCalls.push(cmd); return { exitCode: 0, stdout: 'vm says: ' + cmd, stderr: '' }; },
    usage: () => ({ secondsThisRun: 0, secondsToday: 0 }), status: () => ({ state: 'running', size: 'default' }), claudeAvailable: () => false,
  } as any;
  const engine = new Engine({ store: store as any, bus, vms, approvals, config, queryFn, boatConfigured: () => !!o.vm, providers });
  return { store, bus, events, config, approvals, claudeCalls, vmCalls, engine, agent, providers, keys };
}

export const until = async (cond: () => boolean, ms = 15000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting for condition'); await new Promise((r) => setTimeout(r, 10)); }
};
export const run = async (h: ReturnType<typeof setup>, prompt = 'hello', extra: Record<string, unknown> = {}): Promise<Task> => {
  const t = h.engine.startTask({ agentId: h.agent.id, prompt, source: 'ui', ...extra } as any);
  return h.engine.waitFor(t.id, 16000);
};
