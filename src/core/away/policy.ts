/**
 * The ask timer both brokers use, and the policy they read (spec 4.5).
 *
 * SAFETY (spec 5.1): the only automatic outcomes of an ask are DENY, PARK and WAIT. This file has no path to an allow: its two
 * callbacks are `onDeny` and `onPark`, and the brokers wire both to a "no". A test greps for it (test/broker-policy.test.ts).
 *
 * With no policy the timer is one plain timeout of the base wait: exactly the old behaviour.
 */
import { denyAt, nextQuietBoundary, parkAt } from '../../shared/ask-clock.js';
import type { QuietConfig } from '../../shared/ask-clock.js';

/** What the brokers read per ask. Implemented by the away module; absent means today's behaviour. */
export interface AskPolicy {
  policyFor(projectId?: string): { onSilence: 'deny' | 'park'; parkMinutes: number };
  quiet(): QuietConfig | undefined;
  /** The project of a task, for an ask raised by a module that does not know it. */
  projectOf?(taskId: string): string | undefined;
}

/** The most a "hold" may push a deadline out: enough to finish a click in the last seconds, never a way to stall an ask. */
export const HOLD_MAX_MS = 15_000;
/** The largest delay setTimeout takes. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
const PARK_MAX_MS = 120 * 60_000;
const DAY_MS = 24 * 3_600_000;

export interface AskTimerOpts {
  baseWaitMs: number;
  policy?: AskPolicy;
  projectId?: string;
  /** The ask may be parked (only the engine's own cards and questions). */
  parkable?: boolean;
  /** Time source; tests pass their own. */
  now?: () => number;
  onDeny: () => void;
  onPark?: () => void;
}
export interface AskTimer {
  cancel(): void;
  /** Delays the deadline to at least `now + ms` (ms clamped to HOLD_MAX_MS). Once per ask. Never answers the ask. */
  hold(ms: number): boolean;
  /** The moment the ask will be denied or parked, as things stand now. */
  dueAt(): number;
}

export function startAskTimer(o: AskTimerOpts): AskTimer {
  const clock = o.now ?? Date.now;
  const askedAt = clock();
  let holdUntil = 0;
  let held = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const target = (): { kind: 'deny' | 'park'; at: number } => {
    const pol = o.policy?.policyFor(o.projectId);
    const parks = pol?.onSilence === 'park' && o.parkable === true && !!o.onPark;
    const base = parks ? parkAt(askedAt, pol!.parkMinutes) : (denyAt(askedAt, o.baseWaitMs, o.policy?.quiet()) ?? askedAt + o.baseWaitMs);
    return { kind: parks ? 'park' : 'deny', at: Math.max(base, holdUntil) };
  };
  const arm = (): void => {
    if (done) return;
    const t = target();
    const now = clock();
    let next = t.at;
    // wake at each quiet boundary too, so a moved clock or a changed setting is re-read (the deadline is recomputed every time)
    const edge = o.policy ? nextQuietBoundary(now, o.policy.quiet()) : null;
    if (edge !== null && edge < next) next = edge;
    timer = setTimeout(fire, Math.min(Math.max(0, next - now), MAX_TIMER_MS));
  };
  const fire = (): void => {
    if (done) return;
    const t = target();
    if (clock() < t.at) { arm(); return; }
    done = true;
    if (t.kind === 'park') o.onPark!(); else o.onDeny();
  };
  arm();
  return {
    cancel() { done = true; if (timer) clearTimeout(timer); },
    hold(ms: number) {
      if (done || held) return false;
      held = true;
      holdUntil = clock() + Math.min(Math.max(0, Number.isFinite(ms) ? ms : 0), HOLD_MAX_MS);
      if (timer) clearTimeout(timer);
      arm();
      return true;
    },
    dueAt: () => target().at,
  };
}

/** The longest an ask can wait before it is denied or parked, in whole seconds: what a hook that awaits the card must be given. */
export function longestWaitSeconds(baseWaitMs: number, policy: AskPolicy | undefined): number {
  let ms = baseWaitMs;
  if (policy) {
    // always a day for quiet hours, whether or not they are on right now: they can be switched on while the run is going and the hook is fixed at its start
    ms = Math.max(baseWaitMs + DAY_MS, PARK_MAX_MS) + HOLD_MAX_MS;
  }
  // stay clear of the timer limit (and keep room for the minute the engine adds)
  return Math.ceil(Math.min(ms, MAX_TIMER_MS - 120_000) / 1000);
}
