/** Runs agent tasks via the Claude Agent SDK. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile, ApprovalMode, ChatMessage, ConcreteModel, LegionConfig, MascotMood, MessageRole, ModelChoice, Task, TaskSource,
} from '../shared/types.js';
import { newId, nowIso, titleFrom } from '../shared/util.js';
import { scrubHostSessionEnv } from '../shared/config.js';
import { needsApproval, stricterMode } from './approvals.js';
import type { CoreModule } from './modules.js';
import type { TaskOrigin } from '../shared/comms.js';
import type { ApprovalBroker } from './approvals.js';
import type { EventBus } from './bus.js';
import { routeModel, shouldEscalate } from './router.js';
import type { Store } from './store.js';
import { buildVmToolsServer } from './vm-tools.js';
import type { VmManager } from './vm-manager.js';

export type QueryFn = typeof sdkQuery;

export interface EngineDeps {
  store: Store; bus: EventBus; vms: VmManager; approvals: ApprovalBroker; config: LegionConfig;
  /** Injected for tests; defaults to the real SDK query(). */
  queryFn?: QueryFn;
  /** Returns whether boat is configured (vm tools only offered when true). */
  boatConfigured: () => boolean;
  maxConcurrent?: number;
  modules?: CoreModule[];
}

export class EngineError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'EngineError'; }
}

export const LEGION_PREAMBLE = [
  'You are {name}, an agent inside Legion, the user\'s personal multi-agent bot running on their own computer.',
  'Be direct and get the work done; report results concisely.',
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

interface Job { taskId: string; agentId: string; prompt: string; choice: ModelChoice; priorModel?: ConcreteModel; origin?: TaskOrigin }
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
  private modules: CoreModule[];

  constructor(deps: EngineDeps) {
    this.store = deps.store; this.bus = deps.bus; this.vms = deps.vms; this.approvals = deps.approvals;
    this.config = deps.config;
    this.queryFn = deps.queryFn ?? realQuery;
    this.boatConfigured = deps.boatConfigured;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 4);
    this.modules = deps.modules ?? [];
  }

  /** Modules are built after the engine (they need it), so they are attached here. */
  setModules(mods: CoreModule[]): void { this.modules = mods; }

  startTask(p: { agentId: string; prompt: string; source: TaskSource; model?: ModelChoice; continueTaskId?: string; origin?: TaskOrigin }): Task {
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
      task = this.saveTask({
        ...prev, status: 'queued', source: p.source, requestedModel: p.model ?? prev.requestedModel,
        result: undefined, error: undefined, origin: p.origin,
      });
    } else {
      const now = nowIso();
      task = this.saveTask({
        id: newId('task'), agentId: agent.id, title: titleFrom(prompt.replace(/^\s*\/(opus|sonnet)\b\s*/i, '') || prompt), status: 'queued', source: p.source,
        requestedModel: p.model ?? agent.model, createdAt: now, updatedAt: now,
        ...(p.origin ? { origin: p.origin } : {}),
      });
    }
    this.addMessage(task.id, 'user', prompt);
    this.queue.push({ taskId: task.id, agentId: agent.id, prompt, choice: task.requestedModel, priorModel, origin: p.origin });
    queueMicrotask(() => this.pump());
    return { ...task };
  }

  cancel(taskId: string): boolean {
    const qi = this.queue.findIndex((j) => j.taskId === taskId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.markCancelled(taskId);
      return true;
    }
    const a = this.active.get(taskId);
    if (!a || a.cancelled) return false;
    a.cancelled = true;
    this.markCancelled(taskId);
    this.approvals.cancelForTask(taskId);
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

  private addMessage(taskId: string, role: MessageRole, text: string, toolName?: string): ChatMessage {
    const m: ChatMessage = { id: newId('msg'), taskId, role, text, at: nowIso(), ...(toolName ? { toolName } : {}) };
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

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active.set(job.taskId, { ac: new AbortController(), cancelled: false });
      void this.runJob(job);
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      await this.execute(job);
    } catch (e) {
      this.failTask(job.taskId, e);
    } finally {
      this.active.delete(job.taskId);
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

  private async execute(job: Job): Promise<void> {
    const act = this.active.get(job.taskId)!;
    const agent = this.store.getAgent(job.agentId);
    if (!agent) throw new Error(`Agent ${job.agentId} no longer exists`);
    const decision = routeModel(job.prompt, job.choice, { priorModel: job.priorModel });
    let model = decision.model;
    const first = this.patchTask(job.taskId, { status: 'running', model, error: undefined });
    if (!first) throw new Error('Task disappeared');
    this.mascot('thinking', `${agent.name} on ${model}: ${decision.reason}`);

    let outcome = await this.runOnce(job, agent, model, decision.prompt, act);
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
      outcome = await this.runOnce(job, agent, model, decision.prompt, act);
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

  private buildMcpServers(agent: AgentProfile): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    const wanted = agent.mcpServers ?? [];
    const all = wanted.includes('*');
    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      if (!all && !wanted.includes(name)) continue;
      if (entry.type === 'http') out[name] = { type: 'http', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else if (entry.type === 'sse') out[name] = { type: 'sse', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else out[name] = { type: 'stdio', command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
    }
    if (agent.vm?.enabled && this.boatConfigured()) out.legion = buildVmToolsServer(agent.id, this.vms);
    for (const m of this.modules) {
      try { Object.assign(out, m.mcpServers?.(agent) ?? {}); } catch { /* a broken module must not break runs */ }
    }
    return out;
  }

  private modulePreamble(agent: AgentProfile): string {
    let out = '';
    for (const m of this.modules) {
      try { const t = m.preamble?.(agent); if (t) out += '\n\n' + t; } catch { /* ignore */ }
    }
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
        append: LEGION_PREAMBLE.replace('{name}', agent.name) + this.modulePreamble(agent) + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : ''),
      },
      settingSources: this.config.claude.inheritClaudeCodeSettings ? ['user', 'project', 'local'] : [],
      mcpServers: this.buildMcpServers(agent),
      maxTurns: this.config.claude.maxTurns,
      includePartialMessages: true,
      abortController: act.ac,
      env: buildChildEnv(this.config),
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
        if (!needsApproval(mode, toolName)) return { behavior: 'allow', updatedInput: input };
        const o = job.origin;
        const allowed = await this.approvals.request(
          job.taskId, agent.id, toolName, input,
          o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined,
        );
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
          this.addMessage(taskId, 'tool', json, String(b.name ?? 'tool'));
          this.mascot('hacking', String(b.name ?? ''));
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
