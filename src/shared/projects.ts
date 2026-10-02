/**
 * Legion — Projects contract (see claude/plan-projects.md). A project groups the work for one job: shared instructions, a folder,
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
