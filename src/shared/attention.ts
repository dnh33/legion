/**
 * What waits on the owner: one derivation for the meta line, the tab pip, the digest, the rail, the switcher, the overlay and (via the
 * core) the notifications. Pure. A number that is shown anywhere comes from `deriveAsks` + `countAsks`, so two surfaces cannot disagree.
 *
 * An ask is anything waiting on the owner: an approval card, a question, a parked ask, a board proposal in the Inbox. Questions count
 * (as they do for the bust). Nothing here carries or needs the text of a command.
 */
import type { WorkItem } from './board.js';
import { classifySafe } from './consequence.js';
import type { Consequence } from './consequence.js';
import { isLimitPause, isParkPause } from './continue.js';
import type { ApprovalRequest, ParkedAsk, PendingQuestion, Task } from './types.js';

export type AskKind = 'approval' | 'question' | 'proposal' | 'parked';
export interface Ask {
  id: string;
  kind: AskKind;
  taskId?: string;
  agentId: string;
  /** null: the run belongs to no project. */
  projectId: string | null;
  /** ISO time the ask was raised. */
  at: string;
  consequence: Consequence;
}

export interface AskSources {
  approvals: readonly ApprovalRequest[];
  questions?: readonly PendingQuestion[];
  parked?: readonly ParkedAsk[];
  /** Inbox proposals (board items with a `proposal`). */
  proposals?: ReadonlyArray<Pick<WorkItem, 'id' | 'projectId' | 'createdAt' | 'createdBy'>>;
  /** Used to find the project of an ask whose request carries none. */
  tasks?: ReadonlyArray<Pick<Task, 'id' | 'projectId'>>;
}

const QUESTION: Consequence = { level: 0, tags: ['decides'], chip: 'A choice, nothing happens until you answer', certain: true };
const PROPOSAL: Consequence = { level: 2, tags: ['edits'], chip: 'Written after outside content', certain: true };

export function deriveAsks(src: AskSources): Ask[] {
  const projectOfTask = new Map<string, string | undefined>();
  for (const t of src.tasks ?? []) projectOfTask.set(t.id, t.projectId);
  const out: Ask[] = [];
  for (const a of src.approvals) {
    out.push({
      id: a.id, kind: 'approval', taskId: a.taskId, agentId: a.agentId, at: a.at,
      projectId: a.projectId ?? projectOfTask.get(a.taskId) ?? null,
      consequence: a.consequence ?? classifySafe({ kind: 'approval', toolName: a.toolName, input: a.input }),
    });
  }
  for (const q of src.questions ?? []) {
    out.push({ id: q.id, kind: 'question', taskId: q.taskId, agentId: q.agentId, at: q.at, projectId: q.projectId ?? projectOfTask.get(q.taskId) ?? null, consequence: q.consequence ?? QUESTION });
  }
  for (const p of src.parked ?? []) {
    out.push({ id: p.id, kind: 'parked', taskId: p.taskId, agentId: p.agentId, at: p.askedAt, projectId: p.projectId ?? projectOfTask.get(p.taskId) ?? null, consequence: p.consequence });
  }
  for (const i of src.proposals ?? []) {
    out.push({ id: i.id, kind: 'proposal', agentId: i.createdBy.kind === 'agent' ? i.createdBy.id : '', at: i.createdAt, projectId: i.projectId, consequence: PROPOSAL });
  }
  return out;
}

export interface AskCounts { total: number; byProject: Record<string, number> }
/** The key `byProject` uses for an ask with no project. */
export const NO_PROJECT = 'none';

export function countAsks(asks: readonly Ask[]): AskCounts {
  const byProject: Record<string, number> = {};
  for (const a of asks) byProject[a.projectId ?? NO_PROJECT] = (byProject[a.projectId ?? NO_PROJECT] ?? 0) + 1;
  return { total: asks.length, byProject };
}

const ms = (iso: string): number => { const n = Date.parse(iso); return Number.isFinite(n) ? n : 0; };

