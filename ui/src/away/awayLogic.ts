/** Pure helpers for Settings, Notifications and Spending (no DOM). Period math is the core's own: src/shared/spend-periods.ts. */
import { periodEnd } from '../../../src/shared/spend-periods.js';

export interface QuietView { enabled: boolean; from: string; to: string }

/** Dollars as the owner reads them. A real but tiny amount is never shown as zero. */
export function money(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.005) return 'under $0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `Resets Monday 19 October`: the budget week is local, ISO, and ends Monday 00:00. */
export function weekResetLabel(nowMs: number): string {
  const d = new Date(periodEnd('week', nowMs));
  return `Resets Monday ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Bar heights in percent (0 to 100). The biggest day is 100; a day with any spend is at least 4 so it can be seen. */
export function barHeights(daily: ReadonlyArray<{ day?: string; usd: number }>): number[] {
  const max = Math.max(0, ...daily.map((d) => d.usd));
  if (max <= 0) return daily.map(() => 0);
  return daily.map((d) => (d.usd <= 0 ? 0 : Math.max(4, Math.round((d.usd / max) * 100))));
}

/** `Wed`, or `Wed 14` for the label that also gives the date. `day` is a local `YYYY-MM-DD`. */
export function dayLabel(day: string, withDate = false): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return withDate ? `${DAYS[dt.getDay()]} ${d}` : DAYS[dt.getDay()]!;
}

export interface SpendRow { id: string; label: string; usd: number }
/** Rows for "by project": the name from `names`, `none` for a run with no project, `gone` for a project that no longer exists. */
export function spendRows(rows: ReadonlyArray<{ projectId: string | null; usd: number }>, names: Record<string, string>, none: string, gone: string): SpendRow[] {
  return rows.map((r) => ({ id: r.projectId ?? '', label: r.projectId === null ? none : names[r.projectId] ?? gone, usd: r.usd }));
}

export const SPEND_NOTE = 'Cost is counted per run since 0.3.0. Older tasks are shown on the day they were last updated.';

export function quietProblem(q: QuietView): string | null {
  if (!q.enabled) return null;
  if (!q.from || !q.to) return 'Pick a start and an end time.';
  if (q.from === q.to) return 'Pick two different times.';
  return null;
}
export function notificationsLine(q: QuietView): string {
  return q.enabled ? `Quiet from ${q.from} to ${q.to}. Asks keep waiting; you get one summary when it ends.` : 'Quiet hours are off.';
}
