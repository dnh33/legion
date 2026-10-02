/** Project board store: one JSONL log per project (<dataDir>/board/<projectId>.jsonl). See claude/plan-project-board.md. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_LIMITS, BOARD_PRIORITIES, BOARD_STATUSES, BOT_STATUSES, WORK_ITEM_ID_RE } from '../../../shared/board.js';
import type { ActivityEntry, BoardActor, BoardAssignee, BoardPriority, BoardStatus, BoardView, WorkItem } from '../../../shared/board.js';
import { PROJECT_ID_RE } from '../../../shared/projects.js';
import type { Project } from '../../../shared/projects.js';
import { newId, nowIso } from '../../../shared/util.js';
import { findForbiddenSecret, scrubSecrets } from '../../comms/scrub.js';

export class BoardError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'BoardError'; }
}

/** The part of a project the store needs; the caller reads it from the ProjectStore at the moment of the call. */
export type ProjectRef = Pick<Project, 'id' | 'members' | 'status'>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanText = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export const cleanTitle = (v: unknown): string => {
  if (typeof v !== 'string') throw new BoardError(400, 'title must be a string');
  const t = oneLine(v);
  if (!t) throw new BoardError(400, 'title must not be empty');
  if (t.length > BOARD_LIMITS.titleChars) throw new BoardError(400, `title is too long (max ${BOARD_LIMITS.titleChars} characters)`);
  return t;
};
/** Clipped, not refused (the dialog shows a counter), like project instructions. */
export const cleanDescription = (v: unknown): string => {
  if (typeof v !== 'string') throw new BoardError(400, 'description must be a string');
  return clip(cleanText(v), BOARD_LIMITS.descriptionChars);
};
export const cleanLabels = (v: unknown): string[] => {
  if (!Array.isArray(v)) throw new BoardError(400, 'labels must be an array');
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') throw new BoardError(400, 'a label must be a string');
    const l = oneLine(x).toLowerCase();
    if (!l) continue;
    if (l.length > BOARD_LIMITS.labelChars || !/^[a-z0-9][a-z0-9 -]*$/.test(l)) throw new BoardError(400, `label "${clip(l, 30)}" must be 1-${BOARD_LIMITS.labelChars} characters: letters, digits, spaces, hyphens`);
    if (!out.includes(l)) out.push(l);
  }
  if (out.length > BOARD_LIMITS.labels) throw new BoardError(400, `at most ${BOARD_LIMITS.labels} labels per item`);
  return out;
};
export const cleanDue = (v: unknown): string | undefined => {
  if (v === null || v === '') return undefined;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BoardError(400, 'due must be a date like 2026-12-31');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new BoardError(400, 'due is not a real date');
  return v;
};
const cleanPriority = (v: unknown): BoardPriority => {
  if (!BOARD_PRIORITIES.includes(v as BoardPriority)) throw new BoardError(400, `priority must be one of ${BOARD_PRIORITIES.join(', ')}`);
  return v as BoardPriority;
};
export const cleanStatus = (v: unknown): BoardStatus => {
  if (!BOARD_STATUSES.includes(v as BoardStatus)) throw new BoardError(400, `status must be one of ${BOARD_STATUSES.join(', ')}`);
  return v as BoardStatus;
};
/** Wire form: null, {kind:'owner'} or {kind:'agent', id}. The agent must be a member of the project. */
export function cleanAssignee(v: unknown, proj: ProjectRef): BoardAssignee | null {
  if (v === null) return null;
  if (isObj(v) && v.kind === 'owner') return { kind: 'owner' };
  if (isObj(v) && v.kind === 'agent' && typeof v.id === 'string') {
    if (!proj.members.includes(v.id)) throw new BoardError(400, `"${clip(v.id, 40)}" is not a member of this project`);
    return { kind: 'agent', id: v.id };
  }
  throw new BoardError(400, 'assignee must be null, {"kind":"owner"} or {"kind":"agent","id":...}');
}
/** Text a bot wrote: refused when it holds a seed phrase or private key, otherwise credentials are redacted. */
export function botText(s: string, what: string): string {
  const bad = findForbiddenSecret(s);
  if (bad) throw new BoardError(400, `${what} looks like it contains a ${bad}; nothing was saved. Never put secrets in the board.`);
  return scrubSecrets(s, { keepHex: true });
}

