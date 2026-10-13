/** Runs agent tasks via the Claude Agent SDK. */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, Query, Settings, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile, ApprovalMode, ChatMessage, ConcreteModel, LegionConfig, MascotMood, MessageRole, ModelChoice, Task, TaskProgress, TaskSource,
} from '../shared/types.js';
import { newId, nowIso, titleFrom } from '../shared/util.js';
import { gatesFor, scrubHostSessionEnv } from '../shared/config.js';
import { liveSecrets } from './kg/index.js';
import { BUDGET_LIMIT_PREFIX, CONTINUE_PROMPT, TURN_LIMIT_PREFIX, budgetCap, formatUsdLimit } from '../shared/continue.js';
import { clampBudget } from './brief.js';
import { InputChannel } from './input-channel.js';
import { BackgroundTasks } from './background-tasks.js';
import { capStored, RESULT_STORE_MAX } from './result-store.js';
import { contextTokensOf } from '../shared/context-meter.js';
import { isLegionTool, needsApproval, stricterMode, LEGION_SERVER_NAMES } from './approvals.js';
import { decideGate } from './gates.js';
import { TaintedPaths } from './tainted-paths.js';
import { carryDone, CLAUDE_TASK_TOOLS, mirrorClaudeTaskCall, renderEmptyHandover, renderForModel, renderHandover, TaskList, TaskListStore } from './task-list.js';
import { nativeTaskListOn } from '../shared/task-list-setting.js';
import { buildHostToolsServer, redactValues } from './exec/host-tools.js';
import { MAX_READABLE, refuseCatastrophic, unjudgeableCommand, type ShellKind } from './exec/shell-floor.js';
/** The tools that run a shell command: Legion's host shell and Claude Code's own Bash and PowerShell. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['mcp__host__shell', 'Bash', 'PowerShell', 'Monitor']);
/** The shell each tool runs its command in: Claude Code's Bash and Monitor (POSIX sh, Git Bash on Windows), its PowerShell, Legion's host shell (agent-shell.ts: Git Bash, or cmd.exe on Windows without Git). */
const shellKindOf = (toolName: string): ShellKind => (toolName === 'PowerShell' ? 'pwsh' : toolName === 'mcp__host__shell' ? floorShell(agentShell()) : 'sh');
import { DirectHostBackend } from './exec/direct-host.js';
import { agentShell, floorShell } from './exec/agent-shell.js';
import { clampExecLimits } from './exec/limits.js';
import { CONTINUE_REFUSED } from './connector-withhold.js';
import type { CoreModule, ModuleJob, PreambleContext, TaskEndOutcome } from './modules.js';
import type { TaskOrigin } from '../shared/comms.js';
import type { ApprovalBroker } from './approvals.js';
import { QuestionBroker } from './questions.js';
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
import { renderTeamwork } from './teamwork.js';
import type { ProjectStore } from './projects/store.js';
import { tmpdir } from 'node:os';

/** On Windows the agent shell and Git Bash read `/tmp` as the user's temp folder: gates check both spellings there. */
const GATE_TMP_DIR = process.platform === 'win32' ? tmpdir() : undefined;

export type QueryFn = typeof sdkQuery;

export interface EngineDeps {
  store: Store; bus: EventBus; vms: VmManager; approvals: ApprovalBroker; config: LegionConfig;
  /** Structured questions (agent ask_user_question -> thread card). Defaults to one private to this engine, on the same bus. */
  questions?: QuestionBroker;
  /** Injected for tests; defaults to the real SDK query(). */
  queryFn?: QueryFn;
  /** Returns whether boat is configured (vm tools only offered when true). */
  boatConfigured: () => boolean;
  maxConcurrent?: number;
  modules?: CoreModule[];
  /** Where the list of files written by tainted runs is kept; defaults to <workspaceDir>/.tainted-paths.json. */
  taintedPaths?: TaintedPaths;
  /** Where each task's own task list is kept (task-list.ts); defaults to <workspaceDir>/.task-lists. */
  taskLists?: TaskListStore;
  /** Other model providers (OpenAI-compatible endpoints). Absent: every run is a Claude run, exactly as before. */
  providers?: ProviderRuntime;
  /** Projects (src/core/projects). Absent: no task has a project and nothing about projects is interpreted. */
  projects?: ProjectStore;
  /** Timings for a run that is held open by background agents. Tests shorten them; the defaults are BG_STALL_MS and BG_GRACE_MS. */
  background?: { stallMs?: number; graceMs?: number; maxHeldMs?: number; now?: () => number };
}

/**
 * A run with background agents is held open (its input stays open) until they report. If the SDK sends nothing at all for this long while
 * they are running, Legion stops waiting, says so in the thread and closes the run (which ends them).
 */
export const BG_STALL_MS = 60 * 60_000;
/** After the last background agent reports, how long a silent run is given to answer the notification before it is closed. */
export const BG_GRACE_MS = 30_000;
/**
 * The most a run is held open for background agents, whatever they send: their own heartbeats (task_progress, tool_progress) would
 * otherwise keep the silence cap from ever firing on a wedged agent, and the run holds a concurrency slot meanwhile.
 */
export const BG_MAX_HELD_MS = 2 * 60 * 60_000;

/** Claude Code's own task tools, opted in or out per agent (nativeTaskListOn). */
const NATIVE_TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'] as const;

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

/** A task list as the live checklist: the same limit a TodoWrite list has. */
const checklistOf = (list: TaskList): TodoItem[] => list.todos().slice(0, TODO_MAX_ITEMS);

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
  'ScheduleWakeup', // schedules the agent's own next turn; returns only a confirmation
  'PushNotification', // notice to the owner's device; nothing comes back into the run
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
/** The owner already decided this call (on a floor card): skip the ordinary permission check for it. */
function preToolAllow(reason: string): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow'; permissionDecisionReason: string } } {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } };
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

/**
 * Who the agent is and how to behave. Reaching other agents lives in the teamwork block (teamwork.ts) and the VM policy in the
 * capabilities block (agent-facts.ts), each said once and only when the run has those tools (Fascia 3a).
 */
