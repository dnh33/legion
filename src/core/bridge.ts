/** Agent-to-agent bridge: lets any Legion agent message any other agent (ask = wait, tell = async reply). */
import { randomUUID } from 'node:crypto';
import { overrideAllowed, overrideRefusal } from './model-cap.js';
import type { AgentProfile, Catalog, ModelChoice, Task, TaskSource } from '../shared/types.js';
import type { TaskOrigin } from '../shared/comms.js';
import type { EventBus } from './bus.js';
import type { Store } from './store.js';

export const MAX_DEPTH = 3;
export const MAX_HOP = 6;
export const RESULT_MAX_CHARS = 4000;
export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** The per-task model a lead may ask for through `ask`, `tell`, `bot_send` and `room_post`. */
export const OVERRIDE_MODELS = ['sonnet', 'opus', 'haiku', 'auto'] as const;
const clampTimeout = (v: unknown, def = 600) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(3600, Math.max(1, v)) : def);

export interface BridgeStartParams {
  agentId: string; prompt: string; source: TaskSource; model?: ModelChoice; continueTaskId?: string;
  /** Set by the rooms module: approval ceiling inherited from the waking bot. */
  origin?: TaskOrigin;
  /** Set with `model` when another bot chose the model for this run only (`ask`/`tell`, room messages). The engine records it on the task and drops it at the next message that asks for none. */
  modelOverrideBy?: string;
  /** The prompt carries text from a tainted source (for example room history written by a tainted bot): the task starts tainted. */
  tainted?: boolean;
  /**
   * The project of the task, when the caller may name one: the app (source 'ui') and a room's own wake (source 'bot'). `null` clears it.
   * Every other source (MCP, ask/tell, cli) is ignored here: a bridge run inherits its caller's project inside the engine, only for members.
   */
  projectId?: string | null;
  /** `fromTaskId` (replies only) is the task whose result this message carries, so its taint can follow it. */
  bridge?: { fromAgentId: string; parentTaskId?: string; header?: string; reply?: boolean; hop?: number; fromTaskId?: string };
}
/** The slice of Engine the bridge needs. */
export interface BridgeEngine {
  startTask(p: BridgeStartParams): Task;
  cancel(taskId: string): boolean;
  /** Whether a task has touched outside content. Optional so test doubles need not implement it. */
  isTainted?(taskId: string): boolean;
  /** Marks a live or stored task tainted (a tainted peer's result just reached it). */
  markTainted?(taskId: string): void;
}

export class BridgeError extends Error {
  constructor(message: string) { super(message); this.name = 'BridgeError'; }
}

interface QueueItem {
  message: string;
  /** Who is speaking (for the header / fromAgentId). */
  fromAgentId: string;
  parentTaskId?: string;
  reply: boolean;
  /** Replies: the task whose result this carries (taint follows it). */
  fromTaskId?: string;
  /** Bridge hop of the run this message starts (caller's hop + 1). */
  hop: number;
  /** Model the caller asked for, for this message's run only. */
  model?: ModelChoice;
  /** Called with the final task when this item's own run ends; or with an error if it could not start. */
  settle?: (r: { task?: Task; error?: Error }) => void;
}

const isLive = (t: Task) => t.status === 'queued' || t.status === 'running';
const truncate = (s: string, n = RESULT_MAX_CHARS) => (s.length <= n ? s : `${s.slice(0, n)}\n[truncated: ${s.length - n} more chars]`);

export class Bridge {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly engine: BridgeEngine;
  /** FIFO of messages waiting for a busy task to finish. */
  private readonly queues = new Map<string, QueueItem[]>();
  /** Tasks currently blocked inside an `ask` call. */
  private readonly waiting = new Map<string, number>();
  /** caller task -> target tasks of its pending asks. */
  private readonly pendingAsks = new Map<string, Set<string>>();
  /** task id -> finish listeners. */
  private readonly finishers = new Map<string, Set<(t: Task | undefined) => void>>();
  /** `from>to` -> delivery timestamps (rate limit). */
  private readonly deliveries = new Map<string, number[]>();
  private readonly now: () => number;
  /** Hides agents that are switched off (e.g. `requires: 'bsv'` while BSV mode is off). Set by the composition root. */
  isVisible: (a: AgentProfile) => boolean = () => true;
  /** The account's model catalog (cached, probed without a model call). Set by the composition root; without it only the alias list limits `model`. */
  catalog?: () => Promise<Catalog>;