const KNOWN = new Set(['id', 'projectId', 'title', 'description', 'status', 'assignee', 'due', 'priority', 'labels', 'order', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'trust', 'proposal', 'taskIds', 'roomIds', 'activeRun', 'lastRun', 'activity']);

const asActor = (v: unknown): BoardActor => {
  if (isObj(v) && v.kind === 'owner') return { kind: 'owner' };
  if (isObj(v) && v.kind === 'agent' && typeof v.id === 'string') return { kind: 'agent', id: clip(v.id, 64), ...(v.tainted === true ? { tainted: true } : {}) };
  return { kind: 'system' };
};
const strArr = (v: unknown, max: number, each = 64): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => clip(x, each)))].slice(-max) : []);

/** Reads one stored snapshot, tolerant: never throws, clips and coerces every field; unknown fields are returned apart. */
function loadItem(raw: unknown, projectId: string): { item: WorkItem; extra: Record<string, unknown> } | undefined {
  if (!isObj(raw) || typeof raw.id !== 'string' || !WORK_ITEM_ID_RE.test(raw.id) || typeof raw.title !== 'string') return undefined;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k)) extra[k] = v;
  const now = nowIso();
  const a = raw.assignee;
  const lr = raw.lastRun;
  const item: WorkItem = {
    id: raw.id, projectId,
    title: oneLine(raw.title).slice(0, BOARD_LIMITS.titleChars) || 'Untitled',
    description: typeof raw.description === 'string' ? clip(cleanText(raw.description), BOARD_LIMITS.descriptionChars) : '',
    status: BOARD_STATUSES.includes(raw.status as BoardStatus) ? (raw.status as BoardStatus) : 'backlog',
    assignee: isObj(a) && a.kind === 'owner' ? { kind: 'owner' } : isObj(a) && a.kind === 'agent' && typeof a.id === 'string' ? { kind: 'agent', id: clip(a.id, 64) } : null,
    ...(typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due) ? { due: raw.due } : {}),
    priority: BOARD_PRIORITIES.includes(raw.priority as BoardPriority) ? (raw.priority as BoardPriority) : 'normal',
    labels: Array.isArray(raw.labels) ? raw.labels.filter((l): l is string => typeof l === 'string' && /^[a-z0-9][a-z0-9 -]{0,23}$/.test(l)).slice(0, BOARD_LIMITS.labels) : [],
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0,
    createdBy: asActor(raw.createdBy), updatedBy: asActor(raw.updatedBy),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    // anything that is not plainly "human" is untrusted: a damaged or foreign value never widens trust
    trust: raw.trust === 'human' ? 'human' : 'untrusted',
    ...(isObj(raw.proposal) ? { proposal: { ...(typeof raw.proposal.suggestedAssignee === 'string' ? { suggestedAssignee: clip(raw.proposal.suggestedAssignee, 64) } : {}) } } : {}),
    taskIds: strArr(raw.taskIds, BOARD_LIMITS.taskLinks), roomIds: strArr(raw.roomIds, BOARD_LIMITS.roomLinks),
    ...(typeof raw.activeRun === 'string' ? { activeRun: clip(raw.activeRun, 64) } : {}),
    ...(isObj(lr) && typeof lr.taskId === 'string' ? { lastRun: { taskId: clip(lr.taskId, 64), status: clip(String(lr.status ?? ''), 20), endedAt: typeof lr.endedAt === 'string' ? lr.endedAt : now, tainted: lr.tainted === true, preview: clip(typeof lr.preview === 'string' ? lr.preview : '', BOARD_LIMITS.previewChars) } } : {}),
    activity: Array.isArray(raw.activity) ? raw.activity.filter(isObj).slice(-BOARD_LIMITS.activityEntries).map((e) => ({ at: typeof e.at === 'string' ? e.at : now, by: asActor(e.by), kind: clip(String(e.kind ?? 'note'), 20), text: clip(String(e.text ?? ''), BOARD_LIMITS.noteChars) })) : [],
  };
  return { item, extra };
}

class Board {
  readonly items = new Map<string, WorkItem>();
  readonly extras = new Map<string, Record<string, unknown>>();
  /** Lines written by a later build (v > 1): kept and written back on compaction. */
  foreign: string[] = [];
  lines = 0;
  constructor(readonly file: string, readonly projectId: string) {}
}

