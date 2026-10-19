/**
 * Legion — Projects contract (see docs/design/plan-projects.md). A project groups the work for one job: shared instructions, a folder,
 * member agents, and the tasks and rooms that name it. Owner-only to create or change.
 */
export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  name: string;
  /** Owner's text for every task in the project. Clipped to PROJECT_LIMITS.instructionsChars. */
  instructions: string;
  /** Absolute path. Default <workspaceDir>/projects/<id>. */
  folder: string;
  /** Agent ids. */
  members: string[];
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * True when the project's folder is its default one (<workspace>/projects/<id>): the core builds that path from the project id and nothing else does,
 * so the window can tell without knowing the workspace folder. Slashes of either kind, and a trailing one, are fine.
 */
export function usesDefaultFolder(p: Pick<Project, 'id' | 'folder'>): boolean {
  const parts = p.folder.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.length >= 2 && parts[parts.length - 1] === p.id && parts[parts.length - 2] === 'projects';
}

export const PROJECT_LIMITS = { nameChars: 80, instructionsChars: 4_000, members: 24, projects: 50 } as const;

export const PROJECT_ID_RE = /^proj_[a-f0-9]{12}$/;

/**
 * The Library scope of a project's notes. It is shaped like a private scope on purpose: an older build accepts the string and treats it as
 * private to an agent that does not exist (hidden from every bot, visible to the owner) instead of widening it to "shared".
 * Real agent ids never contain a dot (they come from slugify), so this can never equal `agent:<agentId>`.
 */
export const PROJECT_SCOPE_PREFIX = 'agent:project.';
export const projectScope = (projectId: string): `agent:${string}` => `${PROJECT_SCOPE_PREFIX}${projectId}`;
/** The project id a scope names, or undefined for any other scope. */
export const projectIdOfScope = (scope: string): string | undefined => {
  if (!scope.startsWith(PROJECT_SCOPE_PREFIX)) return undefined;
  const id = scope.slice(PROJECT_SCOPE_PREFIX.length);
  return PROJECT_ID_RE.test(id) ? id : undefined;
};

/**
 * Why a room tagged with a project is out of it (decision B4), or undefined while it is in it: the project is gone or
 * archived, or one of the room's agents is not a member. The room keeps its tag, so putting this right brings it back.
 */
export function roomOutOfProjectReason(members: readonly string[], project: Pick<Project, 'status' | 'members'> | undefined, nameOf: (id: string) => string): string | undefined {
  if (!project) return 'the project was deleted';
  if (project.status !== 'active') return 'the project is archived';
  const outside = members.find((m) => !project.members.includes(m));
  return outside ? `${nameOf(outside)} is not a member of it` : undefined;
}
