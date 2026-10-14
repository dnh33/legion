/** What the GitHub area reads on top of the shared GithubAreaView (src/shared/github-area.ts). Amendment 13.3: the view also carries what agents did. */
import type { CiProblem, CiRun } from '../../../src/shared/ci.js';
import type { GithubAreaView } from '../../../src/shared/github-area.js';
import type { ActivityKind } from './areaState.js';

export interface GithubActivity {
  id: string;
  /** ISO time. */
  at: string;
  /** The agent's display name. */
  agent: string;
  kind: ActivityKind;
  /** owner/name */
  repo: string;
  /** "#139 Add the GitHub area"; absent when the core gave none. */
  title?: string;
  /** The core sends no link to the item, so none is made up. */
  url?: string;
}

/** The area's one call (GET /api/github/area), with each agent action given its agent's name. */
export interface GithubAreaData extends Omit<GithubAreaView, 'activity'> {
  activity: GithubActivity[];
}

export interface GithubProjectUse { id: string; name: string; level: 'none' | 'read' | 'write' }

export interface GithubRepoCi {
  runs: CiRun[];
  /** Names of the failed jobs per run id. */
  failed: Record<number, string[]>;
  problem: CiProblem | null;
  /** 'watch-needed': the CI panel watches another repo, so there is nothing to show here yet. */
  source: 'here' | 'watch-needed';
}

/** `projectsError`: the plain reason the projects list could not be read (the rest of the detail still shows). */
export interface GithubRepoDetail { projects: GithubProjectUse[]; projectsError?: string; ci: GithubRepoCi }

export interface CreateRepoBody { owner?: string; name: string; description?: string; private: boolean; readme: boolean; tick: boolean }

/** One agent as the area needs it (id, name and its GitHub level inputs). */
export interface AreaAgent { id: string; name: string; connectors?: string[]; githubWrite?: string[] }