export class BoardStore {
  private readonly boards = new Map<string, Board>();
  private readonly proposals = new Map<string, number[]>();
  private readonly botWrites = new Map<string, number[]>();

  constructor(private readonly dir: string, private readonly clock: () => number = Date.now) {}

  private board(pid: string): Board {
    if (!PROJECT_ID_RE.test(pid)) throw new BoardError(404, 'Unknown project');
    let b = this.boards.get(pid);
    if (b) return b;
    mkdirSync(this.dir, { recursive: true });
    b = new Board(join(this.dir, `${pid}.jsonl`), pid);
    this.boards.set(pid, b);
    this.load(b);
    return b;
  }

  private load(b: Board): void {
    if (!existsSync(b.file)) return;
    try {
      if (statSync(b.file).size > BOARD_LIMITS.fileBytes) throw new Error('too large');
      for (const line of readFileSync(b.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        b.lines++;
        let rec: unknown;
        try { rec = JSON.parse(line); } catch { continue; } // a torn last line, or damage: that line only is skipped
        if (!isObj(rec)) continue;
        if (typeof rec.v === 'number' && rec.v > 1) { b.foreign.push(line); continue; }
        if (rec.kind === 'delete' && typeof rec.id === 'string') { b.items.delete(rec.id); b.extras.delete(rec.id); continue; }
        if (rec.kind === 'item') {
          const r = loadItem(rec.item, b.projectId);
          if (r) { b.items.set(r.item.id, r.item); if (Object.keys(r.extra).length) b.extras.set(r.item.id, r.extra); else b.extras.delete(r.item.id); }
        }
      }
    } catch {
      b.items.clear(); b.extras.clear(); b.foreign = []; b.lines = 0;
      try { renameSync(b.file, b.file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
    }
  }

  private append(b: Board, rec: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(b.file, JSON.stringify(rec) + '\n', 'utf8');
    b.lines++;
    if (b.lines > b.items.size * 3 + 200) this.compact(b);
  }
  private save(b: Board, item: WorkItem): void {
    this.append(b, { v: 1, kind: 'item', at: nowIso(), item: { ...(b.extras.get(item.id) ?? {}), ...item } });
  }
  private drop(b: Board, id: string): void {
    b.items.delete(id); b.extras.delete(id);
    this.append(b, { v: 1, kind: 'delete', at: nowIso(), id });
  }

  /** Rewrites the log as one snapshot per live item (tmp file, then rename). A failure leaves the old log valid. */
  compact(b: Board): void {
    const at = nowIso();
    const text = [
      ...b.foreign,
      ...[...b.items.values()].map((i) => JSON.stringify({ v: 1, kind: 'item', at, item: { ...(b.extras.get(i.id) ?? {}), ...i } })),
    ].join('\n') + '\n';
    const tmp = b.file + '.tmp';
    try {
      writeFileSync(tmp, text, 'utf8');
      try { renameSync(tmp, b.file); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EEXIST') { unlinkSync(b.file); renameSync(tmp, b.file); } else throw e;
      }
      b.lines = b.items.size + b.foreign.length;
    } catch { try { unlinkSync(tmp); } catch { /* ignore */ } }
  }

  // ------------------------------------------------------------------ reads

  private column(b: Board, status: BoardStatus): WorkItem[] {
    return [...b.items.values()].filter((i) => !i.proposal && i.status === status).sort((x, y) => x.order - y.order || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
  }
  view(proj: ProjectRef): BoardView {
    const b = this.board(proj.id);
    const items = BOARD_STATUSES.flatMap((s) => this.column(b, s)).map((i) => structuredClone(i));
    const inbox = [...b.items.values()].filter((i) => i.proposal).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((i) => structuredClone(i));
    return { items, inbox, archived: proj.status === 'archived' };
  }
  /** One item of this project (an id from another project is simply not found). */
  get(pid: string, id: string): WorkItem | undefined {
    const i = this.board(pid).items.get(id);
    return i ? structuredClone(i) : undefined;
  }
  count(pid: string): number { return this.board(pid).items.size; }

  // ------------------------------------------------------------------ helpers

  private writable(proj: ProjectRef): Board {
    if (proj.status === 'archived') throw new BoardError(409, 'This project is archived: its board is read-only. Unarchive it first.');
    return this.board(proj.id);
  }
  private must(b: Board, id: string): WorkItem {
    const i = b.items.get(id);
    if (!i) throw new BoardError(404, `Unknown item "${clip(id, 40)}"`);
    return i;
  }
  private note(i: WorkItem, by: BoardActor, kind: string, text: string): void {
    i.activity.push({ at: nowIso(), by, kind, text: clip(text, BOARD_LIMITS.noteChars) });
    if (i.activity.length > BOARD_LIMITS.activityEntries) i.activity.splice(0, i.activity.length - BOARD_LIMITS.activityEntries);
  }
  private touch(i: WorkItem, by: BoardActor): void { i.updatedBy = by; i.updatedAt = nowIso(); }
  /** Dense 0..n-1 order in a column; saves the items whose position changed. */
  private renumber(b: Board, status: BoardStatus, skip?: string): void {
    this.column(b, status).forEach((i, n) => { if (i.order !== n) { i.order = n; if (i.id !== skip) this.save(b, i); } });
  }
  private atEnd(b: Board, status: BoardStatus, except?: string): number { return this.column(b, status).filter((i) => i.id !== except).length; }
  private tick(map: Map<string, number[]>, key: string, max: number, windowMs: number, msg: string): void {
    const now = this.clock();
    const list = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) { map.set(key, list); throw new BoardError(429, msg); }
    list.push(now); map.set(key, list);
  }

  // ------------------------------------------------------------------ owner writes

  create(proj: ProjectRef, input: { title?: unknown; description?: unknown; status?: unknown; assignee?: unknown; due?: unknown; priority?: unknown; labels?: unknown }, by: BoardActor = { kind: 'owner' }): WorkItem {
    const b = this.writable(proj);
    if (b.items.size >= BOARD_LIMITS.itemsPerProject) throw new BoardError(409, `A board holds at most ${BOARD_LIMITS.itemsPerProject} items. Delete finished ones.`);
    const status = input.status === undefined ? 'backlog' : cleanStatus(input.status);
    const due = input.due === undefined ? undefined : cleanDue(input.due);
    const now = nowIso();
    let id = '';
    do { id = newId('wi'); } while (b.items.has(id));
    const item: WorkItem = {
      id, projectId: proj.id, title: cleanTitle(input.title), description: input.description === undefined ? '' : cleanDescription(input.description),
      status, assignee: input.assignee === undefined ? null : cleanAssignee(input.assignee, proj), ...(due ? { due } : {}),
      priority: input.priority === undefined ? 'normal' : cleanPriority(input.priority), labels: input.labels === undefined ? [] : cleanLabels(input.labels),
      order: this.atEnd(b, status), createdBy: by, updatedBy: by, createdAt: now, updatedAt: now, trust: 'human', taskIds: [], roomIds: [], activity: [],
    };
    this.note(item, by, 'created', 'Created');
    b.items.set(id, item);
    this.save(b, item);
    return structuredClone(item);
  }

  /** The owner's edits. `trust: 'human'` is "I have read this text". */
  patch(proj: ProjectRef, id: string, p: { title?: unknown; description?: unknown; status?: unknown; assignee?: unknown; due?: unknown; priority?: unknown; labels?: unknown; trust?: unknown; roomIds?: unknown }): WorkItem {
    const b = this.writable(proj);
    const i = this.must(b, id);
    const by: BoardActor = { kind: 'owner' };
    // validate everything first so a bad field leaves the item untouched
    const next = {
      title: p.title === undefined ? undefined : cleanTitle(p.title),
      description: p.description === undefined ? undefined : cleanDescription(p.description),
      assignee: p.assignee === undefined ? undefined : cleanAssignee(p.assignee, proj),
      due: p.due === undefined ? undefined : (cleanDue(p.due) ?? null),
      priority: p.priority === undefined ? undefined : cleanPriority(p.priority),
      labels: p.labels === undefined ? undefined : cleanLabels(p.labels),
      status: p.status === undefined ? undefined : cleanStatus(p.status),
      roomIds: p.roomIds === undefined ? undefined : this.cleanRooms(p.roomIds),
    };
    if (p.trust !== undefined && p.trust !== 'human') throw new BoardError(400, 'trust can only be set to "human" (the owner has reviewed the text)');
    if (next.status !== undefined && i.proposal) throw new BoardError(409, 'Accept this proposal before moving it.');
    if (next.title !== undefined && next.title !== i.title) { i.title = next.title; this.note(i, by, 'edit', 'Title changed'); }
    if (next.description !== undefined && next.description !== i.description) { i.description = next.description; this.note(i, by, 'edit', 'Description changed'); }
    if (next.assignee !== undefined) { i.assignee = next.assignee; this.note(i, by, 'assign', next.assignee ? `Assigned to ${next.assignee.kind === 'owner' ? 'the owner' : next.assignee.id}` : 'Unassigned'); }
    if (next.due !== undefined) { if (next.due) i.due = next.due; else delete i.due; this.note(i, by, 'edit', next.due ? `Due ${next.due}` : 'Due date cleared'); }
    if (next.priority !== undefined && next.priority !== i.priority) { i.priority = next.priority; this.note(i, by, 'edit', `Priority ${next.priority}`); }
    if (next.labels !== undefined) i.labels = next.labels;
    if (next.roomIds !== undefined) i.roomIds = next.roomIds;
    if (p.trust === 'human' && i.trust !== 'human') { i.trust = 'human'; this.note(i, by, 'review', 'The owner reviewed the text'); }
    const moved = next.status !== undefined && next.status !== i.status;
    if (moved) {
      const from = i.status;
      this.note(i, by, 'status', `${from} → ${next.status}`);
      i.status = next.status!; i.order = this.atEnd(b, next.status!, i.id);
      this.touch(i, by); this.save(b, i);
      this.renumber(b, from);
      return structuredClone(i);
    }
    this.touch(i, by);
    this.save(b, i);
    return structuredClone(i);
  }

  private cleanRooms(v: unknown): string[] {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !/^room_[a-f0-9]{12}$/.test(x))) throw new BoardError(400, 'roomIds must be room ids');
    if (v.length > BOARD_LIMITS.roomLinks) throw new BoardError(400, `at most ${BOARD_LIMITS.roomLinks} linked rooms`);
    return [...new Set(v as string[])];
  }

  /** Move to a column at a position (owner; pointer and keyboard moves both end here). Keeps both columns dense. */
  move(proj: ProjectRef, id: string, statusIn: unknown, indexIn: unknown): WorkItem {
    const b = this.writable(proj);
    const i = this.must(b, id);
    if (i.proposal) throw new BoardError(409, 'Accept this proposal before moving it.');
    const status = cleanStatus(statusIn);
    if (typeof indexIn !== 'number' || !Number.isInteger(indexIn)) throw new BoardError(400, 'index must be an integer');
    const by: BoardActor = { kind: 'owner' };
    const from = i.status;
    const target = this.column(b, status).filter((x) => x.id !== id);
    const at = Math.max(0, Math.min(indexIn, target.length));
    target.splice(at, 0, i);
    if (from !== status) { this.note(i, by, 'status', `${from} → ${status}`); i.status = status; }
    this.touch(i, by);
    target.forEach((x, n) => { if (x.order !== n || x.id === id) { x.order = n; this.save(b, x); } });
    if (from !== status) this.renumber(b, from);
    return structuredClone(i);
  }

  remove(proj: ProjectRef, id: string): void {
    const b = this.writable(proj);
    const i = this.must(b, id);
    const col = i.status;
    this.drop(b, id);
    this.renumber(b, col);
  }

  // ------------------------------------------------------------------ Inbox (bot proposals)

  /** A member bot proposes an item. It is stored as a pending, untrusted proposal; nothing is live until the owner accepts. */
  propose(proj: ProjectRef, agentId: string, input: { title?: unknown; description?: unknown; priority?: unknown; labels?: unknown; suggestedAssignee?: unknown }, run: { tainted: boolean }): WorkItem {
    const b = this.writable(proj);
    if (!proj.members.includes(agentId)) throw new BoardError(403, 'Only a member of this project can propose items.');
    const title = botText(cleanTitle(input.title), 'The title');
    const description = input.description === undefined ? '' : botText(cleanDescription(input.description), 'The description');
    const labels = input.labels === undefined ? [] : cleanLabels(input.labels);
    const priority = input.priority === undefined ? 'normal' : cleanPriority(input.priority);
    const sug = input.suggestedAssignee;
    if (sug !== undefined && (typeof sug !== 'string' || !proj.members.includes(sug))) throw new BoardError(400, 'suggestedAssignee must be a member agent id');
    const inbox = [...b.items.values()].filter((i) => i.proposal);
    if (b.items.size >= BOARD_LIMITS.itemsPerProject) throw new BoardError(409, 'The board is full; the owner has to clear items first.');
    if (inbox.length >= BOARD_LIMITS.inboxPerProject) throw new BoardError(409, `The Inbox already holds ${inbox.length} proposals waiting for the owner. Nothing was saved; do not propose more until they are reviewed.`);
    if (inbox.filter((i) => i.createdBy.kind === 'agent' && i.createdBy.id === agentId).length >= BOARD_LIMITS.inboxPerAgent) throw new BoardError(409, `You already have ${BOARD_LIMITS.inboxPerAgent} proposals waiting for the owner. Nothing was saved.`);
    const key = (t: string) => t.toLowerCase();
    if (inbox.some((i) => i.createdBy.kind === 'agent' && i.createdBy.id === agentId && key(i.title) === key(title))) throw new BoardError(409, 'You already proposed an item with this title; it is waiting for the owner.');
    this.tick(this.botWrites, agentId, BOARD_LIMITS.botWritesPerWindow, BOARD_LIMITS.proposalWindowMs, 'Too many board writes from you in a short time. Wait a few minutes.');
    this.tick(this.proposals, `${proj.id}|${agentId}`, BOARD_LIMITS.proposalsPerWindow, BOARD_LIMITS.proposalWindowMs, `You may propose at most ${BOARD_LIMITS.proposalsPerWindow} items per ${BOARD_LIMITS.proposalWindowMs / 60000} minutes. Wait, or put the rest in one item.`);
    const by: BoardActor = { kind: 'agent', id: agentId, ...(run.tainted ? { tainted: true } : {}) };
    const now = nowIso();
    let id = '';
    do { id = newId('wi'); } while (b.items.has(id));
    const item: WorkItem = {
      id, projectId: proj.id, title, description, status: 'backlog', assignee: null, priority, labels, order: 0,
      createdBy: by, updatedBy: by, createdAt: now, updatedAt: now, trust: 'untrusted',
      proposal: { ...(sug ? { suggestedAssignee: sug } : {}) }, taskIds: [], roomIds: [], activity: [],
    };
    this.note(item, by, 'proposed', run.tainted ? 'Proposed by an agent whose run touched outside content' : 'Proposed by an agent');
    b.items.set(id, item);
    this.save(b, item);
    return structuredClone(item);
  }

  accept(proj: ProjectRef, id: string, o: { assignee?: unknown; status?: unknown } = {}): WorkItem {
    const b = this.writable(proj);
    const i = this.must(b, id);
    if (!i.proposal) throw new BoardError(409, 'This item is not waiting in the Inbox.');
    const assignee = o.assignee === undefined ? null : cleanAssignee(o.assignee, proj);
    const status = o.status === undefined ? 'backlog' : cleanStatus(o.status);
    delete i.proposal;
    i.assignee = assignee; i.status = status; i.order = this.atEnd(b, status, id);
    // trust stays `untrusted` on purpose: accepting puts it on the board; only "reviewed" lifts the run limits
    this.note(i, { kind: 'owner' }, 'accepted', 'Accepted from the Inbox');
    this.touch(i, { kind: 'owner' });
    this.save(b, i);
    return structuredClone(i);
  }
  reject(proj: ProjectRef, id: string): void {
    const b = this.writable(proj);
    const i = this.must(b, id);
    if (!i.proposal) throw new BoardError(409, 'This item is not waiting in the Inbox.');
    this.drop(b, id);
  }

  // ------------------------------------------------------------------ bot update of its own item

  /** A member bot changes the status or adds a note on an item assigned to it. Nothing else about an item is writable by a bot. */
  botUpdate(proj: ProjectRef, agentId: string, id: string, u: { status?: unknown; note?: unknown }, run: { taskId?: string; tainted: boolean; roomId?: string }): WorkItem {
    const b = this.writable(proj);
    if (!proj.members.includes(agentId)) throw new BoardError(403, 'Only a member of this project can update its items.');
    const i = b.items.get(id);
    // an item of another project, an Inbox proposal and an item assigned to someone else all look the same: not yours
    if (!i || i.proposal || i.assignee?.kind !== 'agent' || i.assignee.id !== agentId) throw new BoardError(404, `No item "${clip(String(id), 40)}" is assigned to you in this project.`);
    if (u.status === undefined && u.note === undefined) throw new BoardError(400, 'Give a status, a note, or both.');
    if (i.status === 'done') throw new BoardError(409, 'The owner already closed this item. Propose a new item if more work is needed.');
    let status: BoardStatus | undefined;
    if (u.status !== undefined) {
      if (!BOT_STATUSES.includes(u.status as never)) throw new BoardError(403, `You can set doing, review or blocked. Only the owner marks an item done${u.status === 'done' ? ' (move it to review instead)' : ''}.`);
      status = u.status as BoardStatus;
    }
    let note: string | undefined;
    if (u.note !== undefined) {
      if (typeof u.note !== 'string' || !u.note.trim()) throw new BoardError(400, 'note must be text');
      note = botText(clip(cleanText(u.note).trim(), BOARD_LIMITS.noteChars), 'The note');
    }
    this.tick(this.botWrites, agentId, BOARD_LIMITS.botWritesPerWindow, BOARD_LIMITS.proposalWindowMs, 'Too many board writes from you in a short time. Wait a few minutes.');
    const by: BoardActor = { kind: 'agent', id: agentId, ...(run.tainted ? { tainted: true } : {}) };
    const from = i.status;
    if (status && status !== from) { this.note(i, by, 'status', `${from} → ${status}`); i.status = status; i.order = this.atEnd(b, status, i.id); }
    if (note) this.note(i, by, 'note', note);
    if (run.taskId && !i.taskIds.includes(run.taskId)) i.taskIds = [...i.taskIds, run.taskId].slice(-BOARD_LIMITS.taskLinks);
    if (run.roomId && /^room_[a-f0-9]{12}$/.test(run.roomId) && !i.roomIds.includes(run.roomId) && i.roomIds.length < BOARD_LIMITS.roomLinks) i.roomIds = [...i.roomIds, run.roomId];
    this.touch(i, by);
    this.save(b, i);
    if (status && status !== from) this.renumber(b, from);
    return structuredClone(i);
  }

  // ------------------------------------------------------------------ runs

  /** "Run this item": the item goes to doing and the task is linked. The caller starts the task and passes its id. */
  beginRun(proj: ProjectRef, id: string, taskId: string): WorkItem {
    const b = this.writable(proj);
    const i = this.must(b, id);
    const from = i.status;
    i.activeRun = taskId;
    i.taskIds = [...i.taskIds.filter((t) => t !== taskId), taskId].slice(-BOARD_LIMITS.taskLinks);
    const by: BoardActor = { kind: 'owner' };
    this.note(i, by, 'run', 'Run started');
    if (from !== 'doing') { this.note(i, by, 'status', `${from} → doing`); i.status = 'doing'; i.order = this.atEnd(b, 'doing', id); }
    this.touch(i, by);
    this.save(b, i);
    if (from !== 'doing') this.renumber(b, from);
    return structuredClone(i);
  }

  /** A run ended. Moves the item to review (done) or blocked (error, cancelled), never to done, and only if the owner has not moved it. */
  endRun(pid: string, taskId: string, r: { status: string; isError: boolean; text?: string; tainted: boolean }): WorkItem | undefined {
    if (!PROJECT_ID_RE.test(pid)) return undefined;
    const b = this.board(pid);
    const i = [...b.items.values()].find((x) => x.activeRun === taskId);
    if (!i) return undefined;
    const by: BoardActor = { kind: 'system' };
    const ok = r.status === 'done' && !r.isError;
    const from = i.status;
    delete i.activeRun;
    const preview = clip(scrubSecrets(cleanText(r.text ?? ''), { keepHex: true }), BOARD_LIMITS.previewChars);
    i.lastRun = { taskId, status: clip(r.status, 20), endedAt: nowIso(), tainted: r.tainted, preview };
    this.note(i, by, 'run', ok ? 'Run finished' : `Run ended: ${r.status}`);
    if (from === 'doing') {
      const to: BoardStatus = ok ? 'review' : 'blocked';
      this.note(i, by, 'status', `doing → ${to}`);
      i.status = to; i.order = this.atEnd(b, to, i.id);
    }
    this.touch(i, by);
    this.save(b, i);
    if (from === 'doing') this.renumber(b, 'doing');
    return structuredClone(i);
  }
}
