/**
 * Core module seam. A module adds in-process MCP servers, HTTP routes and a prompt
 * preamble without touching engine.ts / server.ts again. Owned by the integration lead.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from '../shared/types.js';
import type { Handler } from './server.js';

export type RouteAdder = (method: string, pattern: string, handler: Handler, status?: number) => void;

export interface CoreModule {
  id: string;
  /** In-process MCP servers this agent gets (keys become the server name, e.g. "legion_comms"). */
  mcpServers?(agent: AgentProfile): Record<string, McpServerConfig>;
  /** Extra system-prompt text for this agent (appended after the Legion preamble). */
  preamble?(agent: AgentProfile): string;
  /** Register HTTP routes under /api/... (bearer auth is already enforced by the dispatcher). */
  routes?(add: RouteAdder): void;
  /** Called on shutdown. */
  dispose?(): void | Promise<void>;
}

import type { LegionConfig } from '../shared/types.js';
import type { ApprovalBroker } from './approvals.js';
import type { EventBus } from './bus.js';
import type { Engine } from './engine.js';
import type { Store } from './store.js';

/** Everything a module may use. Built in the composition root after the engine exists. */
export interface ModuleDeps {
  config: LegionConfig;
  store: Store;
  bus: EventBus;
  engine: Engine;
  approvals: ApprovalBroker;
  /** Legion data dir (e.g. ~/.legion). Modules keep their files in a subfolder of it. */
  dataDir: string;
  /** True while the optional BSV Dev Kit toggle is on. */
  bsvEnabled: () => boolean;
}
