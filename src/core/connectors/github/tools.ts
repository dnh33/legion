/**
 * GitHub read tools (design 4.1 and 4.3). Each one takes the client and already-parsed arguments, calls `client.request()` (the only way to
 * GitHub), and returns plain data. The gateway (../gateway.ts) wraps the result as outside text, scrubs it, taints the run and registers
 * the tool under its literal name. Nothing here writes; the write tools are slice 2.
 *
 * Every text field that came from GitHub (titles, bodies, comments, file contents, branch names) is outside content: it is returned
 * as data and wrapped by the gateway. This file never builds a path from a model-chosen value without checking it first (`repoPath`).
 */
import { GhError, validRepo } from './client.js';
import type { Connection, GhResponse } from './client.js';
import { isRunning, parseJobs, parseRun, parseRuns, summarizeRun } from '../../ci/parse.js';
import type { RunSummary } from '../../../shared/ci.js';

/** What the tools use of the client (so tests can pass a small fake). */
export interface GhApi {
  request(path: string, init?: { method?: string; ifNoneMatch?: string; raw?: boolean }): Promise<GhResponse>;
  connection(): Promise<Connection>;
}

export interface ToolCtx {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** True once the run that called the tool is over or cancelled (github_ci_wait stops waiting). */
  stopped: () => boolean;
}
/** What a tool returns: the data, and an optional plain note shown next to it (outside the data, e.g. "timed out"). */
export interface ToolOut { data: unknown; note?: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clip = (v: unknown, max: number): string => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) + '…' : v) : '');
const login = (v: unknown): string => clip(isObj(v) ? v.login : '', 60);
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new GhError('not-found');
  return v;
};
const page = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 50 ? v : 1);
const STATES = new Set(['open', 'closed', 'all']);
const stateOf = (v: unknown): string => (typeof v === 'string' && STATES.has(v) ? v : 'open');
const NO_CTRL = /[\u0000-\u001f\u007f\\]/;

