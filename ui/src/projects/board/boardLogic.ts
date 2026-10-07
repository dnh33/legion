/** Project board UI logic (pure). The server owns the rules; this mirrors only what the window needs to show and to move cards quickly. */
import { BOARD_STATUSES, COLUMN_LABEL } from '../../../../src/shared/board.js';
import type { BoardAssignee, BoardPriority, BoardStatus, WorkItem } from '../../../../src/shared/board.js';

export const COLUMNS: readonly BoardStatus[] = BOARD_STATUSES;
export const columnLabel = (s: BoardStatus): string => COLUMN_LABEL[s];
export const PRIORITY_LABEL: Record<BoardPriority, string> = { low: 'Low', normal: 'Normal', high: 'High' };
/** Priority as text plus a symbol: never colour alone. */
export const priorityMark = (p: BoardPriority): string => (p === 'high' ? '\u25B2 High' : p === 'low' ? '\u25BD Low' : '\u25CF Normal');

export interface Filters { q: string; assignee: 'all' | 'owner' | 'agents' | 'none' | string; status: 'all' | BoardStatus; priority: 'all' | BoardPriority; label: 'all' | string }
export const NO_FILTERS: Filters = { q: '', assignee: 'all', status: 'all', priority: 'all', label: 'all' };
export const hasFilters = (f: Filters): boolean => JSON.stringify(f) !== JSON.stringify(NO_FILTERS);

export function matches(i: WorkItem, f: Filters): boolean {
  if (f.status !== 'all' && i.status !== f.status) return false;
  if (f.priority !== 'all' && i.priority !== f.priority) return false;
  if (f.label !== 'all' && !i.labels.includes(f.label)) return false;
  if (f.assignee !== 'all') {
    const a = i.assignee;
    if (f.assignee === 'none' ? a !== null : f.assignee === 'owner' ? a?.kind !== 'owner' : f.assignee === 'agents' ? a?.kind !== 'agent' : !(a?.kind === 'agent' && a.id === f.assignee)) return false;
  }
  const q = f.q.trim().toLowerCase();
  return !q || i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.labels.some((l) => l.includes(q));
}
export const applyFilters = (items: WorkItem[], f: Filters): WorkItem[] => (hasFilters(f) ? items.filter((i) => matches(i, f)) : items);
export const labelsOf = (items: WorkItem[]): string[] => [...new Set(items.flatMap((i) => i.labels))].sort();

export function byColumn(items: WorkItem[]): Record<BoardStatus, WorkItem[]> {
  const out = { backlog: [], doing: [], review: [], done: [], blocked: [] } as Record<BoardStatus, WorkItem[]>;
  for (const i of [...items].sort((a, b) => a.order - b.order)) out[i.status].push(i);
  return out;
}

/**
 * The same move the server makes (dense order in both columns), so a card can jump at once while the request is on its way.
 * `index` is clamped. Returns a new list; items other than the moved one keep their identity unless their order changed.
 */
export function moveLocal(items: WorkItem[], id: string, status: BoardStatus, index: number): WorkItem[] {
  const cols = byColumn(items);
  const item = items.find((i) => i.id === id);
  if (!item) return items;
  const from = item.status;
  const target = cols[status].filter((i) => i.id !== id);
  const at = Math.max(0, Math.min(Math.trunc(index), target.length));
  target.splice(at, 0, { ...item, status });
  const next = new Map<string, WorkItem>();
  target.forEach((i, n) => next.set(i.id, { ...i, order: n }));
  if (from !== status) cols[from].filter((i) => i.id !== id).forEach((i, n) => next.set(i.id, { ...i, order: n }));
  return items.map((i) => next.get(i.id) ?? i);
}

/** Keyboard: Alt+Left/Right moves to the next column (same row where possible), Alt+Up/Down reorders. null = not a move key. */
export function keyMove(items: WorkItem[], item: WorkItem, key: string): { status: BoardStatus; index: number } | null {
  const col = byColumn(items)[item.status];
  const pos = col.findIndex((i) => i.id === item.id);
  if (key === 'ArrowUp') return pos > 0 ? { status: item.status, index: pos - 1 } : null;
  if (key === 'ArrowDown') return pos >= 0 && pos < col.length - 1 ? { status: item.status, index: pos + 1 } : null;
  const at = COLUMNS.indexOf(item.status) + (key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0);
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const to = COLUMNS[at];
  if (!to) return null;
  return { status: to, index: Math.min(Math.max(pos, 0), byColumn(items)[to].length) };
}