export const LEGION_PREAMBLE = [
  'You are {name}, an agent inside Legion, the user\'s personal multi-agent bot running on their own computer.',
  'Be direct and get the work done; report results concisely.',
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

/** Environment variables that hold Legion's own credentials. */
const LEGION_CREDENTIAL_ENV = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BOAT_API_KEY']);

/**
 * The environment the agent shell (host tools) starts from. Legion's own credentials are not the agent's: the Anthropic
 * key and token, the boat key, and any variable whose value holds the bearer token or a configured key are left out, so a
 * command (`set`, `env`, a curl that sends a variable) does not get them from its environment. Legion's own control
 * variables (the LEGION_ namespace) are left out too. Everything else is kept,
 * including credentials the owner set up for the work itself (a GITHUB_TOKEN for git push): the approval card is the
 * check on those.
 *
 * Known limit, stated rather than hidden: the shell runs as the user, so it can still READ Legion's own files
 * (`~/.legion/config.json`, or LEGION_HOME) where those keys are kept. Only a sandboxed backend closes that.
 */
export function buildHostShellEnv(config: LegionConfig): Record<string, string> {
  // a section that is not there has no key in it: the named variables are still dropped
  const secrets = [config.authToken, config.claude?.apiKey, config.boat?.apiKey]
    .filter((s): s is string => typeof s === 'string' && s.length >= 8).map((s) => s.toLowerCase());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubHostSessionEnv({ ...process.env }))) {
    if (v === undefined || LEGION_CREDENTIAL_ENV.has(k.toUpperCase())) continue;
    // LEGION_* steers the core itself (LEGION_PORT, LEGION_HOME, LEGION_TEST_MODE, ...): a Legion or a test the agent starts must not inherit it
    if (/^LEGION_/i.test(k)) continue;
    const lower = v.toLowerCase();
    if (secrets.some((s) => lower.includes(s))) continue;
    out[k] = v;
  }
  return out;
}

interface Job {
  taskId: string; agentId: string; prompt: string; choice: ModelChoice; priorModel?: ConcreteModel;
  /** The project the run was queued in (A10): if it is gone when the run starts, the thread says so. */
  projectAtStart?: string;
  /** One-line bridge header prepended to what Claude sees (not stored). */
  header?: string;
  /** Text the auto router scores, when it differs from `prompt` (a typed brief scores its goal only; Fascia 3b). */
  routeText?: string;
  /** A per-run spend cap in USD (a brief's budget); clamped in buildOptions, never above the owner's claude.maxBudgetUsd. */
  maxBudgetUsd?: number;
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
  /** Live progress of the current run (Claude, or a provider run from its first turn): sent as `task.progress`, never stored. */
  progress?: { startedAt: string; turn: number; maxTurns: number; tool: string | null; turnIds: Set<string>; contextTokens?: number; todos?: TodoItem[]; thinking: boolean };
  /** The live prompt stream of the current Claude run: a message from the person while it works is pushed here. */
  input?: InputChannel;
  /** The background agents the current Claude run has going (from the SDK's task messages). While any run, the input stays open. */
  bg?: BackgroundTasks;
  /** When the held phase ends whatever happens (ms since epoch); set while the run is held for background agents. */
  bgStopsAt?: number;
  /** The task's own task list (kept per Legion task): a mirror of Claude Code's on a Claude run, the list itself on a provider run. */
  taskList?: TaskList;
  /** Claude Code task-tool calls waiting for their result (a new task's id arrives only in the result), by tool_use id. */
  taskCalls?: Map<string, { name: string; input: unknown }>;
  /** The list as it was handed over to this Claude run (flag still set): put back if the run does not finish, so nothing is lost. */
  handoverFrom?: TaskList;
  /** The run ended done (set just before that status is saved). */
  finishedOk?: boolean;
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
  private readonly questions: QuestionBroker;
  private readonly config: LegionConfig;
  private readonly queryFn: QueryFn;
  private readonly boatConfigured: () => boolean;
  private readonly maxConcurrent: number;
  private readonly taintedPaths: TaintedPaths;
  private readonly taskLists: TaskListStore;
  private readonly providers?: ProviderRuntime;
  private readonly projects?: ProjectStore;
  private readonly queue: Job[] = [];
  private readonly active = new Map<string, Active>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly bridge: Bridge;
  private modules: CoreModule[];
  private readonly mcpTracker = new McpStatusTracker();
  private readonly bgStallMs: number;
  private readonly bgGraceMs: number;
  private readonly bgMaxHeldMs: number;
  private readonly bgNow: () => number;

