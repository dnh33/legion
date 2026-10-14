/**
 * Where a waiting item goes when the owner clicks it (agent rail row, "Needs you in other projects" row, notification, tray). Pure: the
 * store applies the answer. An approval or question opens the thread that holds it; a proposal opens the proposing agent's newest chat in
 * that proposal's project (a new chat there when it has none), where a card for it waits. Only the card's "Open on board" leaves the chat.
 */
export interface RouteRow { kind: 'approval' | 'question' | 'proposal' | 'parked'; id: string; taskId?: string; agentId: string; projectId: string | null }
export interface RouteTask { id: string; agentId: string; projectId?: string | null; updatedAt: string; archived?: boolean }

export type RailTarget =
  | { kind: 'inbox'; projectId: string; itemId: string }
  | { kind: 'thread'; taskId: string; askId: string; proposalProject?: string }
  | { kind: 'newChat'; agentId: string; projectId: string; askId: string; proposalProject: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'none' };

/** The agent's newest unarchived chat in one project. */
export function latestChat<T extends RouteTask>(agentId: string, projectId: string, tasks: readonly T[]): T | undefined {
  return tasks.filter((t) => t.agentId === agentId && t.projectId === projectId && !t.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** The one map from a waiting item to its open action. */
export function askTarget(row: RouteRow, tasks: readonly RouteTask[]): RailTarget {
  if (row.kind === 'proposal') {
    if (!row.projectId) return { kind: 'none' };
    if (!row.agentId) return { kind: 'inbox', projectId: row.projectId, itemId: row.id };
    const chat = latestChat(row.agentId, row.projectId, tasks);
    return chat ? { kind: 'thread', taskId: chat.id, askId: row.id, proposalProject: row.projectId } : { kind: 'newChat', agentId: row.agentId, projectId: row.projectId, askId: row.id, proposalProject: row.projectId };
  }
  if (row.taskId) return { kind: 'thread', taskId: row.taskId, askId: row.id };
  return row.projectId ? { kind: 'project', projectId: row.projectId } : { kind: 'none' };
}

interface ProposalLike { projectId: string; createdAt: string; createdBy: { kind: string; id?: string } }
/**
 * The proposals to show as cards in the chat in view: the agent's own, one project at a time. In a chat, only those whose newest chat in their
 * project is this one. In the new-chat view, only the project in view (`scope`, the rail's filter) and only where the agent has no chat yet:
 * another project's card waits in the rail's "Needs you in other projects", not here. Archived projects are left out. Oldest first.
 */
export function proposalsForThread<P extends ProposalLike>(agentId: string, taskId: string | null, tasks: readonly RouteTask[], proposals: readonly P[], archivedProjects: ReadonlySet<string>, scope: string | null = null): P[] {
  return proposals
    .filter((p) => p.createdBy.kind === 'agent' && p.createdBy.id === agentId && !archivedProjects.has(p.projectId))
    .filter((p) => {
      const home = latestChat(agentId, p.projectId, tasks);
      return taskId !== null ? home?.id === taskId : p.projectId === scope && !home;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

/** What the Board does with a request to show one Inbox entry: wait for the board to load, show the entry, or tell the owner it is gone. */
export type InboxFocusPlan = 'ignore' | 'wait' | 'show' | 'gone';
export function inboxFocusPlan(req: { projectId: string; itemId: string } | null, projectId: string, inbox: ReadonlyArray<{ id: string }>, loaded: boolean): InboxFocusPlan {
  if (!req || req.projectId !== projectId) return 'ignore';
  if (inbox.some((i) => i.id === req.itemId)) return 'show';
  return loaded ? 'gone' : 'wait';
}

/**
 * One pending request each, in memory: set by the click, taken by the view that shows it. A request older than the TTL is ignored (the view
 * it was for never came), and navigating elsewhere drops it.
 */
export const REQUEST_TTL_MS = 3000;
export const BOARD_WAIT_MS = 30_000;
/** `boardAt`: when the fresh load of the project's board finished. A request about a proposal waits for it (up to BOARD_WAIT_MS), then has the TTL. */
export interface InboxRequest { projectId: string; itemId: string; at: number; boardAt?: number }
export interface AskRequest { taskId: string | null; askId: string; at: number; boardAt?: number; /** Set when the card is a proposal's: the project whose board must load before it can show. */ projectId?: string }
let inboxReq: InboxRequest | null = null;
let askReq: AskRequest | null = null;
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());
function alive(r: { at: number; boardAt?: number; projectId?: string }, now: number): boolean {
  if (r.projectId && r.boardAt === undefined) return now - r.at <= BOARD_WAIT_MS;
  return now - (r.boardAt ?? r.at) <= REQUEST_TTL_MS;
}
const fresh = <T extends { at: number; boardAt?: number; projectId?: string }>(r: T | null, now: number): T | null => (r && alive(r, now) ? r : null);
export const subscribeFocus = (cb: () => void): (() => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
export const getInboxRequest = (now = Date.now()): InboxRequest | null => fresh(inboxReq, now);
export const getAskRequest = (now = Date.now()): AskRequest | null => fresh(askReq, now);
export function requestInbox(projectId: string, itemId: string, now = Date.now()): void { inboxReq = { projectId, itemId, at: now }; emit(); }
export function clearInboxRequest(): void { if (inboxReq) { inboxReq = null; emit(); } }
export function requestAsk(taskId: string | null, askId: string, now = Date.now(), projectId?: string): void { askReq = { taskId, askId, at: now, ...(projectId ? { projectId } : {}) }; emit(); }
export function clearAskRequest(): void { if (askReq) { askReq = null; emit(); } }
/** A task (or the new-chat view, null) was selected: a card request for another one is dropped. */
export function noteTaskSelected(taskId: string | null): void { if (askReq && askReq.taskId !== taskId) clearAskRequest(); }
/** The window switched view: a card request is for the chat, an Inbox request for the project page. */
export function noteViewSet(view: string): void {
  if (view !== 'chat') clearAskRequest();
  if (view !== 'project') clearInboxRequest();
}

/**
 * What the chat does with a request for a proposal card: wait for the board to load, show the card, say it is gone, or do nothing.
 * `cardIds` are the cards this chat holds; `knownIds` every proposal known to be waiting.
 */
export type ProposalFocusPlan = 'ignore' | 'wait' | 'show' | 'gone';
export function proposalFocusPlan(req: AskRequest | null, taskId: string | null, cardIds: readonly string[], knownIds: readonly string[], boardLoaded: boolean): ProposalFocusPlan {
  if (!req || !req.projectId || req.taskId !== taskId) return 'ignore';
  if (cardIds.includes(req.askId)) return 'show';
  if (knownIds.includes(req.askId)) return 'ignore';
  return boardLoaded ? 'gone' : 'wait';
}

/** Moving focus is fine unless the owner is typing: a text field keeps it (the card is scrolled into view instead). */
export function canTakeFocus(active: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!active) return true;
  const tag = (active.tagName ?? '').toUpperCase();
  return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable);
}

/** The fresh load of a board finished for the request made at `at`: its TTL starts now. A newer request is left alone. */
export function markBoardSettled(at: number, now = Date.now()): void {
  if (now - at > BOARD_WAIT_MS) return; // too late: the request has expired, and a late load does not bring it back
  if (askReq && askReq.at === at) askReq = { ...askReq, boardAt: now };
  if (inboxReq && inboxReq.at === at) inboxReq = { ...inboxReq, boardAt: now };
  emit();
}
/** The load failed: drops the request made at `at`. True when one was dropped (the caller then says so). A request that has expired is left to lapse: no late toast. */
export function failBoardLoad(at: number, now = Date.now()): boolean {
  if (now - at > BOARD_WAIT_MS) return false;
  let dropped = false;
  if (askReq && askReq.at === at) { askReq = null; dropped = true; }
  if (inboxReq && inboxReq.at === at) { inboxReq = null; dropped = true; }
  if (dropped) emit();
  return dropped;
}

/**
 * A count of the owner's own moves (a view switch, a chat or agent pick). A click queued at cold start is for the screen the owner was on:
 * if they moved since, it is dropped. The routing's own moves and the app's housekeeping run `withoutNavigation` and do not count.
 */
let navCount = 0;
let quietDepth = 0;
export const navigationCount = (): number => navCount;
export function noteNavigation(): void { if (quietDepth === 0) navCount++; }
export function withoutNavigation<T>(fn: () => T): T {
  quietDepth++;
  try { return fn(); } finally { quietDepth--; }
}