export function moveAnnouncement(title: string, status: BoardStatus, index: number, count: number): string {
  return `${title} moved to ${columnLabel(status)}, position ${index + 1} of ${Math.max(count, index + 1)}.`;
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later';
export function dueState(due: string | undefined, today: string = new Date().toISOString().slice(0, 10)): DueState | undefined {
  if (!due) return undefined;
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  const days = (Date.parse(due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000;
  return days <= 3 ? 'soon' : 'later';
}
export const dueText = (due: string | undefined, today?: string): string => {
  const s = dueState(due, today);
  return !due || !s ? '' : s === 'overdue' ? `Overdue, was due ${due}` : s === 'today' ? 'Due today' : `Due ${due}`;
};

export const assigneeKey = (a: BoardAssignee | null): string => (a === null ? '' : a.kind === 'owner' ? 'owner' : `agent:${a.id}`);
export function parseAssignee(v: string): BoardAssignee | null {
  return v === '' ? null : v === 'owner' ? { kind: 'owner' } : v.startsWith('agent:') ? { kind: 'agent', id: v.slice(6) } : null;
}
export const assigneeLabel = (a: BoardAssignee | null, name: (id: string) => string): string => (a === null ? 'Unassigned' : a.kind === 'owner' ? 'You' : name(a.id));

/** Card name for screen readers: everything the eye sees, in one sentence. */
export function cardLabel(i: WorkItem, name: (id: string) => string, today?: string): string {
  return [i.title, columnLabel(i.status), `${PRIORITY_LABEL[i.priority]} priority`, assigneeLabel(i.assignee, name), dueText(i.due, today), i.labels.length ? `labels ${i.labels.join(', ')}` : '', i.trust === 'untrusted' ? 'written by an agent, not reviewed' : '']
    .filter(Boolean).join(', ');
}

export const DESC_MAX = 2_000;
export const descCounter = (s: string): { label: string; over: boolean } => ({ label: `${s.length} / ${DESC_MAX} characters`, over: s.length > DESC_MAX });

export const FILTER_KEY = (projectId: string): string => `legion.board.filters.${projectId}`;
export function readFilters(raw: string | null): Filters {
  try {
    const o = raw ? JSON.parse(raw) as Partial<Filters> : {};
    const ok = <T extends string>(v: unknown, allowed: readonly string[] | null, d: T): string => (typeof v === 'string' && (!allowed || allowed.includes(v)) ? v : d);
    return {
      q: typeof o.q === 'string' ? o.q.slice(0, 80) : '', assignee: ok(o.assignee, null, 'all'),
      status: ok(o.status, ['all', ...COLUMNS], 'all') as Filters['status'], priority: ok(o.priority, ['all', 'low', 'normal', 'high'], 'all') as Filters['priority'], label: ok(o.label, null, 'all'),
    };
  } catch { return NO_FILTERS; }
}

const clipTo = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);
/**
 * A starting text for "Save what we learned": what the last run said and what the agents noted on the item. The owner edits it before it is saved:
 * agent text is only a draft here, and a run that read outside content is flagged in the dialog.
 */
export function learnDraft(i: WorkItem, name: (id: string) => string): { title: string; body: string } {
  const notes = i.activity.filter((a) => a.kind === 'note' && a.by.kind === 'agent').slice(-6).map((a) => `- ${a.by.kind === 'agent' ? name(a.by.id) : ''}: ${a.text.replace(/\s+/g, ' ').trim()}`);
  const parts = [`Item: ${i.title}`];
  if (i.lastRun?.preview) parts.push(`What the last run reported:\n${i.lastRun.preview.trim()}`);
  if (notes.length) parts.push(`Notes from the agents:\n${notes.join('\n')}`);
  parts.push('What we learned:\n- ');
  return { title: clipTo(`${i.title}: what we learned`, 120), body: clipTo(parts.join('\n\n'), 4000) };
}
/** Offer the note when an item has just been closed and has none yet. */
export const shouldOfferNote = (before: BoardStatus, after: BoardStatus, noteCount: number): boolean => after === 'done' && before !== 'done' && noteCount === 0;

/** The fields of the edit form that differ from the item as the dialog opened it. Only these are sent, so a save cannot overwrite what a run changed meanwhile. */
export function changedFields(item: WorkItem, f: { title: string; description: string; status: BoardStatus; assignee: BoardAssignee | null; priority: BoardPriority; due: string | null; labels: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.title !== item.title) out.title = f.title;
  if (f.description !== item.description) out.description = f.description;
  if (f.status !== item.status) out.status = f.status;
  if (assigneeKey(f.assignee) !== assigneeKey(item.assignee)) out.assignee = f.assignee;
  if (f.priority !== item.priority) out.priority = f.priority;
  if ((f.due ?? null) !== (item.due ?? null)) out.due = f.due;
  if (f.labels.join('\u0000') !== item.labels.join('\u0000')) out.labels = f.labels;
  return out;
}

/** The edit form as the dialog holds it (strings as the inputs show them). */
export interface ItemForm { title: string; description: string; status: BoardStatus; assignee: string; priority: BoardPriority; due: string; labels: string }
export const formOf = (i: WorkItem): ItemForm => ({ title: i.title, description: i.description, status: i.status, assignee: assigneeKey(i.assignee), priority: i.priority, due: i.due ?? '', labels: i.labels.join(', ') });
/** After the item changed under an open dialog: a field the owner had not touched takes the new value; a field the owner edited keeps the edit. */
export function rebaseForm(old: WorkItem, fresh: WorkItem, f: ItemForm): ItemForm {
  const was = formOf(old); const now = formOf(fresh);
  const out = { ...f };
  for (const k of Object.keys(was) as Array<keyof ItemForm>) if (f[k] === was[k]) (out as Record<keyof ItemForm, string>)[k] = now[k];
  return out;
}

/** The line under "Run this item": why it is, or is not, available. */
export function runHint(item: WorkItem, canRun: boolean): string {
  if (item.activeRun) return 'A run is in progress for this item. Wait for it to end.';
  if (item.status === 'done') return 'Move it out of Done to run it again.';
  if (canRun) return 'Runs the assigned agent once, with this item’s text and the project instructions, under its usual approvals. The item moves to Doing, then to Review when the run ends. Only you mark it Done.';
  return 'To run an item, assign it to a member agent first.';
}
