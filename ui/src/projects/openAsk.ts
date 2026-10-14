/**
 * Where "open this ask" goes (a notification click, the tray item, the rail row). Pure: the store applies the answer.
 * A thread when the ask has a task; a proposal when the ref names one; for a project, its oldest waiting proposal (else its page);
 * with no ref, the oldest ask or proposal waiting anywhere; else nothing (the window just shows).
 */
export interface AskRef { projectId?: string; taskId?: string; itemId?: string }
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
    const itemId = str(ref?.itemId);
    const named = itemId ? proposals.find((p) => p.id === itemId && p.projectId === projectId) : undefined;
    if (named) return { kind: 'proposal', projectId, itemId: named.id, agentId: named.agentId };
    return oldest([], proposals.filter((p) => p.projectId === projectId)) ?? { kind: 'project', projectId };
  }
  return oldest(waiting, proposals) ?? { kind: 'none' };
}
