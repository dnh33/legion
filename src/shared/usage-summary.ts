/**
 * Claude usage, summed from the tasks Legion already stores. Pure, so the core test suite can pin the clock.
 *
 * What it counts: `costUsd` and `turns` as the Agent SDK reported them, per task. Both are cumulative over the task's life, so a
 * task is counted once, on the local day it last ran (`updatedAt`). A task that spanned midnight therefore lands wholly on the
 * later day: close enough for a glance, and the panel says so. Tasks from other providers carry no cost and are never given one.
 */
import { localDay, localDayStart } from './vm-usage.js';

export interface UsageTask { agentId: string; model?: string; provider?: string; costUsd?: number; turns?: number; updatedAt: string }
export interface UsageRow { key: string; costUsd: number; turns: number; tasks: number }
export interface UsageRange { costUsd: number; turns: number; tasks: number; byModel: UsageRow[]; byAgent: UsageRow[] }
export interface UsageSummary {
  generatedAt: string;
  today: UsageRange; days7: UsageRange; days30: UsageRange;
  /** The last 14 local days, oldest first, zero-filled. */
  daily: Array<{ day: string; costUsd: number }>;
}

const DAY = 86_400_000;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function range(tasks: readonly UsageTask[]): UsageRange {
  const sum = (key: (t: UsageTask) => string): UsageRow[] => {
    const m = new Map<string, UsageRow>();
    for (const t of tasks) {
      const k = key(t);
      const r = m.get(k) ?? { key: k, costUsd: 0, turns: 0, tasks: 0 };
      r.costUsd += num(t.costUsd); r.turns += num(t.turns); r.tasks += 1;
      m.set(k, r);
    }
    return [...m.values()].sort((a, b) => b.costUsd - a.costUsd || b.tasks - a.tasks || a.key.localeCompare(b.key));
  };
  return {
    costUsd: tasks.reduce((n, t) => n + num(t.costUsd), 0), turns: tasks.reduce((n, t) => n + num(t.turns), 0), tasks: tasks.length,
    byModel: sum((t) => (t.model ? (t.provider ? `${t.provider}:${t.model}` : t.model) : 'unknown')),
    byAgent: sum((t) => t.agentId),
  };
}

export function summariseUsage(all: readonly UsageTask[], nowMs: number): UsageSummary {
  const start = localDayStart(nowMs);
  const dated = all.map((t) => ({ t, ms: Date.parse(t.updatedAt) })).filter((x) => Number.isFinite(x.ms) && x.ms <= nowMs + DAY);
  const since = (days: number) => dated.filter((x) => x.ms >= start - (days - 1) * DAY).map((x) => x.t);
  const daily: UsageSummary['daily'] = [];
  for (let i = 13; i >= 0; i--) {
    const day = localDay(start - i * DAY + DAY / 2); // mid-day of that date, immune to a 23 or 25 hour DST day
    daily.push({ day, costUsd: dated.filter((x) => localDay(x.ms) === day).reduce((n, x) => n + num(x.t.costUsd), 0) });
  }
  return { generatedAt: new Date(nowMs).toISOString(), today: range(since(1)), days7: range(since(7)), days30: range(since(30)), daily };
}
