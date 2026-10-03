/** Pure helpers for the Projects UI (no React, no store): tested in node. */
import type { Room } from '../../../src/shared/comms.js';
import { PROJECT_LIMITS } from '../../../src/shared/projects.js';
import type { Project } from '../../../src/shared/projects.js';
import type { AgentProfile, Task } from '../../../src/shared/types.js';

export const INSTRUCTIONS_MAX = PROJECT_LIMITS.instructionsChars;
export const FILTER_KEY = 'legion.project';

const byName = (a: Project, b: Project): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
/** Active projects first (by name), then archived (by name). */
export const sortProjects = (ps: Project[]): Project[] => [...ps.filter((p) => p.status === 'active').sort(byName), ...ps.filter((p) => p.status !== 'active').sort(byName)];
export const projectLabel = (p: Pick<Project, 'name' | 'status'>): string => (p.status === 'archived' ? `${p.name} (archived)` : p.name);

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
