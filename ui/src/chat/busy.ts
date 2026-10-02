/**
 * Is a thread busy? Pure (types only), shared by the composer (Enter queues or sends) and the queue runner (may the next message go?).
 *  - 'run'      the thread's own task is queued or running
 *  - 'approval' an approval card for this thread is waiting (the run is paused on the owner, which still counts as running)
 *  - 'other'    the same agent is busy with a task that did not come from this window: a room, an agent-to-agent call, an MCP client.
 *               The owner's own other tabs do not count, so running two tabs of one agent in parallel works as before.
 * A thread with no task yet (the New task view) can only be 'other'.
 */
import type { ApprovalRequest, Task } from '../../../src/shared/types.js';

export type BusyReason = 'run' | 'approval' | 'other';

const live = (t: Pick<Task, 'status'>): boolean => t.status === 'running' || t.status === 'queued';

export function busyReason(agentId: string, taskId: string | null, tasks: readonly Task[], approvals: readonly ApprovalRequest[]): BusyReason | null {
  if (taskId) {
    const own = tasks.find((t) => t.id === taskId);
    if (own && live(own)) return 'run';
    if (approvals.some((a) => a.taskId === taskId)) return 'approval';
  }
  for (const t of tasks) if (t.agentId === agentId && t.id !== taskId && live(t) && t.source !== 'ui') return 'other';
  return null;
}

export const busyLabel = (r: BusyReason | null): string =>
  r === 'run' ? 'Waiting for the current run to finish'
    : r === 'approval' ? 'Waiting on an approval before it can continue'
      : r === 'other' ? 'This agent is busy with another task (room or agent call)'
        : '';
