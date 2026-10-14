/** What the GitHub area routes say, as the editor and the project page need it: a loading and an error state apart from an empty list, and the project's own repo. */
import type { GithubAreaView } from '../../../src/shared/github-area';
import { areaStateOf } from './accessState';
import type { AreaState, ProjectRepo } from './accessState';

/** api.ts reads window at load, so it is imported only when a call is made in the browser (keeps server-side renders and tests free of it). */
const req = async <T>(m: string, p: string, body?: unknown): Promise<T> => (await import('../api')).request<T>(m, p, body);

export async function loadArea(): Promise<AreaState> {
  try { return areaStateOf(await req<GithubAreaView>('GET', '/api/github/area')); } catch { return { status: 'error', view: null }; }
}

export async function loadProjectRepo(id: string): Promise<ProjectRepo | null> {
  try { return await req<ProjectRepo>('GET', `/api/github/projects/${encodeURIComponent(id)}/repo`); } catch { return null; }
}
/** One call raises access for the project's members; the server answers 409 in plain words. */
export async function putProjectAccess(id: string, level: 'read' | 'write'): Promise<{ ok: true; agents: number } | { ok: false; status: number; message: string }> {
  try {
    const r = await req<{ agents: number }>('PUT', `/api/github/projects/${encodeURIComponent(id)}/access`, { level });
    return { ok: true, agents: r.agents };
  } catch (e) { const x = e as { status?: number; message?: string }; return { ok: false, status: x.status ?? 0, message: x.message ?? '' }; }
}
