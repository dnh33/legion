/**
 * Is a thread busy? Pure (types only), shared by the composer (Enter queues or sends) and the queue runner (may the next message go?).
 *  - 'run'      the thread's own task is queued or running
 *  - 'approval' an approval card for this thread is waiting (the run is paused on the owner, which still counts as running)
 *  - 'other'    the same agent is busy with a task that did not come from this window: a room, an agent-to-agent call, an MCP client.
 *               The owner's own other tabs do not count, so running two tabs of one agent in parallel works as before.
 * A thread with no task yet (the New task view) can only be 'other'.
 * Only a run in the SAME project counts for 'other' (a run in another project, or in none while this thread is in one, is
 * shown as "Also working in..." and never blocks). The thread's project is its task's, or for the New task view the project
 * a new task would start in (`newTaskProject`).
 */
import type { Project } from '../../../src/shared/projects.js';
import type { ApprovalRequest, Task } from '../../../src/shared/types.js';
import { newTaskProjectId } from '../projects/projectsLogic.js';

export type BusyReason = 'run' | 'approval' | 'other';

const live = (t: Pick<Task, 'status'>): boolean => t.status === 'running' || t.status === 'queued';

export function busyReason(agentId: string, taskId: string | null, tasks: readonly Task[], approvals: readonly ApprovalRequest[], newTaskProject?: string): BusyReason | null {
  const own = taskId ? tasks.find((t) => t.id === taskId) : undefined;
  const project = taskId ? own?.projectId : newTaskProject;
  if (taskId) {
    if (own && live(own)) return 'run';
    if (approvals.some((a) => a.taskId === taskId)) return 'approval';
  }
  for (const t of tasks) if (t.agentId === agentId && t.id !== taskId && live(t) && t.source !== 'ui' && t.projectId === project) return 'other';
  return null;
}

/**
 * busyReason for the thread in view, reading the project a New task would start in from the window state. The composer, the
 * queue runner and every send path call this one, so they cannot disagree about whether a run in another project blocks.
 */
export function busyIn(st: { tasks: readonly Task[]; approvals: readonly ApprovalRequest[]; projects: Project[]; projectFilter: string | null }, agentId: string, taskId: string | null): BusyReason | null {
  return busyReason(agentId, taskId, st.tasks, st.approvals, newTaskProjectId(st.projects, st.projectFilter, agentId, !!taskId));
}

/** A provider model id ("openai:gpt-4o"); same rule as the core's providerPrefix (an AWS "arn:" id is Claude). */
export const isProviderModel = (m: string | undefined): boolean => !!m && /^([a-z][a-z0-9-]{1,31}):(.+)$/.test(m) && !m.startsWith('arn:');

/**
 * May this message join the thread's running Claude run (read after its current step) instead of waiting for the whole
 * run to end? Only the thread's own running task, with nothing already in its queue (a new message never jumps ahead of
 * queued ones), not a provider run (no live stream), and not a slash command (it would act on the run). The core has the
 * last word: it answers 409 and the message is queued as before.
 */
export function canJoinRun(why: BusyReason | null, task: Pick<Task, 'status' | 'provider' | 'model'> | undefined, queued: number, text: string): boolean {
  return why === 'run' && task?.status === 'running' && queued === 0 && !task.provider && !isProviderModel(task.model) && !text.trim().startsWith('/');
}

export const busyLabel = (r: BusyReason | null): string =>
  r === 'run' ? 'Waiting for the current run to finish'
    : r === 'approval' ? 'Waiting on an approval before it can continue'
      : r === 'other' ? 'This agent is busy with another task in this project (room or agent call)'
        : '';
