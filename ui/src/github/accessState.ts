/** The agent and project GitHub access states and the words for them. Pure, so the tests render nothing. */
import type { GithubAreaView } from '../../../src/shared/github-area.js';

/** `ok` means GET /api/github/area answered. An empty list is only believed in that state. */
export interface AreaState { status: 'loading' | 'error' | 'ok'; view: GithubAreaView | null }
export const AREA_LOADING: AreaState = { status: 'loading', view: null };
export const areaStateOf = (view: GithubAreaView): AreaState => ({ status: 'ok', view: { ...view, repos: Array.isArray(view.repos) ? view.repos : [] } });

export interface AreaNotice { kind: 'loading' | 'error' | 'not-connected' | 'auth-expired' | 'write-signin'; text: string; /** a button that opens Settings, GitHub */ settings?: boolean; /** a Try again button */ retry?: boolean }

/** The one line to show instead of the repo list, or null when the list can be trusted. `needWrite` is true for the write choice, which also needs the write sign-in. */
export function areaNotice(a: AreaState, needWrite: boolean): AreaNotice | null {
  if (a.status === 'loading') return { kind: 'loading', text: 'Loading repositories\u2026' };
  const v = a.view;
  if (a.status === 'error' || !v) return { kind: 'error', text: 'Legion could not reach GitHub.', retry: true };
  if (v.problem?.kind === 'not-connected' || !v.signedIn.read) return { kind: 'not-connected', text: 'GitHub is not connected.', settings: true };
  if (v.problem?.kind === 'auth-expired') return { kind: 'auth-expired', text: 'The GitHub sign-in ran out.', settings: true };
  if (v.problem) return { kind: 'error', text: 'Legion could not reach GitHub.', retry: true };
  if (needWrite && !v.signedIn.write) return { kind: 'write-signin', text: 'Write sign-in not done, so agents cannot write yet.', settings: true };
  return null;
}

/** The project page line, from GET /api/github/projects/:id/repo. Offers nothing when the folder has no GitHub repo. */
export interface ProjectRepo { repo: string | null; ticked: boolean }
export function projectRepoNotice(p: ProjectRepo): { text: string; offer: boolean } {
  if (!p.repo) return { text: 'This project\u2019s folder has no GitHub repository, so there is nothing to share with its agents.', offer: false };
  return { text: p.ticked ? 'It is turned on in Legion.' : 'It is not turned on in Legion yet, so no agent can use it.', offer: true };
}