  constructor(deps: EngineDeps) {
    this.bgStallMs = Math.max(1, deps.background?.stallMs ?? BG_STALL_MS);
    this.bgGraceMs = Math.max(1, deps.background?.graceMs ?? BG_GRACE_MS);
    this.bgMaxHeldMs = Math.max(1, deps.background?.maxHeldMs ?? BG_MAX_HELD_MS);
    this.bgNow = deps.background?.now ?? Date.now;
    this.store = deps.store; this.bus = deps.bus; this.vms = deps.vms; this.approvals = deps.approvals;
    this.questions = deps.questions ?? new QuestionBroker(deps.bus);
    this.config = deps.config;
    this.queryFn = deps.queryFn ?? realQuery;
    this.boatConfigured = deps.boatConfigured;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 4);
    this.modules = deps.modules ?? [];
    this.providers = deps.providers;
    this.projects = deps.projects;
    this.taintedPaths = deps.taintedPaths ?? new TaintedPaths(join(deps.config.workspaceDir, '.tainted-paths.json'));
    this.taskLists = deps.taskLists ?? new TaskListStore(join(deps.config.workspaceDir, '.task-lists'));
    // a deleted task takes its task list with it, so nothing of it is left behind for a later task to find
    this.bus.on((e) => { if (e.type === 'task.deleted') { try { this.taskLists.remove(e.taskId); } catch { /* best effort */ } } });
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
      const picked = this.pickProject(p, agent, prev);
      // Continuing never erases the task's project (council A4): when this run cannot use it (the agent left the project,
      // or it is archived), the task keeps it, the run goes without it, and the thread says so. Only an explicit `null`
      // from the app or a room clears it.
      const projectId = picked ?? (p.projectId === null ? undefined : prev.projectId);
      const lostProject = picked === undefined && projectId !== undefined && this.projects ? this.projects.get(projectId) : undefined;
      priorModel = prev.model;
      const viaBridge = p.bridge && !p.bridge.reply;
      // A model another bot chose lasts for that run only: a later message that asks for none (and is not a reply landing in the caller's own task) goes back to the agent's setting.
      const keepOverride = !!p.bridge?.reply;
      // Provenance flag `modelChosen` (carried on the task row): requestedModel was CHOSEN for this task - a value
      // other than agent.model - rather than copied from Settings. When nobody asks for a model on this turn the
      // configured model is re-read instead of the snapshot taken at task creation, so changing a bot's model in
      // Settings reaches every thread it owns. The one place the previous value survives is a reply landing in the
      // caller's own task, and only while it is still an explicit choice (or a recorded override).
      const chosenBefore = (prev as Task & { modelChosen?: boolean }).modelChosen === true;
      const keepChosen = keepOverride && (chosenBefore || !!prev.modelOverride);
      const requestedModel = p.model ?? (keepChosen ? prev.requestedModel : agent.model);
      const next = {
        ...prev, status: 'queued' as const, source: p.source,
        requestedModel, modelChosen: requestedModel !== agent.model,
        modelOverride: overriding ? { model: p.model!, by: p.modelOverrideBy! } : keepOverride ? prev.modelOverride : undefined,
        // not resumable until this run's own prompt reaches the session (a restart before then must re-send it, not continue)
        result: undefined, error: undefined, resumable: undefined,
        ...(this.projects ? { projectId } : {}),
        ...(viaBridge ? { fromAgentId: p.bridge!.fromAgentId, parentTaskId: p.bridge!.parentTaskId } : {}),
        bridgeHop: p.bridge ? p.bridge.hop ?? 0 : undefined,
        // A human continuing a task clears any bot-origin ceiling; a bridge reply keeps the task's own.
        origin: origin ?? (p.bridge?.reply ? prev.origin : undefined),
        ...(tainted ? { tainted: true } : {}),
      };
      task = this.saveTask(next);
      if (lostProject) {
        const why = lostProject.status === 'archived' ? 'the project is archived' : `${agent.name} is not a member of it any more`;
        this.addMessage(task.id, 'system', `This run is not in project "${lostProject.name}": ${why}. The task still belongs to the project; it runs without the project's instructions, board and folder until that changes.`);
      }
    } else {
      const now = nowIso();
      const base = prompt.replace(/^\s*\/(opus|sonnet)\b\s*/i, '') || prompt;
      const callerName = p.bridge ? (this.store.getAgent(p.bridge.fromAgentId)?.name ?? p.bridge.fromAgentId) : '';
      const projectId = this.pickProject(p, agent, undefined);
      const requestedModel = p.model ?? agent.model;
      const next = {
        id: newId('task'), agentId: agent.id,
        title: p.bridge ? `${callerName}: ${base.replace(/\s+/g, ' ').trim().slice(0, 50)}` : titleFrom(base),
        status: 'queued' as const, source: p.source,
        ...(p.bridge ? { fromAgentId: p.bridge.fromAgentId, parentTaskId: p.bridge.parentTaskId, bridgeHop: p.bridge.hop ?? 0 } : {}),
        // provenance: a task that runs on its agent's own model carries no choice of its own (see the continue branch)
        requestedModel, modelChosen: requestedModel !== agent.model, createdAt: now, updatedAt: now,
        ...(overriding ? { modelOverride: { model: p.model!, by: p.modelOverrideBy! } } : {}),
        ...(origin ? { origin } : {}),
        ...(projectId ? { projectId } : {}),
        ...(tainted ? { tainted: true } : {}),
      };
      task = this.saveTask(next);
    }
    this.addMessage(task.id, 'user', prompt, undefined, p.bridge?.fromAgentId);
    const projectAtStart = this.projectOf(task.id, agent.id)?.id;
    this.queue.push({
      taskId: task.id, agentId: agent.id, prompt, choice: task.requestedModel, priorModel,
      ...(projectAtStart ? { projectAtStart } : {}),
      header: p.bridge?.header, fromAgentId: p.bridge?.fromAgentId, parentTaskId: p.bridge && !p.bridge.reply ? p.bridge.parentTaskId : undefined,
      ...(p.routeText !== undefined ? { routeText: p.routeText } : {}),
      ...(p.maxBudgetUsd !== undefined ? { maxBudgetUsd: p.maxBudgetUsd } : {}),
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
    // a delegation (ask/tell) belongs to its CALLER's project, before any older thread's (BUG-5)
    const delegated = !!p.bridge && !p.bridge.reply && !!p.bridge.parentTaskId;
    if ((p.source === 'ui' || p.source === 'bot') && p.projectId !== undefined) { want = p.projectId ?? undefined; named = true; }
    else if (delegated) want = this.store.getTask(p.bridge!.parentTaskId!)?.projectId;
    else if (prev) want = prev.projectId;
    if (!want) return undefined;
    const pr = this.projects.get(want);
    if (pr && pr.status === 'archived') {
      if (p.source === 'ui' || (prev && !named)) throw new EngineError(`Project "${pr.name}" is archived. Unarchive it to start or continue a task in it.`, 409);
      return undefined;
    }
    if (pr && pr.members.includes(agent.id)) return want;
    if (p.source === 'ui' && named) throw new EngineError(pr ? `${agent.name} is not a member of project "${pr.name}"` : `Unknown project: ${want}`, 400);
    // A delegation into a project goes to its members only: a run without the project would miss its rules, board and folder,
    // and the caller would never know (council A3). The caller is told, and can ask a member or the owner instead.
    if (delegated && pr) throw new EngineError(`${agent.name} is not a member of project "${pr.name}". Ask an agent that is a member, or ask the owner to add ${agent.name} to the project.`, 403);
    return undefined;
  }

  /**
   * Says in the thread that a run queued in a project starts without it (council A10): the project was archived or
   * deleted, or the agent was removed, while the run waited. Worded like the note a continued task gets at start.
   */
  private noteProjectLost(taskId: string, projectId: string, agent: AgentProfile): void {
    const pr = this.projects?.get(projectId);
    const text = !pr ? 'This run has no project: its project was deleted while the run waited.'
      : `This run is not in project "${pr.name}": ${pr.status === 'archived' ? 'the project is archived' : `${agent.name} is not a member of it any more`}. The task still belongs to the project; it runs without the project's instructions, board and folder until that changes.`;
    try { this.addMessage(taskId, 'system', text); } catch { /* the note is advisory */ }
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
    this.questions.cancelForTask(taskId);
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

  /**
   * The task row's copy of a reply. A reply longer than the row holds is kept whole in the result store first, and the
   * row's visible note points there, so no character is lost (the owner's no-silent-truncation rule): only this copy is cut.
   */
  private keepResult(taskId: string, text: string): string {
    if (text.length <= RESULT_STORE_MAX) return text;
    try { return capStored(text, RESULT_STORE_MAX, { taskId, resultId: this.bridge.results.put(taskId, text) }); } catch { return capStored(text); }
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
      const p = this.progressView(act);
      // a run whose task is already marked done/error is in its last moments of cleanup: it has no progress to show
      if (!p || this.store.getTask(taskId)?.status !== 'running') continue;
      out[taskId] = p;
    }
    return out;
  }

  private emitProgress(taskId: string, act: Active): void {
    const p = this.progressView(act);
    if (p) this.bus.emit({ type: 'task.progress', taskId, progress: p });
  }

  /** A Claude run's mirrored task list changed: keep it for the task's next run and show it as the live checklist. */
  private keepTaskList(taskId: string, act: Active, list: TaskList): void {
    // only the checklist's copy (Claude Code keeps the real list): an unwritable folder must not stop the run
    try { this.taskLists.save(taskId, list); } catch { /* the live checklist still updates */ }
    this.showTaskList(taskId, act, list);
  }

  /** Shows the task's list as the live checklist of the current run. */
  private showTaskList(taskId: string, act: Active, list: TaskList): void {
    act.taskList = list;
    if (act.progress) { act.progress.todos = checklistOf(list); this.emitProgress(taskId, act); }
  }

  /** What the app is told about a run: one place, so the live event and the snapshot for a late client cannot drift apart. */
  private progressView(act: Active): TaskProgress | undefined {
    const p = act.progress;
    if (!p) return undefined;
    const background = act.bg?.count ?? 0;
    return {
      startedAt: p.startedAt, turn: p.turn, maxTurns: p.maxTurns, tool: p.tool, thinking: p.thinking,
      ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}), ...(p.todos ? { todos: p.todos } : {}),
      ...(background > 0 ? { background, ...(act.bgStopsAt !== undefined ? { backgroundStopsAt: new Date(act.bgStopsAt).toISOString() } : {}) } : {}),
    };
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
      this.settleHandover(job.taskId, act);
      this.endTask(job, act);
      if (this.active.get(job.taskId) === act) this.active.delete(job.taskId);
      try { this.approvals.cancelForTask(job.taskId); } catch { /* ignore */ }
      try { this.questions.cancelForTask(job.taskId); } catch { /* ignore */ }
      if (this.active.size === 0 && this.queue.length === 0) this.scheduleIdle();
      this.pump();
    }
  }

  /** A hand-over run that did not finish (stopped, failed, paused at a limit) puts the handed-over list back, flagged, so the next Claude run gets it again. */
  private settleHandover(taskId: string, act: Active): void {
    // the run's own outcome, not the task's status: a continuation queued the moment this run finished has already re-set that
    if (!act.handoverFrom || act.finishedOk) return;
    try { this.taskLists.save(taskId, act.handoverFrom); } catch { /* best effort */ }
  }

  /** Tells every module the run is over (after the final status is saved). A broken module never breaks the engine. */
  private endTask(job: Job, act: Active): void {
    const task = this.store.getTask(job.taskId);
    const agent = this.store.getAgent(job.agentId);
    if (!task || !agent) return;
    const projectId = this.projectOf(job.taskId, agent.id)?.id;
    const outcome: TaskEndOutcome = {
      status: task.status, isError: task.status === 'error', ...(task.error ? { errorText: task.error } : {}), tainted: act.tainted,
      ...(projectId ? { projectId } : {}),
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
    // Fascia 3b: a typed brief is sent whole, but only its goal is scored by the auto router. The checks and the context
    // refs are a checklist, not the task, and must not flip `auto` (they name words such as plan, review and debug, or run long).
    const hasBriefRoute = !!(job.routeText && job.routeText.trim());
    let decision = routeModel(hasBriefRoute ? job.routeText! : job.prompt, job.choice, { priorModel: job.priorModel });
    // The last check before anything is sent, on the exact text Claude Code will get. A queued prompt starts here, and the owner may have
    // switched the skill off since it was queued.
    const sendText = hasBriefRoute ? job.prompt : decision.prompt;
    const slashNo = this.slashRefusal(agent, sendText);
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
    const sendPrompt = (job.header ? job.header + '\n' : '') + sendText;

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
      // the cap this run really had: a brief's budget when it lowered the owner's (Fascia 3b)
      const cap = this.perRunBudget(job);
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
      act.finishedOk = true;
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
      if (LEGION_SERVER_NAMES.has(name)) continue;
      if (entry.type === 'http') out[name] = { type: 'http', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else if (entry.type === 'sse') out[name] = { type: 'sse', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else out[name] = { type: 'stdio', command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
    }
    // Every agent gets the in-process `legion` server (bridge tools; plus vm_* when a VM is enabled).
    out.legion = buildAgentToolsServer({
      agentId: agent.id, taskId, vms: this.vms, bridge: this.bridge, questions: this.questions,
      vmEnabled: !!agent.vm?.enabled && this.boatConfigured(),
      claudeAvailable: this.vms.claudeAvailable?.() ?? true, // vm_claude is hidden while Claude is known not to be set up on boat.dev
      ...(job.origin ? { origin: { roomId: job.origin.roomId, fromAgentId: job.origin.fromAgentId, hop: job.origin.hop } } : {}),
      // a provider run has no Claude Code task tools: Legion keeps the list for it (a Claude run's own list is only mirrored, for the checklist)
      // a provider change is handed over to the next Claude run of this conversation (its own list is behind)
      ...(runtime === 'provider' ? { taskList: { load: () => this.taskLists.load(taskId), save: (l: TaskList) => { l.handoverPending = true; this.taskLists.save(taskId, l); this.showTaskList(taskId, act, l); } } } : {}),
    });
    // The agent shell: host shell/file tools, only for an agent that opted in. The names are `mcp__host__*` (NOT
    // Legion's own), so needsApproval raises a card and taintsRun marks the run; `host` grants the TOOLS, the agent's
    // `approval` mode decides whether each call is carded. An absent `host` = no tools (the opt-in gate).
    if (agent.host?.enabled) {
      out.host = buildHostToolsServer({
        agentId: agent.id, taskId,
        rootDir: this.hostRootOf(agent),
        backend: new DirectHostBackend({ limits: clampExecLimits({ timeoutSeconds: agent.host.timeoutSeconds }), env: buildHostShellEnv(this.config) }),
        // the shell can read Legion's own files (config.json, provider keys): every secret Legion holds is taken out of what comes back
        redact: (text) => redactValues(text, [...liveSecrets(this.config), ...(this.providers?.secretValues() ?? [])]),
        envFiles: agent.host.envFiles ?? 'masked',
      });
    }
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

  /** Where the agent shell runs and its file paths resolve (host-tools.ts resolveWithin). */
  private hostRootOf(agent: AgentProfile): string {
    return agent.host?.rootDir ?? agent.cwd ?? join(this.config.workspaceDir, agent.id);
  }

  /**
   * The folder a tool call's relative paths mean, so a path gate rule reads `secrets/key.txt` as the file it names: the
   * agent shell's root for its own tools, the agent's working folder for everything else.
   */
  private gateCwd(agent: AgentProfile, toolName: string): string {
    return toolName.startsWith('mcp__host__') ? this.hostRootOf(agent) : (agent.cwd || join(this.config.workspaceDir, agent.id));
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
  private webEgressCard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string }> | undefined {
    if (toolName !== 'WebFetch' && toolName !== 'WebSearch') return undefined;
    const used = this.store.getTask(job.taskId)?.usedConnectors === true;
    const tainted = this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true;
    if (!used || !tainted) return undefined;
    const target = String(toolName === 'WebFetch' ? input?.url ?? '' : input?.query ?? '').slice(0, 1000);
    const o = job.origin;
    let timedOut = false;
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: () => { timedOut = true; },
      summary: `${toolName}: ${target}
This run read connector (GitHub) data and other outside text. Web access can send that data out. Check the address or query before you allow it.`,
    }).then((allowed) => allowed ? { allow: true } : { allow: false, message: timedOut ? `No one answered the approval request within ${this.approvals.timeoutWait}, so this web request was not run.` : 'The user denied this web request.' });
  }

  /**
   * The safety floor for every shell an agent drives: Legion's own host shell AND Claude Code's Bash and PowerShell tools.
   * A catastrophic command (a whole drive, a system or home folder) or one that runs decoded or encoded text is refused, with
   * no card. A command the floor cannot read (its program is built when it runs: `$(echo rm)`, `$x`, `{a,b}`, `%X%`, or
   * another command's output piped into a shell) is never assumed safe: in the ask modes it gets a card with no Remember;
   * in Full it is refused at once with the reason and how to write it plainly, so a run nobody watches never waits on a card
   * (owner decision 2026-10-13). Undefined when the floor has nothing to say.
   */
  private shellFloor(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, opts: { card?: boolean } = {}): Promise<{ allow: boolean; message?: string }> | undefined {
    if (!SHELL_TOOLS.has(toolName)) return undefined;
    const command = typeof input?.command === 'string' ? input.command : '';
    if (!command) return undefined;
    const kind = shellKindOf(toolName);
    let why: string | undefined;
    try {
      // a command too long to read is not read (that would hold up the core): it goes straight to the owner's card
      if (command.length <= MAX_READABLE) {
        const refused = refuseCatastrophic(command, kind);
        if (refused) return Promise.resolve({ allow: false, message: refused });
      }
      // the card is raised in one place per call: where the call is decided first (the ask-mode hook owns it for Claude's tools)
      if (opts.card === false) return undefined;
      why = unjudgeableCommand(command, kind);
    } catch {
      // fail closed: a floor that could not read the command asks the owner
      if (opts.card === false) return undefined;
      why = 'the safety check could not read it';
    }
    if (!why) return undefined;
    const mode = this.store.getAgent(agent.id)?.approval ?? agent.approval;
    if ((job.origin?.approvalCeiling ? stricterMode(mode, job.origin.approvalCeiling) : mode) === 'full') {
      return Promise.resolve({ allow: false, message: `Not run: Legion cannot read what this command will run (${why}), and with full access such a command is refused rather than asked about. Write it out plainly: name the program itself, not through a variable, a substitution or a pipe into a shell, and keep it under ${MAX_READABLE.toLocaleString('en-US')} characters. Then run it again. If it cannot be written plainly, do not look for another way around: tell the user what it was meant to do.` });
    }
    const o = job.origin;
    let timedOut = false;
    const shown = command.length > 1000 ? `${command.slice(0, 1000)}\n(${(command.length - 1000).toLocaleString('en-US')} more characters not shown here)` : command;
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: () => { timedOut = true; },
      noRemember: true,
      summary: `Legion cannot read what this command will run.\n${shown}\nWhy: ${why}.\nThe safety check cannot judge it by reading it, so you are asked in every approval mode. Allow it only if you know what it does.`,
    }).then((allowed) => {
      if (allowed) return { allow: true };
      const stop = 'Do not retry it, rephrase it or reach the same result another way. Stop, tell the user what the command was meant to do, and wait for their answer.';
      return { allow: false, message: timedOut ? `No one answered the approval request within ${this.approvals.timeoutWait}, so this command was not run (${why}). ${stop}` : `The user has not approved this command (${why}). ${stop}` };
    });
  }

  /**
   * The approval decision for one tool call, shared by the Claude path (canUseTool) and the provider path: effective mode (never looser
   * than the run's ceiling), then needsApproval, then a card the user answers (10 minutes, then denied).
   */
  private toolDecider(job: Job, agent: AgentProfile, opts: { egress?: boolean; /** false: the floor's card is raised by a hook for this path; only its refusals apply here. */ floorCard?: boolean } = {}): (toolName: string, input: Record<string, unknown>) => Promise<{ allow: boolean; message?: string }> {
    const ceiling = job.origin?.approvalCeiling;
    const effective = (): ApprovalMode => {
      const mode = this.store.getAgent(agent.id)?.approval ?? agent.approval;
      return ceiling ? stricterMode(mode, ceiling) : mode;
    };
    return async (toolName, input) => {
      // web egress after connector data: a card in every mode (maintainer decision 2026-10-07)
      // (no await when no card is due: the card of a normal tool must still be raised synchronously)
      const egress = opts.egress === false ? undefined : this.webEgressCard(job, agent, toolName, input);
      if (egress) return egress;
      const mode = effective();
      // Gate rules (Settings -> Gates) sit ahead of the approval baseline: deny wins outright (and survives full), an
      // explicit allow skips the card, an ask forces one (inert in full), and no rule falls through to the baseline.
      const gate = decideGate({ toolName, input, agentId: agent.id, cwd: this.gateCwd(agent, toolName), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, mode, job.origin?.approvalCeiling === 'ask');
      if (gate.verdict === 'deny') return { allow: false, message: 'Blocked by a gate rule (Settings -> Gates).' };
      // the shell floor sits ahead of allow rules and the baseline: an allow rule cannot pass a command nobody could read
      const floor = this.shellFloor(job, agent, toolName, input, { card: opts.floorCard !== false });
      if (floor) return floor;
      if (gate.verdict === 'allow') return { allow: true };
      if (gate.verdict !== 'ask' && !needsApproval(mode, toolName, { capped: job.origin?.approvalCeiling === 'ask' })) return { allow: true };
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

  /**
   * The spend cap for one run: a typed brief's budget when one asked for it, clamped so it is never above the owner's
   * claude.maxBudgetUsd (Fascia 3b). Absent both: undefined (no cap), exactly as before.
   */
  private perRunBudget(job: Job): number | undefined {
    return clampBudget(job.maxBudgetUsd, budgetCap(this.config.claude.maxBudgetUsd));
  }

  private buildOptions(job: Job, agent: AgentProfile, model: ConcreteModel, act: Active, prompt: string, resume?: string): Options {
    const cwd = agent.cwd || join(this.config.workspaceDir, agent.id);
    mkdirSync(cwd, { recursive: true });
    // the project (if any) adds text AFTER everything else and one extra folder: its own, and only its own
    const project = this.projectOf(job.taskId, agent.id);
    // in the project when it was queued, not any more when it starts (archived, deleted, member removed meanwhile)
    if (!project && job.projectAtStart && this.projects) this.noteProjectLost(job.taskId, job.projectAtStart, agent);
    let projectFolder: string | undefined;
    if (project) { try { mkdirSync(project.folder, { recursive: true }); projectFolder = project.folder; } catch { /* no folder this run: the instructions still apply */ } }
    const servers = this.buildMcpServers(agent, job, act);
    const skillSet = this.moduleSkills(agent);
    const allowSkillShell = this.skillShellAllowed();
    const maxBudgetUsd = this.perRunBudget(job);
    const options: Options = {
      model,
      cwd,
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: LEGION_PREAMBLE.replace('{name}', agent.name)
          + '\n\n' + renderTeamwork(servers)
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
      // Claude Code's own task list: 5.x models have it only when asked for. Naming the tools in allowedTools turns them on
      // (Claude Code CLI behaviour, verified live 2026-10-12; sdk.d.ts documents allowedTools only as auto-approval) and
      // auto-approves them, so a Gates rule for them does not apply — harmless: they are notes (READ_ONLY), never carded.
      // Off, the old TodoWrite goes too.
      ...(nativeTaskListOn(agent) ? { allowedTools: [...NATIVE_TASK_TOOLS] } : {}),
      disallowedTools: ['SendMessage', 'ListAgents', ...(nativeTaskListOn(agent) ? [] : [...NATIVE_TASK_TOOLS, 'TodoWrite']), ...this.moduleDisallowed(agent)],
      maxTurns: this.config.claude.maxTurns,
      // optional spend cap per run; a typed brief may ask for a lower one, clamped here, never above the owner's. On a resumed session it counts only the new spend.
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
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
    // a hook that awaits a card gets the card's own wait and a minute more: a hook timeout would stop the run, not deny the call
    const cardHookSeconds = this.approvals.timeoutSeconds + 60;
    if (agent.approval === 'full' && !(ceiling && ceiling !== 'full')) {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
      // bypass mode has no canUseTool: the web-egress card is raised from a PreToolUse hook instead (never both, so one card per call)
      options.hooks?.PreToolUse?.push({ matcher: 'WebFetch|WebSearch', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const d = await this.webEgressCard(job, agent, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        return d && !d.allow ? preToolDeny(d.message ?? 'The user denied this web request.') : { continue: true };
      }] });
      // The run started in full, but the owner may demote the agent while it works: bypass mode cannot be left, so this hook
      // re-reads the mode on every call and, once it is no longer full, decides the call as that mode would, card included.
      // (The web-egress card has its own hook above, so it is left out here: one card per call.)
      const demoted = this.toolDecider(job, agent, { egress: false });
      // deny rules survive Full (the one class meant to): a Block rule still stops the tool here, where canUseTool does not exist.
      options.hooks?.PreToolUse?.push({ matcher: '.*', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        if (effective() !== 'full') {
          const d = await demoted(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
          return d.allow ? { continue: true } : preToolDeny(d.message ?? 'The user denied this action.');
        }
        const g = decideGate({ toolName: input.tool_name, input: (input.tool_input ?? {}) as Record<string, unknown>, agentId: agent.id, cwd: this.gateCwd(agent, input.tool_name), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, 'full', false);
        if (g.verdict === 'deny') return preToolDeny('Blocked by a gate rule (Settings -> Gates).');
        // Full forgives the approval card, not the machine: the shell floor holds here too (Claude's own Bash included)
        const floor = this.shellFloor(job, agent, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        if (floor) { const d = await floor; return d.allow ? { continue: true } : preToolDeny(d.message ?? 'The user denied this action.'); }
        return { continue: true };
      }] });
    } else {
      options.permissionMode = 'default';
      // The shell floor as a hook too: Claude Code's own allow rules (inherited settings, `Bash(rm:*)`) decide a call before
      // canUseTool is asked, which would step around the floor. A Block gate still wins first; an approved floor card is
      // final for that call (no second, ordinary card).
      options.hooks?.PreToolUse?.push({ matcher: 'Bash|PowerShell|Monitor|mcp__host__shell', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const tin = (input.tool_input ?? {}) as Record<string, unknown>;
        const g = decideGate({ toolName: input.tool_name, input: tin, agentId: agent.id, cwd: this.gateCwd(agent, input.tool_name), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, effective(), job.origin?.approvalCeiling === 'ask');
        if (g.verdict === 'deny') return preToolDeny('Blocked by a gate rule (Settings -> Gates).');
        const floor = this.shellFloor(job, agent, input.tool_name, tin);
        if (!floor) return { continue: true };
        const d = await floor;
        return d.allow ? preToolAllow('The owner approved this command on its card.') : preToolDeny(d.message ?? 'The user denied this action.');
      }] });
      // the hook above owns the floor's card for Claude's shell tools, so it is not asked a second time here
      const decide = this.toolDecider(job, agent, { floorCard: false });
      options.canUseTool = async (toolName, input) => {
        const d = await decide(toolName, input);
        return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message ?? 'The user denied this action.' };
      };
    }
    // The task list reaches Claude's own list through the documented SessionStart hook only: shown again after Claude
    // compacts, and handed over when a provider run changed it or the session is new. An agent without the tools gets neither.
    if (nativeTaskListOn(agent)) {
      options.hooks!.SessionStart = [{ hooks: [async (input) => {
        if (input.hook_event_name !== 'SessionStart') return { continue: true };
        const list = this.taskLists.load(job.taskId);
        let text: string | undefined;
        if (input.source === 'compact') text = renderForModel(list);
        else if (list.handoverPending || (!resume && list.list().length > 0)) {
          // a list another model emptied still hands over: Claude's own list holds tasks that no longer exist
          text = renderHandover(list) ?? (list.handoverPending ? renderEmptyHandover() : undefined);
          if (text) {
            // Claude's first step (TaskList) replaces the mirror with its own, still-behind list: the handed-over list is
            // kept aside and put back unless the run finishes (settleHandover)
            act.handoverFrom ??= TaskList.fromJSON(JSON.parse(JSON.stringify(list)));
            // the run's mirror becomes the taken-over list (flag cleared, or its next mirrored Task call would write it back),
            // with done tasks carried under their own ids so Claude's TaskList does not drop them
            const taken = carryDone(list);
            taken.handoverPending = false;
            this.keepTaskList(job.taskId, act, taken);
          }
        }
        return text ? { hookSpecificOutput: { hookEventName: 'SessionStart' as const, additionalContext: text } } : { continue: true };
      }] }];
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
    const allServers = this.buildMcpServers(agent, job, act, 'provider');
    for (const [name, cfg] of Object.entries(allServers)) {
      if (cfg.type === 'sdk') servers[name] = cfg;
      else if (cfg.type === 'http' || cfg.type === 'sse') external[name] = { type: cfg.type, url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) };
      else if (cfg.type === 'stdio' || cfg.type === undefined) external[name] = { command: (cfg as { command: string }).command, ...((cfg as { args?: string[] }).args ? { args: (cfg as { args?: string[] }).args } : {}), ...((cfg as { env?: Record<string, string> }).env ? { env: (cfg as { env?: Record<string, string> }).env } : {}) };
    }
    const decide = this.toolDecider(job, agent);
    const projectHere = this.projectOf(taskId, agent.id);
    // in the project when it was queued, not any more when it starts: said in the thread, as on the Claude path
    if (!projectHere && job.projectAtStart && this.projects) this.noteProjectLost(taskId, job.projectAtStart, agent);
    const host: ProviderHost = {
      taskId, agentName: agent.name, signal: act.ac.signal, cancelled: () => act.cancelled || act.ac.signal.aborted,
      // the same teamwork and capabilities blocks as a Claude run, so an agent on another provider gets the same rules and tool facts
      systemPrompt: LEGION_PREAMBLE.replace('{name}', agent.name)
        + '\n\n' + renderTeamwork(allServers)
        + this.modulePreamble(agent, { prompt, taskId, ...(job.origin ? { origin: job.origin } : {}), tainted: act.tainted || job.origin?.tainted === true, ...(projectHere ? { projectId: projectHere.id } : {}) })
        + '\n\n' + renderCapabilities(agent, { servers: allServers, ...(job.origin?.approvalCeiling ? { ceiling: job.origin.approvalCeiling } : {}), vmEnabledForAgent: !!agent.vm?.enabled })
        + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : '')
        + (() => { const t = renderForModel(this.taskLists.load(taskId)); return t ? '\n\n' + t : ''; })()
        + `\n\nYou are running on ${pr.model} through ${pr.entry?.label ?? pr.providerId}. You have only the tools listed in this request; you have no file, shell or web tools of your own.`
        + (leadDoctrineFor(agent.id) ? '\n\n' + leadDoctrineFor(agent.id) : '')
        // the project's own rules and folder, last, as on the Claude path (council A5: provider runs had none)
        + (projectHere ? '\n\n' + projectSection({ name: projectHere.name, instructions: projectHere.instructions, folder: projectHere.folder }, { files: agent.host?.enabled === true }) : ''),
      prompt, stored: this.store.listMessages(taskId),
      taskListText: () => renderForModel(this.taskLists.load(taskId)),
      servers, external,
      authorize: decide,
      noteToolUse: (name, id, input) => this.noteToolUse(job, act, name, id, input),
      // the same live progress a Claude run sends: the turn against the provider loop's own limit, the tool it waits on, the task list
      onTurn: (turn, maxTurns) => {
        if (!act.progress) {
          act.progress = { startedAt: nowIso(), turn, maxTurns, tool: null, turnIds: new Set(), thinking: false };
          const list = this.taskLists.load(taskId);
          if (list.list().length) act.progress.todos = checklistOf(list);
        }
        act.progress.turn = turn;
        act.progress.tool = null;
        this.emitProgress(taskId, act);
      },
      onDelta: (text) => this.bus.emit({ type: 'message.delta', taskId, text }),
      onAssistantText: (text) => { this.addMessage(taskId, 'assistant', text); },
      onToolCall: (name, id, input) => {
        let json: string;
        try { json = JSON.stringify(input ?? {}); } catch { json = '{}'; }
        if (json.length > 500) json = json.slice(0, 499) + '…';
        this.addMessage(taskId, 'tool', json, name, undefined, { toolUseId: id });
        this.mascot('hacking', name);
        if (act.progress) { act.progress.tool = name; this.emitProgress(taskId, act); }
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
      ...(!r.isError && r.resultText !== undefined ? { result: this.keepResult(taskId, r.resultText) } : {}),
    });
    return { subtype: r.subtype, isError: r.isError, errorText: r.isError ? r.errorText : undefined };
  }

  /** One SDK query() run. Returns the outcome of its result message; throws on SDK failure. */
  private async runOnce(job: Job, agent: AgentProfile, model: ConcreteModel, prompt: string, act: Active): Promise<Outcome> {
    const pr = this.providers?.resolve(model);
    if (pr) return this.runProvider(job, agent, pr, prompt, act);
    // Never the Claude path: a `<id>:<model>` value whose provider resolves to nothing (no provider runtime at all,
    // a reserved id the config dropped, an id resolve() cannot parse) FAILS the way a preset-backed id with a
    // deleted entry already does (providers/runtime.ts:119) instead of being handed to the Claude SDK as a model
    // name. The owner must see "not set up any more", not a silent run on the wrong model. `arn:` is a Bedrock id
    // for the Claude path, never a provider (same exclusion as providerPrefix).
    const shaped = /^([A-Za-z][A-Za-z0-9-]{1,31}):/.exec(model);
    if (shaped && !/^arn:/i.test(model)) {
      return {
        subtype: 'error_during_execution', isError: true,
        errorText: `The provider "${shaped[1]}" is not set up any more. Choose another model for this agent in Settings, Providers.`,
      };
    }
    const resume = this.store.getTask(job.taskId)?.sessionId;
    const options = this.buildOptions(job, agent, model, act, prompt, resume);
    // Streaming input: the request is the first message of a stream the person can add to while the run works.
    const input = new InputChannel(prompt);
    act.input = input;
    const q = this.queryFn({ prompt: input, options });
    act.q = q;
    // each run counts its own turns (the limit is per run); the clock and the tool reset with it
    act.progress = { startedAt: nowIso(), turn: 0, maxTurns: this.config.claude.maxTurns, tool: null, turnIds: new Set(), thinking: false };
    // the task's list is kept across its runs, so a continued conversation shows its checklist from the start
    act.taskList = this.taskLists.load(job.taskId);
    act.taskCalls = new Map();
    if (act.taskList.list().length) act.progress.todos = checklistOf(act.taskList);
    this.emitProgress(job.taskId, act);

    const aborted = new Promise<'aborted'>((res) => {
      if (act.ac.signal.aborted) res('aborted');
      else act.ac.signal.addEventListener('abort', () => res('aborted'), { once: true });
    });
    const it = q[Symbol.asyncIterator]();
    let outcome: Outcome | undefined;
    // Background agents (Claude Code's own subagents) die with the run's input stream: closing it while they work kills them. So a
    // success result closes the input only when no background agent is running; otherwise the run is held open until they report.
    const bg = new BackgroundTasks();
    act.bg = bg;
    let lastActivity = this.bgNow();
    let held = false;
    // a turn (the model answering a notification) has started since the run was held: then only its result may close the run
    let turnStarted = false;
    const watchdog = setInterval(() => {
      if (input.isClosed) return;
      const quiet = this.bgNow() - lastActivity;
      if (act.bgStopsAt !== undefined && this.bgNow() >= act.bgStopsAt) {
        const n = bg.count;
        this.addMessage(job.taskId, 'system', `Legion stopped waiting for background agents after ${Math.round(this.bgMaxHeldMs / 60_000)} minutes${n ? `; the ${n} still running ${n === 1 ? 'was' : 'were'} stopped` : ''}. Ask again to start the work over.`);
        for (const id of bg.ids()) { try { void (q as any).stopTask?.(id)?.catch?.(() => undefined); } catch { /* ignore */ } }
        input.close();
      } else if (bg.count > 0 && quiet >= this.bgStallMs) {
        this.addMessage(job.taskId, 'system', `Legion stopped waiting for ${bg.count} background agent${bg.count === 1 ? '' : 's'}: nothing came from them for ${Math.round(this.bgStallMs / 60_000)} minutes. They end with this run; ask again to start them over.`);
        input.close();
      } else if (held && bg.count === 0 && !turnStarted && quiet >= this.bgGraceMs) {
        // the last background agent reported and no turn followed: nothing is left to wait for
        input.close();
      }
    }, Math.max(1, Math.min(1000, Math.floor(Math.min(this.bgStallMs, this.bgGraceMs) / 4))));
    watchdog.unref?.();
    try {
      for (;;) {
        const next = await Promise.race([it.next(), aborted]);
        if (next === 'aborted' || act.cancelled) return { subtype: 'cancelled', isError: false };
        if (next.done) break;
        lastActivity = this.bgNow();
        if (bg.note(next.value)) this.emitProgress(job.taskId, act);
        // only the run's own messages: a background agent's carry parent_tool_use_id and are not the model answering
        if (held && ['assistant', 'user', 'stream_event'].includes((next.value as any)?.type) && !(next.value as any)?.parent_tool_use_id) turnStarted = true;
        const o = this.handleMessage(job, act, next.value as any);
        // each result answers one message; once none are waiting the stream closes and the run ends, unless background agents still work
        if (o) {
          outcome = o;
          if (input.answered((next.value as any)?.queued_turn_count)) {
            if (o.isError || bg.count === 0) { held = false; act.bgStopsAt = undefined; input.close(); }
            else {
              turnStarted = false;
              if (!held) {
                held = true;
                act.bgStopsAt = this.bgNow() + this.bgMaxHeldMs;
                this.emitProgress(job.taskId, act);
                const n = bg.count;
                this.addMessage(job.taskId, 'system', `Waiting for ${n} background agent${n === 1 ? '' : 's'} to report before this run ends. Stop cancels them.`);
              }
            }
          }
        }
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
      clearInterval(watchdog);
      act.bg = undefined; act.bgStopsAt = undefined;
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
            else if (b?.type === 'tool_use' && CLAUDE_TASK_TOOLS.has(b.name) && typeof b.id === 'string') act.taskCalls?.set(b.id, { name: b.name, input: b.input });
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
        // the structured result belongs to the message's one tool result; with several it cannot be told apart, so the text is used
        const results = blocks.filter((b) => b?.type === 'tool_result');
        for (const b of blocks) {
          if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const raw = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '';
          const call = act.taskCalls?.get(b.tool_use_id);
          if (call && act.taskList) {
            act.taskCalls!.delete(b.tool_use_id);
            const next = mirrorClaudeTaskCall(act.taskList, call, { structured: results.length === 1 ? msg.tool_use_result : undefined, text: raw, isError: b.is_error === true });
            if (next) this.keepTaskList(taskId, act, next);
          }
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
        // total_cost_usd is the SESSION's running total (sdk.d.ts: "read the latest result rather than summing"; a resumed
        // session continues from its saved total): only the rise since this session's last result is new spend. Summing it
        // re-added a thread's whole history on every resumed run (measured 4.4x, up to 12.4x on long threads).
        const total = typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : undefined;
        const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined;
        const before = sid && cur?.costSessionId === sid ? (cur?.sessionCostUsd ?? 0) : 0;
        const spent = total === undefined ? 0 : total >= before ? total - before : total; // a lower total = the session's count restarted (/clear)
        this.patchTask(taskId, {
          costUsd: (cur?.costUsd ?? 0) + spent,
          ...(total !== undefined && sid ? { sessionCostUsd: total, costSessionId: sid } : {}),
          turns: (cur?.turns ?? 0) + (typeof msg.num_turns === 'number' ? msg.num_turns : 0),
          ...(typeof msg.session_id === 'string' && !cur?.sessionId ? { sessionId: msg.session_id } : {}),
          ...(!isError && text !== undefined ? { result: this.keepResult(taskId, text) } : {}),
        });
        return { subtype: String(msg.subtype), isError, errorText: isError ? text : undefined };
      }
      default:
        return undefined;
    }
  }
}
