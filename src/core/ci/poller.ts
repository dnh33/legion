/**
 * The CI cache and its rate-budgeted poller. One shared cache for every window; changes go out as one SSE event (`ci.updated`).
 *
 * Budget rules (claude/plan-ci-panel.md):
 * - Nobody watching (no heartbeat for CI_WATCH_TTL_MS): no request at all.
 * - Connected: 10 s while a run is in progress, 60 s idle, `If-None-Match` on every list call (a 304 is free for a signed-in caller).
 * - Anonymous (60 per hour): no idle polling. Refresh on open, focus and the Refresh button; while a run is in progress and the panel is
 *   open, one poll per ANON_POLL_MS. A 304 still costs one anonymous request, so no ETag is sent. A rolling cap (ANON_HOURLY_CAP) is kept
 *   below the limit on purpose, and polling stops when `rate.remaining` falls under RESERVE.
 * - A rate-limit error pauses everything until its `resetAt`.
 * No network and no child process lives here: all requests go through the GitHubPort.
 */
import type { CiCounts, CiJob, CiJobsView, CiLogView, CiProblem, CiRun, CiRunsView, CiStateView, CiUpdateSummary } from '../../shared/ci.js';
import { CI_WATCH_TTL_MS } from '../../shared/ci.js';
import type { Connection, GitHubPort } from './port.js';
import { asGhError } from './port.js';
import { countsFor, isRunning, parseJobs, parseRuns, prepareLog, summarizeRun } from './parse.js';
import type { RepoRef } from './repo.js';
import { repoKey, validRepoString } from './repo.js';

export const DEFAULT_BRANCH = 'main';
export const TICK_MS = 5_000;
export const CONNECTED_ACTIVE_MS = 10_000;
export const CONNECTED_IDLE_MS = 60_000;
/** Anonymous poll spacing while a run is in progress and the panel is open (the plan's floor is 60 s; slower keeps one hour under 60 requests). */
export const ANON_POLL_MS = 75_000;
export const ANON_HOURLY_CAP = 50;
/** Never spend the last requests of a window. */
export const RESERVE = 10;
/** Backstop for a connected account (5,000 an hour): polling at 10 s with two lists is about 720, so this is never reached in normal use. */
export const CONNECTED_HOURLY_CAP = 1500;
/** A repo switch the project filter causes is ignored for this long after the last one; the owner's own PUT /api/ci/repo is not. */
export const SWITCH_DEBOUNCE_MS = 10_000;
/** A manual refresh closer than this to the last fetch is served from the cache. */
export const DEBOUNCE_MS = 5_000;
const HOUR_MS = 3_600_000;
const CONN_TTL_MS = 30_000;
const LIST_SIZE = 30;
const ANON_LIST_SIZE = 50;

export type RefreshReason = 'auto' | 'open' | 'focus' | 'manual' | 'write';

export interface ResolvedRepo { repo: RepoRef | null; branch: string | null; source: 'remote' | 'manual' | null }

export interface PollerOptions {
  /** The client, or a getter that is asked on every use (the connectors client may appear after boot). */
  github: GitHubPort | undefined | (() => GitHubPort | undefined);
  resolveRepo(projectId?: string): ResolvedRepo;
  emit(s: CiUpdateSummary): void;
  now?: () => number;
  /** Starts the tick; returns the cancel function. Tests pass a no-op and call `tick()` themselves. */
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (m: string) => void;
}

interface Watch { mode: 'panel' | 'chip'; projectId?: string; at: number }

const defaultSchedule = (fn: () => void, ms: number): (() => void) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); };

export class CiPoller {
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private watchState: Watch | null = null;
  private stopTimer: (() => void) | null = null;
  private conn: Connection | null = null;
  private connAt = 0;
  private key = '';
  private lists = new Map<string, CiRun[]>();
  private etags = new Map<string, string>();
  private jobsCache = new Map<number, { at: number; jobs: CiJob[] }>();
  private fetched = false;
  private lastFetchAt = 0;
  private reqLog: number[] = [];
  private pausedUntil = 0;
  private problem: CiProblem | null = null;
  private updatedAt: string | null = null;
  private fingerprint = '';
  private rev = 0;
  private inflight: Promise<void> | null = null;
  private lastResolved: ResolvedRepo = { repo: null, branch: null, source: null };

  private get gh(): GitHubPort | undefined { const g = this.o.github; return typeof g === 'function' ? g() : g; }
  private lastSwitchAt = -Infinity;
  private allowSwitch = false;
  private pauseKind: 'rate-limited' | 'budget' = 'budget';

  constructor(private readonly o: PollerOptions) {
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? defaultSchedule;
  }