  constructor(deps: { store: Store; bus: EventBus; engine: BridgeEngine; now?: () => number }) {
    this.store = deps.store; this.bus = deps.bus; this.engine = deps.engine;
    this.now = deps.now ?? Date.now;
    this.bus.on((ev) => {
      if (ev.type === 'task.deleted') { this.forget(ev.taskId); return; }
      if (ev.type !== 'task.updated' || isLive(ev.task)) return;
      const fs = this.finishers.get(ev.task.id);
      if (fs) { this.finishers.delete(ev.task.id); for (const f of fs) f(ev.task); }
      this.drain(ev.task.id);
    });
  }

  // ---------------------------------------------------------------- tools

  /** Compact roster for the `agents` tool: one line per other agent. */
  list(callerAgentId: string): string {
    const lines: string[] = [];
    for (const a of this.store.listAgents().filter((x) => this.isVisible(x))) {
      if (a.id === callerAgentId) continue;
      const tasks = this.store.listTasks(500, a.id, true);
      const status = tasks.some((t) => t.status === 'running') ? 'working' : tasks.some((t) => t.status === 'queued') ? 'queued' : 'idle';
      const thread = this.findPair(callerAgentId, a.id) ? 'thread' : 'no-thread';
      lines.push(`${a.id} | ${a.name} | ${a.description.slice(0, 80)} | ${status} | ${thread}`);
    }
    return lines.length ? lines.join('\n') : 'No other agents.';
  }

  /**
   * Validates a lead's per-task model: one of sonnet, opus, haiku, auto (case and padding forgiven), and, when the catalog can be
   * read, one the account offers. An unreadable catalog never vetoes. Returns the normalised alias, or undefined for none.
   */
  async resolveModel(v: unknown): Promise<ModelChoice | undefined> {
    const m = this.normaliseModel(v);
    if (m === undefined) return undefined;
    if (m === 'auto' || !this.catalog) return m;
    let c: Catalog | undefined;
    try { c = await this.catalog(); } catch { return m; }
    if (!c || c.error || c.models.length === 0) return m;
    if (!c.models.some((x) => [x.value, x.displayName, x.resolvedModel ?? ''].some((s) => s.toLowerCase().includes(m)))) {
      throw new BridgeError(`Model "${m}" is not offered on this account (available: ${c.models.map((x) => x.value).join(', ')}).`);
    }
    return m;
  }

