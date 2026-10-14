/** Which tasks are tabs, the project to switch to when a task opens, and the hint about the agent's runs elsewhere (pure, tested in node). */
import type { Project } from '../../../src/shared/projects.js';
import type { Task } from '../../../src/shared/types.js';
import { inProject, inWhere } from '../projects/projectsLogic.js';

type TabTask = Pick<Task, 'id' | 'agentId' | 'archived' | 'createdAt' | 'projectId'>;

/** One agent's tabs: newest first, only the project in view (All shows every project), open ones plus the selected closed one. */
export function tabTasks<T extends TabTask>(tasks: T[], agentId: string, sel: string | null, filter: string | null): T[] {
  return tasks.filter((t) => t.agentId === agentId && (!t.archived || t.id === sel) && inProject(t, filter))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The project the dropdown must switch to so an opened task is always in view: its own project, or All (null) when it has none
 * or the project is unknown here. Undefined when nothing changes (All is showing, or the task is already in the project in view).
 */
export function projectToShow(task: Pick<Task, 'projectId'>, filter: string | null, projects: Pick<Project, 'id'>[]): string | null | undefined {
  if (filter === null || task.projectId === filter) return undefined;
  return task.projectId && projects.some((p) => p.id === task.projectId) ? task.projectId : null;
}

type LiveTask = Pick<Task, 'id' | 'agentId' | 'status' | 'projectId' | 'updatedAt'>;
export interface OtherProjectsHint { text: string; tone: 'plain' | 'amber'; tasks: LiveTask[] }

/**
 * The quiet line at the end of the tab bar: the agent's live (running or queued) tasks outside the project in view.
 * "+2 running in Atlas", "+3 running in 2 other projects", or amber "1 needs you in Atlas" when one waits on the owner.
 * Nothing under All (every task is already a tab) or when there is nothing live elsewhere.
 */
export function otherProjectsHint(tasks: LiveTask[], agentId: string, filter: string | null, projects: Pick<Project, 'id' | 'name'>[], waiting: { taskId: string }[] = []): OtherProjectsHint | undefined {
  if (filter === null) return undefined;
  const live = tasks.filter((t) => t.agentId === agentId && (t.status === 'running' || t.status === 'queued') && t.projectId !== filter)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!live.length) return undefined;
  const need = live.filter((t) => waiting.some((w) => w.taskId === t.id));
  const rows = need.length ? need : live;
  // real projects are counted; a task outside projects is not a project, so a mix says "elsewhere"
  const where = (ts: LiveTask[]): string => {
    const ids = [...new Set(ts.filter((t) => t.projectId).map((t) => t.projectId!))];
    if (ids.length && ts.some((t) => !t.projectId)) return 'elsewhere';
    if (ids.length > 1) return `in ${ids.length} other projects`;
    return inWhere(projects, ids[0]);
  };
  return need.length
    ? { text: `${need.length} needs you ${where(need)}`, tone: 'amber', tasks: [...need, ...live.filter((t) => !need.includes(t))] }
    : { text: `+${rows.length} running ${where(rows)}`, tone: 'plain', tasks: live };
}
