/**
 * The ask clock: when an unanswered ask is denied or parked. Pure, so the core and the app read the same deadlines.
 *
 * Rules (spec 4.5):
 *  - The deny clock counts only time OUTSIDE quiet hours. An ask raised in quiet hours starts counting at quiet end; one raised
 *    4 minutes before quiet starts has 6 minutes left when quiet ends. Quiet hours only ever lengthen a wait.
 *  - Parking is NOT extended by quiet hours (parking loses nothing, and overnight parking is the right behaviour).
 *  - Quiet hours are local wall-clock time, may wrap midnight, and are computed from local fields (never "+ 24 h"), so a 23 or 25
 *    hour day keeps the same clock times.
 *  - `from == to`, a bad time, or `enabled: false` is no window at all.
 *
 * Nothing here can allow anything: the only outputs are times.
 */

export interface QuietConfig { enabled: boolean; from: string; to: string }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after local midnight for "HH:MM", or null. */
function minutesOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = HHMM.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The config when it describes a real window, else undefined (off, bad times, or from == to). */
export function validQuiet(q: QuietConfig | undefined | null): QuietConfig | undefined {
  if (!q || q.enabled !== true) return undefined;
  const a = minutesOf(q.from);
  const b = minutesOf(q.to);
  if (a === null || b === null || a === b) return undefined;
  return q;
}

/** Is this moment inside quiet hours? `from` is inside, `to` is outside. */
export function isQuietAt(ms: number, quiet: QuietConfig | undefined): boolean {
  const q = validQuiet(quiet);
  if (!q) return false;
  const a = minutesOf(q.from)!;
  const b = minutesOf(q.to)!;
  const d = new Date(ms);
  const m = d.getHours() * 60 + d.getMinutes();
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Local time `min` minutes after midnight, `dayOffset` days from the day of `ms`. Built from local fields, so DST cannot skew it. */
function localAt(ms: number, dayOffset: number, min: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, Math.floor(min / 60), min % 60, 0, 0).getTime();
}

/** The next moment (after `ms`) at which quiet hours start or end; null when there is no window. */
export function nextQuietBoundary(ms: number, quiet: QuietConfig | undefined): number | null {
  const q = validQuiet(quiet);
  if (!q) return null;
  const a = minutesOf(q.from)!;
  const b = minutesOf(q.to)!;
  let best: number | null = null;
  for (let day = 0; day <= 2; day++) {
    for (const min of [a, b]) {
      const t = localAt(ms, day, min);
      if (t > ms && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/**
 * When an ask raised at `askedAtMs` is denied after waiting `waitMs` of time outside quiet hours; null if it cannot be worked out
 * (the caller then keeps the plain wait). Quiet hours absent: `askedAtMs + waitMs`, exactly as before.
 */
export function denyAt(askedAtMs: number, waitMs: number, quiet: QuietConfig | undefined): number | null {
  const q = validQuiet(quiet);
  if (!q) return askedAtMs + waitMs;
  let t = askedAtMs;
  let left = waitMs;
  for (let i = 0; i < 64; i++) {
    const edge = nextQuietBoundary(t, q);
    if (edge === null) return t + left;
    if (isQuietAt(t, q)) { t = edge; continue; }
    // outside quiet: the wait runs until the next quiet start
    if (t + left <= edge) return t + left;
    left -= edge - t;
    t = edge;
  }
  return null;
}

/** When an ask raised at `askedAtMs` is parked: a plain wait, quiet hours do not extend it. */
export function parkAt(askedAtMs: number, parkMinutes: number): number {
  return askedAtMs + parkMinutes * 60_000;
}
