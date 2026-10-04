/** Builds the real in-process servers of every module (fake outside world) so the "What you can do right now" tests read real registrations. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { buildAgentToolsServer } from '../src/core/agent-tools.js';
import { renderCapabilities } from '../src/core/agent-facts.js';
import { createBlenderModule } from '../src/core/blender/index.js';
import { createBrowserModule } from '../src/core/browser/index.js';
import { createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { createCommsModule } from '../src/core/comms/index.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../src/core/modules.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ApprovalMode } from '../src/shared/types.js';

export interface World { agents: AgentProfile[]; servers(a: AgentProfile, o?: { vm?: boolean }): Record<string, McpServerConfig>; block(a: AgentProfile, o?: { vm?: boolean; ceiling?: ApprovalMode }): string; dispose(): void }

export function world(o: { bsv?: boolean; browser?: boolean; blender?: boolean; both?: boolean; polyhaven?: boolean } = {}): World {
  const dir = cleanupTemp('legion-facts-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const config = defaultConfig();
  Object.assign(config, { workspaceDir: join(dir, 'ws') });
  if (o.bsv) (config as { bsv?: unknown }).bsv = { enabled: true, network: 'testnet' };
  if (o.blender) (config as { blender?: unknown }).blender = { enabled: true, ...(o.both ? { both: true } : {}), ...(o.polyhaven ? { assets: { polyhaven: true } } : {}) };
  const store = new Store(dir);
  store.seedDefaults(join(dir, 'ws'));
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus, { timeoutMs: 1000 });
  const bsvState = createBsvState({ dataDir, config });
  const deps = { config, store, bus, engine: {} as never, approvals, dataDir, bsvEnabled: () => bsvState.enabled } as ModuleDeps;
  const mods: CoreModule[] = [
    createCommsModule(deps),
    createKnowledgeModule(deps),
    createBsvModule(deps, { state: bsvState }),
    createBlenderModule(deps, { vms: { touch() {}, ensureRunning: async () => ({}), stop: async () => ({}), status: (id: string) => ({ agentId: id, state: 'none' }) } as never, boatConfigured: () => false, log: () => undefined }),
  ];
  const browser = createBrowserModule(deps);
  if (o.browser) browser.state.update({ enabled: true });
  mods.push(browser);
  const job: ModuleJob = { taskId: 'facts_1', taint: () => false, markTainted: () => undefined };
  const servers = (a: AgentProfile, so: { vm?: boolean } = {}): Record<string, McpServerConfig> => {
    const out: Record<string, McpServerConfig> = { legion: buildAgentToolsServer({ agentId: a.id, taskId: job.taskId, vms: {} as never, bridge: {} as never, vmEnabled: so.vm === true }) };
    for (const m of mods) Object.assign(out, m.mcpServers?.(a, job) ?? {});
    return out;
  };
  return {
    agents: store.listAgents(),
    servers,
    block: (a, bo = {}) => renderCapabilities(a, { servers: servers(a, bo), vmEnabledForAgent: !!a.vm?.enabled, ...(bo.ceiling ? { ceiling: bo.ceiling } : {}) }),
    dispose: () => { for (const m of mods) void m.dispose?.(); },
  };
}

/** The tool names a block lists on the line for one server. */
export function listedFor(block: string, server: string): string[] {
  const m = block.split('\n').find((l) => l.includes(`(${server}):`));
  if (!m) return [];
  return m.slice(m.indexOf(`(${server}):`) + server.length + 3).split('.')[0]!.split(',').map((s) => s.trim()).filter(Boolean);
}
