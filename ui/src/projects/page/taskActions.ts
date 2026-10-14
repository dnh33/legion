/** Opening, continuing and stopping a run from the page. Each is the owner's click; the core and the thread keep their own rules. */
import { CONTINUE_PROMPT } from '../../../../src/shared/continue';
import type { Task } from '../../../../src/shared/types';
import { selectAgent, selectTask, sendPromptTo, setView, stopTask, toast } from '../../store';

export function openTask(taskId: string): void { setView('chat'); selectTask(taskId); }
export async function continueTask(t: Pick<Task, 'id' | 'agentId'>): Promise<void> {
  const r = await sendPromptTo({ agentId: t.agentId, taskId: t.id }, CONTINUE_PROMPT, { select: false });
  if (!r.ok) toast(r.message, 'error');
  else toast('Continuing where it stopped.', 'info');
}
/** A run that kept its session continues; one that did not opens its thread, where Retry re-sends the request. */
export function retryTask(t: Pick<Task, 'id' | 'agentId' | 'resumable'>): void {
  if (t.resumable) { void continueTask(t); return; }
  selectAgent(t.agentId);
  openTask(t.id);
}
export { stopTask };
