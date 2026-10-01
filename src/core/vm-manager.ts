/** Per-agent on-demand VM lifecycle. */
import type { ConcreteModel, VmRecord, VmState } from '../shared/types.js';
import { sleep } from '../shared/util.js';
import { BoatError, type BoatClient, type BoatSandbox, type ExecResult } from './boat.js';
import type { EventBus } from './bus.js';
import type { Store } from './store.js';

export class VmError extends Error {
  constructor(message: string, public readonly code: 'not_configured' | 'disabled' | 'not_running' | 'boat' | 'unknown_agent') { super(message); this.name = 'VmError'; }
}

export interface VmManagerDeps { store: Store; bus: EventBus; getBoat: () => BoatClient | null; now?: () => number }

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

  constructor(deps: VmManagerDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.getBoat = deps.getBoat;
    this.now = deps.now ?? Date.now;
  }

  status(agentId: string): VmRecord { return this.store.getVm(agentId); }

  /** Create (ttl = idleStopMinutes*60+900 s safety net) or resume, wait until ready, touch. Concurrent calls for the same agent share one promise. */
  ensureRunning(agentId: string): Promise<VmRecord> {
    const existing = this.inflight.get(agentId);
    if (existing) return existing;
    const p = this.doEnsure(agentId).finally(() => { this.inflight.delete(agentId); });
    this.inflight.set(agentId, p);
    return p;
  }

  async stop(agentId: string): Promise<VmRecord> {
    const boat = this.requireBoat();
    const rec = this.store.getVm(agentId);
    if (!rec.sandboxId) return rec;
    const id = rec.sandboxId;
    try {
      await boat.stop(id);
    } catch (e) {
      if (e instanceof BoatError && e.status === 404) {
        return this.save({ ...rec, sandboxId: null, state: 'none', error: undefined });
      }
      throw this.wrap(e);
    }
    this.save({ ...rec, state: 'archiving', error: undefined });
    // Best effort: wait briefly for the snapshot to finish so the UI shows 'archived'.
    for (let i = 0; i < 20; i++) {
      try {
        const sb = await boat.get(id);
        const st = mapBoatState(sb.state);
        if (st === 'archived' || st === 'error') return this.save({ ...this.store.getVm(agentId), state: st });
      } catch { break; }
      await sleep(1000);
    }
    return this.store.getVm(agentId);
  }

  async exec(agentId: string, command: string, opts?: { cwd?: string; timeoutSeconds?: number }): Promise<ExecResult> {
    const rec = await this.ensureRunning(agentId);
    this.touch(agentId);
    try { return await this.requireBoat().exec(rec.sandboxId!, command, opts); } catch (e) { throw this.wrap(e); } finally { this.touch(agentId); }
  }

  async readFile(agentId: string, path: string): Promise<string> {
    const rec = await this.ensureRunning(agentId);
    this.touch(agentId);
    try { return await this.requireBoat().readFile(rec.sandboxId!, path); } catch (e) { throw this.wrap(e); } finally { this.touch(agentId); }
  }

  async writeFile(agentId: string, path: string, content: string): Promise<void> {
    const rec = await this.ensureRunning(agentId);
    this.touch(agentId);
    try { await this.requireBoat().writeFile(rec.sandboxId!, path, content); } catch (e) { throw this.wrap(e); } finally { this.touch(agentId); }
  }

  /** Run a whole task with Claude Code inside the VM; returns final text. */
  async claude(agentId: string, prompt: string, opts?: { model?: ConcreteModel; timeoutMs?: number }): Promise<string> {
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
      return res.text;
    } catch (e) {
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
      if (this.inflight.has(rec.agentId)) continue;
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
        if (st !== rec.state) this.save({ ...this.store.getVm(rec.agentId), state: st });
      } catch (e) {
        if (e instanceof BoatError && e.status === 404) this.save({ ...this.store.getVm(rec.agentId), sandboxId: null, state: 'none' });
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
    return new VmError(e instanceof Error ? e.message : String(e), 'boat');
  }

  private save(rec: VmRecord): VmRecord {
    const saved = this.store.upsertVm(rec);
    this.bus.emit({ type: 'vm.updated', vm: saved });
    return saved;
  }

  private async doEnsure(agentId: string): Promise<VmRecord> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new VmError(`Unknown agent '${agentId}'`, 'unknown_agent');
    const boat = this.requireBoat();
    if (!agent.vm.enabled) throw new VmError(`VM is disabled for agent '${agent.name}'. Enable it in the agent settings.`, 'disabled');

    const size = agent.vm.size;
    const ttlSeconds = agent.vm.idleStopMinutes * 60 + 900;
    let rec = this.store.getVm(agentId);

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
        rec = this.save({ ...rec, sandboxId: null, state: 'provisioning', size, error: undefined });
        const created = await boat.create({ type: size, ttlSeconds, name: `legion-${agentId}` });
        sandboxId = created.id;
        rec = this.save({ ...rec, sandboxId, state: 'provisioning', size, createdAt: new Date(this.now()).toISOString(), error: undefined });
      } else {
        sandboxId = sandbox.id;
        const st = mapBoatState(sandbox.state);
        if (st === 'archived' || st === 'archiving') {
          rec = this.save({ ...rec, state: 'provisioning', size, error: undefined });
          await this.resumeWithRetry(boat, sandboxId, { ttlSeconds, type: size });
        } else if (st !== rec.state) {
          rec = this.save({ ...rec, state: st, error: undefined });
        }
      }

      const ready = await boat.waitUntilReady(sandboxId);
      return this.save({
        ...this.store.getVm(agentId),
        sandboxId,
        state: mapBoatState(ready.state),
        lastUsedAt: new Date(this.now()).toISOString(),
        error: undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
