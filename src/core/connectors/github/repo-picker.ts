/**
 * Choose an App's repositories from inside Legion. Owner-only (reached by the admin routes in repo-picker-routes.ts, never offered to an
 * agent). Uses the signed-in App's own user token: GET /user/installations, GET /user/repos, and PUT/DELETE on
 * /user/installations/{id}/repositories/{repo_id}. GitHub needs repo admin for a change, and refuses a change on an "all repositories"
 * installation. One change at a time per App; a PUT or DELETE is sent once and never retried.
 */
import { HttpError } from '../../server.js';
import { GhError, type GitHubClient } from './client.js';
import { githubInstallUrl, GITHUB_APP_SLUGS } from './hosts.js';
import type { GithubApp, GithubPickerRow, GithubPickerView } from '../../../shared/github-area.js';

export interface RepoPickerDeps {
  client: (app: GithubApp) => Pick<GitHubClient, 'signedIn' | 'request'> | undefined;
  /** Called after a change, so the area list shows it without waiting for its cache. */
  invalidate(): void;
}

const CANDIDATE_PAGES = 3;
const INSTALLED_PAGES = 10;
const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const validRepoName = (s: string): boolean => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s);

export const parseApp = (v: unknown): GithubApp => {
  if (v === 'read' || v === 'write') return v;
  throw new HttpError(400, 'The app must be read or write.');
};
export const parseRepoId = (v: unknown): number => {
  const s = typeof v === 'string' ? v : '';
  const n = /^[1-9]\d{0,15}$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n)) throw new HttpError(400, 'The repo id must be a positive whole number.');
  return n;
};

/** Plain words for a failed call. A 422 means GitHub refused the change itself; the body of the answer is never shown. */
function failure(e: unknown, op: 'read' | 'put' | 'delete'): HttpError {
  if (!(e instanceof GhError)) return new HttpError(502, 'Could not reach GitHub.');
  if (e.kind === 'rate-limited') return new HttpError(429, 'GitHub is limiting requests. Try again in a while.');
  if (e.kind === 'not-found') return new HttpError(404, 'GitHub did not find that repo or installation.');
  if (e.kind === 'forbidden') return new HttpError(403, op === 'read' ? 'GitHub refused. Sign in again, then try again.' : 'You need to be an admin of that repo to add it.');
  if (e.kind === 'not-connected' || e.kind === 'auth-expired') return new HttpError(401, 'Sign in to GitHub again.');
  if (e.kind === 'network' && e.status === 422) {
    return new HttpError(422, op === 'delete'
      ? 'Legion must keep at least one repo, or it is set to all repos on GitHub.'
      : 'GitHub refused: the app is set to all repos. Change that at GitHub.');
  }
  return new HttpError(502, op === 'read' ? 'Could not reach GitHub.' : 'Could not reach GitHub. Check the repo list before you try again.');
}

type Inst = { id: number; account: string; selection: 'all' | 'selected' };

export function createRepoPicker(deps: RepoPickerDeps) {
  const running = new Set<GithubApp>();

  const signedClient = async (app: GithubApp): Promise<NonNullable<ReturnType<RepoPickerDeps['client']>> | undefined> => {
    const c = deps.client(app);
    try { return c && (await c.signedIn()) ? c : undefined; } catch { return undefined; }
  };

  /** The App's installation on the owner's own account (an organisation one only when there is no personal one). */
  async function installationOf(c: NonNullable<ReturnType<RepoPickerDeps['client']>>): Promise<Inst | undefined> {
    const raw = asRec((await c.request('/user/installations?per_page=100')).json).installations;
    const found = (Array.isArray(raw) ? raw : []).map(asRec).filter((i) => typeof i.id === 'number' && typeof asRec(i.account).login === 'string');
    const inst = found.find((i) => asRec(i.account).type !== 'Organization') ?? found[0];
    if (!inst) return undefined;
    return { id: inst.id as number, account: String(asRec(inst.account).login), selection: inst.repository_selection === 'all' ? 'all' : 'selected' };
  }

  async function list(appIn: unknown, qIn: string): Promise<GithubPickerView> {
    const app = parseApp(appIn);
    const q = qIn.trim().toLowerCase().slice(0, 100);
    const c = await signedClient(app);
    if (!c) return { phase: 'needs-signin' };
    const installUrl = githubInstallUrl(GITHUB_APP_SLUGS[app]);
    try {
      const inst = await installationOf(c);
      if (!inst) return { phase: 'not-installed', installUrl };
      const installed = new Set<number>();
      for (let page = 1; page <= INSTALLED_PAGES; page++) {
        const got = asRec((await c.request(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`)).json).repositories;
        const rows = Array.isArray(got) ? got : [];
        for (const r of rows) { const id = asRec(r).id; if (typeof id === 'number') installed.add(id); }
        if (rows.length < 100) break;
      }
      const out: GithubPickerRow[] = [];
      let truncated = false;
      for (let page = 1; page <= CANDIDATE_PAGES; page++) {
        const res = (await c.request(`/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=${page}`)).json;
        const rows = Array.isArray(res) ? res : [];
        for (const raw of rows) {
          const r = asRec(raw);
          if (typeof r.id !== 'number' || typeof r.full_name !== 'string' || !validRepoName(r.full_name)) continue;
          // a change goes to this one installation, so only that account's repos can be chosen here
          if (r.full_name.split('/')[0]!.toLowerCase() !== inst.account.toLowerCase()) continue;
          if (q && !r.full_name.toLowerCase().includes(q)) continue;
          out.push({ id: r.id, fullName: r.full_name, private: r.private === true, admin: asRec(r.permissions).admin === true, installed: installed.has(r.id) });
        }
        if (rows.length < 100) break;
        if (page === CANDIDATE_PAGES) truncated = true;
      }
      return { phase: 'ready', installationId: inst.id, selection: inst.selection, account: inst.account, rows: out, seesUninstalled: out.some((r) => !r.installed), installUrl, truncated };
    } catch (e) { throw failure(e, 'read'); }
  }

  async function change(appIn: unknown, repoIdIn: unknown, add: boolean): Promise<{ ok: true }> {
    const app = parseApp(appIn);
    const repoId = parseRepoId(repoIdIn); // refused before any lock or call
    if (running.has(app)) throw new HttpError(409, 'A change is already running.');
    running.add(app);
    try {
      const c = await signedClient(app);
      if (!c) throw new HttpError(401, 'Sign in to GitHub again.');
      try {
        const inst = await installationOf(c);
        if (!inst) throw new GhError('not-found');
        await c.request(`/user/installations/${inst.id}/repositories/${repoId}`, { method: add ? 'PUT' : 'DELETE' });
      } catch (e) { throw failure(e, add ? 'put' : 'delete'); } finally { deps.invalidate(); }
      return { ok: true };
    } finally { running.delete(app); }
  }

  return { list, add: (app: unknown, id: unknown) => change(app, id, true), remove: (app: unknown, id: unknown) => change(app, id, false) };
}