  /** One home for the override-model validation: undefined/null → undefined, else the trimmed lowercase alias that must be in OVERRIDE_MODELS. */
  private normaliseModel(v: unknown): ModelChoice | undefined {
    if (v === undefined || v === null) return undefined;
    const m = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!(OVERRIDE_MODELS as readonly string[]).includes(m)) throw new BridgeError(`model must be one of: ${OVERRIDE_MODELS.join(', ')}`);
    return m;
  }

  /** The synchronous half of resolveModel, for callers that cannot await (Bridge.ask/tell guard themselves with it). */
  private checkModel(v: unknown): ModelChoice | undefined {
    return this.normaliseModel(v);
  }

  /**
   * A per-task model is capped at the target agent's own setting (see model-cap.ts): a lead cannot upgrade a peer to something
   * dearer than its owner chose.
   *
   * Owner decision 2026-10-03 (after Zealot's report that a lead silently discarded the owner's fixed model for an agent):
   * the ceiling STAYS as it is — upgrades refused, downgrades allowed — but every decision it reaches is now REPORTED.
   * `notice` is a human-readable line describing what happened, returned so the caller can surface it; it is produced whether
   * the override was applied, silently redundant, or refused. No override is ever silent again.
   *
   * NOTE on the ceiling's limits (deliberately not overclaimed): modelRank is a three-bucket guess (opus=3, haiku=1,
   * everything else=2), so a model it cannot place is treated as mid-tier and passes. It is a cost/allocation guard for the
   * three aliases Legion knows, NOT a general security boundary, and this function does not pretend otherwise.
   */
  private checkCeiling(target: AgentProfile, model: ModelChoice | undefined): string | undefined {
    if (!model) return undefined;
    if (!overrideAllowed(target.model, model)) throw new BridgeError(overrideRefusal(target.name, target.model, model));
    const configured = target.model;
    if (!configured || configured.toLowerCase() === model.toLowerCase()) return undefined; // nothing overridden
    return `Model override: ${target.name} is configured for ${configured}, but this task runs on ${model}. The agent keeps its configured model for every other task.`;
  }

  async ask(callerTaskId: string, agentRef: string, message: string, opts: { fresh?: boolean; timeoutSeconds?: number; model?: ModelChoice } = {}) {
    const model = this.checkModel(opts.model);
    const { caller, target, hop } = this.resolve(callerTaskId, agentRef, message, 'ask');
    const modelNotice = this.checkCeiling(target, model);
    if (modelNotice) this.noteOverride(callerTaskId, target, model!, target.model);
    const { taskId, done } = this.deliver(caller, target, message, !!opts.fresh, hop, model);
    this.waiting.set(callerTaskId, (this.waiting.get(callerTaskId) ?? 0) + 1);
    let set = this.pendingAsks.get(callerTaskId);
    if (!set) { set = new Set(); this.pendingAsks.set(callerTaskId, set); }
    set.add(taskId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = clampTimeout(opts.timeoutSeconds) * 1000;
      const r = await Promise.race([
        done,
        new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), timeoutMs); }),
      ]);
      if (r === 'timeout') {
        const t = this.store.getTask(taskId);
        return { taskId, status: t?.status ?? 'running', note: `Still working; use ask again later or tell. Timed out after ${Math.round(timeoutMs / 1000)}s.` };
      }
      if (r.error) throw r.error;
      const t = r.task ?? this.store.getTask(taskId);
      if (!t) throw new BridgeError('The target task no longer exists');
      const text = t.status === 'done' ? (t.result ?? '') : (t.error ?? t.status);
      // the answer comes back into the caller's context: a tainted answer taints the caller
      if (this.engine.isTainted?.(t.id)) this.engine.markTainted?.(callerTaskId);
      return { taskId, status: t.status, model: t.model, result: truncate(text) };
    } finally {
      if (timer) clearTimeout(timer);
      const left = (this.waiting.get(callerTaskId) ?? 1) - 1;
      if (left <= 0) this.waiting.delete(callerTaskId); else this.waiting.set(callerTaskId, left);
      set.delete(taskId);
      if (set.size === 0) this.pendingAsks.delete(callerTaskId);
    }
  }

  tell(callerTaskId: string, agentRef: string, message: string, opts: { fresh?: boolean; model?: ModelChoice } = {}): { taskId: string } {
    const model = this.checkModel(opts.model);
    const { caller, target, hop } = this.resolve(callerTaskId, agentRef, message, 'tell');
    const modelNotice = this.checkCeiling(target, model);
    if (modelNotice) this.noteOverride(callerTaskId, target, model!, target.model);
    const { taskId, done } = this.deliver(caller, target, message, !!opts.fresh, hop, model);
    void done.then((r) => {
      const t = r.task ?? this.store.getTask(taskId);
      const body = r.error ? `(failed) ${r.error.message}` : t?.status === 'done' ? (t.result ?? '') : `(${t?.status ?? 'gone'}) ${t?.error ?? ''}`.trim();
      // the outcome travels in the header, which only Legion writes: a free-text answer that happens to start with
      // "(error)" is still an answer (review of 0.2.5-f)
      const outcome = r.error ? 'failed' : t?.status === 'done' ? undefined : (t?.status ?? 'gone');
      this.deliverReply(callerTaskId, target, taskId, truncate(body), outcome);
    });
    return { taskId };
  }

  /** The caller task was cancelled: cancel what it was waiting on and drop its queued messages. */
  cancelFor(callerTaskId: string): void {
    for (const [tid, q] of this.queues) {
      const keep = q.filter((i) => {
        if (i.parentTaskId !== callerTaskId || i.reply) return true;
        i.settle?.({ error: new BridgeError('Cancelled') });
        return false;
      });
      if (keep.length) this.queues.set(tid, keep); else this.queues.delete(tid);
    }
    for (const tid of [...(this.pendingAsks.get(callerTaskId) ?? [])]) {
      const t = this.store.getTask(tid);
      if (t && isLive(t)) this.engine.cancel(tid);
    }
  }

  // ---------------------------------------------------------------- internals

  private resolve(callerTaskId: string, agentRef: string, message: string, mode: 'ask' | 'tell'): { caller: Task; target: AgentProfile; hop: number } {
    const caller = this.store.getTask(callerTaskId);
    if (!caller) throw new BridgeError('Unknown caller task');
    if (!message?.trim()) throw new BridgeError('message is empty');
    const ref = String(agentRef ?? '').trim().toLowerCase();
    const agents = this.store.listAgents().filter((x) => this.isVisible(x));
    const target = agents.find((a) => a.id.toLowerCase() === ref) ?? agents.find((a) => a.name.toLowerCase() === ref);
    if (!target) throw new BridgeError(`Unknown agent "${agentRef}". Available: ${agents.filter((a) => a.id !== caller.agentId).map((a) => a.id).join(', ') || 'none'}`);
    if (target.id === caller.agentId) throw new BridgeError('You cannot message yourself');

    // Ancestors of the caller (by parentTaskId), nearest first.
    const chain: Task[] = [];
    const seen = new Set<string>([caller.id]);
    for (let p = caller.parentTaskId; p && !seen.has(p) && chain.length < 16;) {
      const t = this.store.getTask(p);
      if (!t) break;
      seen.add(p); chain.push(t); p = t.parentTaskId;
    }
    if (chain.length + 1 > MAX_DEPTH) throw new BridgeError(`delegation too deep (max ${MAX_DEPTH})`);
    if (mode === 'ask' && chain.some((t) => t.agentId === target.id && this.waiting.has(t.id))) {
      throw new BridgeError(`would deadlock: ${target.name} is waiting on this chain. Use tell instead.`);
    }
    const hop = (caller.bridgeHop ?? 0) + 1;
    if (hop > MAX_HOP) throw new BridgeError(`Bridge hop limit reached (${MAX_HOP}). Finish the work yourself or ask the user.`);
    const key = `${caller.agentId}>${target.id}`;
    const t = this.now();
    const recent = (this.deliveries.get(key) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      this.deliveries.set(key, recent);
      throw new BridgeError(`Rate limit: more than ${RATE_LIMIT} messages from ${caller.agentId} to ${target.id} in 10 minutes. Finish the work yourself or ask the user.`);
    }
    recent.push(t);
    this.deliveries.set(key, recent);
    return { caller, target, hop };
  }

  /** A task was deleted: drop its queued messages and wake anyone waiting on it. */
  forget(taskId: string): void {
    const q = this.queues.get(taskId);
    this.queues.delete(taskId);
    for (const i of q ?? []) i.settle?.({ error: new BridgeError('The target task was deleted') });
    const fs = this.finishers.get(taskId);
    this.finishers.delete(taskId);
    for (const f of fs ?? []) f(undefined);
  }

  /** Latest bridge task from `from` to `to`, if any (archived ones count so a new thread is made instead). */
  /**
   * The pair thread `from` -> `to`: the newest task of `to` that `from` delivered an ask or tell into. Keyed on `fromAgentId`, which only
   * the bridge writes (Engine.startTask, for a bridge request), and never on `source`: `source` records who sent the latest turn, so an
   * owner typing into the thread turns it into 'ui', and matching on it lost the thread and made the next ask start a new, cold session
   * (measured twice in claude/investigation-cost-bridge.md, section 5.3).
   */
  private findPair(from: string, to: string): Task | undefined {
    return this.store.listTasks(500, to, true).find((t) => t.fromAgentId === from);
  }

  private awaitFinish(taskId: string): Promise<Task | undefined> {
    return new Promise((resolve) => {
      let set = this.finishers.get(taskId);
      if (!set) { set = new Set(); this.finishers.set(taskId, set); }
      set.add(resolve);
    });
  }

  /** Deliver a message to the pair thread (or a new task). `done` resolves when THIS message's run has finished. */
  private deliver(caller: Task, target: AgentProfile, message: string, fresh: boolean, hop: number, model?: ModelChoice): { taskId: string; done: Promise<{ task?: Task; error?: Error }> } {
    const thread = fresh ? undefined : this.findPair(caller.agentId, target.id);
    const item: QueueItem = { message, fromAgentId: caller.agentId, parentTaskId: caller.id, reply: false, hop, ...(model ? { model } : {}) };
    if (thread && !thread.archived && isLive(thread)) {
      const done = new Promise<{ task?: Task; error?: Error }>((res) => { item.settle = res; });
      this.enqueue(thread.id, item);
      return { taskId: thread.id, done };
    }
    const cont = thread && !thread.archived ? thread.id : undefined;
    const started = this.start(target.id, item, cont, cont ? thread!.source : 'agent');
    return { taskId: started.id, done: this.awaitFinish(started.id).then((task) => ({ task })) };
  }

  private start(agentId: string, item: QueueItem, continueTaskId: string | undefined, source: TaskSource): Task {
    const caller = this.store.getAgent(item.fromAgentId);
    const header = item.reply ? undefined
      : `[From ${caller?.name ?? item.fromAgentId} (Legion agent) via the bridge. Reply with just what they need; your final message is returned to them.]`;
    return this.engine.startTask({
      agentId, prompt: item.message, source, continueTaskId,
      ...(item.model ? { model: item.model, modelOverrideBy: item.fromAgentId } : {}),
      bridge: { fromAgentId: item.fromAgentId, parentTaskId: item.parentTaskId, header, reply: item.reply, hop: item.hop, ...(item.fromTaskId ? { fromTaskId: item.fromTaskId } : {}) },
    });
  }

  private enqueue(taskId: string, item: QueueItem): void {
    const q = this.queues.get(taskId) ?? [];
    q.push(item);
    this.queues.set(taskId, q);
  }

  /** The task just finished: start its next queued message, if any. */
  private drain(taskId: string): void {
    const q = this.queues.get(taskId);
    if (!q?.length) return;
    const item = q.shift()!;
    if (!q.length) this.queues.delete(taskId);
    const task = this.store.getTask(taskId);
    if (!task || (item.reply && task.status === 'cancelled')) {
      item.settle?.({ error: new BridgeError('The target task no longer exists') });
      return this.drain(taskId);
    }
    try {
      const started = this.start(task.agentId, item, taskId, task.source);
      if (item.settle) { const s = item.settle; void this.awaitFinish(started.id).then((t) => s({ task: t })); }
    } catch (e) {
      item.settle?.({ error: e instanceof Error ? e : new Error(String(e)) });
      this.drain(taskId);
    }
  }

  /**
   * Record an override in the caller's transcript so the owner can SEE it (Zealot's report: a lead discarded the owner's fixed
   * model with no trace). This appends a message to the caller's thread — it does NOT deliver a reply and does NOT start a
   * run, which is what deliverReply would do (it is for agent-to-agent answers, and using it here queued a second task and
   * broke the ask's own result).
   */
  private noteOverride(callerTaskId: string, target: AgentProfile, model: ModelChoice, configured: string | undefined): void {
    const caller = this.store.getTask(callerTaskId);
    if (!caller || caller.status === 'cancelled') return;
    const text = `Model override: ${target.name} is set to ${configured ?? 'its default'} in your configuration, but this one task runs on ${model}. Other tasks are unaffected.`;
    try {
      // a Legion notice (role 'system', no fromAgentId): not a message FROM the target, and a provider-backed caller does not replay it as a user turn
      this.store.addMessage({ id: randomUUID(), taskId: callerTaskId, role: 'system', text, at: new Date().toISOString() });
      this.bus?.emit?.({ type: 'task.updated', task: caller });
    } catch { /* the notice must never break the call */ }
  }

  /** Async reply from a `tell`: becomes a new user turn in the caller's task (queued if it is running). */
  private deliverReply(callerTaskId: string, from: AgentProfile, fromTaskId: string, body: string, outcome?: string): void {
    const caller = this.store.getTask(callerTaskId);
    if (!caller || caller.status === 'cancelled') return;
    const hop = (this.store.getTask(fromTaskId)?.bridgeHop ?? 0) + 1;
    if (hop > MAX_HOP) return; // loop guard: stop delivering replies deep in a chain
    const item: QueueItem = { message: `[Reply from ${from.name} · task ${fromTaskId}${outcome ? ` · ${outcome}` : ''}] ${body}`, fromAgentId: from.id, reply: true, hop, fromTaskId };
    if (isLive(caller)) { this.enqueue(caller.id, item); return; }
    try { this.start(caller.agentId, item, caller.id, caller.source); } catch { /* caller agent gone: drop */ }
  }
}