  /* ---------- watching ---------- */
  isWatching(): boolean { return !!this.watchState && this.now() - this.watchState.at < CI_WATCH_TTL_MS; }
  watchMode(): 'panel' | 'chip' | null { return this.isWatching() ? this.watchState!.mode : null; }

  /** The UI's heartbeat. The first one after nobody was watching also loads once. */
  heartbeat(mode: 'panel' | 'chip', projectId?: string): void {
    const was = this.isWatching();
    this.watchState = { mode, ...(projectId ? { projectId } : {}), at: this.now() };
    if (!this.stopTimer) this.stopTimer = this.schedule(() => { void this.tick(); }, TICK_MS);
    if (!was) void this.refresh('open');
  }

  dispose(): void { this.stopTimer?.(); this.stopTimer = null; }

  /* ---------- what is known ---------- */
  private repoNow(): ResolvedRepo {
    const r = this.o.resolveRepo(this.watchState?.projectId);
    const k = r.repo ? repoKey(r.repo) : '';
    if (k !== this.key) {
      // The project filter and the heartbeat share one slot: windows that disagree would flip the repo and refetch every time. A switch within
      // SWITCH_DEBOUNCE_MS of the last one is ignored; the first resolution and the owner's explicit repo are always taken.
      const now = this.now();
      if (this.key !== '' && !this.allowSwitch && now - this.lastSwitchAt < SWITCH_DEBOUNCE_MS) return this.lastResolved;
      this.allowSwitch = false;
      this.lastSwitchAt = now;
      // Only the per-repo caches go. A rate-limit pause and the fetch debounce belong to the account and stay.
      this.key = k; this.lists.clear(); this.etags.clear(); this.jobsCache.clear(); this.fetched = false; this.problem = null; this.updatedAt = null; this.fingerprint = '';
    }
    this.lastResolved = r;
    return r;
  }

  private allRuns(): CiRun[] {
    const byId = new Map<number, CiRun>();
    for (const list of this.lists.values()) for (const r of list) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  }
  private relevant(runs: CiRun[], branch: string | null): CiRun[] {
    return branch === null ? runs : runs.filter((r) => r.branch === branch || r.branch === DEFAULT_BRANCH);
  }
  private anyRunning(): boolean { return this.relevant(this.allRuns(), this.lastResolved.branch).some((r) => isRunning(r.status)); }

  private async connection(force = false): Promise<Connection | null> {
    const gh = this.gh;
    if (!gh) return null;
    if (!force && this.conn && this.now() - this.connAt < CONN_TTL_MS) return this.conn;
    try { this.conn = await gh.connection(); this.connAt = this.now(); } catch { /* keep the old one */ }
    return this.conn;
  }

  private remaining(c: Connection): number {
    // a window that has reset has its full budget again
    return Date.parse(c.rate.resetAt) <= this.now() ? c.rate.limit : c.rate.remaining;
  }
  private usedInHour(): number {
    const cut = this.now() - HOUR_MS;
    this.reqLog = this.reqLog.filter((t) => t > cut);
    return this.reqLog.length;
  }
  private spent(): void { this.reqLog.push(this.now()); }

  /** Why a request may not go out now (null: it may). `kind` of CiProblem is what the panel shows. */
  private blocked(c: Connection): CiProblem | null {
    const now = this.now();
    if (this.pausedUntil > now) return { kind: this.pauseKind, resetAt: new Date(this.pausedUntil).toISOString() };
    if (this.remaining(c) < RESERVE) return { kind: 'budget', resetAt: c.rate.resetAt };
    if (c.auth !== 'anonymous' && this.usedInHour() >= CONNECTED_HOURLY_CAP) return { kind: 'budget', resetAt: new Date((this.reqLog[0] ?? now) + HOUR_MS).toISOString() };
    if (c.auth === 'anonymous' && this.usedInHour() >= ANON_HOURLY_CAP) return { kind: 'budget', resetAt: new Date((this.reqLog[0] ?? now) + HOUR_MS).toISOString() };
    return null;
  }

  /* ---------- the poll ---------- */
  /** One timer step: decides whether a request is due and makes it. Safe to call as often as you like. */
  async tick(): Promise<'idle' | 'skipped' | 'fetched'> {
    if (!this.isWatching()) { this.stopTimer?.(); this.stopTimer = null; return 'idle'; }
    const c = await this.connection();
    if (!c) return 'idle';
    this.repoNow();
    const since = this.now() - this.lastFetchAt;
    let due: boolean;
    if (c.auth === 'anonymous') due = this.watchState!.mode === 'panel' && this.anyRunning() && since >= ANON_POLL_MS;
    else due = since >= (this.anyRunning() ? CONNECTED_ACTIVE_MS : CONNECTED_IDLE_MS);
    if (!due) return 'skipped';
    await this.refresh('auto');
    return 'fetched';
  }

