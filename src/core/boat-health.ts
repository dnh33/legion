/**
 * What Legion knows about the boat.dev key and account: which actions the key is refused, whether the account is on a trial that
 * rejects big machine classes, and whether Claude is set up on boat.dev (needed for vm_claude). Learned from an explicit probe
 * (on key save, on "Check again", in Doctor) and from real calls that failed. Held in memory only, reset when the key changes.
 * Nothing here ever contains the API key.
 */
import type { BoatHealthView, LegionConfig } from '../shared/types.js';
import { sanitizeRates } from '../shared/vm-usage.js';
import { BOAT_CODE, BoatError, forbiddenAction, type BoatClient } from './boat.js';
import type { EventBus } from './bus.js';

export interface BoatHealthDeps {
  getBoat: () => BoatClient | null;
  bus?: EventBus;
  /** Live view of config.boat (rates and currency follow Settings edits). */
  boatConfig?: () => LegionConfig['boat'] | undefined;
  now?: () => number;
  /** How long a "Claude is not configured" finding hides vm_claude before Legion tries again. */
  claudeTtlMs?: number;
  /** How long a "trial refused this machine class" finding makes Legion go straight to the default size. */
  trialTtlMs?: number;
}

export const CLAUDE_NOT_CONFIGURED = 'Claude is not configured on boat.dev: open the Agents page in your boat.dev dashboard and connect Claude. Until then vm_claude cannot run.';
export const TRIAL_NOTE = 'This boat.dev account is on a free trial, which does not allow the larger VM size. Legion used the default size instead.';

export class BoatHealth {
  private checkedAt: number | null = null;
  private keyOk: boolean | null = null;
  private forbidden = new Map<string, { action: string; op: string; at: number }>();
  private probes: BoatHealthView['probes'] = [];
  private claude: { state: 'configured' | 'not_configured' | 'unknown'; at?: number } = { state: 'unknown' };
  private trial: { limited: boolean; at?: number } = { limited: false };
  private readonly now: () => number;
  private readonly claudeTtl: number;
  private readonly trialTtl: number;
  private probing: Promise<BoatHealthView> | null = null;

  constructor(private readonly deps: BoatHealthDeps) {
    this.now = deps.now ?? Date.now;
    this.claudeTtl = deps.claudeTtlMs ?? 5 * 60_000;
    this.trialTtl = deps.trialTtlMs ?? 60 * 60_000;
  }

  view(): BoatHealthView {
    const iso = (t?: number | null) => (t === undefined || t === null ? undefined : new Date(t).toISOString());
    const claudeMissing = this.claudeMissing();
    const trialLimited = this.trialLimited();
    return {
      configured: !!this.deps.getBoat(),
      checkedAt: iso(this.checkedAt) ?? null,
      keyOk: this.keyOk,
      forbidden: [...this.forbidden.values()].map((f) => ({ action: f.action, op: f.op, at: new Date(f.at).toISOString() })),
      probes: this.probes.map((p) => ({ ...p })),
      claude: claudeMissing
        ? { state: 'not_configured', message: CLAUDE_NOT_CONFIGURED, at: iso(this.claude.at) }
        : { state: this.claude.state === 'configured' ? 'configured' : 'unknown' },
      trial: trialLimited ? { limited: true, message: TRIAL_NOTE, at: iso(this.trial.at) } : { limited: false },
      ...this.rates(),
    };
  }

  /** Rates and currency for usage estimates (empty rates = no estimates). */
  rates(): { rates: BoatHealthView['rates']; currency: string } {
    const cfg = this.deps.boatConfig?.();
    return { rates: sanitizeRates(cfg?.rates), currency: typeof cfg?.currency === 'string' ? cfg.currency.slice(0, 12) : '' };
  }

  /** True while a recent finding says Claude is not set up on boat.dev. Expires, so a fixed setup is noticed. */
  claudeMissing(): boolean {
    return this.claude.state === 'not_configured' && this.claude.at !== undefined && this.now() - this.claude.at < this.claudeTtl;
  }
  trialLimited(): boolean {
    return this.trial.limited && this.trial.at !== undefined && this.now() - this.trial.at < this.trialTtl;
  }

  /** Forget everything (the key or base URL changed). */
  reset(): void {
    this.checkedAt = null; this.keyOk = null; this.forbidden.clear(); this.probes = [];
    this.claude = { state: 'unknown' }; this.trial = { limited: false };
    this.emit();
  }

  /** Learn from a failed boat call. Returns true when it taught us something. */
  note(e: unknown): boolean {
    if (!(e instanceof BoatError)) return false;
    const at = this.now();
    if (e.code === BOAT_CODE.keyActionForbidden) {
      const action = e.action ?? forbiddenAction(e.message) ?? 'unknown action';
      this.forbidden.set(action, { action, op: action.split('.').pop() ?? action, at });
      this.emit();
      return true;
    }
    if (e.code === BOAT_CODE.providerNotConfigured) { this.claude = { state: 'not_configured', at }; this.emit(); return true; }
    if (e.code === BOAT_CODE.trialMachineClass) { this.trial = { limited: true, at }; this.emit(); return true; }
    return false;
  }

  /** A real call worked: drop the matching "forbidden" finding (the user replaced the key with a better one). */
  noteOk(op: string): void {
    let changed = false;
    for (const [k, f] of this.forbidden) if (f.op === op) { this.forbidden.delete(k); changed = true; }
    if (op === 'prompt' && this.claude.state !== 'configured') { this.claude = { state: 'configured', at: this.now() }; changed = true; }
    if (changed) this.emit();
  }

  /** Run the key probe now (shared between concurrent callers). Never throws. */
  probe(): Promise<BoatHealthView> {
    if (this.probing) return this.probing;
    this.probing = this.doProbe().finally(() => { this.probing = null; });
    return this.probing;
  }

  private async doProbe(): Promise<BoatHealthView> {
    const boat = this.deps.getBoat();
    if (!boat) { this.reset(); return this.view(); }
    try {
      const r = await boat.checkKey();
      const at = this.now();
      this.checkedAt = at;
      this.keyOk = r.me.ok;
      this.probes = r.ops.map((o) => ({ op: o.op, status: o.status }));
      // The probe is the fresh truth about permissions: rebuild the forbidden list from it, keep what real calls taught us for other actions.
      for (const o of r.ops) {
        if (o.status === 'forbidden') {
          const action = o.action ?? o.op;
          this.forbidden.set(action, { action, op: action.split('.').pop() ?? o.op, at });
        } else if (o.status === 'allowed') {
          for (const [k, f] of this.forbidden) if (f.op === o.op) this.forbidden.delete(k);
        }
      }
      if (r.claude === 'not_configured') this.claude = { state: 'not_configured', at };
      else if (this.claude.state === 'not_configured' && !this.claudeMissing()) this.claude = { state: 'unknown' };
    } catch { /* checkKey never throws; belt and braces */ }
    this.emit();
    return this.view();
  }

  private emit(): void { try { this.deps.bus?.emit({ type: 'boat.health', health: this.view() }); } catch { /* ignore */ } }
}
