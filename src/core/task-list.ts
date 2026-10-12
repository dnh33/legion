/**
 * A run's own task list: the model of Claude Code's TaskCreate/TaskUpdate/TaskList/TaskGet tools, kept by Legion.
 *
 * One model, two uses. A provider run (OpenRouter and the rest) has no Claude Code tools, so Legion offers the same four
 * tools itself (agent-tools.ts) over a list kept here, one file per Legion task, so a continued conversation keeps its list.
 * A Claude run uses Claude Code's own tools; the engine mirrors their calls into a list of this kind (with Claude Code's
 * own ids) only to show the live checklist. Either way the checklist the window shows is `todos()`.
 *
 * It is notes, not an action: the tools never carry a card (approvals.ts READ_ONLY) and never taint a run.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TodoItem } from '../shared/types.js';

export type ListedStatus = 'pending' | 'in_progress' | 'completed';
export interface ListedTask {
  id: string; subject: string; description: string; status: ListedStatus; activeForm?: string;
  /** Tasks that wait for this one. */
  blocks: string[];
  /** Tasks this one waits for. */
  blockedBy: string[];
}
export interface TaskCreateFields { subject: string; description?: string; activeForm?: string }
export interface TaskUpdateFields {
  taskId: string; subject?: string; description?: string; activeForm?: string;
  status?: ListedStatus | 'deleted'; addBlocks?: string[]; addBlockedBy?: string[];
}
/** Claude Code's TaskUpdate answer shape, so a model sees the same result on either runtime. */
export interface TaskUpdateResult {
  success: boolean; taskId: string; updatedFields: string[]; error?: string;
  statusChange?: { from: string; to: string };
}

