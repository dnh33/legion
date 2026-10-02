/** Per-agent on-demand VM lifecycle. */
import type { ConcreteModel, LegionConfig, VmRecord, VmSize, VmState, VmStopResult, VmUsage } from '../shared/types.js';
import { sleep } from '../shared/util.js';
import { closeRun, createUsageMemo } from '../shared/vm-usage.js';
import { BOAT_CODE, BoatError, type BoatClient, type BoatSandbox, type ExecResult } from './boat.js';
import { BoatHealth, CLAUDE_NOT_CONFIGURED, TRIAL_NOTE } from './boat-health.js';
import type { EventBus } from './bus.js';
import type { Store } from './store.js';

export class VmError extends Error {
  constructor(message: string, public readonly code: 'not_configured' | 'disabled' | 'not_running' | 'boat' | 'unknown_agent' | 'claude_not_configured') { super(message); this.name = 'VmError'; }
}

export interface VmManagerDeps {
  store: Store; bus: EventBus; getBoat: () => BoatClient | null; now?: () => number;
  /** Shared key/account knowledge. Created internally when omitted. */
  health?: BoatHealth;
  /** Live config.boat (hourly rates for usage estimates). */
  boatConfig?: () => LegionConfig['boat'] | undefined;
  /** How often and how many times stop() asks boat.dev whether the snapshot finished (default 1000 ms, 20 times). Tests shrink it. */
  stopPollMs?: number;
  stopPollTries?: number;
}

const VM_SIZES: ReadonlySet<string> = new Set(['small', 'default', 'large']);

const LIVE_STATES: ReadonlySet<VmState> = new Set(['ready', 'idle', 'running']);

/** Map a boat.dev sandbox state to Legion's VmState. */
export function mapBoatState(s: string): VmState {
  switch (s) {
    case 'init': case 'provisioning': case 'provisioned': case 'cloning': return 'provisioning';
    case 'ready': return 'ready';
    case 'idle': return 'idle';
    case 'running': return 'running';
    case 'archiving': return 'archiving';
    case 'archived': return 'archived';
    default: return 'error'; // 'error', 'cancelled', unknown
  }
}

export class VmManager {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly getBoat: () => BoatClient | null;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<VmRecord>>();
  private readonly conversations = new Map<string, { sandboxId: string; conversationId: string }>();
  /** Per-agent queue: a start, a stop and a later start never overlap, so a stop cannot misjudge a start that is still in flight. */
  private readonly tail = new Map<string, Promise<void>>();
  private readonly usageMemo = createUsageMemo();
  private readonly stopPollMs: number;
  private readonly stopPollTries: number;
  readonly health: BoatHealth;

  constructor(deps: VmManagerDeps) {
    this.stopPollMs = deps.stopPollMs ?? 1000;
    this.stopPollTries = deps.stopPollTries ?? 20;
    this.store = deps.store;
    this.bus = deps.bus;
    this.getBoat = deps.getBoat;
    this.now = deps.now ?? Date.now;
    this.health = deps.health ?? new BoatHealth({ getBoat: deps.getBoat, bus: deps.bus, boatConfig: deps.boatConfig, now: this.now });
  }

  status(agentId: string): VmRecord { return this.store.getVm(agentId); }

  /** Runtime counters for this agent's VM (Legion-measured uptime; an estimate in money only when a rate is configured). */
  usage(agentId: string): VmUsage {
    const { rates, currency } = this.health.rates(); // read live from the config on every call: never a cached copy
    return this.usageMemo(this.store.getVm(agentId), this.now(), rates, currency);
  }

  /** False while Claude is known not to be set up on boat.dev: the vm_claude tool is left out of the agent's tool list. */
  claudeAvailable(): boolean { return !this.health.claudeMissing(); }

  /** Create (ttl = idleStopMinutes*60+900 s safety net) or resume, wait until ready, touch. Concurrent calls for the same agent share one promise. */
  ensureRunning(agentId: string): Promise<VmRecord> {
    const existing = this.inflight.get(agentId);
    if (existing) return existing;
    const p: Promise<VmRecord> = this.enqueue(agentId, () => this.doEnsure(agentId)).finally(() => { if (this.inflight.get(agentId) === p) this.inflight.delete(agentId); });
    this.inflight.set(agentId, p);
    return p;
  }