  refresh(reason: RefreshReason): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.doRefresh(reason).finally(() => { this.inflight = null; });
    this.inflight = p;
    return p;
  }

  private paths(c: Connection, r: ResolvedRepo): string[] {
    const base = `/repos/${r.repo!.owner}/${r.repo!.name}/actions/runs`;
    if (c.auth === 'anonymous' || r.branch === null) return [`${base}?per_page=${c.auth === 'anonymous' ? ANON_LIST_SIZE : LIST_SIZE}`];
    const one = (b: string): string => `${base}?branch=${encodeURIComponent(b)}&per_page=${LIST_SIZE}`;
    return r.branch === DEFAULT_BRANCH ? [one(DEFAULT_BRANCH)] : [one(r.branch), one(DEFAULT_BRANCH)];
  }

  private async doRefresh(reason: RefreshReason): Promise<void> {
    const gh = this.gh;
    if (!gh) return;
    const c = await this.connection(reason !== 'auto');
    if (!c) return;
    const r = this.repoNow();
    if (!r.repo) { this.publish(); return; }
    if (reason !== 'auto' && reason !== 'write' && this.now() - this.lastFetchAt < DEBOUNCE_MS) return;
    const block = this.blocked(c);
    if (block) { this.problem = block; this.publish(); return; }
    this.lastFetchAt = this.now();
    let problem: CiProblem | null = null;
    for (const path of this.paths(c, r)) {
      const again = this.blocked(c);
      if (again) { problem = again; break; }
      try {
        const etag = c.auth !== 'anonymous' ? this.etags.get(path) : undefined;
        const resp = await gh.request(path, etag ? { headers: { 'If-None-Match': etag } } : {});
        this.spent();
        this.conn = { ...c, rate: resp.rate }; c.rate = resp.rate;
        if (resp.notModified) continue;
        this.lists.set(path, parseRuns(resp.json));
        if (resp.etag) this.etags.set(path, resp.etag);
      } catch (e) {
        this.spent();
        const err = asGhError(e);
        problem = err.kind === 'rate-limited' ? { kind: 'rate-limited', resetAt: err.resetAt }
          : err.kind === 'forbidden' ? { kind: 'forbidden' }
          : err.kind === 'network' || err.kind === 'logs-unavailable' ? { kind: 'network' }
          : { kind: err.kind };
        if (problem.kind === 'rate-limited') { this.pausedUntil = Math.max(this.pausedUntil, Date.parse(problem.resetAt ?? '') || this.now() + 60_000); this.pauseKind = 'rate-limited'; }
        break;
      }
    }
    if (!problem) { this.fetched = true; this.updatedAt = new Date(this.now()).toISOString(); }
    this.problem = problem;
    this.publish();
  }

  /** Emits `ci.updated` only when something the UI shows changed. A 304 or an identical answer emits nothing. */
  private publish(): void {
    const runs = this.allRuns();
    const fp = JSON.stringify([this.key, runs, this.problem, this.conn?.auth, this.conn?.login, this.canWrite(), this.gh ? 1 : 0]);
    if (fp === this.fingerprint) return;
    this.fingerprint = fp;
    this.rev++;
    this.o.emit(this.summary(runs));
  }

  private canWrite(): 'yes' | 'no' | 'unknown' { const g = this.gh; return g ? g.can('actions', 'write') : 'no'; }

  private summary(runs = this.allRuns()): CiUpdateSummary {
    const r = this.lastResolved;
    const rel = this.relevant(runs, r.branch);
    return {
      repo: r.repo ? repoKey(r.repo) : null, branch: r.branch, counts: countsFor(runs, r.branch), running: rel.some((x) => isRunning(x.status)),
      problem: this.problem, rev: this.rev,
    };
  }

  /* ---------- views ---------- */
  async stateView(): Promise<CiStateView> {
    const gh = this.gh;
    const r = this.repoNow();
    const defaults = { defaultBranch: DEFAULT_BRANCH, updatedAt: this.updatedAt };
    if (!gh) return { available: false, repo: null, branch: null, connection: null, canWrite: 'no', live: 'slow', problem: null, ...defaults };
    const c = await this.connection();
    return {
      available: true,
      repo: r.repo && r.source ? { owner: r.repo.owner, name: r.repo.name, source: r.source } : null,
      branch: r.branch,
      connection: c ? { auth: c.auth, ...(c.login ? { login: c.login } : {}), rate: { ...c.rate } } : null,
      canWrite: this.canWrite(),
      live: c && c.auth !== 'anonymous' ? 'live' : 'slow',
      problem: this.problem, ...defaults,
    };
  }

  /** `branch` set: only that branch. Unset: the current branch and main. Loads once when nothing was fetched yet. */
  async runsView(branch?: string): Promise<CiRunsView> {
    this.repoNow();
    if (this.gh && !this.fetched && !this.problem) { await this.connection(); await this.refresh('open'); }
    const r = this.lastResolved;
    const all = this.allRuns();
    const runs = (branch ? all.filter((x) => x.branch === branch) : this.relevant(all, r.branch)).slice(0, 40);
    return { runs, counts: countsFor(all, branch ?? r.branch), stale: !!this.problem && this.fetched, problem: this.problem, updatedAt: this.updatedAt };
  }

  private cachedRun(runId: number): CiRun | undefined { return this.allRuns().find((x) => x.id === runId); }

  async jobsView(runId: number): Promise<CiJobsView> {
    const gh = this.gh;
    const r = this.repoNow();
    if (!gh || !r.repo) return { jobs: [], summary: null, problem: null };
    const run = this.cachedRun(runId);
    const c = await this.connection();
    const cached = this.jobsCache.get(runId);
    const done = run ? !isRunning(run.status) : false;
    const minAge = c?.auth === 'anonymous' ? ANON_POLL_MS : CONNECTED_ACTIVE_MS;
    const fresh = !!cached && (done || this.now() - cached.at < minAge);
    if (fresh) return { jobs: cached!.jobs, summary: run ? summarizeRun(run, cached!.jobs) : null, problem: null };
    if (!c) return { jobs: cached?.jobs ?? [], summary: null, problem: { kind: 'network' } };
    const block = this.blocked(c);
    if (block) return { jobs: cached?.jobs ?? [], summary: run && cached ? summarizeRun(run, cached.jobs) : null, problem: block };
    try {
      const resp = await gh.request(`/repos/${r.repo.owner}/${r.repo.name}/actions/runs/${runId}/jobs?per_page=100`);
      this.spent(); this.conn = { ...c, rate: resp.rate };
      const jobs = parseJobs(resp.json);
      this.jobsCache.set(runId, { at: this.now(), jobs });
      return { jobs, summary: run ? summarizeRun(run, jobs) : null, problem: null };
    } catch (e) {
      this.spent();
      const err = asGhError(e);
      if (err.kind === 'rate-limited') { this.pausedUntil = Math.max(this.pausedUntil, Date.parse(err.resetAt) || this.now() + 60_000); this.pauseKind = 'rate-limited'; }
      const problem: CiProblem = err.kind === 'rate-limited' ? { kind: 'rate-limited', resetAt: err.resetAt } : err.kind === 'logs-unavailable' || err.kind === 'network' ? { kind: 'network' } : err.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: err.kind };
      return { jobs: cached?.jobs ?? [], summary: null, problem };
    }
  }

  async logView(jobId: number): Promise<CiLogView> {
    const gh = this.gh;
    const r = this.repoNow();
    if (!gh || !r.repo || !validRepoString(repoKey(r.repo))) return { available: false, reason: 'logs-unavailable' };
    const c = await this.connection();
    if (c) {
      const block = this.blocked(c);
      if (block) return { available: false, reason: 'problem', problem: block };
    }
    try {
      const out = await gh.logs(jobId, repoKey(r.repo));
      this.spent();
      const p = prepareLog(typeof out.text === 'string' ? out.text : '', !!out.truncated);
      return { available: true, text: p.text, truncated: p.truncated, masked: p.masked };
    } catch (e) {
      const err = asGhError(e);
      if (err.kind === 'logs-unavailable') return { available: false, reason: 'logs-unavailable' };
      this.spent();
      if (err.kind === 'not-found') return { available: false, reason: 'expired' };
      if (err.kind === 'rate-limited') { this.pausedUntil = Math.max(this.pausedUntil, Date.parse(err.resetAt) || this.now() + 60_000); this.pauseKind = 'rate-limited'; return { available: false, reason: 'problem', problem: { kind: 'rate-limited', resetAt: err.resetAt } }; }
      return { available: false, reason: 'problem', problem: { kind: err.kind } };
    }
  }

  /** The owner typed a repo: take the next resolution at once, even inside the switch debounce. */
  switchNow(): void { this.allowSwitch = true; }

  /** What the write routes need: the repo to act on, or null. */
  repoText(): string | null { const r = this.repoNow(); return r.repo && validRepoString(repoKey(r.repo)) ? repoKey(r.repo) : null; }
  counts(): CiCounts { return countsFor(this.allRuns(), this.lastResolved.branch); }
  requestsInHour(): number { return this.usedInHour(); }
}
