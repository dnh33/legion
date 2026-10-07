/**
 * Connector data stays out of reach of the MCP bearer token (design 5, row R1). A run that read connector data is marked
 * `usedConnectors` the first time a gateway handler reaches GitHub. For a caller that is not the app window (bearer token only):
 * tool rows, assistant rows, live text chunks and the final result of such a task are withheld on every read path, and a continue is refused.
 */
import type { ChatMessage, LegionEvent, Task } from '../shared/types.js';

export const WITHHELD = 'withheld: this run read connector data';
export const CONTINUE_REFUSED = 'This task read connector data, so it cannot be continued from an MCP client. Continue it in the Legion app.';

export const usedConnectors = (t: Pick<Task, 'usedConnectors'> | undefined): boolean => t?.usedConnectors === true;

/** The task as a bearer-only caller may see it. */
export function withholdTask<T extends Task>(t: T): T {
  if (!usedConnectors(t) || t.result === undefined) return t;
  return { ...t, result: WITHHELD };
}

/** A stored message as a bearer-only caller may see it (user and system rows are the caller's own words or Legion's). */
export function withholdMessage(m: ChatMessage, task: Pick<Task, 'usedConnectors'> | undefined): ChatMessage {
  if (!usedConnectors(task) || (m.role !== 'tool' && m.role !== 'assistant')) return m;
  const { toolName: _t, toolUseId: _u, resultFor: _r, ...rest } = m as ChatMessage & { toolUseId?: string; resultFor?: string };
  return { ...rest, text: WITHHELD };
}

/** An event for a bearer-only stream: null drops it. */
export function withholdEvent(ev: LegionEvent, taskOf: (id: string) => Task | undefined): LegionEvent | null {
  if (ev.type === 'task.updated') return usedConnectors(ev.task) ? { ...ev, task: withholdTask(ev.task) } : ev;
  if (ev.type === 'message') return usedConnectors(taskOf(ev.message.taskId)) ? { ...ev, message: withholdMessage(ev.message, taskOf(ev.message.taskId)) } : ev;
  if (ev.type === 'message.delta') return usedConnectors(taskOf(ev.taskId)) ? null : ev;
  return ev;
}
