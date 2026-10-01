/** Shared fixtures for the Library stage B tests: a real Engine with a scripted queryFn and the real knowledge module. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import type { KnowledgeModuleOptions } from '../src/core/kg/index.js';
import type { Graph } from '../src/core/kg/graph.js';
import { buildKgToolsServer } from '../src/core/kg/tools.js';
import type { CoreModule } from '../src/core/modules.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, Task } from '../src/shared/types.js';

export type Call = { agent: string; prompt: string; options: any; n: number };
export type Script = (c: Call) => AsyncGenerator<any, void> | undefined;

export const mkAgent = (id: string, name: string, approval: AgentProfile['approval'] = 'full', cwd?: string): AgentProfile => ({
  id, name, emoji: '*', description: `${name} does things`, systemPrompt: '', model: 'sonnet',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval, mcpServers: [], ...(cwd ? { cwd } : {}),
  createdAt: '', updatedAt: '',
});

let sidN = 0;
export const ok = (text: string, sid: string, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0, num_turns: 1, session_id: sid, ...extra });
export const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid });
export const toolUse = (name: string, id = `tu_${++sidN}`, input: unknown = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

export function setup(script: Script, opts: { modules?: CoreModule[]; agents?: AgentProfile[]; kg?: KnowledgeModuleOptions } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-libb-'));
  const store = new Store(dir);
  for (const a of opts.agents ?? [mkAgent('alpha', 'Alpha'), mkAgent('beta', 'Beta'), mkAgent('archivist', 'Archivist', 'ask'), mkAgent('builder', 'Builder')]) store.upsertAgent(a);
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  const calls: Call[] = [];
  const queryFn = ((p: any) => {
    const agent = basename(p.options.cwd);
    const call: Call = { agent, prompt: p.prompt, options: p.options, n: calls.filter((c) => c.agent === agent).length };
    calls.push(call);
    const sid = `sess-${++sidN}`;
    const gen = script(call) ?? (async function* () { yield init(sid); yield ok(`${agent} done`, sid); })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const approvals = new ApprovalBroker(bus);
  const engine = new Engine({ store, bus, vms: {} as any, approvals, config, queryFn, boatConfigured: () => false, maxConcurrent: 4 });
  const kg = createKnowledgeModule({ config, store, bus, engine, approvals, dataDir: join(dir, 'data'), bsvEnabled: () => false }, opts.kg);
  engine.setModules([kg, ...(opts.modules ?? [])]);
  return { dir, store, bus, engine, calls, kg, graph: kg.graph() as Graph, config, approvals };
}

/** Invoke one of the agent's own kg tools exactly as the model would. */
export async function kg(options: any, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const t = options.mcpServers.legion_kg.instance._registeredTools[name];
  const r = await t.handler(args, {});
  return { isError: r.isError === true, text: r.content.map((c: any) => c.text).join('\n') };
}

export const idOf = (text: string): string => /\(id (n_[0-9a-f]+)/.exec(text)![1]!;

export const waitDone = async (s: ReturnType<typeof setup>, t: Task) => {
  const done = await s.engine.waitFor(t.id, 5000);
  await new Promise((r) => setTimeout(r, 15)); // let runJob's finally (onTaskEnd) run
  return done;
};

/** Calls a tool through a real MCP client, so zod validation runs too. */
export async function connect(g: Graph, agentId: string, runCtx = {}) {
  const cfg = buildKgToolsServer(g, agentId, runCtx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(st);
  const client = new Client({ name: 'lib-test', version: '0.0.0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[]).map((c) => c.text).join('\n'), isError: r.isError === true };
  };
  return { call, client, close: async () => { await client.close(); } };
}
