/** Opens the chat of a refresh run (the Archivist's thread, where its report and any approval card are). Kept out of graphStore: that store must not pull in the app store. */
import { api } from '../api';
import { adoptTask, selectTask, setView } from '../store';

export async function openRun(taskId: string): Promise<void> {
  try { adoptTask((await api.getTask(taskId)).task); } catch { /* the chat still opens if the window already has the task */ }
  setView('chat');
  selectTask(taskId);
}
