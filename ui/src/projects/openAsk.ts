/**
 * Where "open this ask" goes (a notification click, the tray item, the rail row). Pure: the store applies the answer.
 * A thread when the ask has a task; a proposal when the ref names one; a project alone is its page, a ref with an item id is that proposal;
 * with no ref, the oldest ask or proposal waiting anywhere; else nothing (the window just shows).
 */
export interface AskRef { projectId?: string; taskId?: string; itemId?: string; agentId?: string }
export interface WaitingAsk { taskId: string; projectId: string | null; at: string }
export interface WaitingProposal { id: string; projectId: string; agentId: string; createdAt: string }
export type OpenAskAction =
  | { kind: 'thread'; taskId: string }
  | { kind: 'proposal'; projectId: string; itemId: string; agentId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'none' };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** The oldest of the asks and proposals given, as an action. */
function oldest(asks: readonly WaitingAsk[], proposals: readonly WaitingProposal[]): OpenAskAction | undefined {
  const a = [...asks].sort((x, y) => x.at.localeCompare(y.at))[0];
  const p = [...proposals].sort((x, y) => x.createdAt.localeCompare(y.createdAt))[0];
  if (a && (!p || a.at <= p.createdAt)) return { kind: 'thread', taskId: a.taskId };
  return p ? { kind: 'proposal', projectId: p.projectId, itemId: p.id, agentId: p.agentId } : undefined;
}

export function resolveAsk(ref: AskRef | null | undefined, waiting: readonly WaitingAsk[], projectIds: readonly string[], proposals: readonly WaitingProposal[] = []): OpenAskAction {
  const taskId = str(ref?.taskId);
  if (taskId) return { kind: 'thread', taskId };
  const projectId = str(ref?.projectId);
  if (projectId && projectIds.includes(projectId)) {
    // only a ref that names a proposal opens one, from its ids alone (the board need not be loaded); a project-only ref (a notification) is the page
    const itemId = str(ref?.itemId);
    if (!itemId) return { kind: 'project', projectId };
    const agentId = str(ref?.agentId) ?? proposals.find((p) => p.id === itemId)?.agentId ?? '';
    return { kind: 'proposal', projectId, itemId, agentId };
  }
  return oldest(waiting, proposals) ?? { kind: 'none' };
}

/** A click that arrives before the window has loaded its projects, tasks and agents waits for them, for at most this long. */
export const ASK_QUEUE_MS = 15_000;
export type QueuedAskStep = 'none' | 'wait' | 'run' | 'expired';
export function queuedAskStep(queuedAt: number | null, ready: boolean, now: number): QueuedAskStep {
  if (queuedAt === null) return 'none';
  if (ready) return 'run';
  return now - queuedAt >= ASK_QUEUE_MS ? 'expired' : 'wait';
}
