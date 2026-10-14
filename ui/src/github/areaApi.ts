/**
 * The ticked repos, from GET /api/github/area. That route lands with the GitHub area core; until it answers, a clearly marked sample list keeps the
 * checklist usable. Delete MOCK_AREA and the fallback once the route is merged: the shape already matches GithubAreaView.
 */
import type { GithubAreaView } from '../../../src/shared/github-area';

/** api.ts reads window at load, so it is imported only when a call is made in the browser (keeps server-side renders and tests free of it). */
const req = async <T>(m: string, p: string): Promise<T> => (await import('../api')).request<T>(m as 'GET', p);

export type AreaRepos = Pick<GithubAreaView, 'repos'> & { sample: boolean };
const MOCK_AREA: AreaRepos = { sample: true, repos: [] };

export async function loadAreaRepos(): Promise<AreaRepos> {
  try {
    const v = await req<GithubAreaView>('GET', '/api/github/area');
    return { repos: Array.isArray(v.repos) ? v.repos : [], sample: false };
  } catch { return MOCK_AREA; }
}

/** The GitHub repo of the folder the CI panel is watching, as "owner/name". Null when there is none. */
export async function loadWatchedRepo(): Promise<string | null> {
  try {
    const s = await req<{ repo: { owner: string; name: string } | null }>('GET', '/api/ci/state');
    return s.repo ? `${s.repo.owner}/${s.repo.name}` : null;
  } catch { return null; }
}
