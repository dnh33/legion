/** Runs agent tasks via the Claude Agent SDK. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile, ChatMessage, ConcreteModel, LegionConfig, MascotMood, MessageRole, ModelChoice, Task, TaskSource,
} from '../shared/types.js';
import { newId, nowIso, titleFrom } from '../shared/util.js';
import { scrubHostSessionEnv } from '../shared/config.js';
import { needsApproval } from './approvals.js';
import type { ApprovalBroker } from './approvals.js';
import type { EventBus } from './bus.js';
import { routeModel, shouldEscalate } from './router.js';
import type { Store } from './store.js';
import { buildAgentToolsServer } from './agent-tools.js';
import { Bridge } from './bridge.js';
import type { BridgeStartParams } from './bridge.js';
import type { VmManager } from './vm-manager.js';

export type QueryFn = typeof sdkQuery;

export interface EngineDeps {
  store: Store; bus: EventBus; vms: VmManager; approvals: ApprovalBroker; config: LegionConfig;
  /** Injected for tests; defaults to the real SDK query(). */
  queryFn?: QueryFn;
  /** Returns whether boat is configured (vm tools only offered when true). */
  boatConfigured: () => boolean;
  maxConcurrent?: number;
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

export class EngineError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'EngineError'; }
}

export const LEGION_PREAMBLE = [
  'You are {name}, an agent inside Legion, the user\'s personal multi-agent bot running on their own computer.',
  'Be direct and get the work done; report results concisely.',
  'Other Legion agents are reachable ONLY through mcp__legion__agents (list them), mcp__legion__ask and mcp__legion__tell.',
  'Use ask when you need the answer before you can continue; it blocks and returns their final message.',
  'Use tell for long or parallel work: it returns at once and their answer arrives later as a new message in your task.',
  'Do not use SendMessage or ListAgents; they do not reach Legion agents. Keep messages short and self-contained.',
  'You may have mcp__legion__vm_* tools (vm_start, vm_exec, vm_write_file, vm_read_file, vm_claude, vm_desktop, vm_stop)',
  'for an on-demand cloud VM that costs money while running. Start it only when needed',
  '(untrusted code, long jobs, GUI/browser work, heavy installs) and stop it with vm_stop when done.',
  'vm_claude hands a whole task to Claude Code inside the VM, which can also drive the VM desktop/browser.',
  'Treat desktop URLs as secrets and tell the user to open them.',
].join('\n');

/**
 * Child-process env. Built from process.env only; Legion never reads credential files.
 * claude-login: API key vars removed so the signed-in account is used. api-key: key from config.
 */
