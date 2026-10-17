/**
 * The Marshal's driver: the per-project tick that makes the loop a live feature instead of a tested library.
 *
 * One pass settles the runs that ended or stalled (`monitor`) and then works a wave (`step`), on the config
 * the owner wrote on that project's board. The tick is OPT-IN: a project whose config says `enabled: false`
 * (the default) gets no timer at all, so an untouched board never starts a run by itself. A pass is guarded
 * against itself (one at a time per project), never throws out of the timer, and skips a project that has
 * since been archived — the board is read-only there, so nothing could be written anyway.
 *
 * Everything time-shaped comes from `deps.now`, and `deps.schedule` is a seam (tests pass a no-op and call
 * `tick()` themselves), so the whole driver is testable without waiting on a real interval.
 */
import type { MarshalConfig } from '../../shared/board.js';
import type { BoardStore, ProjectRef } from '../projects/board/store.js';
import type { AttemptLimits } from './ledger.js';
import { Marshal } from './orchestrator.js';
import type { MarshalPorts, MarshalStatus } from './orchestrator.js';

/** How often an enabled project gets a pass: minutes, not seconds — a dispatch is a run on a bot, not a poll. */
export const MARSHAL_TICK_MS = 15_000;

/** What the status route answers: the picture, its plain lines, and the checks written so far (by item id). */
export interface MarshalProjectStatus {
  status: MarshalStatus;
  statusText: string;
  checks: Record<string, string[]>;
}

export interface MarshalDriverDeps {
  board: BoardStore;
  /** The project right now. Undefined = no such project (the routes have already 404'd by then). */
  project(pid: string): ProjectRef | undefined;
  /** This project's ports, built once by the composition root over the engine, the store and the matcher. */
  ports(pid: string): MarshalPorts;
  /** The board changed: the window reloads it (advisory, exactly like every other board write). */
  changed(pid: string): void;
  /** "Pause new starts" is on for this project: the loop settles what ended but dispatches nothing. Absent: never paused. */
  paused?(pid: string): boolean;
  /** The attempt caps for this project, read at every dispatch check (the `attempt-caps` gate). Absent: the exported defaults. */
  limits?(pid: string): AttemptLimits;
  /** The loop's clock. */
  now(): number;
  /** Starts the tick; returns the cancel function. Tests pass a no-op and call `tick()` themselves. */
  schedule(fn: () => void, ms: number): () => void;
}

export class MarshalDriver {
  private readonly marshals = new Map<string, Marshal>();
  private readonly ticks = new Map<string, () => void>();
  private readonly busy = new Set<string>();

  constructor(private readonly deps: MarshalDriverDeps) {}

  /**
   * This project's Marshal, built on first use from the config on its board (the ledger rides the sidecars,
   * so a build always starts from what the board already knows). Undefined for a project that does not exist.
   */
  marshalFor(pid: string): Marshal | undefined {
    const built = this.marshals.get(pid);
    if (built) return built;
    const p = this.deps.project(pid);
    if (!p) return undefined;
    const cfg = this.deps.board.marshalConfig(pid);
    const marshal = new Marshal(this.deps.ports(pid), p, { waveSize: cfg.waveSize, stallMs: cfg.stallMinutes * 60_000, ...(this.deps.limits ? { limits: (id: string) => this.deps.limits!(id) } : {}) });
    this.marshals.set(pid, marshal);
    return marshal;
  }

  /** Is the tick running for this project? */
  running(pid: string): boolean { return this.ticks.has(pid); }

  /**
   * The owner's config takes effect at once: the tick starts or stops, and a Marshal already in flight takes
   * the new wave and stall budget without losing the runs it is tracking.
   */
  apply(pid: string, cfg: MarshalConfig): void {
    const marshal = this.marshalFor(pid);
    if (!marshal) return; // no project, no loop (the route answers 404 before this)
    marshal.reconfigure({ waveSize: cfg.waveSize, stallMs: cfg.stallMinutes * 60_000 });
    const stop = this.ticks.get(pid);
    if (cfg.enabled && !stop) this.ticks.set(pid, this.deps.schedule(() => { void this.tick(pid); }, MARSHAL_TICK_MS));
    else if (!cfg.enabled && stop) { stop(); this.ticks.delete(pid); }
  }

  /**
   * One pass: settle what ended or stalled, then work one wave. Never throws (a bad pass must not take the
   * timer down with it), never overlaps itself on one project, and never runs a project whose config says off
   * or whose board has gone read-only. `changed` fires only when the pass actually moved something.
   */
  async tick(pid: string): Promise<void> {
    if (this.busy.has(pid)) return;
    const p = this.deps.project(pid);
    if (!p || p.status === 'archived') return;
    const marshal = this.marshalFor(pid);
    if (!marshal) return;
    const cfg = this.deps.board.marshalConfig(pid);
    if (!cfg.enabled) return;
    this.busy.add(pid);
    try {
      // the roster may have changed since the last pass: the loop takes the project as it is now
      marshal.reconfigure({ project: p, waveSize: cfg.waveSize, stallMs: cfg.stallMinutes * 60_000 });
      const now = this.deps.now();
      const mon = marshal.monitor(now);
      // paused: what already ended is still settled, but no new run is asked for or started (the engine holds a marshal start too: defense in depth)
      let paused = false;
      try { paused = this.deps.paused?.(pid) === true; } catch { /* a failing hook does not pause */ }
      if (paused) { if (mon.finished.length || mon.failed.length || mon.stalled.length || mon.escalated.length) this.deps.changed(pid); return; }
      const step = await marshal.step(now, cfg.waveSize);
      if (mon.finished.length || mon.failed.length || mon.stalled.length || mon.escalated.length || step.dispatched.length || step.blocked.length) this.deps.changed(pid);
    } catch { /* one bad pass is one lost pass, never a stopped loop */ } finally { this.busy.delete(pid); }
  }

  /** The human-readable picture, plus the checks written so far (the status view needs them to show what an item dispatches with). */
  status(pid: string): MarshalProjectStatus {
    const marshal = this.marshalFor(pid);
    const now = this.deps.now();
    if (!marshal) return { status: { running: [], blocked: [], next: [] }, statusText: 'STATUS 0 running, 0 blocked, 0 next', checks: {} };
    const checks: Record<string, string[]> = {};
    for (const [itemId, state] of Object.entries(marshal.ledger.snapshot())) if (state.doneWhen?.length) checks[itemId] = state.doneWhen;
    return { status: marshal.status(now), statusText: marshal.statusText(now), checks };
  }

  /** Every tick this driver started is cancelled; the Marshals stay (a dispose is a shutdown, not a reset). */
  dispose(): void {
    for (const stop of this.ticks.values()) stop();
    this.ticks.clear();
    this.busy.clear();
  }
}
