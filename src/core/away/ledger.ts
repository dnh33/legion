/**
 * The spend ledger: <dataDir>/away/spend-YYYY-MM.jsonl, append-only, one line { at, taskId, agentId, projectId?, usd } per cost the
 * engine learns of. Ids and amounts only (no text, no keys). A failure to write never fails a run: the amount still counts in memory
 * while the core runs. The task's own `costUsd` is unchanged.
 *
 * Reads sum the months a window touches, on demand, cached per month (an append updates the cache).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { periodEnd, periodStart } from '../../shared/spend-periods.js';
import type { SpendPeriod } from '../../shared/spend-periods.js';
import { localDay, localDayStart } from '../../shared/vm-usage.js';
import type { ProjectAway } from './store.js';

export interface SpendEntry { at: string; taskId: string; agentId: string; projectId?: string; usd: number }
export interface SpendSummary {
  /** This ISO week. */
  week: number;
  today: number;
  /** Within this week, biggest first. A run with no project is listed with `projectId: null`. */
  byProject: Array<{ projectId: string | null; usd: number }>;
  byAgent: Array<{ agentId: string; usd: number }>;
  /** The last 14 local days, oldest first, zero-filled. */
  daily: Array<{ day: string; usd: number }>;
}

const monthKey = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const valid = (e: unknown): e is SpendEntry => {
  const x = e as SpendEntry | null;
  return !!x && typeof x === 'object' && typeof x.usd === 'number' && Number.isFinite(x.usd) && x.usd > 0
    && typeof x.at === 'string' && Number.isFinite(Date.parse(x.at)) && typeof x.taskId === 'string' && typeof x.agentId === 'string';
};

export class SpendLedger {
  private readonly months = new Map<string, SpendEntry[]>();
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private file(key: string): string { return join(this.dir, `spend-${key}.jsonl`); }

  private load(key: string): SpendEntry[] {
    let list = this.months.get(key);
    if (list) return list;
    list = [];
    try {
      const f = this.file(key);
      if (existsSync(f)) {
        for (const line of readFileSync(f, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const e = JSON.parse(line); if (valid(e)) list.push(e); } catch { /* a bad line is skipped */ }
        }
      }
    } catch { /* unreadable month: counts as empty */ }
    this.months.set(key, list);
    return list;
  }

  /** Writes one line. Never throws. */
  record(e: SpendEntry): void {
    try {
      if (!valid(e)) return;
      const line: SpendEntry = { at: e.at, taskId: e.taskId, agentId: e.agentId, ...(e.projectId ? { projectId: e.projectId } : {}), usd: e.usd };
      const key = monthKey(Date.parse(e.at));
      const list = this.load(key);
      list.push(line);
      try {
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(this.file(key), JSON.stringify(line) + '\n', 'utf8');
      } catch { /* kept in memory; the run is not affected */ }
    } catch { /* never fails a run */ }
  }

  /** Entries with `fromMs <= at < toMs`, optionally for one project. */
  private between(fromMs: number, toMs: number, projectId?: string): SpendEntry[] {
    const out: SpendEntry[] = [];
    const d = new Date(fromMs);
    let y = d.getFullYear(); let m = d.getMonth();
    const last = new Date(toMs - 1);
    while (y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth())) {
      for (const e of this.load(`${y}-${String(m + 1).padStart(2, '0')}`)) {
        const t = Date.parse(e.at);
        if (t >= fromMs && t < toMs && (projectId === undefined || e.projectId === projectId)) out.push(e);
      }
      if (++m > 11) { m = 0; y++; }
    }
    return out;
  }

  /** What was spent in the period that contains `nowMs`, for one project or all. */
  periodTotal(period: SpendPeriod, nowMs: number = this.now(), projectId?: string): number {
    return this.between(periodStart(period, nowMs), periodEnd(period, nowMs), projectId).reduce((n, e) => n + e.usd, 0);
  }

  /** Spent since a moment (for the digest's "$6.10 spent"). */
  since(sinceMs: number, nowMs: number = this.now(), projectId?: string): number {
    return this.between(sinceMs, nowMs + 1, projectId).reduce((n, e) => n + e.usd, 0);
  }

  summary(nowMs: number = this.now(), projectId?: string): SpendSummary {
    const weekStart = periodStart('week', nowMs);
    const week = this.between(weekStart, periodEnd('week', nowMs), projectId);
    const sum = <K>(key: (e: SpendEntry) => K): Map<K, number> => { const m = new Map<K, number>(); for (const e of week) m.set(key(e), (m.get(key(e)) ?? 0) + e.usd); return m; };
    const byProject = [...sum((e) => e.projectId ?? null)].map(([p, usd]) => ({ projectId: p, usd })).sort((a, b) => b.usd - a.usd);
    const byAgent = [...sum((e) => e.agentId)].map(([agentId, usd]) => ({ agentId, usd })).sort((a, b) => b.usd - a.usd);
    const DAY = 86_400_000;
    const todayStart = localDayStart(nowMs);
    const daily: SpendSummary['daily'] = [];
    const span = this.between(todayStart - 13 * DAY - DAY / 2, nowMs + DAY, projectId);
    for (let i = 13; i >= 0; i--) {
      const day = localDay(todayStart - i * DAY + DAY / 2); // mid-day of that date, immune to a 23 or 25 hour DST day
      daily.push({ day, usd: span.filter((e) => localDay(Date.parse(e.at)) === day).reduce((n, e) => n + e.usd, 0) });
    }
    return {
      week: week.reduce((n, e) => n + e.usd, 0),
      today: this.between(todayStart, nowMs + 1, projectId).reduce((n, e) => n + e.usd, 0),
      byProject, byAgent, daily,
    };
  }
}

export interface BudgetStatus {
  /** A limit is set. */
  limited: boolean;
  /** Limit set, no override in force, and the period's spend has reached it. */
  reached: boolean;
  overridden: boolean;
  spent: number;
  limit?: number;
  period?: SpendPeriod;
  periodStart?: number;
  periodEnd?: number;
}

/** The pure verdict: `isBudgetReached` = limit set, no override, the period's total at or above the limit (spec 4.7). */
export function budgetStatus(ledger: SpendLedger, cfg: Pick<ProjectAway, 'budget' | 'budgetOverrideUntil'>, projectId: string, nowMs: number): BudgetStatus {
  if (!cfg.budget) return { limited: false, reached: false, overridden: false, spent: 0 };
  const { limit, period } = cfg.budget;
  const start = periodStart(period, nowMs);
  const end = periodEnd(period, nowMs);
  const spent = ledger.periodTotal(period, nowMs, projectId);
  const until = cfg.budgetOverrideUntil ? Date.parse(cfg.budgetOverrideUntil) : NaN;
  const overridden = Number.isFinite(until) && until > nowMs;
  return { limited: true, reached: !overridden && spent >= limit, overridden, spent, limit, period, periodStart: start, periodEnd: end };
}