  /** Runs `fn` after everything already queued for this agent (a failure of an earlier step does not stop the queue). */
  private enqueue<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tail.get(agentId) ?? Promise.resolve();
    const run = prev.then(fn);
    const t = run.then(() => undefined, () => undefined);
    this.tail.set(agentId, t);
    void t.then(() => { if (this.tail.get(agentId) === t) this.tail.delete(agentId); });
    return run;
  }

  /**
   * Stop and snapshot. Queued behind any start or stop already in flight for this agent, so it never declares "already stopped" or
   * "nothing to stop" while a start is still creating the VM. With nothing to stop this is a plain "nothing to stop" result, never an
   * error state. After the request it asks boat.dev what state the VM is really in and reports that.
   */
  stop(agentId: string): Promise<VmStopResult> {
    this.inflight.delete(agentId); // a start requested from now on waits behind this stop instead of joining an earlier start
    return this.enqueue(agentId, () => this.doStop(agentId));
  }

  private async doStop(agentId: string): Promise<VmStopResult> {
    const boat = this.requireBoat();
    let rec = this.store.getVm(agentId);
    const done = (stopped: boolean, message: string, vm: VmRecord, verified = true): VmStopResult => ({ ok: true, stopped, verified, message, vm, usage: this.usage(agentId) });
    if (!rec.sandboxId) {
      const hadFailure = rec.state === 'error' || !!rec.error;
      // A failed start leaves an 'error' record with no sandbox: there is nothing behind it, so it goes back to 'none'.
      if (hadFailure) rec = this.save({ ...rec, state: 'none', error: undefined, notice: undefined });
      return done(false, `No sandbox to stop: ${agentId} has no VM right now.${hadFailure ? ' (Its last start failed; that failure is cleared.)' : ''}`, rec);
    }
    const id = rec.sandboxId;
    if (rec.state === 'archived') {
      // The record says stopped: confirm with boat.dev before saying so (someone may have resumed it from the dashboard, and it would be billing).
      let up = false;
      try { up = LIVE_STATES.has(mapBoatState((await boat.get(id)).state)); } catch { /* unreachable or gone: treat as stopped */ }
      if (!up) return done(false, 'The VM is already stopped (snapshot kept, not billed).', rec);
    }
    try {
      await boat.stop(id);
    } catch (e) {
      if (e instanceof BoatError && e.status === 404) {
        rec = this.save({ ...rec, sandboxId: null, state: 'none', error: undefined });
        return done(false, 'No sandbox to stop: boat.dev no longer has this VM. The record was cleared.', rec);
      }
      throw this.wrap(e);
    }
    this.health.noteOk('stop');
    const before = rec; // the record as it was while the VM was up, to put back if boat.dev says it is still up
    this.save({ ...rec, state: 'archiving', error: undefined });
    // Ask boat.dev what really happened (the snapshot takes a moment), and report that rather than assuming the request worked.
    let real: VmState | null = null;
    let askError: unknown;
    for (let i = 0; i < this.stopPollTries; i++) {
      try {
        real = mapBoatState((await boat.get(id)).state);
        if (real === 'archived' || real === 'error') break;
      } catch (e) {
        if (e instanceof BoatError && e.status === 404) { real = 'none'; break; }
        askError = e; real = null; break;
      }
      if (i < this.stopPollTries - 1) await sleep(this.stopPollMs);
    }
    if (real === 'archived') return done(true, 'VM stopped (snapshot kept, billing paused).', this.save({ ...this.store.getVm(agentId), state: 'archived' }));
    if (real === 'none') return done(true, 'The VM is gone from boat.dev (nothing is billing). The record was cleared.', this.save({ ...this.store.getVm(agentId), sandboxId: null, state: 'none' }));
    if (real === 'error') return done(false, "boat.dev reports the VM in an error state after the stop request. Check it in the boat.dev dashboard.", this.save({ ...this.store.getVm(agentId), state: 'error', error: 'boat.dev reported an error state after the stop request' }));
    if (real && LIVE_STATES.has(real)) {
      const back = this.save({ ...before, state: real, error: undefined });
      return done(false, `boat.dev still reports the VM as '${real}' after the stop request, so it may still be billing. Try again, or stop it in the boat.dev dashboard.`, back);
    }
    if (real === 'archiving' || real === 'provisioning') return done(true, 'VM stop requested; boat.dev is still saving the snapshot (billing pauses when it finishes).', this.store.getVm(agentId));
    const why = askError instanceof Error ? askError.message : 'no answer';
    return done(true, `VM stop requested, but boat.dev could not be asked to confirm it (${why}). Check the state before relying on it.`, this.store.getVm(agentId), false);
  }

  async exec(agentId: string, command: string, opts?: { cwd?: string; timeoutSeconds?: number }): Promise<ExecResult> {
    const rec = await this.ensureRunning(agentId);
    this.touch(agentId);
    try { return await this.requireBoat().exec(rec.sandboxId!, command, opts); } catch (e) { throw this.wrap(e); } finally { this.touch(agentId); }
  }

  /** `encoding: 'base64'` returns the file base64-encoded (binary exports); the default is UTF-8 text. */
  async readFile(agentId: string, path: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
    const rec = await this.ensureRunning(agentId);
    this.touch(agentId);
    try { return await this.requireBoat().readFile(rec.sandboxId!, path, encoding); } catch (e) { throw this.wrap(e); } finally { this.touch(agentId); }
  }

  /** `encoding: 'base64'` means `content` is base64 text for a binary file; the default is UTF-8 text. */
  async writeFile(agentId: string, path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> {
    const rec = await this.ensureRunning(agentId);
    this.touch(agentId);
    try { await this.requireBoat().writeFile(rec.sandboxId!, path, content, encoding); } catch (e) { throw this.wrap(e); } finally { this.touch(agentId); }
  }

  /** Run a whole task with Claude Code inside the VM; returns final text. */
  async claude(agentId: string, prompt: string, opts?: { model?: ConcreteModel; timeoutMs?: number }): Promise<string> {
    // Known not to work: say so before paying to start a VM.
    if (this.health.claudeMissing()) throw new VmError(CLAUDE_NOT_CONFIGURED, 'claude_not_configured');
    const rec = await this.ensureRunning(agentId);
    const boat = this.requireBoat();
    const sandboxId = rec.sandboxId!;
    this.touch(agentId);
    try {
      const prev = this.conversations.get(agentId);
      const conv = prev && prev.sandboxId === sandboxId ? prev.conversationId : undefined;
      const q = await boat.prompt(sandboxId, conv ? { prompt, model: opts?.model, conversationId: conv } : { prompt, model: opts?.model, new: true });
      const cid = q.conversationId ?? conv;
      if (cid) this.conversations.set(agentId, { sandboxId, conversationId: cid });
      const res = await boat.waitForPrompt(sandboxId, q.promptId, opts?.timeoutMs ?? 20 * 60_000);
      if (res.status === 'failed') throw new VmError(`Claude Code in the VM failed${res.text ? ': ' + res.text : ''}`, 'boat');
      if (res.status === 'interrupted' && !res.text) throw new VmError('Claude Code in the VM was interrupted', 'boat');
      this.health.noteOk('prompt');
      return res.text;
    } catch (e) {
      if (e instanceof BoatError && e.code === BOAT_CODE.providerNotConfigured) {
        this.health.note(e);
        throw new VmError(CLAUDE_NOT_CONFIGURED, 'claude_not_configured');
      }
      throw this.wrap(e);
    } finally {
      this.touch(agentId);
    }
  }

  async desktopUrl(agentId: string): Promise<string> {
    const rec = await this.ensureRunning(agentId);
    this.touch(agentId);
    try { return await this.requireBoat().desktopUrl(rec.sandboxId!); } catch (e) { throw this.wrap(e); } finally { this.touch(agentId); }
  }

  /** Live view frame; requires running VM; does NOT touch idle timer. */
  async screenshot(agentId: string): Promise<{ format: 'jpeg'; data: string }> {
    const boat = this.requireBoat();
    const rec = this.store.getVm(agentId);
    if (!rec.sandboxId || !LIVE_STATES.has(rec.state)) throw new VmError(`VM for '${agentId}' is not running`, 'not_running');
    try {
      await boat.exec(rec.sandboxId, 'DISPLAY=:0 import -window root -resize 1280x -quality 70 /tmp/legion-shot.jpg 2>/dev/null || (command -v scrot && scrot -o /tmp/legion-shot.jpg) ; echo captured', { timeoutSeconds: 20 });
      const data = await boat.readFile(rec.sandboxId, '/tmp/legion-shot.jpg', 'base64');
      return { format: 'jpeg', data };
    } catch (e) { throw this.wrap(e); }
  }

  touch(agentId: string): void {
    const rec = this.store.getVm(agentId);
    if (!rec.sandboxId) return;
    this.store.upsertVm({ ...rec, lastUsedAt: new Date(this.now()).toISOString() });
  }

  /** Stop VMs idle longer than their agent's idleStopMinutes. Returns agentIds stopped. */
  async reapIdle(): Promise<string[]> {
    if (!this.getBoat()) return [];
    const stopped: string[] = [];
    const now = this.now();
    for (const rec of this.store.listVms()) {
      if (!rec.sandboxId || !LIVE_STATES.has(rec.state)) continue;
      if (this.inflight.has(rec.agentId) || this.tail.has(rec.agentId)) continue;
      const minutes = this.store.getAgent(rec.agentId)?.vm.idleStopMinutes ?? 15;
      const last = Date.parse(rec.lastUsedAt ?? rec.createdAt ?? '');
      if (Number.isNaN(last)) continue;
      if (now - last <= minutes * 60_000) continue;
      try { await this.stop(rec.agentId); stopped.push(rec.agentId); } catch { /* retry next sweep */ }
    }
    return stopped;
  }

  /** Also refreshes stored state from boat once at start (sandboxes may have auto-stopped via TTL). Returns a stop fn. */
  startReaper(intervalMs = 60_000): () => void {
    let stopped = false;
    void this.refreshAll().catch(() => undefined);
    const timer = setInterval(() => { if (!stopped) void this.reapIdle().catch(() => undefined); }, intervalMs);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  }

  /** Re-read every known sandbox from boat.dev and update stored state. */
  async refreshAll(): Promise<void> {
    const boat = this.getBoat();
    if (!boat) return;
    for (const rec of this.store.listVms()) {
      if (!rec.sandboxId) continue;
      try {
        const sb = await boat.get(rec.sandboxId);
        const st = mapBoatState(sb.state);
        if (st !== rec.state) this.save({ ...this.store.getVm(rec.agentId), state: st }, this.endedBy(rec));
      } catch (e) {
        if (e instanceof BoatError && e.status === 404) this.save({ ...this.store.getVm(rec.agentId), sandboxId: null, state: 'none' }, this.endedBy(rec));
      }
    }
  }

  // ---- internals ----
  private requireBoat(): BoatClient {
    const boat = this.getBoat();
    if (!boat) throw new VmError('boat.dev is not configured. Open Settings → boat.dev to add a key.', 'not_configured');
    return boat;
  }

  private wrap(e: unknown): Error {
    if (e instanceof VmError) return e;
    this.health.note(e);
    return new VmError(e instanceof Error ? e.message : String(e), 'boat');
  }

  /** Saves the record and keeps the runtime counters honest: a run starts when the VM becomes usable and ends when it stops being so. */
  private save(rec: VmRecord, endedAt?: number): VmRecord {
    const t = this.now();
    let next = rec;
    const live = LIVE_STATES.has(next.state);
    if (live && !next.runStartedAt) next = { ...next, runStartedAt: new Date(t).toISOString() };
    else if (!live && next.runStartedAt) next = { ...next, ...closeRun(next, endedAt ?? t) };
    const saved = this.store.upsertVm(next);
    this.bus.emit({ type: 'vm.updated', vm: saved });
    return saved;
  }

  /** When a run we did not see end (boat's own TTL stop while Legion was closed) most likely ended: last use plus the safety-net TTL, never later than now. */
  private endedBy(rec: VmRecord): number {
    const now = this.now();
    const last = Date.parse(rec.lastUsedAt ?? rec.createdAt ?? '');
    if (Number.isNaN(last)) return now;
    const minutes = this.store.getAgent(rec.agentId)?.vm.idleStopMinutes ?? 15;
    return Math.min(now, last + (minutes * 60 + 900) * 1000);
  }

  /** Runs `fn` with `size`; if a free trial refuses that machine class, runs it again with 'default' and says so. */
  private async withSizeFallback<T>(size: VmSize, fn: (size: VmSize) => Promise<T>): Promise<{ value: T; size: VmSize; notice?: string }> {
    if (size !== 'default' && this.health.trialLimited()) {
      return { value: await fn('default'), size: 'default', notice: `${TRIAL_NOTE} (Configured size: ${size}.)` };
    }
    try {
      return { value: await fn(size), size };
    } catch (e) {
      if (size !== 'default' && e instanceof BoatError && e.code === BOAT_CODE.trialMachineClass) {
        this.health.note(e);
        return { value: await fn('default'), size: 'default', notice: `${TRIAL_NOTE} (Configured size: ${size}.)` };
      }
      throw e;
    }
  }

  private async doEnsure(agentId: string): Promise<VmRecord> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new VmError(`Unknown agent '${agentId}'`, 'unknown_agent');
    const boat = this.requireBoat();
    if (!agent.vm.enabled) throw new VmError(`VM is disabled for agent '${agent.name}'. Enable it in the agent settings.`, 'disabled');

    const requested: VmSize = VM_SIZES.has(agent.vm.size) ? agent.vm.size : 'default';
    const ttlSeconds = agent.vm.idleStopMinutes * 60 + 900;
    let rec = this.store.getVm(agentId);
    let effective: VmSize = requested;
    let notice: string | undefined;

    try {
      let sandbox: BoatSandbox | null = null;
      if (rec.sandboxId) {
        try {
          sandbox = await boat.get(rec.sandboxId);
        } catch (e) {
          if (!(e instanceof BoatError && e.status === 404)) throw e;
        }
        if (sandbox && (sandbox.state === 'cancelled' || sandbox.state === 'error')) sandbox = null;
      }

      let sandboxId: string;
      if (!sandbox) {
        // Whatever the stored record says (a failed start, a size from an older config, a sandbox boat.dev no longer has), a fresh
        // start is built from the agent's current settings. A stuck record is never reused as is.
        rec = this.save({ ...rec, sandboxId: null, state: 'provisioning', size: requested, requestedSize: undefined, notice: undefined, error: undefined });
        const r = await this.withSizeFallback(requested, (type) => boat.create({ type, ttlSeconds, name: `legion-${agentId}` }));
        effective = r.size; notice = r.notice;
        sandboxId = r.value.id;
        rec = this.save({ ...rec, sandboxId, state: 'provisioning', size: effective, requestedSize: effective !== requested ? requested : undefined, notice, createdAt: new Date(this.now()).toISOString(), error: undefined });
        this.health.noteOk('create');
      } else {
        sandboxId = sandbox.id;
        const st = mapBoatState(sandbox.state);
        if (st === 'archived' || st === 'archiving') {
          rec = this.save({ ...rec, state: 'provisioning', size: requested, requestedSize: undefined, notice: undefined, error: undefined });
          const r = await this.withSizeFallback(requested, (type) => this.resumeWithRetry(boat, sandboxId, { ttlSeconds, type }));
          effective = r.size; notice = r.notice;
          rec = this.save({ ...rec, size: effective, requestedSize: effective !== requested ? requested : undefined, notice });
          this.health.noteOk('resume');
        } else {
          // Already up: its size cannot change now. Say so when it differs from the agent's setting (unless that is a trial fallback we already explained).
          const actual: VmSize = sandbox.type && VM_SIZES.has(sandbox.type) ? (sandbox.type as VmSize) : rec.size;
          effective = actual;
          if (actual !== requested) {
            notice = rec.requestedSize === requested && rec.notice
              ? rec.notice
              : `This VM is running at size ${actual}; the configured size ${requested} applies the next time it is stopped and started.`;
          }
          if (st !== rec.state) rec = this.save({ ...rec, state: st, error: undefined });
        }
      }

      const ready = await boat.waitUntilReady(sandboxId);
      return this.save({
        ...this.store.getVm(agentId),
        sandboxId,
        state: mapBoatState(ready.state),
        size: effective,
        requestedSize: effective !== requested ? requested : undefined,
        notice,
        lastUsedAt: new Date(this.now()).toISOString(),
        error: undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.health.note(e);
      this.save({ ...this.store.getVm(agentId), state: 'error', error: msg });
      throw this.wrap(e);
    }
  }

  /** Resume; if the sandbox is still archiving (409), wait a little and retry. */
  private async resumeWithRetry(boat: BoatClient, id: string, p: { ttlSeconds: number; type: VmRecord['size'] }): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await boat.resume(id, p); return; } catch (e) {
        if (e instanceof BoatError && e.status === 409 && attempt < 10) { await sleep(2000); continue; }
        throw e;
      }
    }
  }
}
