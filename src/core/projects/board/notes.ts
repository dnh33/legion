/** The board's view of the Library: project-scope notes only. The board never reads or writes other scopes. */
import type { Graph } from '../../kg/graph.js';
import { effectiveTrust, statusOf } from '../../kg/text.js';
import { HUMAN } from '../../kg/types.js';
import { projectScope } from '../../../shared/projects.js';

export interface BoardNotes {
  /** True when `id` is a note in this project's Library scope. */
  has(id: string, projectId: string): boolean;
  /** Ids (and titles) of the project-scope notes an agent saved during this task. Automatic episodes are left out. */
  byTask(taskId: string, projectId: string): string[];
  /** The owner saves a project note about an item. Throws a plain Error with the Library's own message when it refuses. */
  create(projectId: string, input: { title: string; body: string; itemId: string }): { id: string; title: string };
  title(id: string): string | undefined;
  /** The project's most recently updated notes that are safe to name in a briefing: active, not untrusted, not from a tainted run, not automatic episodes. */
  recent(projectId: string, limit?: number): Array<{ id: string; title: string }>;
}

export function graphNotes(graph: () => Graph): BoardNotes {
  return {
    has: (id, pid) => graph().getNode(HUMAN, id)?.scope === projectScope(pid),
    byTask: (taskId, pid) => graph().allNodes(HUMAN).filter((n) => n.scope === projectScope(pid) && n.origin?.taskId === taskId && n.type !== 'episode' && n.createdBy !== 'system').map((n) => n.id).slice(0, 10),
    create: (pid, i) => {
      const r = graph().upsertNode(HUMAN, { title: i.title, body: i.body, scope: projectScope(pid), tags: ['board', 'learned'], props: { boardItem: i.itemId } });
      return { id: r.node.id, title: r.node.title };
    },
    title: (id) => graph().getNode(HUMAN, id)?.title,
    recent: (pid, limit = 5) => graph().allNodes(HUMAN)
      .filter((n) => n.scope === projectScope(pid) && n.type !== 'episode' && statusOf(n) === 'active' && effectiveTrust(n) !== 'untrusted' && n.origin?.tainted !== true)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, limit).map((n) => ({ id: n.id, title: n.title })),
  };
}
