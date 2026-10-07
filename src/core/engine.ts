/** Runs agent tasks via the Claude Agent SDK. */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, Query, Settings, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile, ApprovalMode, ChatMessage, ConcreteModel, LegionConfig, MascotMood, MessageRole, ModelChoice, Task, TaskProgress, TaskSource,
} from '../shared/types.js';
import { newId, nowIso, titleFrom } from '../shared/util.js';
import { scrubHostSessionEnv } from '../shared/config.js';
import { BUDGET_LIMIT_PREFIX, CONTINUE_PROMPT, TURN_LIMIT_PREFIX, budgetCap, formatUsdLimit } from '../shared/continue.js';
import { InputChannel } from './input-channel.js';
import { contextTokensOf } from '../shared/context-meter.js';
import { isLegionTool, needsApproval, stricterMode } from './approvals.js';
import { TaintedPaths } from './tainted-paths.js';
import { CONTINUE_REFUSED } from './connector-withhold.js';
import type { CoreModule, ModuleJob, PreambleContext, TaskEndOutcome } from './modules.js';
import type { TaskOrigin } from '../shared/comms.js';
import type { ApprovalBroker } from './approvals.js';
import type { EventBus } from './bus.js';
import { modelRank, overrideAllowed, overrideRefusal, rankModel } from './model-cap.js';
import { routeModel, shouldEscalate } from './router.js';
import type { Store } from './store.js';
import { buildAgentToolsServer } from './agent-tools.js';
import { Bridge } from './bridge.js';
import { leadDoctrineFor } from './lead.js';
import type { BridgeStartParams } from './bridge.js';
import type { VmManager } from './vm-manager.js';
import { isSelfMcpUrl, McpStatusTracker, selfMcpNames } from './mcp-status.js';
import type { McpStatusView, TodoItem } from '../shared/types.js';
import { providerPrefix } from './providers/runtime.js';
import type { ProviderRuntime } from './providers/runtime.js';
import type { ProviderHost, ResolvedModel } from './providers/types.js';
import { messagesTokens, isSummaryMessage } from './providers/compaction.js';
import { toChatMessages } from './providers/tool-loop.js';
import type { Project } from '../shared/projects.js';
import { projectSection } from './projects/prompt.js';
import { renderCapabilities } from './agent-facts.js';
import type { ProjectStore } from './projects/store.js';

export type QueryFn = typeof sdkQuery;

export interface EngineDeps {
  store: Store; bus: EventBus; vms: VmManager; approvals: ApprovalBroker; config: LegionConfig;
  /** Injected for tests; defaults to the real SDK query(). */
  queryFn?: QueryFn;
  /** Returns whether boat is configured (vm tools only offered when true). */
  boatConfigured: () => boolean;
  maxConcurrent?: number;
  modules?: CoreModule[];
  /** Where the list of files written by tainted runs is kept; defaults to <workspaceDir>/.tainted-paths.json. */
  taintedPaths?: TaintedPaths;
  /** Other model providers (OpenAI-compatible endpoints). Absent: every run is a Claude run, exactly as before. */
  providers?: ProviderRuntime;
  /** Projects (src/core/projects). Absent: no task has a project and nothing about projects is interpreted. */
  projects?: ProjectStore;
}

/** Most items and longest item text of a TodoWrite list kept for the live checklist. */
export const TODO_MAX_ITEMS = 50;
export const TODO_MAX_TEXT = 200;
const clipText = (v: string) => (v.length > TODO_MAX_TEXT ? v.slice(0, TODO_MAX_TEXT - 1) + '…' : v);

/** Reads a TodoWrite input ({ todos: [{ content, status, activeForm? }] }) into a clipped checklist; null when it has no usable list. */
export function clipTodos(input: unknown): TodoItem[] | null {
  const raw = (input as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (out.length >= TODO_MAX_ITEMS) break;
    const content = typeof t?.content === 'string' ? t.content.trim() : '';
    if (!content) continue;
    const status = t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending';
    const active = typeof t.activeForm === 'string' ? t.activeForm.trim() : '';
    out.push({ content: clipText(content), status, ...(active ? { activeForm: clipText(active) } : {}) });
  }
  return out;
}

/**
 * Keep stored tool results small (≤ ~1500 chars) without breaking JSON: a JSON result is shortened
 * field by field and re-serialised so UIs can still parse it; anything else is cut with an ellipsis.
 */
export function clipToolResult(raw: string, max = 1500): string {
  if (raw.length <= max) return raw;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' && v.length > max - 200 ? v.slice(0, max - 201) + '…' : v;
      const s = JSON.stringify(out);
      if (s.length <= max + 200) return s;
    }
  } catch { /* not JSON */ }
  return raw.slice(0, max - 1) + '…';
}

/**
 * The tools that are known not to bring outside content into a run: file tools (the agent's own workspace), the to-do list
 * and sub-agent plumbing. Everything NOT on this list taints the run (an allowlist, so a tool Legion has never heard of,
 * such as ReadMcpResourceTool, is treated as outside content until someone vouches for it here).
 */
const CLEAN_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode',
  // the agent's own plumbing: no network, no other server, nothing that carries someone else's text into the run.
  // 'Skill' is deliberately NOT here: a skill's text can come from a third party, so each load is classified by the skill it names (noteToolUse).
  'ToolSearch', 'AskUserQuestion', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'Config', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronList', 'CronDelete', 'Monitor',
]);
/** File tools that put a run's content on disk, and the input field that names the file. */
const WRITE_FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const READ_FILE_TOOLS: Record<string, string> = { Read: 'file_path' };
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS']);
/** Legion's own in-process tools that still return outside content: a VM's output. */
const TAINTING_LEGION_TOOLS = new Set([
  'mcp__legion__vm_exec', 'mcp__legion__vm_read_file', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop',
]);
/** True when calling this tool taints the run: unless it is a Legion in-process tool (not a VM-output one) or on the clean built-in list, it does. */
export function taintsRun(toolName: string): boolean {
  if (TAINTING_LEGION_TOOLS.has(toolName)) return true;
  if (isLegionTool(toolName)) return false;
  return !CLEAN_BUILTINS.has(toolName);
}

/** A PreToolUse hook answer that blocks the tool and tells the agent why. */
function preToolDeny(reason: string): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } } {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** The path with symlinks and junctions resolved as far as it exists (the rest of the name is appended as written). */
function realish(p: string): string {
  const parts: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    parts.unshift(basename(cur));
    cur = up;
  }
  let real = cur;
  try { real = realpathSync.native(cur); } catch { /* keep the written path */ }
  return join(real, ...parts);
}

/**
 * True when `target` is `dir` or inside it, compared as written and after symlinks are resolved. Always compared
 * without case: Windows and macOS file systems usually ignore case, and for a deny guard a false match on Linux only
 * blocks a path that differs from a protected one by case, which is harmless.
 */
export function pathInside(dir: string, target: string): boolean {
  const fold = (x: string): string => x.toLowerCase();
  const inside = (d: string, t: string): boolean => { const a = fold(resolve(d)); const b = fold(resolve(t)); return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep); };
  return inside(dir, target) || inside(realish(dir), realish(target));
}

export class EngineError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'EngineError'; }
}

export const LEGION_PREAMBLE = [
  'You are {name}, an agent inside Legion, the user\'s personal multi-agent bot running on their own computer.',
  'Be direct and get the work done; report results concisely.',
  'Other Legion agents are reachable through mcp__legion__agents (list them), mcp__legion__ask and mcp__legion__tell (direct delegation).',
  'Use ask when you need the answer before you can continue; it blocks and returns their final message.',
  'Use tell for long or parallel work: it returns at once and their answer arrives later as a new message in your task.',
  'Do not use SendMessage or ListAgents; they do not reach Legion agents. Keep messages short and self-contained.',
  'You may have mcp__legion__vm_* tools (vm_start, vm_exec, vm_write_file, vm_read_file, vm_claude, vm_desktop, vm_stop, vm_usage)',
  'for an on-demand cloud VM that costs money while running. Start it only when needed',
  '(untrusted code, long jobs, GUI/browser work, heavy installs) and stop it with vm_stop when done.',
  'vm_claude hands a whole task to Claude Code inside the VM, which can also drive the VM desktop/browser.',
  'Treat desktop URLs as secrets and tell the user to open them.',
].join('\n');

/**
 * Child-process env. Built from process.env only; Legion never reads credential files.
 * claude-login: API key vars removed so the signed-in account is used. api-key: key from config.
 */
/**
 * Second layer for "no claude.ai connectors": the SDK `settings` flag layer (`--settings`). `disableClaudeAiConnectors` is any-source-true,
 * so a project or user settings file inherited by this run cannot turn it back off. Absent when the owner turned inheritMcp on (probes: always set).
 */
export function connectorSettings(config: LegionConfig, opts?: { probe?: boolean }): { settings?: Settings } {
  return config.claude.inheritMcp !== true || opts?.probe ? { settings: { disableClaudeAiConnectors: true } } : {};
}

export function buildChildEnv(config: LegionConfig, opts?: { probe?: boolean }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = scrubHostSessionEnv({ ...process.env });
  // the bearer token opens every human-only route: whatever put it in this process's environment, it must not reach a bot's
  if (config.authToken.length >= 8) for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v.toLowerCase().includes(config.authToken.toLowerCase())) delete env[k];
  if (config.claude.auth === 'api-key') {
    env.ANTHROPIC_API_KEY = config.claude.apiKey;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // claude.ai connectors (the account's own MCP servers) load only when the owner turned on claude.inheritMcp. A probe never needs them.
  // The SDK's bundled CLI reads ENABLE_CLAUDEAI_MCP_SERVERS and treats false/0/no/off as "do not load them".
  if (config.claude.inheritMcp !== true || opts?.probe) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return env;
}