/** `/repos/<owner>/<name>/<rest...>`, every rest segment percent-encoded; "." and ".." segments are refused. */
export function repoPath(repo: unknown, ...rest: Array<string | number>): string {
  if (!validRepo(repo)) throw new GhError('not-found');
  const segs: string[] = [];
  for (const r of rest) {
    for (const part of String(r).split('/')) {
      if (part === '') continue;
      if (part === '.' || part === '..') throw new GhError('not-found');
      segs.push(encodeURIComponent(part));
    }
  }
  const [owner, name] = repo.split('/') as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${segs.length ? '/' + segs.join('/') : ''}`;
}
const q = (params: Record<string, string | number | undefined>): string => {
  const e = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return e.length ? '?' + e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
};

const repoRow = (r: unknown) => {
  const o = isObj(r) ? r : {};
  return {
    full_name: clip(o.full_name, 140), description: clip(o.description, 300), private: o.private === true, fork: o.fork === true, archived: o.archived === true,
    default_branch: clip(o.default_branch, 100), language: clip(o.language, 40), stars: typeof o.stargazers_count === 'number' ? o.stargazers_count : 0,
    open_issues: typeof o.open_issues_count === 'number' ? o.open_issues_count : 0, pushed_at: clip(o.pushed_at, 40), url: clip(o.html_url, 200),
  };
};
const issueRow = (i: unknown, body: boolean) => {
  const o = isObj(i) ? i : {};
  return {
    number: typeof o.number === 'number' ? o.number : 0, title: clip(o.title, 300), state: clip(o.state, 20), author: login(o.user),
    labels: arr(o.labels).map((l) => clip(isObj(l) ? l.name : l, 60)).slice(0, 20), comments: typeof o.comments === 'number' ? o.comments : 0,
    created_at: clip(o.created_at, 40), updated_at: clip(o.updated_at, 40), url: clip(o.html_url, 200), ...(body ? { body: clip(o.body, 6000) } : {}),
  };
};
const prRow = (p: unknown, body: boolean) => {
  const o = isObj(p) ? p : {};
  const head = isObj(o.head) ? o.head : {};
  const base = isObj(o.base) ? o.base : {};
  return {
    ...issueRow(p, body), draft: o.draft === true, merged: o.merged === true || (typeof o.merged_at === 'string' && o.merged_at !== ''),
    head: clip(head.ref, 200), base: clip(base.ref, 200), head_sha: clip(head.sha, 40),
    ...(typeof o.additions === 'number' ? { additions: o.additions, deletions: Number(o.deletions ?? 0), changed_files: Number(o.changed_files ?? 0) } : {}),
  };
};

type Run = (c: GhApi, a: Record<string, unknown>, x: ToolCtx) => Promise<ToolOut>;
const ok = (data: unknown, note?: string): ToolOut => ({ data, ...(note ? { note } : {}) });
const refOf = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);

export const GITHUB_READ_TOOLS: Record<string, Run> = {
  async github_status(c) {
    const k = await c.connection();
    return ok({ auth: k.auth, login: k.login ?? null, needsSignIn: k.needsSignIn === true, permissions: k.permissions ?? null, rate: k.rate });
  },
  async github_repo_list(c, a) {
    const owner = typeof a.owner === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(a.owner) && a.owner !== '.' && a.owner !== '..' ? a.owner : undefined;
    const path = owner ? `/users/${encodeURIComponent(owner)}/repos` : '/user/repos';
    const r = await c.request(path + q({ per_page: 30, page: page(a.page), sort: 'updated' }));
    return ok(arr(r.json).map(repoRow));
  },
  async github_repo_get(c, a) { return ok(repoRow((await c.request(repoPath(a.repo))).json)); },
  async github_issue_list(c, a) {
    const r = await c.request(repoPath(a.repo, 'issues') + q({ state: stateOf(a.state), per_page: 30, page: page(a.page) }));
    // the issues endpoint also lists pull requests; they have their own tools
    return ok(arr(r.json).filter((i) => isObj(i) && !('pull_request' in i)).map((i) => issueRow(i, false)));
  },
  async github_issue_get(c, a) { return ok(issueRow((await c.request(repoPath(a.repo, 'issues', int(a.number)))).json, true)); },
  async github_issue_comments(c, a) {
    const r = await c.request(repoPath(a.repo, 'issues', int(a.number), 'comments') + q({ per_page: 30, page: page(a.page) }));
    return ok(arr(r.json).map((m) => { const o = isObj(m) ? m : {}; return { id: typeof o.id === 'number' ? o.id : 0, author: login(o.user), created_at: clip(o.created_at, 40), body: clip(o.body, 4000) }; }));
  },
  async github_pr_list(c, a) {
    const r = await c.request(repoPath(a.repo, 'pulls') + q({ state: stateOf(a.state), per_page: 30, page: page(a.page) }));
    return ok(arr(r.json).map((p) => prRow(p, false)));
  },
  async github_pr_get(c, a) { return ok(prRow((await c.request(repoPath(a.repo, 'pulls', int(a.number)))).json, true)); },
  async github_pr_files(c, a) {
    const r = await c.request(repoPath(a.repo, 'pulls', int(a.number), 'files') + q({ per_page: 50, page: page(a.page) }));
    return ok(arr(r.json).map((f) => { const o = isObj(f) ? f : {}; return { filename: clip(o.filename, 300), status: clip(o.status, 20), additions: Number(o.additions ?? 0), deletions: Number(o.deletions ?? 0), patch: clip(o.patch, 3000) }; }));
  },
  async github_file_get(c, a) {
    const ref = refOf(a.ref);
    const path = typeof a.path === 'string' ? a.path : '';
    if (!path || path.length > 500 || NO_CTRL.test(path)) throw new GhError('not-found');
    const r = await c.request(repoPath(a.repo, 'contents', path) + q({ ref }), { raw: true });
    const text = r.text ?? '';
    const cap = 60_000;
    return ok({ path, ref: ref ?? null, size: text.length, truncated: text.length > cap, text: text.slice(0, cap) });
  },
  async github_dir_list(c, a) {
    const ref = refOf(a.ref);
    const path = typeof a.path === 'string' ? a.path : '';
    if (path.length > 500 || NO_CTRL.test(path)) throw new GhError('not-found');
    const r = await c.request(repoPath(a.repo, 'contents', path) + q({ ref }));
    return ok(arr(r.json).slice(0, 200).map((e) => { const o = isObj(e) ? e : {}; return { name: clip(o.name, 200), path: clip(o.path, 400), type: clip(o.type, 20), size: typeof o.size === 'number' ? o.size : 0 }; }));
  },
  async github_ci_runs(c, a) {
    const r = await c.request(repoPath(a.repo, 'actions', 'runs') + q({ per_page: 20, page: page(a.page), branch: refOf(a.branch) }));
    return ok(parseRuns(r.json));
  },
  async github_ci_run(c, a) {
    const id = int(a.runId);
    const run = parseRun((await c.request(repoPath(a.repo, 'actions', 'runs', id))).json);
    if (!run) throw new GhError('not-found');
    const jobs = parseJobs((await c.request(repoPath(a.repo, 'actions', 'runs', id, 'jobs') + q({ per_page: 100 }))).json);
    return ok({ run, jobs, summary: summarizeRun(run, jobs) });
  },
  async github_ci_wait(c, a, x) { return ciWait(c, a, x); },
};

// ------------------------------------------------------------------------------------------------ github_ci_wait

export const CI_WAIT_DEFAULT_SEC = 600;
export const CI_WAIT_CAP_SEC = 900;
/** Never poll faster than this (design 4.3, pinned 2026-10-07). */
export const CI_WAIT_MIN_INTERVAL_MS = 10_000;

/**
 * Waits for a workflow run to finish and returns `{status, conclusion, url, failedJobs:[{id,name,conclusion}]}` (the RunSummary shape the CI
 * panel shares). Polls through `client.request()` no faster than every 10 s, sends the ETag so an unchanged answer costs no rate limit,
 * backs off on a rate limit, never reads logs, and ends when the run is completed (a cancelled run is completed too), when the caller's
 * own run is over, or when the time is up (then the last status is returned with a note).
 */
async function ciWait(c: GhApi, a: Record<string, unknown>, x: ToolCtx): Promise<ToolOut> {
  const wanted = typeof a.timeoutSec === 'number' && Number.isFinite(a.timeoutSec) ? a.timeoutSec : CI_WAIT_DEFAULT_SEC;
  const timeoutMs = Math.min(CI_WAIT_CAP_SEC, Math.max(1, Math.floor(wanted))) * 1000;
  const deadline = x.now() + timeoutMs;
  let id: number;
  if (a.runId !== undefined) id = int(a.runId);
  else {
    const branch = refOf(a.branch);
    if (!branch) throw new GhError('not-found');
    const latest = parseRuns((await c.request(repoPath(a.repo, 'actions', 'runs') + q({ per_page: 1, branch }))).json)[0];
    if (!latest) throw new GhError('not-found');
    id = latest.id;
  }
  const path = repoPath(a.repo, 'actions', 'runs', id);
  let etag: string | undefined;
  let last: ReturnType<typeof parseRun> = null;
  const partial = (): RunSummary => (last ? summarizeRun(last, []) : { status: 'unknown', conclusion: null, url: '', failedJobs: [] });
  for (;;) {
    let wait = CI_WAIT_MIN_INTERVAL_MS;
    try {
      const r = await c.request(path, etag ? { ifNoneMatch: etag } : {});
      if (r.etag) etag = r.etag;
      if (!r.notModified) last = parseRun(r.json);
      if (!last) throw new GhError('not-found');
      if (last.status === 'completed' || !isRunning(last.status)) {
        const jobs = parseJobs((await c.request(repoPath(a.repo, 'actions', 'runs', id, 'jobs') + q({ per_page: 100 }))).json);
        return ok(summarizeRun(last, jobs));
      }
      // close to the primary limit: wait for the window to reset instead of spending the last requests
      if (r.rate.limit > 0 && r.rate.remaining <= 2) wait = Math.max(wait, Date.parse(r.rate.resetAt) - x.now());
    } catch (e) {
      if (!(e instanceof GhError) || (e.kind !== 'rate-limited' && !(e.kind === 'network' && e.retryable))) throw e;
      wait = e.kind === 'rate-limited' && e.resetAt ? Math.max(wait, Date.parse(e.resetAt) - x.now()) : wait * 2;
    }
    if (!Number.isFinite(wait) || wait < CI_WAIT_MIN_INTERVAL_MS) wait = CI_WAIT_MIN_INTERVAL_MS;
    if (x.stopped()) return ok(partial(), 'Stopped: the run that was waiting is over.');
    if (x.now() + wait >= deadline) {
      const s = partial();
      return ok(s, `Timed out after ${Math.round(timeoutMs / 1000)} s; the run was still ${s.status}. Call github_ci_wait again to keep waiting.`);
    }
    await x.sleep(wait);
    if (x.stopped()) return ok(partial(), 'Stopped: the run that was waiting is over.');
  }
}
