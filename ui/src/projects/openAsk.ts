/**
 * Where "open this ask" goes (a notification click, the tray item, the rail row). Pure: the store applies the answer.
 * A thread when the ask has a task, else the project page, else the oldest ask waiting, else nothing (the window just shows).
 */
export interface AskRef { projectId?: string; taskId?: string }
export interface WaitingAsk { taskId: string; projectId: string | null; at: string }
export type OpenAskAction = { kind: 'thread'; taskId: string } | { kind: 'project'; projectId: string } | { kind: 'none' };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function resolveAsk(ref: AskRef | null | undefined, waiting: readonly WaitingAsk[], projectIds: readonly string[]): OpenAskAction {
  const taskId = str(ref?.taskId);
  if (taskId) return { kind: 'thread', taskId };
  const projectId = str(ref?.projectId);
  if (projectId && projectIds.includes(projectId)) return { kind: 'project', projectId };
  const oldest = [...waiting].sort((a, b) => a.at.localeCompare(b.at))[0];
  return oldest ? { kind: 'thread', taskId: oldest.taskId } : { kind: 'none' };
}