interface Job {
  taskId: string; agentId: string; prompt: string; choice: ModelChoice; priorModel?: ConcreteModel;
  /** One-line bridge header prepended to what Claude sees (not stored). */
  header?: string;
  /** Set for bridge runs: the caller agent + task, for mascot note and cap bypass. */
  fromAgentId?: string; parentTaskId?: string;
  /** Set when another bot woke this run (rooms, or the agent bridge). Caps the run's approval mode. */
  origin?: TaskOrigin;
}
interface Active {
  ac: AbortController; cancelled: boolean; q?: Query;
  /** Sticky: the run (or the chain that woke it) touched outside content. Set by the engine, never by a tool argument. */
  tainted: boolean;
  /** tool_use ids already reported (the stream and the PreToolUse hook both see each one). */
  toolUses: Set<string>;
  /** This run's prompt reached a session (Claude: its init arrived; provider: it took a turn). Only then can a stop be continued. */
  reached?: boolean;
  /** Live progress of the current run (Claude): sent as `task.progress`, never stored. */
  progress?: { startedAt: string; turn: number; maxTurns: number; tool: string | null; turnIds: Set<string>; contextTokens?: number; todos?: TodoItem[]; thinking: boolean };
  /** The live prompt stream of the current Claude run: a message from the person while it works is pushed here. */
  input?: InputChannel;
}
interface Outcome { subtype: string; isError: boolean; errorText?: string }

const IDLE_MASCOT_MS = 4000;
/** What the bundled Claude Code says when `resume` names a session it cannot find (strings in claude.exe, SDK 0.3.285). */
const SESSION_MISSING_RE = /no conversation found|failed to resume session/i;

export class Engine {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly vms: VmManager;
  private readonly approvals: ApprovalBroker;
  private readonly config: LegionConfig;
  private readonly queryFn: QueryFn;
  private readonly boatConfigured: () => boolean;
  private readonly maxConcurrent: number;
  private readonly taintedPaths: TaintedPaths;
  private readonly providers?: ProviderRuntime;
  private readonly projects?: ProjectStore;
  private readonly queue: Job[] = [];
  private readonly active = new Map<string, Active>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly bridge: Bridge;
  private modules: CoreModule[];
  private readonly mcpTracker = new McpStatusTracker();

