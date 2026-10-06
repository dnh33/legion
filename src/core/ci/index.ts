/**
 * The CI module: the current repository's GitHub Actions runs, live, for the CI panel and its title-bar chip.
 *
 * Every route is admin-only (the gate denies by default; none is in CLIENT_ROUTES in admin.ts, and none may be). Re-run and Cancel are owner
 * clicks: they call the port's write members from the two POST routes below and nowhere else. The port is the GitHub client of the connectors
 * work; this module never fetches, never spawns a process and holds no token. Without a client, every route says so plainly.
 * The repo comes from the project folder's git remote (origin, then cloud), or from a repo the owner typed in the panel.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../server.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { asGhError } from './port.js';
import type { GitHubPort } from './port.js';
import { CiPoller } from './poller.js';
import type { PollerOptions, ResolvedRepo } from './poller.js';
import { parseRepoText, readRepoInfo, repoKey, validBranch } from './repo.js';
import type { RepoRef } from './repo.js';

export { CiPoller } from './poller.js';
export type { GitHubPort } from './port.js';

export interface CiOptions {
  /** The GitHub client. Absent: the panel says GitHub support arrives with Connectors. */
  github?: GitHubPort | undefined;
  /** For resolving a project's folder. */
  projects?: { get(id: string): { folder: string } | undefined };
  log?: (m: string) => void;
  /** Tests only. */
  now?: () => number;
  schedule?: PollerOptions['schedule'];
}

export interface CiModule extends CoreModule { poller: CiPoller }

const ID = /^[1-9]\d{0,15}$/;
const PROJECT_ID = /^proj_[a-f0-9]{12}$/;
const UNAVAILABLE = 'GitHub support arrives with Connectors.';

const positive = (s: string | undefined, what: string): number => {
  if (!s || !ID.test(s)) throw new HttpError(400, `${what} must be a positive whole number`);
  return Number(s);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createCiModule(deps: ModuleDeps, opts: CiOptions = {}): CiModule {
  const log = opts.log ?? (() => undefined);
  const github = opts.github;
  const file = join(deps.dataDir, 'ci', 'repo.json');
  let manual: RepoRef | null = null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    manual = isObj(raw) ? parseRepoText(raw.repo) : null;
  } catch { /* none set */ }
  const saveManual = (): void => {
    mkdirSync(join(deps.dataDir, 'ci'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ repo: manual ? repoKey(manual) : null }), 'utf8');
    renameSync(tmp, file);
  };

  const resolveRepo = (projectId?: string): ResolvedRepo => {
    let folder = deps.config?.workspaceDir ?? '';
    if (projectId && PROJECT_ID.test(projectId)) { const p = opts.projects?.get(projectId); if (p?.folder) folder = p.folder; }
    const info = folder ? readRepoInfo(folder) : { repo: null, branch: null };
    if (manual) return { repo: manual, branch: info.repo && repoKey(info.repo) === repoKey(manual) ? info.branch : null, source: 'manual' };
    return { repo: info.repo, branch: info.repo ? info.branch : null, source: info.repo ? 'remote' : null };
  };

  const poller = new CiPoller({
    github, resolveRepo, log,
    emit: (summary) => deps.bus.emit({ type: 'ci.updated', summary }),
    ...(opts.now ? { now: opts.now } : {}), ...(opts.schedule ? { schedule: opts.schedule } : {}),
  });

  const need = (): GitHubPort => { if (!github) throw new HttpError(503, UNAVAILABLE); return github; };

  /** Owner clicks only: the single place the write members are called. */
  const write = async (op: 'rerun' | 'cancel', runId: number): Promise<{ ok: true }> => {
    const gh = need();
    if (gh.can('actions', 'write') !== 'yes') throw new HttpError(403, 'Connect GitHub with write access to do this.');
    const repo = poller.repoText();
    if (!repo) throw new HttpError(409, 'No repository is set.');
    try {
      if (op === 'rerun') await gh.rerunFailed(runId, repo); else await gh.cancel(runId, repo);
    } catch (e) {
      const err = asGhError(e);
      log(`ci: ${op} failed (${err.kind})`);
      if (err.kind === 'forbidden' || err.kind === 'auth-expired' || err.kind === 'not-connected') throw new HttpError(403, 'GitHub did not allow this. Connect with write access in Settings, Connectors.');
      if (err.kind === 'not-found') throw new HttpError(404, 'GitHub does not have that run.');
      if (err.kind === 'rate-limited') throw new HttpError(429, 'GitHub is limiting requests for now. Try again after the reset.');
      throw new HttpError(502, 'Could not reach GitHub. Try again.');
    }
    await poller.refresh('write');
    return { ok: true };
  };

  return {
    id: 'ci', poller,
    routes: (add) => {
      add('GET', '/api/ci/state', () => poller.stateView());
      add('GET', '/api/ci/runs', async ({ url }) => {
        need();
        const b = url.searchParams.get('branch');
        if (b !== null && !validBranch(b)) throw new HttpError(400, 'That branch name is not valid');
        return poller.runsView(b ?? undefined);
      });
      add('GET', '/api/ci/runs/:id/jobs', ({ params }) => { need(); return poller.jobsView(positive(params[0], 'Run id')); });
      add('GET', '/api/ci/jobs/:id/log', ({ params }) => { need(); return poller.logView(positive(params[0], 'Job id')); });
      add('POST', '/api/ci/runs/:id/rerun-failed', ({ params }) => write('rerun', positive(params[0], 'Run id')));
      add('POST', '/api/ci/runs/:id/cancel', ({ params }) => write('cancel', positive(params[0], 'Run id')));
      add('POST', '/api/ci/watch', ({ body }) => {
        const b = isObj(body) ? body : {};
        if (b.mode !== 'panel' && b.mode !== 'chip') throw new HttpError(400, "mode must be 'panel' or 'chip'");
        if (b.projectId !== undefined && (typeof b.projectId !== 'string' || !PROJECT_ID.test(b.projectId))) throw new HttpError(400, 'projectId is not valid');
        if (github) poller.heartbeat(b.mode, b.projectId as string | undefined);
        return { ok: true };
      });
      add('POST', '/api/ci/refresh', async ({ body }) => {
        need();
        const r = isObj(body) ? body.reason : undefined;
        await poller.refresh(r === 'open' || r === 'focus' ? r : 'manual');
        return poller.runsView();
      });
      add('PUT', '/api/ci/repo', async ({ body }) => {
        need();
        const v = isObj(body) ? body.repo : undefined;
        if (v === null || v === '') manual = null;
        else {
          const r = parseRepoText(v);
          if (!r) throw new HttpError(400, 'Use the form owner/name. Letters, digits, dots, dashes and underscores only.');
          manual = r;
        }
        saveManual();
        await poller.refresh('manual');
        return poller.stateView();
      });
    },
    dispose: () => poller.dispose(),
  };
}
