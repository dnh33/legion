/**
 * The start gate: while an update is swapping files, a freshly opened Legion must not start a core (it would run files that are
 * being replaced, and the helper then refuses to continue). The caller shows a small window; this loop waits until the marker
 * clears or goes stale. It can never wait forever: a hard cap ends it, and every way out is logged.
 */
import type { UpdateProgress } from './update-marker.js';

export interface GateOptions {
  check(): UpdateProgress;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Removes a marker that belongs to no live update. */
  clearStale(): void;
  log(line: string): void;
  /** Called once, when the start has to wait. */
  onWait?(info: { toVersion?: string }): void;
  /** The helper's own relaunch of the new build: its own marker must not hold it. */
  handoff?: boolean;
  capMs?: number;
  pollMs?: number;
}
export type GateResult = { result: 'clear' | 'stale' | 'capped' | 'handoff'; waited: boolean; waitedMs: number };

/** Longest a start waits for an update to finish: a full-package update with a slow first start takes under 8 minutes. */
export const GATE_CAP_MS = 10 * 60_000;

export async function holdStartForUpdate(o: GateOptions): Promise<GateResult> {
  if (o.handoff) return { result: 'handoff', waited: false, waitedMs: 0 };
  const cap = o.capMs ?? GATE_CAP_MS;
  const poll = o.pollMs ?? 1000;
  const t0 = o.now();
  let waited = false;
  for (;;) {
    const p = o.check();
    if (!p.inProgress) {
      if (p.stale) { o.log(`update marker is stale${p.marker ? ` (${p.marker.fromVersion} -> ${p.marker.toVersion})` : ''}: removing it and starting`); o.clearStale(); return { result: 'stale', waited, waitedMs: o.now() - t0 }; }
      if (waited) o.log(`the update finished after ${Math.round((o.now() - t0) / 1000)} s: starting`);
      return { result: 'clear', waited, waitedMs: o.now() - t0 };
    }
    if (!waited) { waited = true; o.log(`an update is in progress${p.marker ? ` (${p.marker.fromVersion} -> ${p.marker.toVersion})` : ''}: not starting a core until it ends`); o.onWait?.({ ...(p.marker ? { toVersion: p.marker.toVersion } : {}) }); }
    if (o.now() - t0 >= cap) { o.log(`still an update marker after the ${Math.round(cap / 1000)} s cap: giving up on it and starting`); return { result: 'capped', waited, waitedMs: o.now() - t0 }; }
    await o.sleep(poll);
  }
}