/** Most tasks one list holds, and the longest subject and description kept. */
export const TASK_LIST_MAX = 100;
const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 4000;

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);
const isStatus = (v: unknown): v is ListedStatus => v === 'pending' || v === 'in_progress' || v === 'completed';
/** Ids as text: Claude Code's are strings, but a number is read as the same id. */
const idOf = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(idOf).filter((x): x is string => x !== undefined) : []);
/** Numeric ids in number order first, then any other ids in text order: one total order, the same every time. */
const byId = (a: string, b: string): number => {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (!Number.isNaN(na)) return -1;
  if (!Number.isNaN(nb)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

export class TaskList {
  private readonly tasks = new Map<string, ListedTask>();
  private nextId = 1;
  /** A provider run changed the list since a Claude run last saw it: the next Claude run is handed it over. */
  handoverPending = false;

  /** `id` is given only when mirroring a list numbered elsewhere (Claude Code's); the next own id then follows it. */
  create(f: TaskCreateFields, id?: string): ListedTask {
    const subject = typeof f.subject === 'string' ? f.subject.trim() : '';
    if (!subject) throw new Error('A task needs a subject (a short title).');
    if (this.tasks.size >= TASK_LIST_MAX) throw new Error(`The task list holds at most ${TASK_LIST_MAX} tasks. Finish or delete some first.`);
    const key = id ?? String(this.nextId);
    const n = Number(key);
    if (Number.isInteger(n) && n >= this.nextId) this.nextId = n + 1;
    const active = typeof f.activeForm === 'string' ? f.activeForm.trim() : '';
    const t: ListedTask = {
      id: key, subject: clip(subject, SUBJECT_MAX), description: clip(typeof f.description === 'string' ? f.description : '', DESCRIPTION_MAX),
      status: 'pending', ...(active ? { activeForm: clip(active, SUBJECT_MAX) } : {}), blocks: [], blockedBy: [],
    };
    this.tasks.set(key, t);
    return { ...t, blocks: [], blockedBy: [] };
  }

  update(u: TaskUpdateFields): TaskUpdateResult {
    const taskId = String(u.taskId ?? '');
    const t = this.tasks.get(taskId);
    const refuse = (error: string): TaskUpdateResult => ({ success: false, taskId, updatedFields: [], error });
    if (!t) return refuse(`There is no task #${taskId}.`);
    if (u.status === 'deleted') {
      this.tasks.delete(taskId);
      for (const o of this.tasks.values()) { o.blocks = o.blocks.filter((x) => x !== taskId); o.blockedBy = o.blockedBy.filter((x) => x !== taskId); }
      return { success: true, taskId, updatedFields: ['status'], statusChange: { from: t.status, to: 'deleted' } };
    }
    // every link is checked before anything changes, so a refused update leaves the list as it was
    const links = [...strs(u.addBlocks), ...strs(u.addBlockedBy)];
    if (links.includes(taskId)) return refuse('A task cannot block itself.');
    const unknown = links.filter((x) => !this.tasks.has(x));
    if (unknown.length) return refuse(`There is no task #${unknown.join(', #')}.`);
    if (u.status !== undefined && !isStatus(u.status)) return refuse('status must be pending, in_progress, completed or deleted.');

    const fields: string[] = [];
    if (typeof u.subject === 'string' && u.subject.trim() && u.subject.trim() !== t.subject) { t.subject = clip(u.subject.trim(), SUBJECT_MAX); fields.push('subject'); }
    if (typeof u.description === 'string' && u.description !== t.description) { t.description = clip(u.description, DESCRIPTION_MAX); fields.push('description'); }
    if (typeof u.activeForm === 'string' && u.activeForm.trim() !== (t.activeForm ?? '')) {
      const a = u.activeForm.trim();
      if (a) t.activeForm = clip(a, SUBJECT_MAX); else delete t.activeForm;
      fields.push('activeForm');
    }
    for (const b of strs(u.addBlocks)) this.link(t.id, b);
    for (const b of strs(u.addBlockedBy)) this.link(b, t.id);
    if (strs(u.addBlocks).length) fields.push('blocks');
    if (strs(u.addBlockedBy).length) fields.push('blockedBy');
    let statusChange: TaskUpdateResult['statusChange'];
    if (u.status !== undefined && u.status !== t.status) { statusChange = { from: t.status, to: u.status }; t.status = u.status; fields.push('status'); }
    return { success: true, taskId, updatedFields: fields, ...(statusChange ? { statusChange } : {}) };
  }

  /** `first` blocks `then` (then waits for first). Both sides are kept, each link once. */
  private link(first: string, then: string): void {
    const a = this.tasks.get(first)!;
    const b = this.tasks.get(then)!;
    if (!a.blocks.includes(then)) a.blocks.push(then);
    if (!b.blockedBy.includes(first)) b.blockedBy.push(first);
  }

  get(id: string): ListedTask | null {
    const t = this.tasks.get(String(id));
    return t ? { ...t, blocks: [...t.blocks], blockedBy: [...t.blockedBy] } : null;
  }

  /** Every task, in id order. */
  list(): ListedTask[] {
    return [...this.tasks.keys()].sort(byId).map((id) => this.get(id)!);
  }

  /** The live checklist the window shows (the same shape a TodoWrite list gives). */
  todos(): TodoItem[] {
    return this.list().map((t) => ({ content: t.subject, status: t.status, ...(t.activeForm ? { activeForm: t.activeForm } : {}) }));
  }

  toJSON(): { nextId: number; handoverPending: boolean; tasks: ListedTask[] } { return { nextId: this.nextId, handoverPending: this.handoverPending, tasks: this.list() }; }

  /** Rebuilds a stored list. Anything damaged is dropped, never trusted: a task without an id or subject, an unknown status (pending), a dangling link. */
  static fromJSON(raw: unknown): TaskList {
    const l = new TaskList();
    const o = raw && typeof raw === 'object' ? raw as { nextId?: unknown; handoverPending?: unknown; tasks?: unknown } : {};
    for (const t of Array.isArray(o.tasks) ? o.tasks : []) {
      if (!t || typeof t !== 'object') continue;
      const r = t as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id || typeof r.subject !== 'string' || !r.subject.trim() || l.tasks.size >= TASK_LIST_MAX) continue;
      const made = l.create({ subject: r.subject, description: typeof r.description === 'string' ? r.description : '', ...(typeof r.activeForm === 'string' ? { activeForm: r.activeForm } : {}) }, r.id);
      const kept = l.tasks.get(made.id)!;
      if (isStatus(r.status)) kept.status = r.status;
      kept.blocks = strs(r.blocks);
      kept.blockedBy = strs(r.blockedBy);
    }
    for (const t of l.tasks.values()) { t.blocks = t.blocks.filter((x) => l.tasks.has(x)); t.blockedBy = t.blockedBy.filter((x) => l.tasks.has(x)); }
    // links are kept on both sides: a list that names only one side (Claude Code's TaskList gives blockedBy alone) gets the other
    for (const t of l.tasks.values()) {
      for (const b of t.blockedBy) { const o = l.tasks.get(b)!; if (!o.blocks.includes(t.id)) o.blocks.push(t.id); }
      for (const b of t.blocks) { const o = l.tasks.get(b)!; if (!o.blockedBy.includes(t.id)) o.blockedBy.push(t.id); }
    }
    if (typeof o.nextId === 'number' && Number.isInteger(o.nextId) && o.nextId > l.nextId) l.nextId = o.nextId;
    l.handoverPending = o.handoverPending === true;
    return l;
  }
}

export const TASK_LIST_HEADER = '[Your task list for this conversation, kept by Legion]';
const MAX_OPEN_SHOWN = 40;
const MAX_DONE_CHARS = 1500;

/** The list as the model is shown it again: open items in full, done titles on one line. Undefined for an empty list. */
export function renderForModel(list: TaskList): string | undefined {
  const all = list.list();
  if (!all.length) return undefined;
  const open = all.filter((t) => t.status !== 'completed');
  const done = all.filter((t) => t.status === 'completed');
  const lines = [TASK_LIST_HEADER];
  for (const t of open.slice(0, MAX_OPEN_SHOWN)) {
    const waits = t.blockedBy.length ? `; waits for ${t.blockedBy.join(', ')}` : '';
    lines.push(`- [${t.status === 'in_progress' ? '>' : ' '}] ${t.id}. ${t.subject} (${t.status === 'in_progress' ? 'in progress' : 'pending'}${waits})`);
  }
  if (open.length > MAX_OPEN_SHOWN) lines.push(`${open.length - MAX_OPEN_SHOWN} more open tasks are not shown.`);
  if (done.length) {
    let line = 'Done: ';
    let shown = 0;
    for (const t of done) {
      const part = `${shown ? '; ' : ''}${t.id}. ${t.subject}`;
      if (line.length + part.length > MAX_DONE_CHARS) break;
      line += part; shown++;
    }
    if (shown < done.length) line += ` (and ${done.length - shown} more done)`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** The hand-over to a Claude run whose own list may be behind: the list, and how to make Claude's own list match. */
export function renderHandover(list: TaskList): string | undefined {
  const body = renderForModel(list);
  if (!body) return undefined;
  return `${body}\nThis conversation's task list changed while another model was working on it. Call TaskList, then make your own list match the one above: TaskCreate for each open task you do not have, TaskUpdate for any status that differs. Do this before other work.`;
}

/** One JSON file per Legion task under `dir`. A missing or unreadable file is an empty list; a failed write is reported to the caller. */
export class TaskListStore {
  constructor(private readonly dir: string) {}

  private file(taskId: string): string { return join(this.dir, `${taskId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`); }

  load(taskId: string): TaskList {
    try { return TaskList.fromJSON(JSON.parse(readFileSync(this.file(taskId), 'utf8'))); } catch { return new TaskList(); }
  }

  save(taskId: string, list: TaskList): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(taskId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(list), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  }

  /** The task was deleted: its list goes with it. */
  remove(taskId: string): void {
    rmSync(this.file(taskId), { force: true });
  }
}

/** Claude Code's own task tools. Their calls are mirrored into a TaskList on a Claude run, only for the live checklist. */
export const CLAUDE_TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TaskList']);

/**
 * Applies one finished call of Claude Code's task tools to the mirror. A new task's id arrives only in the result
 * (`tool_use_result.task.id`, or the "Task #N created" text when no structured result came with it), so the call and
 * its result are paired by the caller. A refused call (an error result, success:false) changes nothing. A TaskList
 * result replaces the mirror outright: on a Claude run Claude Code's own list is the truth.
 * Returns the list to keep, or null when nothing changed.
 */
export function mirrorClaudeTaskCall(list: TaskList, call: { name: string; input: unknown }, result: { structured?: unknown; text: string; isError: boolean }): TaskList | null {
  if (result.isError) return null;
  const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
  const out = (result.structured && typeof result.structured === 'object' ? result.structured : {}) as Record<string, unknown>;
  try {
    if (call.name === 'TaskCreate') {
      const task = out.task as { id?: unknown } | undefined;
      const id = idOf(task?.id) ?? /Task #(\S+) created/.exec(result.text)?.[1];
      if (!id) return null;
      list.create({ subject: String(input.subject ?? ''), description: typeof input.description === 'string' ? input.description : '', ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm } : {}) }, id);
      return list;
    }
    if (call.name === 'TaskUpdate') {
      if (out.success === false) return null;
      return list.update(input as unknown as TaskUpdateFields).success ? list : null;
    }
    if (call.name === 'TaskList' && Array.isArray(out.tasks)) {
      // merged by id: the result carries status and links but not activeForm or description, which the mirror keeps
      const tasks = out.tasks.map((t) => {
        const r = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        const id = idOf(r.id);
        const had = id ? list.get(id) : null;
        return { ...r, id, description: had?.description ?? '', ...(had?.activeForm ? { activeForm: had.activeForm } : {}) };
      });
      return TaskList.fromJSON({ tasks });
    }
  } catch { /* a mirror that cannot follow a call keeps what it had */ }
  return null;
}