  constructor(deps: EngineDeps) {
    this.store = deps.store; this.bus = deps.bus; this.vms = deps.vms; this.approvals = deps.approvals;
    this.config = deps.config;
    this.queryFn = deps.queryFn ?? realQuery;
    this.boatConfigured = deps.boatConfigured;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 4);
    this.modules = deps.modules ?? [];
    this.providers = deps.providers;
    this.projects = deps.projects;
    this.taintedPaths = deps.taintedPaths ?? new TaintedPaths(join(deps.config.workspaceDir, '.tainted-paths.json'));
    this.bridge = new Bridge({ store: this.store, bus: this.bus, engine: this });
  }

  /** Modules are built after the engine (they need it), so they are attached here. */
  setModules(mods: CoreModule[]): void { this.modules = mods; }

  startTask(p: BridgeStartParams): Task {
    const agent = this.store.getAgent(p.agentId);
    if (!agent || !this.bridge.isVisible(agent)) throw new EngineError(`Unknown agent: ${p.agentId}`, 404);
    const prompt = (p.prompt ?? '').trim();
    if (!prompt) throw new EngineError('Prompt is empty', 400);
    // A /command the owner switched off for this agent is refused here, before anything is queued or fed to a live run, so it holds for the app,
    // MCP clients, rooms and agent-to-agent messages alike.
    // The check runs on the text that will really be sent (after routeModel strips a /model or /opus prefix): `/model sonnet /update-config x`
    // reaches Claude Code as `/update-config x`. A message to a live run that starts with a slash is not fed live (feedLive). execute() checks again when the run starts.
    const refusal = this.slashRefusal(agent, routeModel(prompt, 'auto').prompt);
    if (refusal) throw new EngineError(refusal, 400);

    // Confused-deputy rule: a run another agent starts through the bridge never gets looser
    // approvals than its caller (rooms set their own origin and take precedence).
    const origin = p.origin ?? this.bridgeOrigin(p) ?? this.mcpOrigin(p, p.continueTaskId ? this.store.getTask(p.continueTaskId) : undefined);
    // Taint follows the chain: a tainted waking bot, or a tainted peer's reply, taints this task for good.
    const tainted = !!p.tainted || !!origin?.tainted || (!!p.bridge?.reply && !!p.bridge.fromTaskId && this.isTainted(p.bridge.fromTaskId));

    // A token client (MCP, curl) never moves a run between Claude and a provider, or between providers: that decides where the owner's data goes.
    if (p.source === 'mcp' && p.model && (providerPrefix(p.model) || providerPrefix(agent.model)) && p.model !== agent.model) {
      throw new EngineError('Provider models can only be chosen in the Legion app. This agent runs on its own setting; leave model out.', 400);
    }
    const overriding = !!p.modelOverrideBy && !!p.model;
    if (overriding && !overrideAllowed(agent.model, p.model)) throw new EngineError(overrideRefusal(agent.name, agent.model, p.model!), 400);
    let task: Task;
    let priorModel: ConcreteModel | undefined;
    if (p.continueTaskId) {
      const prev = this.store.getTask(p.continueTaskId);
      if (!prev) throw new EngineError(`Unknown task: ${p.continueTaskId}`, 404);
      if (prev.status === 'running') { const live = this.feedLive(p, prev, prompt); if (live) return live; }
      if (prev.status === 'queued' || prev.status === 'running') throw new EngineError('Task is still running', 409);
      if (prev.agentId !== agent.id) throw new EngineError('Task belongs to a different agent', 400);
      // a task that read connector data holds that text in its session: nothing started by or down a chain from an MCP client may resume it
      if (prev.usedConnectors && origin?.viaMcpClient) throw new EngineError(CONTINUE_REFUSED, 403);
      const projectId = this.pickProject(p, agent, prev);
      priorModel = prev.model;
      const viaBridge = p.bridge && !p.bridge.reply;
      // A model another bot chose lasts for that run only: a later message that asks for none (and is not a reply landing in the caller's own task) goes back to the agent's setting.
      const keepOverride = !!p.bridge?.reply;
      task = this.saveTask({
        ...prev, status: 'queued', source: p.source,
        requestedModel: p.model ?? (prev.modelOverride && !keepOverride ? agent.model : prev.requestedModel),
        modelOverride: overriding ? { model: p.model!, by: p.modelOverrideBy! } : keepOverride ? prev.modelOverride : undefined,
        // not resumable until this run's own prompt reaches the session (a restart before then must re-send it, not continue)
        result: undefined, error: undefined, resumable: undefined,
        ...(this.projects ? { projectId } : {}),
        ...(viaBridge ? { fromAgentId: p.bridge!.fromAgentId, parentTaskId: p.bridge!.parentTaskId } : {}),
        bridgeHop: p.bridge ? p.bridge.hop ?? 0 : undefined,
        // A human continuing a task clears any bot-origin ceiling; a bridge reply keeps the task's own.
        origin: origin ?? (p.bridge?.reply ? prev.origin : undefined),
        ...(tainted ? { tainted: true } : {}),
      });
    } else {
      const now = nowIso();
      const base = prompt.replace(/^\s*\/(opus|sonnet)\b\s*/i, '') || prompt;
      const callerName = p.bridge ? (this.store.getAgent(p.bridge.fromAgentId)?.name ?? p.bridge.fromAgentId) : '';
      const projectId = this.pickProject(p, agent, undefined);
      task = this.saveTask({
        id: newId('task'), agentId: agent.id,
        title: p.bridge ? `${callerName}: ${base.replace(/\s+/g, ' ').trim().slice(0, 50)}` : titleFrom(base),
        status: 'queued', source: p.source,
        ...(p.bridge ? { fromAgentId: p.bridge.fromAgentId, parentTaskId: p.bridge.parentTaskId, bridgeHop: p.bridge.hop ?? 0 } : {}),
        requestedModel: p.model ?? agent.model, createdAt: now, updatedAt: now,
        ...(overriding ? { modelOverride: { model: p.model!, by: p.modelOverrideBy! } } : {}),
        ...(origin ? { origin } : {}),
        ...(projectId ? { projectId } : {}),
        ...(tainted ? { tainted: true } : {}),
      });
    }
    this.addMessage(task.id, 'user', prompt, undefined, p.bridge?.fromAgentId);
    this.queue.push({
      taskId: task.id, agentId: agent.id, prompt, choice: task.requestedModel, priorModel,
      header: p.bridge?.header, fromAgentId: p.bridge?.fromAgentId, parentTaskId: p.bridge && !p.bridge.reply ? p.bridge.parentTaskId : undefined,
      origin: task.origin,
    });
    queueMicrotask(() => this.pump());
    return { ...task };
  }

  /**
   * The project a new or continued task belongs to. Only the app (source 'ui', admin) and a room's own wake (source 'bot') may name one;
   * a bridge run (ask/tell) inherits its caller's task's project; an MCP or CLI client never picks. The agent must be a member and the
   * project active. The app gets an error for a bad pick; a room or bridge run just starts without the project. Continuing keeps the
   * task's project unless the app or the room says otherwise. `undefined` = no project.
   */
  private pickProject(p: BridgeStartParams, agent: AgentProfile, prev: Task | undefined): string | undefined {
    if (!this.projects) {
      if (p.source === 'ui' && typeof p.projectId === 'string') throw new EngineError('Projects are not available in this core', 400);
      return prev?.projectId;
    }
    let want: string | undefined;
    let named = false;
    if ((p.source === 'ui' || p.source === 'bot') && p.projectId !== undefined) { want = p.projectId ?? undefined; named = true; }
    else if (prev) want = prev.projectId;
    else if (p.bridge && !p.bridge.reply && p.bridge.parentTaskId) want = this.store.getTask(p.bridge.parentTaskId)?.projectId;
    if (!want) return undefined;
    const pr = this.projects.get(want);
    if (pr && pr.status === 'archived') {
      if (p.source === 'ui' || (prev && !named)) throw new EngineError(`Project "${pr.name}" is archived. Unarchive it to start or continue a task in it.`, 409);
      return undefined;
    }
    if (pr && pr.members.includes(agent.id)) return want;
    if (p.source === 'ui' && named) throw new EngineError(pr ? `${agent.name} is not a member of project "${pr.name}"` : `Unknown project: ${want}`, 400);
    return undefined;
  }

  /** The project this task's run belongs to right now (active, agent is a member), else undefined. Checked at every run. */
  private projectOf(taskId: string, agentId: string): Project | undefined {
    if (!this.projects) return undefined;
    return this.projects.forRun(this.store.getTask(taskId)?.projectId, agentId);
  }

  /**
   * A run started by a bearer-token client (Claude Code / Cowork / curl via MCP or POST /api/tasks without the admin header) is never
   * human-level: its approval is capped at `ask` whatever the agent is set to (a `full` agent runs in `default` mode with cards).
   * Only the Electron UI (admin) starts human runs. Continuing keeps what the task already had (room, hop, taint) and the stricter
   * of its earlier ceiling and `ask`, so a continue can never launder a ceiling away.
   */
  private mcpOrigin(p: BridgeStartParams, prev?: Task): TaskOrigin | undefined {
    if (p.source !== 'mcp') return undefined;
    // viaMcpClient is set in both branches: a continue of a room-woken task by a client still came from a client (connector reads are refused for it).
    if (prev?.origin) return { ...prev.origin, approvalCeiling: stricterMode(prev.origin.approvalCeiling, 'ask'), viaMcpClient: true };
    return { roomId: 'mcp', fromAgentId: 'mcp', hop: 0, approvalCeiling: 'ask', viaMcpClient: true };
  }

  /** Origin (approval ceiling) for a task started by `ask`/`tell`. Replies go back to the caller's own task and add none. */
  private bridgeOrigin(p: BridgeStartParams): TaskOrigin | undefined {
    if (!p.bridge || p.bridge.reply) return undefined;
    const callerAgent = this.store.getAgent(p.bridge.fromAgentId);
    const callerTask = p.bridge.parentTaskId ? this.store.getTask(p.bridge.parentTaskId) : undefined;
    let ceiling: ApprovalMode = callerAgent?.approval ?? 'ask';
    if (callerTask?.origin) ceiling = stricterMode(ceiling, callerTask.origin.approvalCeiling);
    const tainted = !!callerTask?.origin?.tainted || (!!p.bridge.parentTaskId && this.isTainted(p.bridge.parentTaskId));
    // the client flag travels down the chain: MCP client -> A -> (ask/tell) -> B is still a client-started chain (strictest wins, never cleared)
    const viaMcpClient = callerTask?.origin?.viaMcpClient === true;
    return { roomId: 'agent-bridge', fromAgentId: p.bridge.fromAgentId, hop: p.bridge.hop ?? 1, approvalCeiling: ceiling, ...(tainted ? { tainted: true } : {}), ...(viaMcpClient ? { viaMcpClient: true } : {}) };
  }

  /** Whether a task touched outside content (live run first, then what was stored). */
  isTainted(taskId: string): boolean {
    const a = this.active.get(taskId);
    if (a?.tainted) return true;
    const t = this.store.getTask(taskId);
    return !!t && (t.tainted === true || t.origin?.tainted === true);
  }

  /** Marks a task tainted: live runs flip at once, stored tasks keep it for later runs. */
  markTainted(taskId: string): void {
    const a = this.active.get(taskId);
    if (a) a.tainted = true;
    const t = this.store.getTask(taskId);
    if (t && !t.tainted) this.patchTask(taskId, { tainted: true });
  }

  cancel(taskId: string): boolean {
    const qi = this.queue.findIndex((j) => j.taskId === taskId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.markCancelled(taskId);
      try { this.bridge.cancelFor(taskId); } catch { /* ignore */ }
      return true;
    }
    const a = this.active.get(taskId);
    if (!a || a.cancelled) return false;
    a.cancelled = true;
    this.markCancelled(taskId);
    this.approvals.cancelForTask(taskId);
    try { this.bridge.cancelFor(taskId); } catch { /* ignore */ }
    try { a.ac.abort(); } catch { /* ignore */ }
    try { void a.q?.interrupt?.()?.catch?.(() => undefined); } catch { /* ignore */ }
    return true;
  }

  waitFor(taskId: string, timeoutMs: number): Promise<Task> {
    const cur = this.store.getTask(taskId);
    if (!cur) return Promise.reject(new EngineError(`Unknown task: ${taskId}`, 404));
    const isLive = (t: Task) => t.status === 'queued' || t.status === 'running';
    if (!isLive(cur)) return Promise.resolve(cur);
    return new Promise<Task>((resolve) => {
      let off: () => void = () => undefined;
      const timer = setTimeout(() => { off(); resolve(this.store.getTask(taskId) ?? cur); }, Math.max(0, timeoutMs));
      off = this.bus.on((ev) => {
        if (ev.type === 'task.updated' && ev.task.id === taskId && !isLive(ev.task)) {
          clearTimeout(timer); off(); resolve(ev.task);
        }
      });
    });
  }

  running(): string[] { return [...this.active.keys()]; }

  // ---------------------------------------------------------------- internals

  private saveTask(t: Task): Task {
    const saved = this.store.upsertTask({ ...t, updatedAt: nowIso() });
    this.bus.emit({ type: 'task.updated', task: saved });
    return saved;
  }

  private patchTask(taskId: string, patch: Partial<Task>): Task | undefined {
    const cur = this.store.getTask(taskId);
    if (!cur) return undefined;
    return this.saveTask({ ...cur, ...patch });
  }

  private addMessage(taskId: string, role: MessageRole, text: string, toolName?: string, fromAgentId?: string, extra?: Partial<ChatMessage>): ChatMessage {
    const m: ChatMessage = { id: newId('msg'), taskId, role, text, at: nowIso(), ...(toolName ? { toolName } : {}), ...(fromAgentId ? { fromAgentId } : {}), ...(extra ?? {}) };
    const saved = this.store.addMessage(m);
    this.bus.emit({ type: 'message', message: saved ?? m });
    return saved ?? m;
  }

  /** Live progress of a Claude run for the working row; transient by design (a restart has no run to report on). */
  /** The newest request the person (or a bot) actually wrote in this task: not a Continue instruction. */
  private lastRequest(taskId: string): string | undefined {
    const rows = this.store.listMessages(taskId);
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i]!;
      if (m.role === 'user' && m.text.trim() && m.text !== CONTINUE_PROMPT) return m.text;
    }
    return undefined;
  }

  /**
   * A message from the person to their own running Claude task joins the run: Claude reads it after its current step, in
   * the same conversation, instead of it waiting for the whole run to end. Returns undefined (the caller answers 409 and
   * the app queues it as before) for anything else: a bot, an MCP client or a room (their approval ceiling and taint are
   * fixed per run), a provider run (no stream), a slash command (it would act on the run, not join it), or a run that is
   * already closing.
   */
  private feedLive(p: BridgeStartParams, prev: Task, prompt: string): Task | undefined {
    if (p.source !== 'ui' || p.bridge || p.origin || p.modelOverrideBy || prompt.startsWith('/')) return undefined;
    const act = this.active.get(prev.id);
    if (!act?.input || act.input.isClosed || act.cancelled) return undefined;
    if (!act.input.push(prompt)) return undefined;
    this.addMessage(prev.id, 'user', prompt);
    return { ...prev };
  }

  /** The live progress of every running Claude run, for a client that connects mid-run (events are transient). */
  progressSnapshot(): Record<string, TaskProgress> {
    const out: Record<string, TaskProgress> = {};
    for (const [taskId, act] of this.active) {
      const p = act.progress;
      // a run whose task is already marked done/error is in its last moments of cleanup: it has no progress to show
      if (!p || this.store.getTask(taskId)?.status !== 'running') continue;
      out[taskId] = { startedAt: p.startedAt, turn: p.turn, maxTurns: p.maxTurns, tool: p.tool, thinking: p.thinking, ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}), ...(p.todos ? { todos: p.todos } : {}) };
    }
    return out;
  }

  private emitProgress(taskId: string, act: Active): void {
    const p = act.progress;
    if (!p) return;
    this.bus.emit({ type: 'task.progress', taskId, progress: { startedAt: p.startedAt, turn: p.turn, maxTurns: p.maxTurns, tool: p.tool, thinking: p.thinking, ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}), ...(p.todos ? { todos: p.todos } : {}) } });
  }

  private mascot(mood: MascotMood, note?: string): void {
    if (mood !== 'idle' && this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    this.bus.emit({ type: 'mascot', mood, ...(note ? { note } : {}) });
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.active.size === 0 && this.queue.length === 0) this.mascot('idle');
    }, IDLE_MASCOT_MS);
    this.idleTimer.unref?.();
  }

  private markCancelled(taskId: string): void {
    const t = this.patchTask(taskId, { status: 'cancelled', ...(this.active.get(taskId)?.tainted ? { tainted: true } : {}) });
    if (t) this.addMessage(taskId, 'system', 'Cancelled');
    this.mascot('idle', 'cancelled');
  }

  /**
   * Cancels, right now, every queued job whose agent is no longer visible (the Assayer when BSV mode goes off). Returns the task ids.
   * Runs already in progress are left to finish; startJob re-checks too, so a job can never start for a hidden agent.
   */
  cancelHiddenQueued(): string[] {
    const hidden = this.queue.filter((j) => this.isHiddenAgent(j.agentId));
    const ids: string[] = [];
    for (const j of hidden) {
      const i = this.queue.indexOf(j);
      if (i >= 0) { this.queue.splice(i, 1); this.dropHiddenJob(j); ids.push(j.taskId); }
    }
    if (ids.length && this.active.size === 0 && this.queue.length === 0) this.scheduleIdle();
    return ids;
  }

  private isHiddenAgent(agentId: string): boolean {
    const a = this.store.getAgent(agentId);
    return !!a && !this.bridge.isVisible(a);
  }

  /** A queued job whose agent got hidden: it is cancelled with a visible reason and never runs. */
  private dropHiddenJob(job: Job): void {
    const t = this.patchTask(job.taskId, { status: 'cancelled' });
    if (t) this.addMessage(job.taskId, 'system', 'Cancelled: BSV mode was turned off before this run started.');
    try { this.bridge.cancelFor(job.taskId); } catch { /* ignore */ }
    this.mascot('idle', 'cancelled');
  }

  private startJob(job: Job): void {
    // the agent may have been switched off while the job waited in the queue
    if (this.isHiddenAgent(job.agentId)) { this.dropHiddenJob(job); return; }
    const act: Active = { ac: new AbortController(), cancelled: false, tainted: false, toolUses: new Set() };
    act.tainted = !!(job.origin?.tainted || this.store.getTask(job.taskId)?.tainted);
    this.active.set(job.taskId, act);
    void this.runJob(job, act);
  }

  private pump(): void {
    // Bridge runs whose parent is running bypass the cap, so nested asks cannot deadlock the queue.
    for (let i = 0; i < this.queue.length;) {
      const j = this.queue[i]!;
      if (j.parentTaskId && this.active.has(j.parentTaskId) && !this.active.has(j.taskId)) {
        this.queue.splice(i, 1);
        this.startJob(j);
      } else i++;
    }
    while (this.active.size < this.maxConcurrent) {
      const idx = this.queue.findIndex((j) => !this.active.has(j.taskId));
      if (idx < 0) break;
      this.startJob(this.queue.splice(idx, 1)[0]!);
    }
  }

  private async runJob(job: Job, act: Active): Promise<void> {
    try {
      await this.execute(job, act);
    } catch (e) {
      this.failTask(job.taskId, e, act);
    } finally {
      this.endTask(job, act);
      if (this.active.get(job.taskId) === act) this.active.delete(job.taskId);
      try { this.approvals.cancelForTask(job.taskId); } catch { /* ignore */ }
      if (this.active.size === 0 && this.queue.length === 0) this.scheduleIdle();
      this.pump();
    }
  }

  /** Tells every module the run is over (after the final status is saved). A broken module never breaks the engine. */
  private endTask(job: Job, act: Active): void {
    const task = this.store.getTask(job.taskId);
    const agent = this.store.getAgent(job.agentId);
    if (!task || !agent) return;
    const outcome: TaskEndOutcome = {
      status: task.status, isError: task.status === 'error', ...(task.error ? { errorText: task.error } : {}), tainted: act.tainted,
    };
    for (const m of this.modules) {
      try { m.onTaskEnd?.(task, agent, outcome); } catch { /* ignore */ }
    }
  }

  private failTask(taskId: string, e: unknown, act?: Active): void {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const cur = this.store.getTask(taskId);
      if (cur && cur.status === 'cancelled') return;
      this.patchTask(taskId, { status: 'error', error: msg, ...(act?.tainted ? { tainted: true } : {}) });
      this.addMessage(taskId, 'system', `Error: ${msg}`);
    } catch { /* never crash */ }
    this.mascot('error', msg.slice(0, 120));
  }

  private async execute(job: Job, act: Active): Promise<void> {
    const agent = this.store.getAgent(job.agentId);
    if (!agent) throw new Error(`Agent ${job.agentId} no longer exists`);
    let decision = routeModel(job.prompt, job.choice, { priorModel: job.priorModel });
    // The last check before anything is sent, on the exact text Claude Code will get. A queued prompt starts here, and the owner may have
    // switched the skill off since it was queued.
    const slashNo = this.slashRefusal(agent, decision.prompt);
    if (slashNo) throw new EngineError(slashNo, 400);
    // A model a bot picked (per-task override, or a /opus prefix in a bot's message) never goes above the agent's own setting.
    const picked = this.store.getTask(job.taskId)?.modelOverride || (job.origin && decision.reason.startsWith('prefix'));
    const provAgent = providerPrefix(agent.model);
    if (picked && provAgent && decision.model !== agent.model) {
      // a bot's pick never moves a provider agent to another model or to Claude (that would send the owner's data somewhere else)
      decision = { ...decision, model: agent.model, reason: `${decision.reason}, kept on ${agent.name}'s own provider setting` };
    } else if (picked && !provAgent && providerPrefix(decision.model)) {
      const own = rankModel(modelRank(agent.model));
      decision = { ...decision, model: own, reason: `${decision.reason}, a bot cannot pick a provider; using ${own}` };
    } else if (picked && modelRank(decision.model) > modelRank(agent.model)) {
      const capped = rankModel(modelRank(agent.model));
      decision = { ...decision, model: capped, reason: `${decision.reason}, capped at ${capped} (${agent.name}'s own setting)` };
    }
    let model = decision.model;
    const first = this.patchTask(job.taskId, { status: 'running', model, error: undefined, resumable: undefined });
    if (!first) throw new Error('Task disappeared');
    const from = job.header && job.fromAgentId ? this.store.getAgent(job.fromAgentId) : undefined;
    this.mascot('thinking', from ? `${from.name} → ${agent.name}` : `${agent.name} on ${model}: ${decision.reason}`);
    const sendPrompt = (job.header ? job.header + '\n' : '') + decision.prompt;

    const hadSession = !!this.store.getTask(job.taskId)?.sessionId;
    // The same /command check for text that is re-sent later from the task's history (the raw text, and the text after a /model prefix is removed).
    const slashNo2 = (text: string): string | undefined => this.slashRefusal(agent, text) ?? this.slashRefusal(agent, routeModel(text, 'auto').prompt);
    let outcome = await this.runOnce(job, agent, model, sendPrompt, act);
    if (act.cancelled) return;

    // The session this task resumes is gone (its file was deleted, or Claude Code cannot find it): every Retry and
    // Continue would fail the same way forever. Start a new conversation once, with the request itself (a "continue"
    // instruction means nothing to a new conversation), and say so. Checked before escalation, which would hit the
    // same missing session.
    if (hadSession && !act.reached && outcome.isError && SESSION_MISSING_RE.test(outcome.errorText ?? '')) {
      this.patchTask(job.taskId, { sessionId: undefined });
      const request = decision.prompt === CONTINUE_PROMPT ? this.lastRequest(job.taskId) : sendPrompt;
      if (!request || /^\s*\/compact\b/i.test(request)) {
        outcome = { subtype: 'error_during_execution', isError: true, errorText: 'The earlier conversation could not be found, so there is nothing to continue or compact. Send your request again to start a new one.' };
      } else if (slashNo2(request)) {
        // The request comes from the task's history, not from the text checked above: it may be a /command the owner has switched off since.
        // Fail closed, and stop here: this is a refusal, not a failure Opus should retry.
        throw new EngineError(slashNo2(request)!, 400);
      } else {
        this.addMessage(job.taskId, 'system', 'The earlier conversation could not be found, so Claude is starting a new one with your request.');
        outcome = await this.runOnce(job, agent, model, request, act);
        if (act.cancelled) return;
      }
    }

    const cur = this.store.getTask(job.taskId);
    if (
      model === 'sonnet' && !cur?.escalated && outcome.isError && !(cur?.modelOverride && modelRank(agent.model) < 3) &&
      shouldEscalate({ model, subtype: outcome.subtype, isError: outcome.isError, errorText: outcome.errorText })
    ) {
      model = 'opus';
      this.patchTask(job.taskId, { escalated: true, model });
      this.addMessage(job.taskId, 'system', `Sonnet could not finish this (it stopped with an error). Opus is taking over the same conversation.${outcome.errorText ? ` Error: ${outcome.errorText.slice(0, 160)}` : ''}`);
      this.mascot('thinking', 'escalating to opus');
      // The resumed session already holds the request when the failed run got that far: send it again and Opus starts the task over.
      outcome = await this.runOnce(job, agent, model, act.reached ? CONTINUE_PROMPT : sendPrompt, act);
      if (act.cancelled) return;
    }

    if (outcome.isError) {
      // Read by people (the app) and by callers without a button (MCP clients, other bots), so it names no button.
      // A provider run says how far it got ("Stopped after N model turns ...", providers/tool-loop.ts): the same pause,
      // with that run's own limit; a Claude run's stop carries no text and its limit is claude.maxTurns.
      const providerStop = /^Stopped after (\d+) model turns/.exec(outcome.errorText ?? '');
      const turnLimit = outcome.subtype === 'error_max_turns' && (!outcome.errorText || !!providerStop);
      const limitTurns = providerStop ? Number(providerStop[1]) : this.config.claude.maxTurns;
      // The spend limit is the same kind of stop. The subtype alone says so (no error text is needed), and the amount is named when known.
      const budgetLimit = outcome.subtype === 'error_max_budget_usd';
      const cap = budgetCap(this.config.claude.maxBudgetUsd);
      const budgetWhere = cap !== undefined ? ` (${formatUsdLimit(cap)} this run)` : '';
      const text = turnLimit
        ? `${TURN_LIMIT_PREFIX} (${limitTurns} turns this run) before finishing. The work so far is kept: continue the task to pick up where it stopped.`
        : budgetLimit
          ? `${BUDGET_LIMIT_PREFIX}${budgetWhere} before finishing. The work so far is kept: continue the task to pick up where it stopped.`
          : outcome.errorText || outcome.subtype;
      this.patchTask(job.taskId, { status: 'error', error: text, ...(act.tainted ? { tainted: true } : {}) });
      // the history keeps a short line; the full text is the task's error, which the app shows on the Paused card
      this.addMessage(job.taskId, 'system', turnLimit ? `${TURN_LIMIT_PREFIX} (${limitTurns} turns this run).` : budgetLimit ? `${BUDGET_LIMIT_PREFIX}${budgetWhere}.` : `Error: ${text}`);
      // A limit stop is a pause with the work kept: the mascot stands calm. "Fault detected" would contradict the card.
      if (turnLimit) this.mascot('idle', 'paused at the turn limit');
      else if (budgetLimit) this.mascot('idle', 'paused at the spend limit');
      else this.mascot('error', text.slice(0, 120));
    } else {
      this.patchTask(job.taskId, { status: 'done', resumable: undefined, ...(act.tainted ? { tainted: true } : {}) });
      this.mascot('success');
    }
  }

  /** Read-only: the MCP servers the latest run saw and their state (Settings -> MCP). */
  mcpStatus(): McpStatusView { return this.mcpTracker.view(this.config); }

  private buildMcpServers(agent: AgentProfile, job: Job, act: Active, runtime: 'claude' | 'provider' = 'claude'): Record<string, McpServerConfig> {
    const taskId = job.taskId;
    const pid = this.projectOf(taskId, agent.id)?.id;
    const out: Record<string, McpServerConfig> = {};
    const wanted = agent.mcpServers ?? [];
    const all = wanted.includes('*');
    // A Settings entry that points back at Legion's own /mcp (hand-edited config) would connect an agent to its own Legion: skip it.
    const self = new Set(selfMcpNames(this.config));
    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      if (!all && !wanted.includes(name)) continue;
      if (self.has(name)) continue;
      // A Settings entry may not take one of Legion's own server names: its tools would match LEGION_TOOL_PREFIXES (no card, no taint). Names are Legion's.
      if (/^legion(_|$)/.test(name)) continue;
      if (entry.type === 'http') out[name] = { type: 'http', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else if (entry.type === 'sse') out[name] = { type: 'sse', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else out[name] = { type: 'stdio', command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
    }
    // Every agent gets the in-process `legion` server (bridge tools; plus vm_* when a VM is enabled).
    out.legion = buildAgentToolsServer({
      agentId: agent.id, taskId, vms: this.vms, bridge: this.bridge,
      vmEnabled: !!agent.vm?.enabled && this.boatConfigured(),
      claudeAvailable: this.vms.claudeAvailable?.() ?? true, // vm_claude is hidden while Claude is known not to be set up on boat.dev
    });
    const moduleJob: ModuleJob = {
      taskId, ...(job.origin ? { origin: job.origin, ceiling: job.origin.approvalCeiling } : {}),
      taint: () => act.tainted || job.origin?.tainted === true,
      markTainted: () => { act.tainted = true; },
      markConnectorData: () => { this.patchTask(taskId, { usedConnectors: true }); },
      runtime,
      ...(pid ? { projectId: pid } : {}),
    };
    for (const m of this.modules) {
      try { Object.assign(out, m.mcpServers?.(agent, moduleJob) ?? {}); } catch { /* a broken module must not break runs */ }
    }
    return out;
  }

  /**
   * Whether this Skill load taints the run. Read from the stream's tool_use input (`{ skill: "<plugin>:<name>" }`), because Claude Code
   * never calls canUseTool for a Skill load. The first module that answers decides; with none, or a throwing one, it taints (unknown = outside).
   */
  private skillLoadTaints(input: unknown): boolean {
    const raw = input && typeof input === 'object' ? (input as { skill?: unknown }).skill : undefined;
    const id = typeof raw === 'string' ? raw : '';
    for (const m of this.modules) {
      if (!m.skillLoadTaints) continue;
      try { return m.skillLoadTaints(id); } catch { return true; }
    }
    return true;
  }

  /** A plain refusal when `text` starts with a /command this agent may not run. A module that throws fails CLOSED: the command is refused. */
  private slashRefusal(agent: AgentProfile, text: string): string | undefined {
    for (const m of this.modules) {
      if (!m.refuseSlashCommand) continue;
      try {
        const r = m.refuseSlashCommand(agent, text);
        if (r) return r;
      } catch {
        return 'Legion could not check whether this /command is allowed, so it was not sent. Try again, or send it without the slash.';
      }
    }
    return undefined;
  }

  /**
   * Why this Skill load is denied, or undefined when it may go ahead. Used by the PreToolUse hook on 'Skill', which Claude Code also runs
   * for a subagent's loads (a subagent ignores the `skills` list). No module answering, or one that throws: denied.
   */
  private skillDenial(agent: AgentProfile, input: unknown): string | undefined {
    const raw = input && typeof input === 'object' ? (input as { skill?: unknown }).skill : undefined;
    const id = (typeof raw === 'string' ? raw : '').trim().replace(/^\//, '');
    let answered = false;
    for (const m of this.modules) {
      if (!m.skillGate) continue;
      answered = true;
      try {
        const why = m.skillGate(agent, id);
        if (why) return why;
      } catch {
        return `${id || 'That skill'} could not be checked, so Legion did not load it.`;
      }
    }
    return answered ? undefined : `${id || 'That skill'} is off in Legion. The owner can turn it on in Settings \u2192 Armory.`;
  }

  /** The folders Claude file tools may not change (the Armory's own files). */
  private protectedDirs(): string[] {
    const out: string[] = [];
    for (const m of this.modules) {
      try { out.push(...(m.protectedPaths?.() ?? [])); } catch { /* none */ }
    }
    return out;
  }

  /** The `skills` list and plugin folders for a Claude run. Always an array: an omitted list would mean "every skill Claude Code can find". */
  private moduleSkills(agent: AgentProfile): { skills: string[]; plugins: string[] } {
    const skills = new Set<string>();
    const plugins = new Set<string>();
    for (const m of this.modules) {
      try {
        const r = m.claudeSkills?.(agent);
        for (const id of r?.skills ?? []) skills.add(id);
        for (const p of r?.plugins ?? []) plugins.add(p);
      } catch { /* a broken module offers no skills */ }
    }
    return { skills: [...skills], plugins: [...plugins] };
  }

  /** True only when a module says the owner allowed inline skill shell. No module, or a throwing one: blocked. */
  private skillShellAllowed(): boolean {
    for (const m of this.modules) {
      try { if (m.skillShellAllowed?.() === true) return true; } catch { /* blocked */ }
    }
    return false;
  }

  private moduleDisallowed(agent: AgentProfile): string[] {
    const out: string[] = [];
    for (const m of this.modules) {
      try { out.push(...(m.disallowedTools?.(agent) ?? [])); } catch { /* ignore */ }
    }
    return out;
  }

  private modulePreamble(agent: AgentProfile, ctx: PreambleContext): string {
    let out = '';
    for (const m of this.modules) {
      try { const t = m.preamble?.(agent, ctx); if (t) out += '\n\n' + t; } catch { /* ignore */ }
    }
    return out;
  }

  /** One tool_use seen (in the message stream or by the PreToolUse hook; whichever comes first wins): taint, then tell modules. */
  private noteToolUse(job: Job, act: Active, toolName: string, toolUseId?: string, input?: unknown): void {
    if (toolUseId) {
      if (act.toolUses.has(toolUseId)) return;
      act.toolUses.add(toolUseId);
    }
    if (toolName === 'Skill') { if (this.skillLoadTaints(input)) act.tainted = true; }
    else if (taintsRun(toolName)) act.tainted = true;
    this.trackWorkspaceTaint(job, act, toolName, input);
    for (const m of this.modules) {
      try { m.onToolUse?.(job.agentId, job.taskId, toolName); } catch { /* ignore */ }
    }
  }

  /**
   * Taint follows files: what a tainted run Writes or Edits is marked, and a later run that reads a marked file (or searches a
   * tree that holds one) is tainted before the tool runs. A clean run that rewrites a whole file takes the mark off it.
   */
  private trackWorkspaceTaint(job: Job, act: Active, toolName: string, input: unknown): void {
    const o = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const cwd = this.agentCwd(job.agentId);
    const arg = (field: string | undefined): string | undefined => (field && typeof o[field] === 'string' && o[field] ? TaintedPaths.resolvePath(cwd, o[field] as string) : undefined);
    const w = arg(WRITE_FILE_TOOLS[toolName]);
    if (w) {
      if (act.tainted) this.taintedPaths.mark(w);
      else if (toolName === 'Write') this.taintedPaths.unmark(w);
      return;
    }
    if (act.tainted) return;
    const r = arg(READ_FILE_TOOLS[toolName]);
    if (r) { if (this.taintedPaths.has(r)) act.tainted = true; return; }
    if (SEARCH_TOOLS.has(toolName)) {
      const root = typeof o.path === 'string' && o.path ? TaintedPaths.resolvePath(cwd, o.path) : TaintedPaths.resolvePath(cwd, '.');
      if (this.taintedPaths.touches(root)) act.tainted = true;
    }
  }

  private agentCwd(agentId: string): string {
    const agent = this.store.getAgent(agentId);
    return agent?.cwd || join(this.config.workspaceDir, agentId);
  }

  /**
   * Maintainer decision 2026-10-07: in a run that read connector data AND is tainted, WebFetch and WebSearch need an approval card even in
   * full mode: web access could carry that data out. Like the connector gateway's writes this raises its own card (never through guardAsk).
   * Returns undefined when no card is due, else the decision. Used by canUseTool and the provider path (toolDecider) and, in bypass mode where
   * canUseTool does not exist, by a PreToolUse hook.
   */
  private async webEgressCard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string } | undefined> {
    if (toolName !== 'WebFetch' && toolName !== 'WebSearch') return undefined;
    const used = this.store.getTask(job.taskId)?.usedConnectors === true;
    const tainted = this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true;
    if (!used || !tainted) return undefined;
    const target = String(toolName === 'WebFetch' ? input?.url ?? '' : input?.query ?? '').slice(0, 1000);
    const o = job.origin;
    let timedOut = false;
    const allowed = await this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: () => { timedOut = true; },
      summary: `${toolName}: ${target}
This run read connector (GitHub) data and other outside text. Web access can send that data out. Check the address or query before you allow it.`,
    });
    if (allowed) return { allow: true };
    return { allow: false, message: timedOut ? `No one answered the approval request within ${this.approvals.timeoutWait}, so this web request was not run.` : 'The user denied this web request.' };
  }

  /**
   * The approval decision for one tool call, shared by the Claude path (canUseTool) and the provider path: effective mode (never looser
   * than the run's ceiling), then needsApproval, then a card the user answers (10 minutes, then denied).
   */
  private toolDecider(job: Job, agent: AgentProfile): (toolName: string, input: Record<string, unknown>) => Promise<{ allow: boolean; message?: string }> {
    const ceiling = job.origin?.approvalCeiling;
    const effective = (): ApprovalMode => {
      const mode = this.store.getAgent(agent.id)?.approval ?? agent.approval;
      return ceiling ? stricterMode(mode, ceiling) : mode;
    };
    return async (toolName, input) => {
      // web egress after connector data: a card in every mode (maintainer decision 2026-10-07)
      const egress = await this.webEgressCard(job, agent, toolName, input);
      if (egress) return egress;
      const mode = effective();
      if (!needsApproval(mode, toolName, { capped: job.origin?.approvalCeiling === 'ask' })) return { allow: true };
      const o = job.origin;
      let timedOut = false;
      const allowed = await this.approvals.request(
        job.taskId, agent.id, toolName, input,
        o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined,
        { onTimeout: () => { timedOut = true; } },
      );
      if (allowed) return { allow: true };
      // The tool_use already set the mood to 'hacking'; after a deny nothing else would move it until the run ends, so the Relic
      // would read "Executing" for a call that never ran. Skip it once the run is cancelled or over (cancel denies open cards too).
      const live = this.active.get(job.taskId);
      if (live && !live.cancelled) this.mascot('thinking', `${toolName} ${timedOut ? 'not answered' : 'denied'}`);
      if (timedOut) {
        const wait = this.approvals.timeoutWait;
        // An MCP client started this run (Claude Code, Cowork) or woke it through a chain, so the ceiling is `ask`. Its card can only be answered in the Legion app window, so say so
        // when nobody answered (the app is closed, or this core was started headless by the MCP bridge).
        if (o?.approvalCeiling === 'ask') {
          return { allow: false, message: `No one approved this action: it needs your OK in the Legion app window and nothing was answered within ${wait}. Open the Legion app, then ask for it again.` };
        }
        // A timeout is not a "no": the model must not read it as the user refusing the work.
        return { allow: false, message: `No one answered the approval request within ${wait}, so this action was not run. Ask again later or continue without it.` };
      }
      return { allow: false, message: 'The user denied this action.' };
    };
  }

  private buildOptions(job: Job, agent: AgentProfile, model: ConcreteModel, act: Active, prompt: string, resume?: string): Options {
    const cwd = agent.cwd || join(this.config.workspaceDir, agent.id);
    mkdirSync(cwd, { recursive: true });
    // the project (if any) adds text AFTER everything else and one extra folder: its own, and only its own
    const project = this.projectOf(job.taskId, agent.id);
    let projectFolder: string | undefined;
    if (project) { try { mkdirSync(project.folder, { recursive: true }); projectFolder = project.folder; } catch { /* no folder this run: the instructions still apply */ } }
    const servers = this.buildMcpServers(agent, job, act);
    const skillSet = this.moduleSkills(agent);
    const allowSkillShell = this.skillShellAllowed();
    const options: Options = {
      model,
      cwd,
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: LEGION_PREAMBLE.replace('{name}', agent.name)
          + this.modulePreamble(agent, { prompt, taskId: job.taskId, ...(job.origin ? { origin: job.origin } : {}), tainted: act.tainted || job.origin?.tainted === true, ...(project ? { projectId: project.id } : {}) })
          + '\n\n' + renderCapabilities(agent, { servers, ...(job.origin?.approvalCeiling ? { ceiling: job.origin.approvalCeiling } : {}), vmEnabledForAgent: !!agent.vm?.enabled })
          + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : '')
          + (project ? '\n\n' + projectSection({ name: project.name, instructions: project.instructions, folder: project.folder }) : '')
          // the lead's role comes last, after the persona and the project, so no edit or wording above can drop it
          + (leadDoctrineFor(agent.id) ? '\n\n' + leadDoctrineFor(agent.id) : ''),
      },
      ...(projectFolder ? { additionalDirectories: [projectFolder] } : {}),
      settingSources: this.config.claude.inheritClaudeCodeSettings ? ['user', 'project', 'local'] : [],
      // Always an explicit list: omitted means "everything Claude Code can find" (338 skills on the owner's machine). [] = none.
      skills: skillSet.skills,
      ...(skillSet.plugins.length ? { plugins: skillSet.plugins.map((path) => ({ type: 'local' as const, path })) } : {}),
      mcpServers: servers,
      // Off (default): only the servers above, asks the CLI to ignore user/project/local MCP config and plugins. claude.ai connectors are asked off in buildChildEnv and in `settings`.
      ...(this.config.claude.inheritMcp === true ? {} : { strictMcpConfig: true }),
      disallowedTools: ['SendMessage', 'ListAgents', ...this.moduleDisallowed(agent)],
      maxTurns: this.config.claude.maxTurns,
      // optional spend cap per run; on a resumed session it counts only the new spend
      ...(budgetCap(this.config.claude.maxBudgetUsd) !== undefined ? { maxBudgetUsd: budgetCap(this.config.claude.maxBudgetUsd) } : {}),
      includePartialMessages: true,
      abortController: act.ac,
      env: buildChildEnv(this.config),
      // SDK Settings.disableSkillShellExecution (sdk.d.ts:7156): inline shell in skills and slash commands runs before the model sees the text and never
      // reaches canUseTool, so it is replaced by a placeholder unless the owner allowed it in the Armory. Merged into the same flag layer as the connector switch.
      settings: { ...connectorSettings(this.config).settings, disableSkillShellExecution: !allowSkillShell },
      // Runs before every tool executes (also in bypass mode), so taint is set before the tool can act on outside content.
      hooks: {
        PreToolUse: [
          {
            hooks: [async (input) => {
              if (input.hook_event_name === 'PreToolUse') this.noteToolUse(job, act, input.tool_name, input.tool_use_id, input.tool_input);
              return { continue: true };
            }],
          },
          // Every Skill load, in every approval mode and for subagents too (they ignore the `skills` list): denied unless the skill is on for this agent.
          { matcher: 'Skill', hooks: [async (input) => {
            if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Skill') return { continue: true };
            const why = this.skillDenial(agent, input.tool_input);
            return why ? preToolDeny(why) : { continue: true };
          }] },
          // The Armory's own files are changed only through Legion's routes. Limit, stated plainly: this stops the file tools, not Bash.
          { hooks: [async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return { continue: true };
            const field = WRITE_FILE_TOOLS[input.tool_name];
            const target = field && input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>)[field] : undefined;
            if (typeof target !== 'string' || !target) return { continue: true };
            const abs = resolve(cwd, target);
            return this.protectedDirs().some((d) => pathInside(d, abs)) ? preToolDeny('The Armory\'s files can only be changed by the owner in Settings \u2192 Armory, not by an agent.') : { continue: true };
          }] },
        ],
      },
    };
    if (resume) options.resume = resume;
    if (this.config.claude.executablePath) options.pathToClaudeCodeExecutable = this.config.claude.executablePath;
    // A task woken by another bot can never be more permissive than the strictest sender on the chain
    // (confused-deputy guard): it never runs in bypass mode and its cards name who asked.
    const ceiling = job.origin?.approvalCeiling;
    const effective = (): ApprovalMode => {
      const mode = this.store.getAgent(agent.id)?.approval ?? agent.approval;
      return ceiling ? stricterMode(mode, ceiling) : mode;
    };
    if (agent.approval === 'full' && !(ceiling && ceiling !== 'full')) {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
      // bypass mode has no canUseTool: the web-egress card is raised from a PreToolUse hook instead (never both, so one card per call)
      options.hooks?.PreToolUse?.push({ matcher: 'WebFetch|WebSearch', hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const d = await this.webEgressCard(job, agent, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        return d && !d.allow ? preToolDeny(d.message ?? 'The user denied this web request.') : { continue: true };
      }] });
    } else {
      options.permissionMode = 'default';
      const decide = this.toolDecider(job, agent);
      options.canUseTool = async (toolName, input) => {
        const d = await decide(toolName, input);
        return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message ?? 'The user denied this action.' };
      };
    }
    return options;
  }

  /**
   * Compact a stored conversation now, on the user's request, for POST /api/tasks/:id/compact.
   *
   * The summary is written by the SAME model the last run used, so the compacted thread is still the same conversation
   * rather than a new one in a different voice. The result is appended as a system row: the transcript is append-only,
   * so the original turns stay retrievable and nothing is destroyed - which is also why a failed or declined compact
   * simply changes nothing rather than needing an undo.
   */
  async compactTaskNow(taskId: string, focus?: string): Promise<{ ok: boolean; detail: string }> {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, detail: 'That task is not here any more.' };
    const model = task.model;
    // A Claude task's real context is Claude Code's own session, not the rows stored here. Legion's summariser would only
    // add a summary row Claude never reads, so this hands the job to Claude Code's built-in /compact in that session.
    const agentModel = this.store.getAgent(task.agentId)?.model;
    if (!task.provider && !providerPrefix(model) && !providerPrefix(agentModel)) {
      if (!task.sessionId) return { ok: false, detail: 'There is nothing to compact yet. Send a message first, then compact.' };
      const f = focus?.trim();
      try {
        this.startTask({ agentId: task.agentId, prompt: f ? `/compact ${f}` : '/compact', source: 'ui', continueTaskId: taskId });
      } catch (e) {
        if (e instanceof EngineError && e.status === 409) return { ok: false, detail: 'This task is still running. Compact it after it stops.' };
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true, detail: 'Claude Code is compacting this conversation.' };
    }
    if (!model || model === 'auto') {
      return { ok: false, detail: 'This conversation has not run on a provider model yet. Open it and send a message first, then compact.' };
    }
    const stored = this.store.listMessages(taskId);
    if (stored.length < 2) return { ok: false, detail: 'There is not enough conversation here to compact yet.' };

    const asMessages = toChatMessages(stored);
    // No provider runtime means no provider model could ever have run this task, so there is nothing to summarise
    // with. Declining is the honest answer; `this.providers!` here would throw a TypeError and surface as a 500.
    if (!this.providers) return { ok: false, detail: 'Provider models are not available in this build.' };
    const before = messagesTokens(asMessages);
    const notices: string[] = [];
    const result = await this.providers!.compactNow({
      model,
      messages: asMessages,
      ...(focus && focus.trim() ? { focus: focus.trim() } : {}),
      onNotice: (t) => { notices.push(t); },
    });
    for (const n of notices) this.addMessage(taskId, 'system', n);

    if (!result.compacted) {
      return { ok: false, detail: result.reason ?? 'Nothing was compacted; the conversation was left as it was.' };
    }
    // The summary row is what the next run reads, so it is stored like any other system row.
    const summaryRow = result.messages.find((m) => isSummaryMessage(m));
    if (summaryRow?.content) this.addMessage(taskId, 'system', summaryRow.content);
    const after = messagesTokens(toChatMessages(this.store.listMessages(taskId)));
    const lost = result.missing.length ? ` ${result.missing.length} item(s) did not survive the summary.` : '';
    return {
      ok: true,
      detail: `Compacted ${before} to about ${after} estimated tokens.${lost}`,
    };
  }

  /** One run on a non-Claude provider (the seam into src/core/providers). Never falls back to Claude: a failure is the task's error. */
  private async runProvider(job: Job, agent: AgentProfile, pr: ResolvedModel, prompt: string, act: Active): Promise<Outcome> {
    const taskId = job.taskId;
    const servers: ProviderHost['servers'] = {};
    const external: NonNullable<ProviderHost['external']> = {};
    for (const [name, cfg] of Object.entries(this.buildMcpServers(agent, job, act, 'provider'))) {
      if (cfg.type === 'sdk') servers[name] = cfg;
      else if (cfg.type === 'http' || cfg.type === 'sse') external[name] = { type: cfg.type, url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) };
      else if (cfg.type === 'stdio' || cfg.type === undefined) external[name] = { command: (cfg as { command: string }).command, ...((cfg as { args?: string[] }).args ? { args: (cfg as { args?: string[] }).args } : {}), ...((cfg as { env?: Record<string, string> }).env ? { env: (cfg as { env?: Record<string, string> }).env } : {}) };
    }
    const decide = this.toolDecider(job, agent);
    const host: ProviderHost = {
      taskId, agentName: agent.name, signal: act.ac.signal, cancelled: () => act.cancelled || act.ac.signal.aborted,
      systemPrompt: LEGION_PREAMBLE.replace('{name}', agent.name)
        + this.modulePreamble(agent, { prompt, taskId, ...(job.origin ? { origin: job.origin } : {}), tainted: act.tainted || job.origin?.tainted === true })
        + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : '')
        + `\n\nYou are running on ${pr.model} through ${pr.entry?.label ?? pr.providerId}. You have only the tools listed in this request; you have no file, shell or web tools of your own.`
        + (leadDoctrineFor(agent.id) ? '\n\n' + leadDoctrineFor(agent.id) : ''),
      prompt, stored: this.store.listMessages(taskId),
      servers, external,
      authorize: decide,
      noteToolUse: (name, id, input) => this.noteToolUse(job, act, name, id, input),
      onDelta: (text) => this.bus.emit({ type: 'message.delta', taskId, text }),
      onAssistantText: (text) => { this.addMessage(taskId, 'assistant', text); },
      onToolCall: (name, id, input) => {
        let json: string;
        try { json = JSON.stringify(input ?? {}); } catch { json = '{}'; }
        if (json.length > 500) json = json.slice(0, 499) + '…';
        this.addMessage(taskId, 'tool', json, name, undefined, { toolUseId: id });
        this.mascot('hacking', name);
      },
      onToolResult: (id, text) => { if (text.trim()) this.addMessage(taskId, 'tool', clipToolResult(text), undefined, undefined, { resultFor: id }); },
      onNotice: (text) => { this.addMessage(taskId, 'system', text); },
    };
    const r = await this.providers!.run(host, pr);
    if (act.cancelled) return { subtype: 'cancelled', isError: false };
    // provider runs rebuild their history from the stored rows, which now hold the request and the work done so far
    if (r.turns > 0) act.reached = true;
    const cur = this.store.getTask(taskId);
    this.patchTask(taskId, {
      provider: pr.providerId,
      ...(act.reached ? { resumable: true } : {}),
      turns: (cur?.turns ?? 0) + r.turns,
      tokenUsage: {
        ...(r.usage ? { inputTokens: (cur?.tokenUsage?.inputTokens ?? 0) + r.usage.inputTokens, outputTokens: (cur?.tokenUsage?.outputTokens ?? 0) + r.usage.outputTokens } : (cur?.tokenUsage ?? {})),
        ...(r.usageUnknown || !r.usage || cur?.tokenUsage?.unknown ? { unknown: true } : {}),
      },
      ...(r.costUsd !== undefined ? { costUsd: (cur?.costUsd ?? 0) + r.costUsd } : {}),
      ...(!r.isError && r.resultText !== undefined ? { result: r.resultText } : {}),
    });
    return { subtype: r.subtype, isError: r.isError, errorText: r.isError ? r.errorText : undefined };
  }

  /** One SDK query() run. Returns the outcome of its result message; throws on SDK failure. */
  private async runOnce(job: Job, agent: AgentProfile, model: ConcreteModel, prompt: string, act: Active): Promise<Outcome> {
    const pr = this.providers?.resolve(model);
    if (pr) return this.runProvider(job, agent, pr, prompt, act);
    const resume = this.store.getTask(job.taskId)?.sessionId;
    const options = this.buildOptions(job, agent, model, act, prompt, resume);
    // Streaming input: the request is the first message of a stream the person can add to while the run works.
    const input = new InputChannel(prompt);
    act.input = input;
    const q = this.queryFn({ prompt: input, options });
    act.q = q;
    // each run counts its own turns (the limit is per run); the clock and the tool reset with it
    act.progress = { startedAt: nowIso(), turn: 0, maxTurns: this.config.claude.maxTurns, tool: null, turnIds: new Set(), thinking: false };
    this.emitProgress(job.taskId, act);

    const aborted = new Promise<'aborted'>((res) => {
      if (act.ac.signal.aborted) res('aborted');
      else act.ac.signal.addEventListener('abort', () => res('aborted'), { once: true });
    });
    const it = q[Symbol.asyncIterator]();
    let outcome: Outcome | undefined;
    try {
      for (;;) {
        const next = await Promise.race([it.next(), aborted]);
        if (next === 'aborted' || act.cancelled) return { subtype: 'cancelled', isError: false };
        if (next.done) break;
        const o = this.handleMessage(job, act, next.value as any);
        // each result answers one message; once none are waiting the stream closes and the run ends
        if (o) { outcome = o; if (input.answered((next.value as any)?.queued_turn_count)) input.close(); }
      }
    } catch (e) {
      if (act.cancelled || act.ac.signal.aborted) return { subtype: 'cancelled', isError: false };
      const text = e instanceof Error ? e.message : String(e);
      if (!outcome) return { subtype: 'error_during_execution', isError: true, errorText: text };
      // The SDK yields an error result and THEN throws "Claude Code returned an error result: ..." (its documented
      // single-shot behaviour, Query.readMessages). The result already carries the run's outcome; rethrowing would send
      // every turn-limit pause and every escalatable error down the generic failure path instead.
      if (outcome.isError) return outcome;
      throw e;
    } finally {
      // a thinking flag must never outlive its run
      if (act.progress?.thinking) { act.progress.thinking = false; this.emitProgress(job.taskId, act); }
      input.close();
      if (act.input === input) act.input = undefined;
      try { q.close?.(); } catch { /* ignore */ }
      try { void it.return?.(undefined)?.catch?.(() => undefined); } catch { /* ignore */ }
    }
    return outcome ?? { subtype: 'error_during_execution', isError: true, errorText: 'Claude ended without producing a result' };
  }

  /**
   * Remember which MCP servers the run started with. With claude.inheritMcp on, a server inherited from Claude Code that is Legion's own
   * /mcp (for example `claude mcp add legion http://127.0.0.1:<port>/mcp`) is switched off for this run, so an agent never talks to Legion through Legion.
   * Best effort and read-only otherwise: a failure here never touches the run.
   */
  private noteMcpInit(act: Active, servers: unknown): void {
    this.mcpTracker.record(servers, nowIso());
    const q = act.q as any;
    const inherit = this.config.claude.inheritMcp === true;
    const list = Array.isArray(servers) ? servers as Array<{ name?: unknown; status?: unknown }> : [];
    const trouble = list.some((s) => s.status === 'failed' || s.status === 'needs-auth');
    if (!q || typeof q.mcpServerStatus !== 'function' || !(inherit || trouble)) return;
    void (async () => {
      const full = await q.mcpServerStatus();
      this.mcpTracker.addDetails(full);
      if (!inherit || typeof q.toggleMcpServer !== 'function' || !Array.isArray(full)) return;
      for (const s of full) {
        if (s?.source === 'sdk' || typeof s?.name !== 'string') continue;
        if (s.name === 'legion' || isSelfMcpUrl(s.config?.url, this.config.port, { headers: s.config?.headers, authToken: this.config.authToken })) {
          try { await q.toggleMcpServer(s.name, false); } catch { this.mcpTracker.setNotice(`Could not switch off "${s.name}", which points back at Legion. It stays connected for this run.`); }
        }
      }
    })().catch(() => undefined);
  }

  /** Process one SDK message; returns an Outcome for `result` messages. */
  private handleMessage(job: Job, act: Active, msg: any): Outcome | undefined {
    const taskId = job.taskId;
    switch (msg?.type) {
      case 'system': {
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          // Set now, not when the run ends: a crash, a restart or a thrown error must still leave the task continuable.
          act.reached = true;
          this.patchTask(taskId, { sessionId: msg.session_id, resumable: true });
          this.noteMcpInit(act, msg.mcp_servers);
        } else if (msg.subtype === 'compact_boundary') {
          // Claude Code compacted its own context (on /compact, or by itself near the window's end): say so, or the
          // agent seems to forget early instructions for no visible reason.
          const pre = Number(msg.compact_metadata?.pre_tokens);
          const size = Number.isFinite(pre) && pre > 0 ? ` It held about ${Math.round(pre / 1000)}k tokens.` : '';
          this.addMessage(taskId, 'system', msg.compact_metadata?.trigger === 'auto'
            ? `Claude Code compacted this conversation by itself, to make room.${size} Early details may now be summarised.`
            : `Claude Code compacted this conversation.${size}`);
        } else if (msg.subtype === 'local_command_output' && typeof msg.content === 'string' && msg.content.trim()) {
          // Output of a slash command Claude Code ran locally (/cost, /context, ...), shown as an assistant message.
          this.addMessage(taskId, 'assistant', msg.content);
        }
        return undefined;
      }
      case 'stream_event': {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string' && !msg.parent_tool_use_id) {
          this.bus.emit({ type: 'message.delta', taskId, text: ev.delta.text });
        }
        // A thinking block is shown only as a state ("Thinking"); its text is never stored or sent. The flag follows the block.
        const pg = act.progress;
        if (pg && !msg.parent_tool_use_id) {
          if (ev?.type === 'content_block_start' && (ev.content_block?.type === 'thinking' || ev.content_block?.type === 'redacted_thinking') && !pg.thinking) { pg.thinking = true; this.emitProgress(taskId, act); }
          else if (ev?.type === 'content_block_stop' && pg.thinking) { pg.thinking = false; this.emitProgress(taskId, act); }
        }
        return undefined;
      }
      case 'assistant': {
        const blocks: any[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
        const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
        if (text) this.addMessage(taskId, 'assistant', text);
        // A turn is one model response of the run itself: one message id (the SDK may send a response in several
        // messages that share it). A subagent's messages carry parent_tool_use_id and are not the run's own turns.
        const pg = act.progress;
        // a finished response means the thinking in it is over, whatever its blocks said
        const wasThinking = pg?.thinking === true;
        if (pg && wasThinking) pg.thinking = false;
        let todosChanged = false;
        if (pg && !msg.parent_tool_use_id) {
          for (const b of blocks) {
            if (b?.type === 'tool_use' && b.name === 'TodoWrite') { const list = clipTodos(b.input); if (list) { pg.todos = list; todosChanged = true; } }
          }
          const id = typeof msg.message?.id === 'string' ? msg.message.id : `n${pg.turnIds.size}`;
          const lastTool = [...blocks].reverse().find((b) => b?.type === 'tool_use');
          const before = `${pg.turn}|${pg.tool}|${pg.contextTokens ?? ''}`;
          if (!pg.turnIds.has(id)) { pg.turnIds.add(id); pg.turn = pg.turnIds.size; }
          if (lastTool) pg.tool = String(lastTool.name ?? 'tool');
          // the context after this response: its input plus the cache it read and wrote (a subagent's is its own context, so skipped above)
          const ctx = contextTokensOf(msg.message?.usage);
          if (ctx !== undefined) pg.contextTokens = ctx;
          if (`${pg.turn}|${pg.tool}|${pg.contextTokens ?? ''}` !== before || todosChanged || wasThinking) this.emitProgress(taskId, act);
        } else if (pg && wasThinking) this.emitProgress(taskId, act);
        for (const b of blocks) {
          if (b?.type !== 'tool_use') continue;
          this.noteToolUse(job, act, String(b.name ?? 'tool'), typeof b.id === 'string' ? b.id : undefined, b.input);
          let json: string;
          try { json = JSON.stringify(b.input ?? {}); } catch { json = '{}'; }
          if (json.length > 500) json = json.slice(0, 499) + '…';
          this.addMessage(taskId, 'tool', json, String(b.name ?? 'tool'), undefined, typeof b.id === 'string' ? { toolUseId: b.id } : undefined);
          this.mascot('hacking', String(b.name ?? ''));
        }
        return undefined;
      }
      case 'user': {
        // Tool results: stored (truncated) and paired with their call via resultFor, so the UI can expand them.
        if (msg.parent_tool_use_id) return undefined;
        const blocks: any[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
        // the tool came back: the model is thinking again until its next call
        if (act.progress?.tool && blocks.some((b) => b?.type === 'tool_result')) { act.progress.tool = null; this.emitProgress(taskId, act); }
        for (const b of blocks) {
          if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const raw = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '';
          if (!raw.trim()) continue;
          const text = clipToolResult(raw);
          this.addMessage(taskId, 'tool', text, undefined, undefined, { resultFor: b.tool_use_id });
        }
        return undefined;
      }
      case 'result': {
        const cur = this.store.getTask(taskId);
        const isError = Boolean(msg.is_error) || msg.subtype !== 'success';
        const text: string | undefined = msg.subtype === 'success'
          ? (typeof msg.result === 'string' ? msg.result : undefined)
          : (Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join('; ') : undefined);
        this.patchTask(taskId, {
          costUsd: (cur?.costUsd ?? 0) + (typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0),
          turns: (cur?.turns ?? 0) + (typeof msg.num_turns === 'number' ? msg.num_turns : 0),
          ...(typeof msg.session_id === 'string' && !cur?.sessionId ? { sessionId: msg.session_id } : {}),
          ...(!isError && text !== undefined ? { result: text } : {}),
        });
        return { subtype: String(msg.subtype), isError, errorText: isError ? text : undefined };
      }
      default:
        return undefined;
    }
  }
}
