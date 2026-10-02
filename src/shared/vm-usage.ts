/**
 * VM runtime math, shared by the core and the UI (pure, no I/O).
 * Legion measures uptime itself: from "VM usable" to "stop requested". boat.dev bills by its own rules, so every
 * money figure is an estimate, and only exists when the user configured an hourly rate (boat.rates). No prices are built in.
 */
import type { VmRecord, VmSize, VmUsage } from './types.js';

export type VmRates = { small?: number; default?: number; large?: number };

const LIVE: ReadonlySet<string> = new Set(['ready', 'idle', 'running']);
export const vmRecordIsLive = (r: Pick<VmRecord, 'state'>): boolean => LIVE.has(r.state);

/** Local calendar day of a timestamp, "YYYY-MM-DD". */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Start of the local day containing `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Keep only finite positive rates; anything else (strings, negatives, NaN) is dropped, never guessed. */
export function sanitizeRates(r: unknown): VmRates {
  const out: VmRates = {};
  if (!r || typeof r !== 'object') return out;
  for (const k of ['small', 'default', 'large'] as const) {
    const v = (r as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** Seconds of finished runs counted for `today` (0 when the stored day is another day). */
function closedToday(rec: VmRecord, now: number): number {
  return rec.usageDay === localDay(now) && typeof rec.usageSeconds === 'number' ? rec.usageSeconds : 0;
}

/** Seconds of the interval [start, end] that fall on the local day of `end`. */
export function secondsOnDayOf(start: number, end: number): number {
  if (!(end > start)) return 0;
  return Math.max(0, Math.round((end - Math.max(start, localDayStart(end))) / 1000));
}

/** Fold a finished run [runStartedAt, end] into the record's per-day counter. Returns the fields to merge. */
export function closeRun(rec: VmRecord, end: number): Pick<VmRecord, 'runStartedAt' | 'usageDay' | 'usageSeconds'> {
  const start = rec.runStartedAt ? Date.parse(rec.runStartedAt) : NaN;
  const base = closedToday(rec, end);
  const add = Number.isNaN(start) ? 0 : secondsOnDayOf(start, end);
  return { runStartedAt: null, usageDay: localDay(end), usageSeconds: base + add };
}

/** A cached copy of the boat rates older than this is not used for a cost figure (the cost shows as unknown instead). */
export const RATES_TTL_MS = 10 * 60_000;

/**
 * `ratesAsOf` is when the rates were last read from the source of truth (the core's config). Omit it when the rates were just read
 * (the core). A UI holding a cached copy passes the copy's time: past RATES_TTL_MS no estimate is produced, only `estimateNote`.
 */
export function vmUsage(rec: VmRecord, now: number, rates?: VmRates, currency = '', ratesAsOf?: number): VmUsage {
  const start = rec.runStartedAt ? Date.parse(rec.runStartedAt) : NaN;
  const running = vmRecordIsLive(rec) && !Number.isNaN(start);
  const runtimeSeconds = running ? Math.max(0, Math.round((now - start) / 1000)) : 0;
  const todaySeconds = closedToday(rec, now) + (running ? secondsOnDayOf(start, now) : 0);
  const usage: VmUsage = { running, runtimeSeconds, todaySeconds };
  const perHour = rates?.[rec.size as VmSize];
  if (typeof perHour === 'number' && perHour > 0 && ratesAsOf !== undefined && !(now - ratesAsOf <= RATES_TTL_MS)) {
    usage.estimateNote = `cost unknown: the prices were last refreshed ${fmtDuration(Math.max(0, (now - ratesAsOf) / 1000))} ago`;
  } else if (typeof perHour === 'number' && perHour > 0) {
    usage.estimate = {
      amount: Math.round((todaySeconds / 3600) * perHour * 100) / 100,
      currency, perHour,
      basis: `estimate: ${fmtDuration(todaySeconds)} today x ${perHour}${currency ? ' ' + currency : ''}/h (${rec.size} rate you configured); boat.dev's own billing may differ`,
    };
  }
  return usage;
}

/** "42 s", "7 min 3 s", "2 h 05 min". */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** One line for tool results and the UI. */
export function usageLine(u: VmUsage): string {
  const parts = [u.running ? `this run ${fmtDuration(u.runtimeSeconds)}` : 'not running', `today ${fmtDuration(u.todaySeconds)}`];
  if (u.estimate) parts.push(`est. ${u.estimate.amount.toFixed(2)}${u.estimate.currency ? ' ' + u.estimate.currency : ''}`);
  return parts.join(' · ');
}

/**
 * Memo for vmUsage: the same record, rates and second give the same answer without recomputing (the UI renders often, tools call per
 * result). One entry per agent; an entry is reused only while every input that matters is identical.
 */
export function createUsageMemo(max = 64) {
  const cache = new Map<string, { key: string; value: VmUsage }>();
  const stats = { computed: 0, hits: 0 };
  function usage(rec: VmRecord, now: number, rates?: VmRates, currency = '', ratesAsOf?: number): VmUsage {
    const stale = ratesAsOf !== undefined && !(now - ratesAsOf <= RATES_TTL_MS);
    const key = [rec.state, rec.size, rec.runStartedAt ?? '', rec.usageDay ?? '', rec.usageSeconds ?? '', Math.floor(now / 1000),
      JSON.stringify(rates ?? {}), currency, stale ? 'stale' : 'fresh'].join('|');
    const hit = cache.get(rec.agentId);
    if (hit && hit.key === key) { stats.hits++; return hit.value; }
    const value = vmUsage(rec, now, rates, currency, ratesAsOf);
    stats.computed++;
    cache.delete(rec.agentId);
    cache.set(rec.agentId, { key, value });
    if (cache.size > max) cache.delete(cache.keys().next().value as string);
    return value;
  }
  return Object.assign(usage, { stats });
}
