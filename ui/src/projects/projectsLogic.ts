/** Pure helpers for the Projects UI (no React, no store): tested in node. */
import type { Room } from '../../../src/shared/comms.js';
import { PROJECT_LIMITS, roomOutOfProjectReason } from '../../../src/shared/projects.js';
import type { Project } from '../../../src/shared/projects.js';
import type { AgentProfile, ApprovalRequest, PendingQuestion, Task } from '../../../src/shared/types.js';

export const INSTRUCTIONS_MAX = PROJECT_LIMITS.instructionsChars;
export const FILTER_KEY = 'legion.project';

const byName = (a: Project, b: Project): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
/** Active projects first (by name), then archived (by name). */
export const sortProjects = (ps: Project[]): Project[] => [...ps.filter((p) => p.status === 'active').sort(byName), ...ps.filter((p) => p.status !== 'active').sort(byName)];
export const projectLabel = (p: Pick<Project, 'name' | 'status'>): string => (p.status === 'archived' ? `${p.name} (archived)` : p.name);

/**
 * The project a task shows as its own on a tab, a History row or the thread header: its name, or "removed project"
 * for an id the window does not know. Nothing (undefined) when the task has no project, or when it is the project in
 * view (every task there is in it, so the chip would repeat the filter).
 */
export function taskProjectChip(projects: Project[], projectId: string | undefined, filter: string | null): string | undefined {
  if (!projectId || projectId === filter) return undefined;
  const p = projects.find((x) => x.id === projectId);
  return p ? projectLabel(p) : 'removed project';
}

/** A stored or chosen filter that names no project (deleted file, other machine) falls back to "All" (null). */
export const resolveFilter = (projects: Project[], filter: string | null | undefined): string | null =>
  filter && projects.some((p) => p.id === filter) ? filter : null;

/** The agents the rail shows: everyone for "All", the project's members (in the agents' own order) for a project. */
export function agentsFor(agents: AgentProfile[], projects: Project[], filter: string | null): AgentProfile[] {
  const p = filter ? projects.find((x) => x.id === filter) : undefined;
  return p ? agents.filter((a) => p.members.includes(a.id)) : agents;
}

/** "All" shows every task; a project shows only its own. */
export const inProject = (t: Pick<Task, 'projectId'>, filter: string | null): boolean => filter === null || t.projectId === filter;

/**
 * The project a NEW task of `agentId` starts in: the chosen project, when it is active and the agent is a member. A follow-up never names one
 * (the task keeps its own), and "All" never does.
 */
export function newTaskProjectId(projects: Project[], filter: string | null, agentId: string, continuing: boolean): string | undefined {
  if (continuing || !filter) return undefined;
  const p = projects.find((x) => x.id === filter);
  return p && p.status === 'active' && p.members.includes(agentId) ? p.id : undefined;
}

/**
 * Where a NEW task of this agent will go, said before it is sent (the same rule as newTaskProjectId): the project in
 * view, or no project. `why` explains a "No project" that the owner might not expect: the project is archived, or the
 * agent is not one of its members. Undefined when there is nothing to say: a follow-up, or no projects at all.
 */
export function newTaskTarget(projects: Project[], filter: string | null, agent: { id: string; name: string } | undefined, continuing: boolean): { label: string; why?: string } | undefined {
  if (continuing || !agent || !projects.length) return undefined;
  const p = filter ? projects.find((x) => x.id === filter) : undefined;
  if (!p) return { label: 'No project' };
  if (p.status !== 'active') return { label: 'No project', why: `${p.name} is archived, so a new task starts in no project` };
  if (!p.members.includes(agent.id)) return { label: 'No project', why: `${agent.name} is not a member of ${p.name}, so a new task starts in no project` };
  return { label: p.name };
}

/**
 * The question before a project is archived, with what it touches: runs in progress finish; open tasks cannot be
 * continued and no new task starts in it until it is unarchived; its rooms keep working without its context.
 */
export function archiveQuestion(name: string, n: { live: number; open: number; rooms: number }): string {
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const lines = [`Archive "${name}"?`];
  if (n.live) lines.push(`${plural(n.live, 'run in progress finishes', 'runs in progress finish')} first.`);
  lines.push(n.open ? `Its ${plural(n.open, 'open task', 'open tasks')} cannot be continued, and no new task can start in it, until you unarchive it.` : 'No new task can start in it until you unarchive it.');
  if (n.rooms) lines.push(`${plural(n.rooms, 'room is', 'rooms are')} marked out of project, with a notice in ${n.rooms === 1 ? 'it' : 'each'}; ${n.rooms === 1 ? 'it keeps' : 'they keep'} working without the project's instructions, board and notes.`);
  return lines.join('\n\n');
}

/** Why a room is out of its project (the same rule the core uses for its notice), or undefined: shown as a badge. */
export function roomOutOfProject(room: Pick<Room, 'projectId' | 'members'>, projects: Project[], names: Record<string, string>): string | undefined {
  if (!room.projectId) return undefined;
  return roomOutOfProjectReason(room.members, projects.find((p) => p.id === room.projectId), (id) => names[id] ?? id);
}

/** The question before a project is unarchived: what comes back. */
export const unarchiveQuestion = (name: string): string =>
  `Unarchive "${name}"?

Its tasks can be continued again and new tasks can start in it. Its rooms and members get its instructions, board and notes again.`;

