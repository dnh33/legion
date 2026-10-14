/** "Stop a team": which tasks a task started (and they started), and the words for stopping them with it. Pure, so the core suite can check it. */
import type { Task } from '../../../src/shared/types.js';

/** The live tasks a task started, directly or through the tasks it started (nearest first). The task itself is not in it. */
export function startedLive(tasks: readonly Task[], taskId: string): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>([taskId]);
  for (let frontier = [taskId]; frontier.length;) {
    const next: string[] = [];
    for (const t of tasks) {
      if (!t.parentTaskId || seen.has(t.id) || !frontier.includes(t.parentTaskId)) continue;
      seen.add(t.id); next.push(t.id);
      if (t.status === 'running' || t.status === 'queued') out.push(t);
    }
    frontier = next;
  }
  return out;
}

/** The label of the button that stops a task together with the tasks it started. */
export const stopTeamLabel = (n: number): string => `Stop this and the ${n} task${n === 1 ? '' : 's'} it started`;
