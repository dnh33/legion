/**
 * Token fix v1: two secrets. The MCP-class bearer (config.json authToken) opens /mcp and a short client route list and runs
 * every task it starts under an `ask` ceiling; the per-launch admin secret (X-Legion-Admin) is needed for everything else.
 * Real Engine, real HTTP server, real knowledge-graph, comms and BSV modules; only the SDK query is scripted.
 */
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { createCommsModule } from '../src/core/comms/index.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import type { CoreModule } from '../src/core/modules.js';
import { HUMAN } from '../src/core/kg/types.js';
import { SettingsService } from '../src/core/settings.js';
import { isClientRoute } from '../src/core/admin.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile } from '../src/shared/types.js';
import { asClient, AUTH, authHeaders, start, TEST_ADMIN, TOKEN } from './helpers-c.js';
import { init, kg, ok, idOf } from './library-fakes.js';

const closers: Array<() => Promise<void>> = [];
/** Register as `after(closeAll)` in each test file that mounts. */
export const closeAll = async (): Promise<void> => { for (const c of closers) await c().catch(() => undefined); };

export const mk = (id: string, name: string, approval: AgentProfile['approval'], vm = false): AgentProfile => ({
  id, name, emoji: '*', description: `${name} does things`, systemPrompt: '', model: 'sonnet',
  vm: { enabled: vm, size: 'default', idleStopMinutes: 15 }, approval, mcpServers: [], createdAt: '', updatedAt: '',
});

export type Call = { agent: string; prompt: string; options: any };
export type Script = (c: Call) => AsyncGenerator<any, void> | undefined;

let sid = 0;
export const until = async (cond: () => boolean, ms = 12000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting for condition'); await new Promise((r) => setTimeout(r, 10)); }
};

export async function mount(script: Script = () => undefined, o: { headless?: boolean; seeded?: boolean; approvalTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-tok1-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ port: 4747, authToken: TOKEN, workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {} }, null, 2));
  const store = new Store(dir);
  if (o.seeded) store.seedDefaults(join(dir, 'ws'));
  else for (const a of [mk('zealot', 'Zealot', 'ask'), mk('rogue', 'Rogue', 'full', true), mk('worker', 'Worker', 'ask')]) store.upsertAgent(a);
  const bus = new EventBus();
  const config = defaultConfig();
  config.authToken = TOKEN;
  config.workspaceDir = join(dir, 'ws');
  const calls: Call[] = [];
  const queryFn = ((p: any) => {
    const call: Call = { agent: basename(p.options.cwd), prompt: p.prompt, options: p.options };
    calls.push(call);
    const id = `sess-${++sid}`;
    const gen = script(call) ?? (async function* () { yield init(id); yield ok(`${call.agent} done`, id); })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const approvals = new ApprovalBroker(bus, { timeoutMs: o.approvalTimeoutMs });
  const vmCalls: string[] = [];
  const vms: any = {
    touch() {}, ensureRunning: async () => ({}), stop: async () => ({}), status: (id: string) => ({ agentId: id, state: 'none' }),
    exec: async (id: string, cmd: string) => { vmCalls.push(`exec:${id}:${cmd}`); return { exitCode: 0, stdout: 'ran', stderr: '' }; },
    desktopUrl: async () => 'https://desk.example/x', screenshot: async () => ({ format: 'jpeg', data: '' }),
  };
  const engine = new Engine({ store, bus, vms, approvals, config, queryFn, boatConfigured: () => false, maxConcurrent: 4 });
  const bsvState = createBsvState({ dataDir, config });
  const bsvEnabled = () => bsvState.enabled;
  const deps = { config, store, bus, engine, approvals, dataDir, bsvEnabled };
  const kgMod = createKnowledgeModule(deps, { debounceMs: 20 });
  const comms = createCommsModule(deps);
  const bsv = createBsvModule(deps, { state: bsvState, kg: kgMod });
  const modules: CoreModule[] = [kgMod, comms, bsv];
  engine.setModules(modules);
  const settings = new SettingsService({ config, bus, configPath, dataDir, onBoatChange: () => undefined });
  const ctx: any = {
    config, store, bus, engine, vms, approvals, boatConfigured: () => false, modules, bsvEnabled, settings,
    doctor: async () => [], catalog: async () => ({ commands: [], models: [], fetchedAt: 'x' }),
    ...(o.headless ? { adminSecret: undefined } : {}),
  };
  const srv = await start(ctx);
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = asClient) => {
    const r = await fetch(srv.base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  const mcp = async () => {
    const client = new Client({ name: 'tok1', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.base + '/mcp'), { requestInit: { headers: asClient } }));
    return client;
  };
  const tool = async (client: Client, name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: r.content.map((c: any) => c.text).join('\n') };
  };
  const close = async () => { await kgMod.dispose?.(); await comms.dispose?.(); await srv.close(); };
  closers.push(close);
  return { dir, dataDir, configPath, modules, store, bus, engine, approvals, calls, vmCalls, kgMod, bsvState, srv, http, mcp, tool, close };
}
export type Mounted = Awaited<ReturnType<typeof mount>>;
/** legion_run wait=false answers `Started. {"taskId":...}`. */
export const startedTask = (text: string): { id: string } => ({ id: (JSON.parse(text.split('\n')[0]!.replace(/^Started\. /, '')) as { taskId: string }).taskId });
export const modeOf = (m: Mounted, agent: string) => [...m.calls].reverse().find((c) => c.agent === agent)?.options.permissionMode;
