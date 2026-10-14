/**
 * Where a "Needs you in other projects" rail row goes. Pure: the store applies the answer.
 * A proposal opens its Inbox entry on the project's Board; an approval or a question opens the agent's thread with that card focused.
 */
interface RailRow { kind: 'approval' | 'question' | 'proposal' | 'parked'; id: string; taskId?: string; projectId: string | null }

export type RailTarget =
  | { kind: 'inbox'; projectId: string; itemId: string }
  | { kind: 'thread'; taskId: string; askId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'none' };

/** The one map from a waiting item to its open action: the agent rail row, the elsewhere rows and the digest all use it. */
export function askTarget(row: RailRow): RailTarget {
  if (row.kind === 'proposal') {
    if (row.projectId && row.id) return { kind: 'inbox', projectId: row.projectId, itemId: row.id };
    return row.projectId ? { kind: 'project', projectId: row.projectId } : { kind: 'none' };
  }
  if (row.taskId) return { kind: 'thread', taskId: row.taskId, askId: row.id };
  return row.projectId ? { kind: 'project', projectId: row.projectId } : { kind: 'none' };
}

export const railRowTarget = askTarget;

/** The pending proposals one agent made, oldest first (the chat shows a card for each). */
export function proposalsFor<T extends { createdAt: string; createdBy: { kind: string; id?: string } }>(agentId: string, proposals: readonly T[]): T[] {
  return proposals.filter((p) => p.createdBy.kind === 'agent' && p.createdBy.id === agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The waiting card to bring into view in a thread: the one the row named, else the first approval, else the first question. */
export function pickAskCard(
  taskId: string, preferId: string | null,
  approvals: ReadonlyArray<{ id: string; taskId: string }>, questions: ReadonlyArray<{ id: string; taskId: string }>,
): { kind: 'approval' | 'question'; id: string } | null {
  const a = approvals.filter((x) => x.taskId === taskId), q = questions.filter((x) => x.taskId === taskId);
  if (preferId) {
    if (a.some((x) => x.id === preferId)) return { kind: 'approval', id: preferId };
    if (q.some((x) => x.id === preferId)) return { kind: 'question', id: preferId };
  }
  return a[0] ? { kind: 'approval', id: a[0].id } : q[0] ? { kind: 'question', id: q[0].id } : null;
}

/** What the Board does with a request to show one Inbox entry: wait for the board to load, show the entry, or give up quietly (the item is gone). */
export type InboxFocusPlan = 'ignore' | 'wait' | 'show' | 'gone';
export function inboxFocusPlan(req: { projectId: string; itemId: string } | null, projectId: string, inbox: ReadonlyArray<{ id: string }>, loaded: boolean): InboxFocusPlan {
  if (!req || req.projectId !== projectId) return 'ignore';
  if (inbox.some((i) => i.id === req.itemId)) return 'show';
  return loaded ? 'gone' : 'wait';
}

/** One pending request each, in memory: set by the rail, taken by the view that shows it. */
let inboxReq: { projectId: string; itemId: string } | null = null;
let askReq: { taskId: string; askId: string } | null = null;
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());
export const subscribeFocus = (cb: () => void): (() => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
export const getInboxRequest = (): typeof inboxReq => inboxReq;
export const getAskRequest = (): typeof askReq => askReq;
export function requestInbox(projectId: string, itemId: string): void { inboxReq = { projectId, itemId }; emit(); }
export function clearInboxRequest(): void { if (inboxReq) { inboxReq = null; emit(); } }
export function requestAsk(taskId: string, askId: string): void { askReq = { taskId, askId }; emit(); }
export function clearAskRequest(): void { if (askReq) { askReq = null; emit(); } }