export function buildChildEnv(config: LegionConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = scrubHostSessionEnv({ ...process.env });
  if (config.claude.auth === 'api-key') {
    env.ANTHROPIC_API_KEY = config.claude.apiKey;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

interface Job {
  taskId: string; agentId: string; prompt: string; choice: ModelChoice; priorModel?: ConcreteModel;
  /** One-line bridge header prepended to what Claude sees (not stored). */
  header?: string;
  /** Set for bridge runs: the caller agent + task, for mascot note and cap bypass. */
  fromAgentId?: string; parentTaskId?: string;
}
interface Active { ac: AbortController; cancelled: boolean; q?: Query }
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
  private readonly queue: Job[] = [];
  private readonly active = new Map<string, Active>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly bridge: Bridge;

  constructor(deps: EngineDeps) {
    this.store = deps.store; this.bus = deps.bus; this.vms = deps.vms; this.approvals = deps.approvals;
    this.config = deps.config;
    this.queryFn = deps.queryFn ?? realQuery;
    this.boatConfigured = deps.boatConfigured;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 4);
    this.bridge = new Bridge({ store: this.store, bus: this.bus, engine: this });
  }

  startTask(p: BridgeStartParams): Task {
    const agent = this.store.getAgent(p.agentId);
    if (!agent) throw new EngineError(`Unknown agent: ${p.agentId}`, 404);
    const prompt = (p.prompt ?? '').trim();
    if (!prompt) throw new EngineError('Prompt is empty', 400);

    let task: Task;
    let priorModel: ConcreteModel | undefined;
    if (p.continueTaskId) {
      const prev = this.store.getTask(p.continueTaskId);
      if (!prev) throw new EngineError(`Unknown task: ${p.continueTaskId}`, 404);
      if (prev.status === 'queued' || prev.status === 'running') throw new EngineError('Task is still running', 409);
      if (prev.agentId !== agent.id) throw new EngineError('Task belongs to a different agent', 400);
      priorModel = prev.model;
      const viaBridge = p.bridge && !p.bridge.reply;
      task = this.saveTask({
        ...prev, status: 'queued', source: p.source, requestedModel: p.model ?? prev.requestedModel,
        result: undefined, error: undefined,
        ...(viaBridge ? { fromAgentId: p.bridge!.fromAgentId, parentTaskId: p.bridge!.parentTaskId } : {}),
        bridgeHop: p.bridge ? p.bridge.hop ?? 0 : undefined,
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
      });
    }
    this.addMessage(task.id, 'user', prompt, undefined, p.bridge?.fromAgentId);
    this.queue.push({
      taskId: task.id, agentId: agent.id, prompt, choice: task.requestedModel, priorModel,
      header: p.bridge?.header, fromAgentId: p.bridge?.fromAgentId, parentTaskId: p.bridge && !p.bridge.reply ? p.bridge.parentTaskId : undefined,
    });
    queueMicrotask(() => this.pump());
    return { ...task };
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
    const t = this.patchTask(taskId, { status: 'cancelled' });
    if (t) this.addMessage(taskId, 'system', 'Cancelled');
    this.mascot('idle', 'cancelled');
  }

  private startJob(job: Job): void {
    const act: Active = { ac: new AbortController(), cancelled: false };
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
      this.failTask(job.taskId, e);
    } finally {
      if (this.active.get(job.taskId) === act) this.active.delete(job.taskId);
      try { this.approvals.cancelForTask(job.taskId); } catch { /* ignore */ }
      if (this.active.size === 0 && this.queue.length === 0) this.scheduleIdle();
      this.pump();
    }
  }

  private failTask(taskId: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const cur = this.store.getTask(taskId);
      if (cur && cur.status === 'cancelled') return;
      this.patchTask(taskId, { status: 'error', error: msg });
      this.addMessage(taskId, 'system', `Error: ${msg}`);
    } catch { /* never crash */ }
    this.mascot('error', msg.slice(0, 120));
  }

  private async execute(job: Job, act: Active): Promise<void> {
    const agent = this.store.getAgent(job.agentId);
    if (!agent) throw new Error(`Agent ${job.agentId} no longer exists`);
    const decision = routeModel(job.prompt, job.choice, { priorModel: job.priorModel });
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
      model === 'sonnet' && !cur?.escalated && outcome.isError &&
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
      this.patchTask(job.taskId, { status: 'error', error: text });
      this.addMessage(job.taskId, 'system', `Error: ${text}`);
      this.mascot('error', text.slice(0, 120));
    } else {
      this.patchTask(job.taskId, { status: 'done' });
      this.mascot('success');
    }
  }

  private buildMcpServers(agent: AgentProfile, taskId: string): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    const wanted = agent.mcpServers ?? [];
    const all = wanted.includes('*');
    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      if (!all && !wanted.includes(name)) continue;
      if (entry.type === 'http') out[name] = { type: 'http', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else if (entry.type === 'sse') out[name] = { type: 'sse', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else out[name] = { type: 'stdio', command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
    }
    // Every agent gets the in-process `legion` server (bridge tools; plus vm_* when a VM is enabled).
    out.legion = buildAgentToolsServer({
      agentId: agent.id, taskId, vms: this.vms, bridge: this.bridge,
      vmEnabled: !!agent.vm?.enabled && this.boatConfigured(),
    });
    return out;
  }

  private buildOptions(job: Job, agent: AgentProfile, model: ConcreteModel, act: Active, resume?: string): Options {
    const cwd = agent.cwd || join(this.config.workspaceDir, agent.id);
    mkdirSync(cwd, { recursive: true });
    const options: Options = {
      model,
      cwd,
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: LEGION_PREAMBLE.replace('{name}', agent.name) + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : ''),
      },
      settingSources: this.config.claude.inheritClaudeCodeSettings ? ['user', 'project', 'local'] : [],
      mcpServers: this.buildMcpServers(agent, job.taskId),
      disallowedTools: ['SendMessage', 'ListAgents'],
      maxTurns: this.config.claude.maxTurns,
      includePartialMessages: true,
      abortController: act.ac,
      env: buildChildEnv(this.config),
    };
    if (resume) options.resume = resume;
    if (this.config.claude.executablePath) options.pathToClaudeCodeExecutable = this.config.claude.executablePath;
    if (agent.approval === 'full') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else {
      options.permissionMode = 'default';
      options.canUseTool = async (toolName, input) => {
        const mode = this.store.getAgent(agent.id)?.approval ?? agent.approval;
        if (!needsApproval(mode, toolName)) return { behavior: 'allow', updatedInput: input };
        const allowed = await this.approvals.request(job.taskId, agent.id, toolName, input);
        return allowed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user denied this action.' };
      };
    }
    return options;
  }

  /** One SDK query() run. Returns the outcome of its result message; throws on SDK failure. */
  private async runOnce(job: Job, agent: AgentProfile, model: ConcreteModel, prompt: string, act: Active): Promise<Outcome> {
    const resume = this.store.getTask(job.taskId)?.sessionId;
    const options = this.buildOptions(job, agent, model, act, resume);
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
        const o = this.handleMessage(job.taskId, next.value as any);
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

  /** Process one SDK message; returns an Outcome for `result` messages. */
  private handleMessage(taskId: string, msg: any): Outcome | undefined {
    switch (msg?.type) {
      case 'system': {
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          this.patchTask(taskId, { sessionId: msg.session_id });
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
