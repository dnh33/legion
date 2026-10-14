/**
 * Budget periods in local time (spec 4.7): a day, an ISO week that starts Monday 00:00 ("until Monday"), a calendar month.
 * Built from local date fields, never "+ 24 h", so a 23 or 25 hour day keeps the same clock times. Pure.
 */
export type SpendPeriod = 'day' | 'week' | 'month';

/** Start of the period that contains `ms`. */
export function periodStart(period: SpendPeriod, ms: number): number {
  const d = new Date(ms);
  if (period === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (period === 'week') {
    const sinceMonday = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime();
  }
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Start of the next period (the end of the one that contains `ms`). */
export function periodEnd(period: SpendPeriod, ms: number): number {
  const s = new Date(periodStart(period, ms));
  if (period === 'day') return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1).getTime();
  if (period === 'week') return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7).getTime();
  return new Date(s.getFullYear(), s.getMonth() + 1, 1).getTime();
}
