/** What the GitHub area reads on top of the shared GithubAreaView (src/shared/github-area.ts). Amendment 13.3: the view also carries what agents did. */
import type { CiProblem, CiRun } from '../../../src/shared/ci';
import type { GithubAreaView } from '../../../src/shared/github-area';
import type { ActivityKind } from './areaState';

export interface GithubActivity {
  id: string;
  /** ISO time. */
  at: string;
  /** The agent's display name. */
  agent: string;
  kind: ActivityKind;
  /** owner/name */
  repo: string;
  /** "#139 Add the GitHub area" */
  title: string;
  /** A github.com page. */
  url: string;
}

/** The area's one call: the shared view plus what agents did through Legion (from the gateway's own records). */
export interface GithubAreaData extends GithubAreaView {
  activity: GithubActivity[];
  /** The organisations the signed-in account can create repos in. Empty = personal account only. */
  orgs?: string[];
}

export interface GithubProjectUse { id: string; name: string; agentIds: string[] }

export interface GithubRepoCi {
  runs: CiRun[];
  /** Names of the failed jobs per run id. */
  failed: Record<number, string[]>;
  problem: CiProblem | null;
  /** 'watch-needed': the CI panel watches another repo, so there is nothing to show here yet. */
  source: 'here' | 'watch-needed';
}

export interface GithubRepoDetail { projects: GithubProjectUse[]; ci: GithubRepoCi }

export interface CreateRepoBody { owner?: string; name: string; description?: string; private: boolean; readme: boolean; tick: boolean }

/** One agent as the area needs it (id, name and its GitHub level inputs). */
export interface AreaAgent { id: string; name: string; connectors?: string[]; githubWrite?: string[] }