export const roomsOf = (rooms: Room[], projectId: string): Room[] => rooms.filter((r) => r.projectId === projectId);
/** Rooms the owner can move into the project: none yet, and every member of the room is already a member of the project. */
export const assignableRooms = (rooms: Room[], p: Project): Room[] => rooms.filter((r) => r.kind === 'group' && !r.projectId && r.members.every((m) => p.members.includes(m)));

export function memberDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((m) => !before.includes(m)), removed: before.filter((m) => !after.includes(m)) };
}

export function instructionsCounter(text: string): { count: number; over: boolean; label: string } {
  const count = text.length;
  const over = count > INSTRUCTIONS_MAX;
  return { count, over, label: over ? `${count} of ${INSTRUCTIONS_MAX} characters: the extra ${count - INSTRUCTIONS_MAX} will be cut when you save.` : `${count} of ${INSTRUCTIONS_MAX} characters` };
}

/** Plain words for the state of a project, for the page header and the screen reader. */
export function statusLine(p: Project, taskCount: number, roomCount: number): string {
  const bits = [p.status === 'archived' ? 'Archived' : 'Active', `${p.members.length} ${p.members.length === 1 ? 'member' : 'members'}`, `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`, `${roomCount} ${roomCount === 1 ? 'room' : 'rooms'}`];
  return bits.join(', ');
}

const clipTitle = (t: string): string => (t.length > 40 ? t.slice(0, 39) + '…' : t);

/** One thing waiting on the owner that the rail hides under the project in view (decision B1). */
export interface WaitingRow { kind: 'approval' | 'question'; id: string; taskId: string; agentId: string; projectId: string | null; label: string }

/**
 * Approvals and questions the rail would hide under this filter: their task is in another project or none, or the agent
 * is not one of the project's members (so it has no row). Oldest first. Under "All" every agent has a row: nothing.
 */
export function waitingElsewhere(
  approvals: Pick<ApprovalRequest, 'id' | 'taskId' | 'agentId' | 'at'>[],
  questions: Pick<PendingQuestion, 'id' | 'taskId' | 'agentId' | 'at'>[],
  tasks: Pick<Task, 'id' | 'projectId' | 'title'>[],
  projects: Project[], names: Record<string, string>, filter: string | null,
): WaitingRow[] {
  if (!filter) return [];
  const here = projects.find((p) => p.id === filter);
  const items = [...approvals.map((a) => ({ ...a, kind: 'approval' as const })), ...questions.map((q) => ({ ...q, kind: 'question' as const }))];
  const rows: Array<WaitingRow & { at: string }> = [];
  for (const it of items) {
    const t = tasks.find((x) => x.id === it.taskId);
    if (t && t.projectId === filter && here?.members.includes(it.agentId)) continue;
    const who = names[it.agentId] ?? it.agentId;
    const verb = it.kind === 'approval' ? 'needs your OK' : 'asks you something';
    const where = !t ? 'in another task'
      : !t.projectId ? `in no project: ${clipTitle(t.title)}`
        : `in ${projects.find((p) => p.id === t.projectId)?.name ?? 'a removed project'}: ${clipTitle(t.title)}`;
    rows.push({ kind: it.kind, id: it.id, taskId: it.taskId, agentId: it.agentId, projectId: t?.projectId ?? null, label: `${who} ${verb} ${where}`, at: it.at });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _at, ...r }) => r);
}

type LiveTask = Pick<Task, 'id' | 'agentId' | 'status' | 'projectId' | 'title' | 'updatedAt'>;
/**
 * The agent's live (queued or running) tasks outside the project in view, or outside this thread's project, newest
 * first; never the thread itself. With no project to compare (All, and a thread in none): every other live task.
 * Shown as "Also working in…", never a block (decision B1).
 */
export function liveElsewhere(agentId: string, tasks: LiveTask[], here: { filter: string | null; taskId: string | null; taskProjectId?: string }): LiveTask[] {
  const ref = here.taskProjectId ?? here.filter ?? undefined;
  return tasks
    .filter((t) => t.agentId === agentId && t.id !== here.taskId && (t.status === 'running' || t.status === 'queued') && (ref === undefined || t.projectId !== ref))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** "Also working in Shop: Fix the header (+2 more)", or nothing. */
export function alsoWorkingLabel(rows: Pick<Task, 'projectId' | 'title'>[], projects: Project[]): string | undefined {
  const first = rows[0];
  if (!first) return undefined;
  const where = first.projectId ? (projects.find((p) => p.id === first.projectId)?.name ?? 'a removed project') : 'no project';
  return `Also working in ${where}: ${clipTitle(first.title)}${rows.length > 1 ? ` (+${rows.length - 1} more)` : ''}`;
}

/** An editor's text after the saved value changed elsewhere: untouched (still the old saved value) follows; edited keeps the owner's text. */
export const followRemote = (local: string, prevRemote: string, nextRemote: string): string => (local === prevRemote ? nextRemote : local);

/** Who starts a new task from the project page by default: the agent in view when it is a member, else the first member. */
export const defaultStarter = (members: string[], selected: string | null): string | undefined =>
  selected && members.includes(selected) ? selected : members[0];

/** The project page lists this many tasks until the owner asks for all. */
export const PROJECT_TASKS_FOLDED = 30;
export const visibleTasks = <T>(list: T[], expanded: boolean): T[] => (expanded ? list : list.slice(0, PROJECT_TASKS_FOLDED));