/** Riskiest first, then oldest first. Does not change the input. */
export function sortAsks<T extends Pick<Ask, 'id' | 'at' | 'consequence'>>(asks: readonly T[]): T[] {
  return [...asks].sort((a, b) => b.consequence.level - a.consequence.level || ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
}

/** The first `n` asks at full size and how many more there are. Never hides one: `more` is the exact rest. */
export function capAsks<T>(sorted: readonly T[], n = 3): { shown: T[]; more: number } {
  return { shown: sorted.slice(0, n), more: Math.max(0, sorted.length - n) };
}

/* ---------- repeated reads ---------- */

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS']);
export interface ReadGroup { key: string; agentId: string; toolName: string; dir: string; ids: string[]; /** The oldest ask's time. */ at: string }

function dirOf(a: ApprovalRequest): string {
  const input = a.input && typeof a.input === 'object' ? a.input : {};
  const p = [input.file_path, input.path].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (!p) return '';
  const s = p.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return (a.toolName === 'Read' ? (i >= 0 ? s.slice(0, i) : '') : s).toLowerCase();
}

/**
 * Repeated read asks of one kind become one row: grouped by (agent, tool, folder). Only read-only asks are merged (level 1, certain),
 * and only groups of 2 or more; everything else stays a row of its own.
 */
export function mergeReads(approvals: readonly ApprovalRequest[]): { groups: ReadGroup[]; singles: ApprovalRequest[] } {
  const buckets = new Map<string, ApprovalRequest[]>();
  const singles: ApprovalRequest[] = [];
  for (const a of approvals) {
    const c = a.consequence ?? classifySafe({ kind: 'approval', toolName: a.toolName, input: a.input });
    if (!READ_TOOLS.has(a.toolName) || c.level !== 1 || !c.certain) { singles.push(a); continue; }
    const key = `${a.agentId}|${a.toolName}|${dirOf(a)}`;
    const list = buckets.get(key);
    if (list) list.push(a); else buckets.set(key, [a]);
  }
  const groups: ReadGroup[] = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) { singles.push(...list); continue; }
    const oldest = [...list].sort((x, y) => ms(x.at) - ms(y.at))[0]!;
    groups.push({ key, agentId: oldest.agentId, toolName: oldest.toolName, dir: dirOf(oldest), ids: list.map((x) => x.id), at: oldest.at });
  }
  return { groups, singles };
}

/* ---------- since you last looked ---------- */

type EventTask = Pick<Task, 'id' | 'status' | 'updatedAt'> & { error?: string };
export interface DigestEvents<T extends EventTask, R extends { updatedAt: string }> {
  failed: T[]; stopped: T[]; finished: T[]; inReview: R[]; spendUsd: number;
}

/**
 * What happened since `sinceMs`: failed (an error that is not a pause), stopped (paused at a limit, work kept), finished (done), and
 * board items in review. A parked run is an ask, not an event. `spendUsd` is whatever the caller summed from the ledger since then.
 */
export function digestEvents<T extends EventTask, R extends { updatedAt: string } = { updatedAt: string }>(
  input: { tasks: readonly T[]; boardInReview?: readonly R[]; sinceMs: number; spendUsd?: number },
): DigestEvents<T, R> {
  const fresh = (iso: string): boolean => ms(iso) >= input.sinceMs;
  const failed: T[] = []; const stopped: T[] = []; const finished: T[] = [];
  for (const t of input.tasks) {
    if (!fresh(t.updatedAt)) continue;
    if (t.status === 'done') finished.push(t);
    else if (t.status === 'error') {
      if (isParkPause(t)) continue;
      if (isLimitPause(t)) stopped.push(t); else failed.push(t);
    }
  }
  return { failed, stopped, finished, inReview: (input.boardInReview ?? []).filter((r) => fresh(r.updatedAt)), spendUsd: input.spendUsd ?? 0 };
}

export interface DigestState { open: Ask[]; needYou: number; hasNew: boolean; quiet: boolean }

/**
 * The digest's state. "Quiet" (nothing new since you looked) never hides an open ask: `open` always lists every ask, riskiest first.
 */
export function digestState(asks: readonly Ask[], events: Pick<DigestEvents<EventTask, { updatedAt: string }>, 'failed' | 'stopped' | 'finished' | 'inReview'>, sinceMs: number): DigestState {
  const open = sortAsks(asks);
  const newAsks = asks.some((a) => ms(a.at) >= sinceMs);
  const hasNew = newAsks || events.failed.length + events.stopped.length + events.finished.length + events.inReview.length > 0;
  return { open, needYou: asks.length, hasNew, quiet: !hasNew };
}
