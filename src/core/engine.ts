/** Runs agent tasks via the Claude Agent SDK. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, Query, Settings, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile, ApprovalMode, ChatMessage, ConcreteModel, LegionConfig, MascotMood, MessageRole, ModelChoice, Task, TaskSource,
} from '../shared/types.js';
import { newId, nowIso, titleFrom } from '../shared/util.js';
import { scrubHostSessionEnv } from '../shared/config.js';
import { isLegionTool, needsApproval, stricterMode } from './approvals.js';
import { TaintedPaths } from './tainted-paths.js';
import type { CoreModule, ModuleJob, PreambleContext, TaskEndOutcome } from './modules.js';
import type { TaskOrigin } from '../shared/comms.js';
import type { ApprovalBroker } from './approvals.js';
import type { EventBus } from './bus.js';
import { modelRank, overrideAllowed, overrideRefusal, rankModel } from './model-cap.js';
import { routeModel, shouldEscalate } from './router.js';
import type { Store } from './store.js';
import { buildAgentToolsServer } from './agent-tools.js';
import { Bridge } from './bridge.js';
import type { BridgeStartParams } from './bridge.js';
import type { VmManager } from './vm-manager.js';
import { isSelfMcpUrl, McpStatusTracker, selfMcpNames } from './mcp-status.js';
import type { McpStatusView } from '../shared/types.js';

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
  // the agent's own plumbing: no network, no other server, nothing that carries someone else's text into the run
  'Skill', 'ToolSearch', 'AskUserQuestion', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
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
}
interface Outcome { subtype: string; isError: boolean; errorText?: string }

const IDLE_MASCOT_MS = 4000;

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

    // Confused-deputy rule: a run another agent starts through the bridge never gets looser
    // approvals than its caller (rooms set their own origin and take precedence).
    const origin = p.origin ?? this.bridgeOrigin(p) ?? this.mcpOrigin(p, p.continueTaskId ? this.store.getTask(p.continueTaskId) : undefined);
    // Taint follows the chain: a tainted waking bot, or a tainted peer's reply, taints this task for good.
    const tainted = !!p.tainted || !!origin?.tainted || (!!p.bridge?.reply && !!p.bridge.fromTaskId && this.isTainted(p.bridge.fromTaskId));

    const overriding = !!p.modelOverrideBy && !!p.model;
    if (overriding && !overrideAllowed(agent.model, p.model)) throw new EngineError(overrideRefusal(agent.name, agent.model, p.model!), 400);
    let task: Task;
    let priorModel: ConcreteModel | undefined;
    if (p.continueTaskId) {
      const prev = this.store.getTask(p.continueTaskId);
      if (!prev) throw new EngineError(`Unknown task: ${p.continueTaskId}`, 404);
      if (prev.status === 'queued' || prev.status === 'running') throw new EngineError('Task is still running', 409);
      if (prev.agentId !== agent.id) throw new EngineError('Task belongs to a different agent', 400);
      priorModel = prev.model;
      const viaBridge = p.bridge && !p.bridge.reply;
      // A model another bot chose lasts for that run only: a later message that asks for none (and is not a reply landing in the caller's own task) goes back to the agent's setting.
      const keepOverride = !!p.bridge?.reply;
      task = this.saveTask({
        ...prev, status: 'queued', source: p.source,
        requestedModel: p.model ?? (prev.modelOverride && !keepOverride ? agent.model : prev.requestedModel),
        modelOverride: overriding ? { model: p.model!, by: p.modelOverrideBy! } : keepOverride ? prev.modelOverride : undefined,
        result: undefined, error: undefined,
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
      task = this.saveTask({
        id: newId('task'), agentId: agent.id,
        title: p.bridge ? `${callerName}: ${base.replace(/\s+/g, ' ').trim().slice(0, 50)}` : titleFrom(base),
        status: 'queued', source: p.source,
        ...(p.bridge ? { fromAgentId: p.bridge.fromAgentId, parentTaskId: p.bridge.parentTaskId, bridgeHop: p.bridge.hop ?? 0 } : {}),
        requestedModel: p.model ?? agent.model, createdAt: now, updatedAt: now,
        ...(overriding ? { modelOverride: { model: p.model!, by: p.modelOverrideBy! } } : {}),
        ...(origin ? { origin } : {}),
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
   * A run started by a bearer-token client (Claude Code / Cowork / curl via MCP or POST /api/tasks without the admin header) is never
   * human-level: its approval is capped at `ask` whatever the agent is set to (a `full` agent runs in `default` mode with cards).
   * Only the Electron UI (admin) starts human runs. Continuing keeps what the task already had (room, hop, taint) and the stricter
   * of its earlier ceiling and `ask`, so a continue can never launder a ceiling away.
   */
  private mcpOrigin(p: BridgeStartParams, prev?: Task): TaskOrigin | undefined {
    if (p.source !== 'mcp') return undefined;
    if (prev?.origin) return { ...prev.origin, approvalCeiling: stricterMode(prev.origin.approvalCeiling, 'ask') };
    return { roomId: 'mcp', fromAgentId: 'mcp', hop: 0, approvalCeiling: 'ask' };
  }

  /** Origin (approval ceiling) for a task started by `ask`/`tell`. Replies go back to the caller's own task and add none. */
  private bridgeOrigin(p: BridgeStartParams): TaskOrigin | undefined {
    if (!p.bridge || p.bridge.reply) return undefined;
    const callerAgent = this.store.getAgent(p.bridge.fromAgentId);
    const callerTask = p.bridge.parentTaskId ? this.store.getTask(p.bridge.parentTaskId) : undefined;
    let ceiling: ApprovalMode = callerAgent?.approval ?? 'ask';
    if (callerTask?.origin) ceiling = stricterMode(ceiling, callerTask.origin.approvalCeiling);
    const tainted = !!callerTask?.origin?.tainted || (!!p.bridge.parentTaskId && this.isTainted(p.bridge.parentTaskId));
    return { roomId: 'agent-bridge', fromAgentId: p.bridge.fromAgentId, hop: p.bridge.hop ?? 1, approvalCeiling: ceiling, ...(tainted ? { tainted: true } : {}) };
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
    // A model a bot picked (per-task override, or a /opus prefix in a bot's message) never goes above the agent's own setting.
    const picked = this.store.getTask(job.taskId)?.modelOverride || (job.origin && decision.reason.startsWith('prefix'));
    if (picked && modelRank(decision.model) > modelRank(agent.model)) {
      const capped = rankModel(modelRank(agent.model));
      decision = { ...decision, model: capped, reason: `${decision.reason}, capped at ${capped} (${agent.name}'s own setting)` };
    }
    let model = decision.model;
    const first = this.patchTask(job.taskId, { status: 'running', model, error: undefined });
    if (!first) throw new Error('Task disappeared');
    const from = job.header && job.fromAgentId ? this.store.getAgent(job.fromAgentId) : undefined;
    this.mascot('thinking', from ? `${from.name} → ${agent.name}` : `${agent.name} on ${model}: ${decision.reason}`);
    const sendPrompt = (job.header ? job.header + '\n' : '') + decision.prompt;

    let outcome = await this.runOnce(job, agent, model, sendPrompt, act);
    if (act.cancelled) return;

    const cur = this.store.getTask(job.taskId);
    if (
      model === 'sonnet' && !cur?.escalated && outcome.isError && !(cur?.modelOverride && modelRank(agent.model) < 3) &&
      shouldEscalate({ model, subtype: outcome.subtype, isError: outcome.isError, errorText: outcome.errorText })
    ) {
      const reason = outcome.errorText ? `${outcome.subtype}: ${outcome.errorText.slice(0, 160)}` : outcome.subtype;
      model = 'opus';
      this.patchTask(job.taskId, { escalated: true, model });
      this.addMessage(job.taskId, 'system', `Escalated to Opus: ${reason}`);
      this.mascot('thinking', 'escalating to opus');
      outcome = await this.runOnce(job, agent, model, sendPrompt, act);
      if (act.cancelled) return;
    }

    if (outcome.isError) {
      const text = outcome.errorText || outcome.subtype;
      this.patchTask(job.taskId, { status: 'error', error: text, ...(act.tainted ? { tainted: true } : {}) });
      this.addMessage(job.taskId, 'system', `Error: ${text}`);
      this.mascot('error', text.slice(0, 120));
    } else {
      this.patchTask(job.taskId, { status: 'done', ...(act.tainted ? { tainted: true } : {}) });
      this.mascot('success');
    }
  }

  /** Read-only: the MCP servers the latest run saw and their state (Settings -> MCP). */
  mcpStatus(): McpStatusView { return this.mcpTracker.view(this.config); }

  private buildMcpServers(agent: AgentProfile, job: Job, act: Active): Record<string, McpServerConfig> {
    const taskId = job.taskId;
    const out: Record<string, McpServerConfig> = {};
    const wanted = agent.mcpServers ?? [];
    const all = wanted.includes('*');
    // A Settings entry that points back at Legion's own /mcp (hand-edited config) would connect an agent to its own Legion: skip it.
    const self = new Set(selfMcpNames(this.config));
    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      if (!all && !wanted.includes(name)) continue;
      if (self.has(name)) continue;
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
    };
    for (const m of this.modules) {
      try { Object.assign(out, m.mcpServers?.(agent, moduleJob) ?? {}); } catch { /* a broken module must not break runs */ }
    }
    return out;
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
    if (taintsRun(toolName)) act.tainted = true;
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

  private buildOptions(job: Job, agent: AgentProfile, model: ConcreteModel, act: Active, prompt: string, resume?: string): Options {
    const cwd = agent.cwd || join(this.config.workspaceDir, agent.id);
    mkdirSync(cwd, { recursive: true });
    const options: Options = {
      model,
      cwd,
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: LEGION_PREAMBLE.replace('{name}', agent.name)
          + this.modulePreamble(agent, { prompt, taskId: job.taskId, ...(job.origin ? { origin: job.origin } : {}), tainted: act.tainted || job.origin?.tainted === true })
          + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : ''),
      },
      settingSources: this.config.claude.inheritClaudeCodeSettings ? ['user', 'project', 'local'] : [],
      mcpServers: this.buildMcpServers(agent, job, act),
      // Off (default): only the servers above, asks the CLI to ignore user/project/local MCP config and plugins. claude.ai connectors are asked off in buildChildEnv and in `settings`.
      ...(this.config.claude.inheritMcp === true ? {} : { strictMcpConfig: true }),
      disallowedTools: ['SendMessage', 'ListAgents', ...this.moduleDisallowed(agent)],
      maxTurns: this.config.claude.maxTurns,
      includePartialMessages: true,
      abortController: act.ac,
      env: buildChildEnv(this.config),
      ...connectorSettings(this.config),
      // Runs before every tool executes (also in bypass mode), so taint is set before the tool can act on outside content.
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => {
            if (input.hook_event_name === 'PreToolUse') this.noteToolUse(job, act, input.tool_name, input.tool_use_id, input.tool_input);
            return { continue: true };
          }],
        }],
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
    } else {
      options.permissionMode = 'default';
      options.canUseTool = async (toolName, input) => {
        const mode = effective();
        if (!needsApproval(mode, toolName, { capped: job.origin?.approvalCeiling === 'ask' })) return { behavior: 'allow', updatedInput: input };
        const o = job.origin;
        let timedOut = false;
        const allowed = await this.approvals.request(
          job.taskId, agent.id, toolName, input,
          o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined,
          { onTimeout: () => { timedOut = true; } },
        );
        if (allowed) return { behavior: 'allow', updatedInput: input };
        // An MCP client started this run (Claude Code, Cowork) or woke it through a chain, so the ceiling is `ask`. Its card can only be answered in the Legion app window, so say so
        // instead of a bare denial when nobody answered (the app is closed, or this core was started headless by the MCP bridge).
        if (timedOut && o?.approvalCeiling === 'ask') {
          return { behavior: 'deny', message: 'No one approved this action: it needs your OK in the Legion app window and nothing was answered within 10 minutes. Open the Legion app, then ask for it again.' };
        }
        return { behavior: 'deny', message: 'The user denied this action.' };
      };
    }
    return options;
  }

  /** One SDK query() run. Returns the outcome of its result message; throws on SDK failure. */
  private async runOnce(job: Job, agent: AgentProfile, model: ConcreteModel, prompt: string, act: Active): Promise<Outcome> {
    const resume = this.store.getTask(job.taskId)?.sessionId;
    const options = this.buildOptions(job, agent, model, act, prompt, resume);
    const q = this.queryFn({ prompt, options });
    act.q = q;

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
        if (o) outcome = o;
      }
    } catch (e) {
      if (act.cancelled || act.ac.signal.aborted) return { subtype: 'cancelled', isError: false };
      const text = e instanceof Error ? e.message : String(e);
      if (!outcome) return { subtype: 'error_during_execution', isError: true, errorText: text };
      throw e;
    } finally {
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
          this.patchTask(taskId, { sessionId: msg.session_id });
          this.noteMcpInit(act, msg.mcp_servers);
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
        return undefined;
      }
      case 'assistant': {
        const blocks: any[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
        const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
        if (text) this.addMessage(taskId, 'assistant', text);
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
