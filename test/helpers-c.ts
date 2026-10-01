/** Shared fakes for server/mcp tests. */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EventBus } from '../src/core/bus.js';
import { EngineError } from '../src/core/engine.js';
import { createServer } from '../src/core/server.js';
import type { CoreContext } from '../src/core/server.js';
import type { AgentProfile, ApprovalRequest, ChatMessage, Task, VmRecord } from '../src/shared/types.js';

export const TOKEN = 'test-token-123';

export function mkAgent(id: string, name = id): AgentProfile {
  return {
    id, name, emoji: '●', description: `${name} agent`, systemPrompt: '', model: 'auto',
    vm: { enabled: true, size: 'default', idleStopMinutes: 15 }, approval: 'ask', mcpServers: ['*'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function makeFakes() {
  const agents = new Map<string, AgentProfile>([['zealot', mkAgent('zealot', 'Zealot')], ['scout', mkAgent('scout', 'Scout')]]);
  const tasks = new Map<string, Task>();
  const messages = new Map<string, ChatMessage[]>();
  const pending: ApprovalRequest[] = [];
  const bus = new EventBus();
  let n = 0;
  const calls = { cancel: [] as string[], resolved: [] as [string, boolean][], vm: [] as string[] };

  const engine: any = {
    startTask(p: any) {
      if (!agents.has(p.agentId)) throw new EngineError('unknown agent', 404);
      if (!p.prompt?.trim()) throw new EngineError('empty prompt', 400);
      const t: Task = {
        id: `task_${++n}`, agentId: p.agentId, title: p.prompt.slice(0, 60), status: 'running', source: p.source,
        requestedModel: p.model ?? 'auto', model: 'sonnet', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      tasks.set(t.id, t);
      messages.set(t.id, [{ id: 'm1', taskId: t.id, role: 'user', text: p.prompt, at: t.createdAt }]);
      setTimeout(() => { t.status = 'done'; t.result = `echo: ${p.prompt}`; t.costUsd = 0.01; }, 20);
      return t;
    },
    cancel(id: string) { calls.cancel.push(id); return true; },
    async waitFor(id: string, ms: number) {
      const t = tasks.get(id)!;
      const end = Date.now() + ms;
      while (t.status === 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      return t;
    },
    running: () => [],
  };
  const vm = (id: string): VmRecord => ({ agentId: id, sandboxId: null, state: 'none', size: 'default', lastUsedAt: null, createdAt: null });
  const vms: any = {
    status: (id: string) => vm(id),
    async ensureRunning(id: string) { calls.vm.push('start:' + id); return { ...vm(id), state: 'running' }; },
    async stop(id: string) { return { ...vm(id), state: 'archived' }; },
    async exec(_id: string, cmd: string) { return { exitCode: 0, stdout: `ran ${cmd}`, stderr: '' }; },
    async desktopUrl() { return 'https://desk.example/x'; },
    async screenshot(id: string) {
      const { VmError } = await import('../src/core/vm-manager.js');
      throw new VmError(`${id} not running`, 'not_running');
    },
  };
  const store: any = {
    listAgents: () => [...agents.values()],
    getAgent: (id: string) => agents.get(id),
    upsertAgent: (a: AgentProfile) => { agents.set(a.id, a); return a; },
    deleteAgent: (id: string) => agents.delete(id),
    listTasks: (limit = 200) => [...tasks.values()].reverse().slice(0, limit),
    getTask: (id: string) => tasks.get(id),
    listMessages: (id: string) => messages.get(id) ?? [],
    listVms: () => [...agents.keys()].map(vm),
  };
  const approvals: any = {
    pending: () => pending,
    resolve: (id: string, allow: boolean) => { calls.resolved.push([id, allow]); return pending.some((p) => p.id === id); },
  };
  const ctx: CoreContext = {
    config: {
      port: 0, authToken: TOKEN, workspaceDir: '/x',
      claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 5 },
      boat: { baseUrl: 'https://boat.test', apiKey: 'secret' }, mcpServers: {},
    },
    store, bus, engine, vms, approvals, boatConfigured: () => true,
    doctor: async () => [{ id: 'node', label: 'Node', ok: true, detail: 'ok' }],
    catalog: async (force?: boolean) => ({
      commands: [{ name: 'cost', description: 'Show cost', argumentHint: '' }],
      models: [{ value: 'opus', displayName: 'Opus 5.5', description: 'strongest' }],
      fetchedAt: force ? 'forced' : 'cached',
    }),
  };
  return { ctx, agents, tasks, pending, calls, bus };
}

export async function start(ctx: CoreContext): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const server = createServer(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
