/**
 * Core module seam. A module adds in-process MCP servers, HTTP routes and a prompt
 * preamble without touching engine.ts / server.ts again. Owned by the integration lead.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { TaskOrigin } from '../shared/comms.js';
import type { AgentProfile, ApprovalMode, Task } from '../shared/types.js';
import type { Handler } from './server.js';

export type RouteAdder = (method: string, pattern: string, handler: Handler, status?: number) => void;

/** What the engine tells a module about the run it is building servers for. */
export interface ModuleJob {
  taskId: string;
  /** Set when another bot woke this run (rooms or the agent bridge). */
  origin?: TaskOrigin;
  /** The approval ceiling inherited from the waking bot; undefined for a run a human started. */
  ceiling?: ApprovalMode;
  /** True once the run touched outside content (WebFetch, WebSearch, Bash, an external tool) or was woken by a tainted chain. Sticky. */
  taint(): boolean;
  /** Flags the run as tainted from now on (a tool just handed it text a tainted bot wrote, e.g. room_read). Sticky. */
  markTainted?(): void;
  /** Marks the task as having read connector data (sticky): withheld from MCP-client readers. Called by the connector gateway. */
  markConnectorData?(): void;
  /** The project this run belongs to, resolved by the engine (active project, agent is a member). Never taken from a tool argument. */
  projectId?: string;
  /** Which runtime the servers are for: a Claude (SDK) run, or a run on a model provider. Set by the engine, never by a tool. */
  runtime?: 'claude' | 'provider';
}

/** What the engine tells a module while it builds a run's system prompt. */
export interface PreambleContext {
  /** The prompt this run answers (what Claude is about to be asked). */
  prompt: string;
  taskId: string;
  origin?: TaskOrigin;
  /** Taint at prompt-build time: true when the task, or the chain that woke it, is already tainted. */
  tainted: boolean;
  /** The run's project (same rules as ModuleJob.projectId). */
  projectId?: string;
}

/** How a run ended, as the engine reports it to onTaskEnd. */
export interface TaskEndOutcome {
  status: Task['status'];
  isError: boolean;
  errorText?: string;
  /** True when the run touched outside content at any point. */
  tainted: boolean;
}

export interface CoreModule {
  id: string;
  /**
   * In-process MCP servers this agent gets for one run (keys become the server name, e.g. "legion_comms").
   * `job` is absent only when a caller builds servers outside a run (tests, tooling).
   */
  mcpServers?(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig>;
  /**
   * Tool names (or whole-server names like "mcp__blender") the engine must forbid for this agent in every permission mode.
   * A module uses it to keep a backend's raw tools out of reach when the backend could also be reached through the user's own
   * Claude Code settings. The engine adds these to disallowedTools; a throwing module adds nothing.
   */
  disallowedTools?(agent: AgentProfile): string[];
  /** Extra system-prompt text for this agent (appended after the Legion preamble). `ctx` is absent outside a run. */
  preamble?(agent: AgentProfile, ctx?: PreambleContext): string;
  /** Fired synchronously for every tool_use the engine sees in a run (once per tool_use id), before the tool's result. */
  onToolUse?(agentId: string, taskId: string, toolName: string): void;
  /** Fired once when a run ends (done, error or cancelled), after the task's final status is saved. Never throws into the engine. */
  onTaskEnd?(task: Task, agent: AgentProfile, outcome: TaskEndOutcome): void;
  /**
   * Skills a Claude run gets: the ids for the SDK `skills` option and local plugin folders for `plugins`. The engine ALWAYS passes a
   * `skills` array (omitted would mean "everything"), so a build with no module that answers gets `[]`.
   */
  claudeSkills?(agent: AgentProfile): { skills: string[]; plugins: string[] };
  /** Whether the owner allowed skills to run inline shell commands (Armory switch). The engine blocks it unless some module says true. */
  skillShellAllowed?(): boolean;
  /** Whether loading the skill named `id` (the Skill tool's `input.skill`) taints the run. No module answering means yes. */
  skillLoadTaints?(id: string): boolean;
  /** A plain refusal when the prompt starts with a /command the owner switched off for this agent; otherwise undefined. */
  refuseSlashCommand?(agent: AgentProfile, prompt: string): string | undefined;
  /**
   * The gate on every Skill load, main session and subagents alike (a PreToolUse hook on 'Skill'): a plain refusal text when the agent
   * may not load the skill named `id`, else undefined. A throwing module denies. With no module that has this method, every load is denied.
   */
  skillGate?(agent: AgentProfile, id: string): string | undefined;
  /** Folders that Claude file tools (Write, Edit, MultiEdit, NotebookEdit) must not change in an agent run. */
  protectedPaths?(): string[];
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
