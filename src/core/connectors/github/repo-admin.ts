/**
 * Create a repository from Legion (design 6.4, amendment 13). Owner-only: reached by the admin routes in repo-admin-routes.ts, never offered
 * to an agent. It uses the write App's normal encrypted token (`getGitHubClient('write')`); there is no separate create sign-in.
 * One POST per create, never retried after it is sent, and one create at a time per core.
 */
import { HttpError } from '../../server.js';
import { validCreateName } from '../../../shared/github-area.js';
import { setTicked } from './allowlist.js';
import { GhError, type GhAppKind, type GitHubClient } from './client.js';

export interface RepoAdminDeps {
  dataDir: string;
  /** The core's one client per App. */
  client: (kind?: GhAppKind) => GitHubClient | undefined;
}
export type CreateResult =
  | { phase: 'needs-write'; message: string }
  | { phase: 'done'; fullName: string; htmlUrl: string; ticked: boolean };

export const NEEDS_WRITE_MESSAGE = 'Connect writes first: creating a repo uses Legion (write).';
const MAX_DESCRIPTION = 350;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

interface CreateInput { owner?: string; name: string; description?: string; private: boolean; readme: boolean; tick: boolean }

function parse(body: unknown): CreateInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object.');
  const b = body as Record<string, unknown>;
  const flag = (k: string, dflt: boolean): boolean => {
    if (b[k] === undefined) return dflt;
    if (typeof b[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false.`);
    return b[k] as boolean;
  };
  if (typeof b.name !== 'string' || !validCreateName(b.name)) throw new HttpError(400, 'Use letters, digits, dots, dashes and underscores for the name (up to 100).');
  if (b.owner !== undefined && (typeof b.owner !== 'string' || !OWNER_RE.test(b.owner))) throw new HttpError(400, 'That organisation name is not valid.');
  if (b.description !== undefined && typeof b.description !== 'string') throw new HttpError(400, 'The description must be text.');
  return {
    ...(typeof b.owner === 'string' ? { owner: b.owner } : {}),
    name: b.name,
    ...(typeof b.description === 'string' && b.description.trim() ? { description: b.description.slice(0, MAX_DESCRIPTION) } : {}),
    private: flag('private', true), readme: flag('readme', false), tick: flag('tick', false),
  };
}

/** Plain words for a failed create. 422 is a name that is taken (or one GitHub refuses); the body of the answer is never shown. */
function failure(e: unknown, org: boolean): HttpError {
  if (!(e instanceof GhError)) return new HttpError(502, 'Could not create the repository.');
  if (e.kind === 'network' && e.status === 422) return new HttpError(422, 'That name is taken.');
  if (e.kind === 'rate-limited') return new HttpError(429, 'GitHub is limiting requests. Try again in a while.');
  if (e.kind === 'not-found') return new HttpError(404, 'GitHub did not find that.');
  if (e.kind === 'forbidden') return new HttpError(403, org ? 'The organisation must approve Legion (write) first.' : 'GitHub refused. Legion (write) needs permission to create repositories on your account.');
  if (e.kind === 'not-connected' || e.kind === 'auth-expired') return new HttpError(401, 'Sign in to Legion (write) again.');
  return new HttpError(502, 'Could not reach GitHub. Check your repositories before you try again.');
}

export function createRepoAdmin(deps: RepoAdminDeps) {
  let running = false;
  const write = (): GitHubClient | undefined => deps.client('write');

  async function create(body: unknown): Promise<CreateResult> {
    const input = parse(body); // refused before any lock or call
    if (running) throw new HttpError(409, 'A create is already running.');
    running = true;
    try {
      const c = write();
      if (!c || !(await c.signedIn())) return { phase: 'needs-write', message: NEEDS_WRITE_MESSAGE };
      const payload = { name: input.name, ...(input.description ? { description: input.description } : {}), private: input.private, auto_init: input.readme };
      let res;
      try {
        res = await c.request(input.owner ? `/orgs/${encodeURIComponent(input.owner)}/repos` : '/user/repos', { method: 'POST', body: JSON.stringify(payload) });
      } catch (e) { throw failure(e, !!input.owner); }
      const j = asRec(res.json);
      // without full_name and owner the login is unknown: never make up "/name" or tick it
      const known = typeof j.full_name === 'string' ? j.full_name : input.owner ? `${input.owner}/${input.name}` : undefined;
      const fullName = known ?? input.name;
      const htmlUrl = typeof j.html_url === 'string' && j.html_url.startsWith('https://github.com/') ? j.html_url : known ? `https://github.com/${known}` : 'https://github.com/';
      let ticked = false;
      if (input.tick && known) { try { setTicked(deps.dataDir, fullName, true); ticked = true; } catch { /* created; the owner can turn it on in the list */ } }
      return { phase: 'done', fullName, htmlUrl, ticked };
    } finally { running = false; }
  }

  async function orgs(): Promise<{ orgs: { login: string }[] }> {
    const c = write();
    if (!c || !(await c.signedIn())) return { orgs: [] };
    try {
      const res = await c.request('/user/orgs?per_page=100');
      const list = Array.isArray(res.json) ? res.json : [];
      return { orgs: list.flatMap((o) => { const l = asRec(o).login; return typeof l === 'string' && OWNER_RE.test(l) ? [{ login: l }] : []; }) };
    } catch (e) { throw failure(e, true); }
  }

  return { create, orgs };
}
