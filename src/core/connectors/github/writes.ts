/**
 * The GitHub senders (design 4.3, 6.3): the only code that changes anything on GitHub for an agent. Each function sends ONE request and
 * returns a short summary of what GitHub made. None of them retries, ever: a request that left may have been applied, so a second one
 * could do it twice. A failure is thrown as it came (a `GhError`), and the caller reports it.
 *
 * Importable only by `write-tools.ts` (which raises the owner's card before calling any of these) and the admin routes (the owner's own CI panel buttons, `ci/wiring.ts`). A source test
 * (test/connector-imports.test.ts) holds that line, so no path can reach GitHub with a write and skip the card.
 *
 * Arguments are already checked by the caller (types, sizes). Every path is built with `repoPath`, which refuses a repo or segment that
 * could climb out of `/repos/<owner>/<name>`. Never offered here (design 4.4): merge, push, delete, branch, dispatch, settings.
 */
import { GhError, getGitHubClient } from './client.js';
import type { GhResponse } from './client.js';
import { repoPath } from './tools.js';
import type { ToolOut } from './tools.js';

/** What the senders need of the write client: one request with a method and a JSON body. */
export interface WriteApi {
  request(path: string, init?: { method?: string; body?: string }): Promise<GhResponse>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The few fields of GitHub's answer worth handing back to the agent. */
function made(res: GhResponse, what: string): ToolOut {
  const j = isObj(res.json) ? res.json : {};
  const out: Record<string, unknown> = { done: what };
  if (typeof j.number === 'number') out.number = j.number;
  if (typeof j.id === 'number') out.id = j.id;
  if (typeof j.html_url === 'string') out.url = j.html_url.slice(0, 300);
  return { data: out };
}
const post = (api: WriteApi, path: string, body: Record<string, unknown> | undefined, method = 'POST'): Promise<GhResponse> =>
  api.request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

export interface IssueFields { title?: string; body?: string; labels?: string[]; assignees?: string[]; state?: 'open' | 'closed' }

/** Open a new issue. */
export async function createIssue(api: WriteApi, repo: string, f: IssueFields & { title: string }): Promise<ToolOut> {
  return made(await post(api, repoPath(repo, 'issues'), { ...f }), 'issue opened');
}
/** Change an existing issue (title, body, labels, assignees, open or closed). */
export async function updateIssue(api: WriteApi, repo: string, number: number, f: IssueFields): Promise<ToolOut> {
  return made(await post(api, repoPath(repo, 'issues', number), { ...f }, 'PATCH'), 'issue changed');
}
/** Comment on an issue or a pull request. */
export async function commentOn(api: WriteApi, repo: string, number: number, body: string): Promise<ToolOut> {
  return made(await post(api, repoPath(repo, 'issues', number, 'comments'), { body }), 'comment added');
}
/** Open a pull request from a branch that is already pushed. */
export async function createPullRequest(api: WriteApi, repo: string, f: { title: string; head: string; base: string; body?: string; draft?: boolean }): Promise<ToolOut> {
  return made(await post(api, repoPath(repo, 'pulls'), f), 'pull request opened');
}
/** Review a pull request: approve, ask for changes, or comment. */
export async function submitReview(api: WriteApi, repo: string, number: number, f: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string }): Promise<ToolOut> {
  return made(await post(api, repoPath(repo, 'pulls', number, 'reviews'), f), 'review submitted');
}
/**
 * The "Legion (write)" client, for the owner's own buttons (the CI panel loads this module and calls `rerunFailed(runId, repo)` and
 * `cancel(runId, repo)` with no client). Not signed in: `not-connected`, nothing sent.
 */
const writeClient = (): WriteApi => {
  const c = getGitHubClient('write');
  if (!c) throw new GhError('not-connected');
  return c;
};

/** Re-run only the failed jobs of a workflow run. */
export async function rerunFailed(runId: number, repo: string, api: WriteApi = writeClient()): Promise<ToolOut> {
  return made(await post(api, repoPath(repo, 'actions', 'runs', runId, 'rerun-failed-jobs'), undefined), 're-run of the failed jobs requested');
}
/** Cancel a running workflow. */
export async function cancel(runId: number, repo: string, api: WriteApi = writeClient()): Promise<ToolOut> {
  return made(await post(api, repoPath(repo, 'actions', 'runs', runId, 'cancel'), undefined), 'cancel requested');
}
