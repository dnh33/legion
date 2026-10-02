/**
 * Which copy of a task row wins when an HTTP answer (POST /api/tasks, GET /api/tasks/:id) meets what the event stream already delivered.
 * Pure (types only). Events always replace the row; only an HTTP snapshot goes through this check, because it can arrive AFTER the events
 * that followed it (a fast run goes queued, running, done before the POST answer is read).
 */
import type { Task } from '../../../src/shared/types.js';

/** Lifecycle position: queued, then running, then any end state. */
const rank = (s: Task['status']): number => (s === 'queued' ? 0 : s === 'running' ? 1 : 2);

/**
 * True when `incoming` may replace `cur`. The later updatedAt wins. Within the same millisecond neither timestamp says which is later, so
 * the more advanced lifecycle state is kept (never move a finished task back to running); equal states take the incoming row.
 */
export function incomingWins(cur: Pick<Task, 'updatedAt' | 'status'> | undefined, incoming: Pick<Task, 'updatedAt' | 'status'>): boolean {
  if (!cur) return true;
  if (cur.updatedAt !== incoming.updatedAt) return incoming.updatedAt > cur.updatedAt;
  return rank(incoming.status) >= rank(cur.status);
}
