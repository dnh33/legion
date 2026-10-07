import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { initialPrompt } from '../src/core/input-channel.js';
import { basename, join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile } from '../src/shared/types.js';

/** A real Store and Engine with a scripted Claude: four agents (zealot, builder, scout, worker). Shared by the bridge tests. */
export type Call = { agent: string; prompt: string; options: any; n: number };
export type Script = (c: Call) => AsyncGenerator<any, void> | undefined;
const mkAgent = (id: string, name: string): AgentProfile => ({
  id, name, emoji: '*', description: `${name} does things`, systemPrompt: '', model: 'sonnet',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [], createdAt: '', updatedAt: '',
});
let sidN = 0;
export const ok = (text: string, sid: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0, num_turns: 1, session_id: sid });
export const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid });
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
export const isReply = (p: string) => p.split('\n').pop()!.startsWith('[Reply from');

export function setup(script: Script, maxConcurrent = 4) {
  const dir = cleanupTemp('legion-hop-');
  const store = new Store(dir);
  for (const [id, name] of [['zealot', 'Zealot'], ['builder', 'Builder'], ['scout', 'Scout'], ['worker', 'Worker']]) store.upsertAgent(mkAgent(id!, name!));
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  const calls: Call[] = [];
  const queryFn = ((p: any) => {
    const agent = basename(p.options.cwd);
    const call: Call = { agent, prompt: initialPrompt(p.prompt), options: p.options, n: calls.filter((c) => c.agent === agent).length };
    calls.push(call);
    const sid = `sess-${++sidN}`;
    const gen = script(call) ?? (async function* () { yield init(sid); yield ok(`${agent} says: ${call.prompt.split('\n').pop()}`, sid); })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const engine = new Engine({ store, bus, vms: {} as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false, maxConcurrent });
  return { store, bus, engine, calls };
}
export async function callTool(options: any, name: string, args: any): Promise<{ isError?: boolean; text: string }> {
  const r = await options.mcpServers.legion.instance._registeredTools[name].handler(args, {});
  return { isError: r.isError, text: r.content.map((c: any) => c.text).join('\n') };
}
export const notices = (s: ReturnType<typeof setup>, taskId: string) => s.store.listMessages(taskId).filter((m) => m.role === 'system').map((m) => m.text);

