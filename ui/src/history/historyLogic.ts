/**
 * The history list's logic, pure (types only) so node tests can run it: merging pages, following live events, picking the rows to draw.
 * The component is ui/src/history/HistoryList.tsx, the data comes from GET /api/tasks (src/core/task-index.ts is the index behind it).
 */
import type { Task, TasksPage } from '../../../src/shared/types.js';

export const ROW_H = 30;
export const PAGE = 50;
export const SEARCH_DEBOUNCE_MS = 200;

export interface HistoryState {
  rows: Task[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  /** True once a first page for the current query has arrived (an empty list before that is "loading", not "no tasks"). */
  loaded: boolean;
}
export const emptyHistory = (): HistoryState => ({ rows: [], nextCursor: null, loading: false, error: null, loaded: false });

/** Appends a page, dropping rows already shown (a task can be in two pages if it was updated between them). `replace` starts the list over. */
export function mergePage(cur: HistoryState, page: TasksPage, replace: boolean): HistoryState {
  const base = replace ? [] : cur.rows;
  const seen = new Set(base.map((t) => t.id));
  const add = page.tasks.filter((t) => !seen.has(t.id));
  return { rows: [...base, ...add], nextCursor: page.nextCursor, loading: false, error: null, loaded: true };
}

type LiveEvent = { type: 'task.updated'; task: Task } | { type: 'task.deleted'; taskId: string } | { type: string };

/**
 * Keeps the rows in step with the event stream without refetching: an updated row is replaced where it stands (the list re-sorts when it is
 * next opened), a deleted one goes, a closed one goes unless closed tasks are shown. A task the list has not loaded is not added: it is newer
 * than the first page's cursor in order only if it was just created, and the list reloads each time it opens.
 */
export function applyLiveEvent(cur: HistoryState, e: LiveEvent, includeClosed: boolean): HistoryState {
  if (e.type === 'task.deleted') {
    const id = (e as { taskId: string }).taskId;
    return cur.rows.some((t) => t.id === id) ? { ...cur, rows: cur.rows.filter((t) => t.id !== id) } : cur;
  }
  if (e.type === 'task.updated') {
    const t = (e as { task: Task }).task;
    const i = cur.rows.findIndex((x) => x.id === t.id);
    if (i < 0) return cur;
    if (t.archived && !includeClosed) return { ...cur, rows: cur.rows.filter((x) => x.id !== t.id) };
    const rows = cur.rows.slice(); rows[i] = { ...t }; delete rows[i]!.result;
    return { ...cur, rows };
  }
  return cur;
}

/** Rows to draw for a scroll position: a fixed row height makes this arithmetic, so 10,000 loaded rows cost the same as 20. */
export function windowRange(scrollTop: number, viewH: number, count: number, rowH = ROW_H, overscan = 4): { start: number; end: number } {
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const visible = Math.ceil(Math.max(0, viewH) / rowH);
  return { start: Math.max(0, first - overscan), end: Math.min(count, first + visible + overscan) };
}

/** Time to fetch the next page: the window reaches within `ahead` rows of the end and there is more. */
export const needsMore = (s: HistoryState, end: number, ahead = 12): boolean => !!s.nextCursor && !s.loading && !s.error && end >= s.rows.length - ahead;

/** The scroll position that brings row `i` fully into a viewport (unchanged when it already is). */
export function scrollToRow(i: number, scrollTop: number, viewH: number, rowH = ROW_H): number {
  const top = i * rowH, bottom = top + rowH;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewH) return bottom - viewH;
  return scrollTop;
}

/** The status line under the search box (also read out by screen readers). */
export function historyStatus(s: HistoryState, q: string): string {
  if (s.error) return `Could not load: ${s.error}`;
  if (!s.loaded) return 'Loading…';
  if (s.rows.length === 0) return q.trim() ? 'No tasks match.' : 'No tasks yet.';
  const n = s.rows.length;
  return `${n}${s.nextCursor ? '+' : ''} task${n === 1 ? '' : 's'}${q.trim() ? ' match' : ''}${s.loading ? ', loading more…' : ''}`;
}

/**
 * What /api/state?slim=1 gave us, plus the tasks the window still needs that the snapshot left out (the open one, whatever came in from a history
 * page). Without this a refresh (reconnect) would drop the selected task from the store while it is on screen.
 */
export function keepTasks(prev: readonly Task[], incoming: readonly Task[], keepIds: ReadonlySet<string>): Task[] {
  const have = new Set(incoming.map((t) => t.id));
  return [...incoming, ...prev.filter((t) => keepIds.has(t.id) && !have.has(t.id))];
}
