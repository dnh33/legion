/**
 * A scriptable stand-in for the GitHub client, for tests and the harness only (never wired in production). It has the shapes of the real
 * client (src/core/connectors/github/client.ts): `GhInit.ifNoneMatch`, the request path refusals, thrown `GhError` instances, `can()` that
 * answers 'unknown' without a permission map, and NO write members: writes are a separate `FakeWrites` a scenario enables. It answers the two list calls the
 * CI module makes (`/repos/{o}/{r}/actions/runs`, `/repos/{o}/{r}/actions/runs/{id}/jobs`) with JSON in GitHub's documented shape, speaks ETag and
 * 304, counts a rate budget, and can refuse logs, answer 403/404 or run out of rate. Every call is recorded in `calls` / `writes`.
 * Nothing here opens a socket.
 */
import { GhError as GhClientError } from '../connectors/github/client.js';
import type { Connection, GhArea, GhInit, GhResponse, GitHubPort, GitHubWrites } from './port.js';
import { asGhError } from './port.js';
import type { GhError } from './port.js';

type Raw = Record<string, unknown>;
export interface FakeCall { method: string; path: string; ifNoneMatch?: string }

const ISO = (ms: number): string => new Date(ms).toISOString();

/** Throws like the real client: a GhError instance with the same fields. */
const thrown = (e: GhError): GhClientError => new GhClientError(e.kind, { ...('needs' in e && e.needs ? { needs: e.needs } : {}), ...('resetAt' in e ? { resetAt: e.resetAt } : {}), ...('retryable' in e ? { retryable: e.retryable } : {}) });

export class FakeGitHub implements GitHubPort {
  conn: Connection;
  runs: Raw[] = [];
  jobs = new Map<number, Raw[]>();
  logText = new Map<number, string>();
  /** 'ok' serves logs; 'refused' throws logs-unavailable (the real client does until the storage host list is filled). */
  logsMode: 'ok' | 'refused' | 'expired' = 'refused';
  calls: FakeCall[] = [];
  writes: Array<{ op: 'rerun' | 'cancel'; runId: number; repo: string }> = [];
  /** Whether the write members exist (a scenario enables them; the real writes module may not exist yet). */
  writesOn = false;
  connectionCalls = 0;
  /** Repos only a signed-in caller can see: anonymous gets not-connected. */
  privateRepos = new Set<string>();
  missingRepos = new Set<string>();
  /** Thrown by the next `failNext.count` request(s), or by every request when `count` is Infinity. */
  failNext: { error: GhError; count: number } | null = null;
  private rev = 1;
  constructor(public now: () => number = () => Date.now(), conn?: Partial<Connection>) {
    this.conn = { auth: 'anonymous', rate: { limit: 60, remaining: 60, resetAt: ISO(this.now() + 3_600_000) }, ...conn };
  }

  /* ---------- scripting ---------- */
  touch(): void { this.rev++; }
  setConnection(c: Partial<Connection>): void { this.conn = { ...this.conn, ...c }; this.touch(); }
  setRate(r: Partial<Connection['rate']>): void { this.conn.rate = { ...this.conn.rate, ...r }; }
  addRun(r: { id: number; name?: string; branch?: string; status?: string; conclusion?: string | null; title?: string; ageMin?: number; durationSec?: number; jobs?: Array<Partial<{ id: number; name: string; conclusion: string | null; status: string; durSec: number }>> }): void {
    const created = this.now() - (r.ageMin ?? 5) * 60_000;
    const status = r.status ?? 'completed';
    this.runs.push({
      id: r.id, name: r.name ?? 'CI', head_branch: r.branch ?? 'main', head_sha: (`${r.id}`.padStart(8, '0') + 'abcdef0123456789abcdef0123456789').slice(0, 40),
      display_title: r.title ?? `Commit ${r.id}`, event: 'push', status, conclusion: status === 'completed' ? (r.conclusion ?? 'success') : null,
      html_url: `https://github.com/dnh33/legion/actions/runs/${r.id}`, created_at: ISO(created), run_started_at: ISO(created),
      updated_at: ISO(created + (r.durationSec ?? 120) * 1000), run_attempt: 1, head_commit: { message: r.title ?? `Commit ${r.id}` },
    });
    if (r.jobs) this.jobs.set(r.id, r.jobs.map((j, i) => ({
      id: j.id ?? r.id * 100 + i, run_id: r.id, name: j.name ?? `job ${i + 1}`, status: j.status ?? 'completed', conclusion: j.status && j.status !== 'completed' ? null : (j.conclusion ?? 'success'),
      html_url: `https://github.com/dnh33/legion/actions/runs/${r.id}/job/${j.id ?? r.id * 100 + i}`, started_at: ISO(created + 5000), completed_at: j.status && j.status !== 'completed' ? null : ISO(created + 5000 + (j.durSec ?? 60) * 1000), labels: [],
    })));
    this.touch();
  }
  /** Moves a run to its next state (in progress -> completed) so a poll sees a change. */
  finishRun(id: number, conclusion = 'success'): void {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    r.status = 'completed'; r.conclusion = conclusion; r.updated_at = ISO(this.now());
    for (const j of this.jobs.get(id) ?? []) if (j.status !== 'completed') { j.status = 'completed'; j.conclusion = conclusion; j.completed_at = ISO(this.now()); }
    this.touch();
  }
  clear(): void { this.runs = []; this.jobs.clear(); this.logText.clear(); this.touch(); }

  /* ---------- GitHubPort ---------- */
  /** Makes connection() throw (the real one reads /user and can be refused like any request). */
  connectionFail: GhError | null = null;
  async connection(): Promise<Connection> { this.connectionCalls++; if (this.connectionFail) throw thrown(this.connectionFail); return JSON.parse(JSON.stringify(this.conn)) as Connection; }

  can(area: GhArea, level: 'read' | 'write'): 'yes' | 'no' | 'unknown' {
    const p = this.conn.permissions;
    if (!p) return 'unknown';
    const have = p[area];
    if (!have) return 'no';
    return level === 'read' || have === 'write' ? 'yes' : 'no';
  }

  private spend(notModified: boolean): void {
    if (this.conn.rate.remaining <= 0) throw thrown({ kind: 'rate-limited', resetAt: this.conn.rate.resetAt });
    // a 304 is free for a signed-in caller; an anonymous one still pays (GitHub REST best practices)
    if (!notModified || this.conn.auth === 'anonymous') this.conn.rate.remaining--;
  }
  private maybeFail(): void {
    const f = this.failNext;
    if (!f) return;
    if (f.count !== Infinity && --f.count <= 0) this.failNext = null;
    throw thrown(f.error);
  }

  async request(path: string, init: GhInit = {}): Promise<GhResponse> {
    const ifNoneMatch = init.ifNoneMatch;
    this.calls.push({ method: init.method ?? 'GET', path, ...(ifNoneMatch ? { ifNoneMatch } : {}) });
    this.maybeFail();
    // the same refusals as the real client
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path)) throw thrown({ kind: 'network', retryable: false });
    const url = new URL(path, 'https://api.github.com');
    const m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs(?:\/(\d+)\/jobs)?$/.exec(url.pathname);
    if (!m) throw thrown({ kind: 'not-found' });
    const repo = `${m[1]}/${m[2]}`;
    if (this.missingRepos.has(repo)) { this.spend(false); throw thrown({ kind: 'not-found' }); }
    if (this.privateRepos.has(repo) && this.conn.auth === 'anonymous') { this.spend(false); throw thrown({ kind: 'not-connected' }); }
    const etag = `W/"${this.rev}-${url.pathname}${url.search}"`;
    if (ifNoneMatch === etag) { this.spend(true); return { status: 304, json: null, etag, notModified: true, rate: { ...this.conn.rate } }; }
    this.spend(false);
    let json: unknown;
    if (m[3]) {
      const list = this.jobs.get(Number(m[3])) ?? [];
      json = { total_count: list.length, jobs: list };
    } else {
      const branch = url.searchParams.get('branch');
      const per = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30)));
      const list = this.runs.filter((r) => !branch || r.head_branch === branch).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id)).slice(0, per);
      json = { total_count: list.length, workflow_runs: list };
    }
    return { status: 200, json, etag, rate: { ...this.conn.rate } };
  }

  async logs(jobId: number | string, _repo: string): Promise<{ text: string; truncated: boolean }> {
    this.calls.push({ method: 'GET', path: `logs:${jobId}:${_repo}` });
    this.maybeFail();
    if (this.logsMode === 'refused') throw thrown({ kind: 'logs-unavailable' });
    if (this.logsMode === 'expired') throw thrown({ kind: 'not-found' });
    const text = this.logText.get(Number(jobId));
    if (text === undefined) throw thrown({ kind: 'not-found' });
    return { text, truncated: false };
  }

  private writeGuard(): void {
    if (this.can('actions', 'write') !== 'yes') throw thrown({ kind: 'forbidden', needs: 'write' });
  }
  /** The write members, only while a scenario enabled them (the real writes module is optional and may be missing). */
  writesPort(): GitHubWrites | undefined {
    if (!this.writesOn) return undefined;
    return {
      rerunFailed: async (runId, repo) => {
        this.writes.push({ op: 'rerun', runId, repo });
        this.maybeFail(); this.writeGuard();
        const r = this.runs.find((x) => x.id === runId);
        if (!r) throw thrown({ kind: 'not-found' });
        r.status = 'queued'; r.conclusion = null; r.run_attempt = Number(r.run_attempt ?? 1) + 1; this.touch();
      },
      cancel: async (runId, repo) => {
        this.writes.push({ op: 'cancel', runId, repo });
        this.maybeFail(); this.writeGuard();
        const r = this.runs.find((x) => x.id === runId);
        if (!r) throw thrown({ kind: 'not-found' });
        r.status = 'completed'; r.conclusion = 'cancelled'; this.touch();
      },
    };
  }

  /* ---------- harness control ---------- */
  /** Canned data sets for the harness and the browser checks. Ids and names are invented; nothing here is a real run. */
  scenario(name: string): void {
    this.clear();
    if (name === 'empty') return;
    const long = [
      'build and test (windows-latest, shard 1/4) with the extended integration suite and the packaging smoke test enabled',
      'build and test (windows-latest, shard 2/4)', 'build and test (windows-latest, shard 3/4)', 'build and test (windows-latest, shard 4/4)',
      'test (ubuntu-latest, shard 1/3)', 'test (ubuntu-latest, shard 2/3)', 'test (ubuntu-latest, shard 3/3)',
      'test (macos-latest, shard 1/2)', 'typecheck and build the interface bundle', 'package the installer and verify the signature',
    ];
    this.addRun({ id: 9005, name: 'CI', branch: 'feat/ci-panel', status: 'in_progress', title: 'Add the CI panel', ageMin: 2, jobs: long.map((n, i) => ({ id: 900500 + i, name: n, status: i < 5 ? 'completed' : 'in_progress' })) });
    this.addRun({ id: 9004, name: 'CI', branch: 'feat/ci-panel', conclusion: 'failure', title: 'Parse runs and jobs once', ageMin: 40, durationSec: 612, jobs: [
      { id: 900400, name: 'test (ubuntu-latest, shard 1/3)' }, { id: 900401, name: 'test (windows-latest, shard 2/4)', conclusion: 'failure', durSec: 311 }, { id: 900402, name: 'typecheck and build the interface bundle' },
    ] });
    this.addRun({ id: 9003, name: 'Release check', branch: 'feat/ci-panel', title: 'Parse runs and jobs once', ageMin: 41, durationSec: 95, jobs: [{ id: 900300, name: 'verify version' }] });
    this.addRun({ id: 9002, name: 'CI', branch: 'main', title: 'Merge pull request #24 from release/0.2.5-j', ageMin: 300, durationSec: 701, jobs: [{ id: 900200, name: 'test (ubuntu-latest, shard 1/3)' }, { id: 900201, name: 'test (windows-latest, shard 1/4)' }] });
    this.addRun({ id: 9001, name: 'CI', branch: 'main', conclusion: 'cancelled', title: 'Release 0.2.5-i', ageMin: 900, durationSec: 40, jobs: [{ id: 900100, name: 'test (ubuntu-latest, shard 1/3)', conclusion: 'cancelled' }] });
    const lines: string[] = ['##[group]Run node --test dist/test/ci.test.js'];
    for (let i = 1; i <= 395; i++) lines.push(`2026-10-07T10:${String(i % 60).padStart(2, '0')}:00.0000000Z ok ${i} - case ${i} (${(i % 9) + 1}.${i % 7}ms)`);
    lines.push('2026-10-07T10:59:01.0000000Z not ok 396 - rerun calls writes only from the admin routes', '2026-10-07T10:59:01.0000000Z   AssertionError: 0 !== 1', '2026-10-07T10:59:02.0000000Z   token=' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789' + '', '2026-10-07T10:59:02.0000000Z <img src=x onerror=alert(1)> stays text', '2026-10-07T10:59:03.0000000Z ##[error]Process completed with exit code 1.');
    this.logText.set(900401, lines.join('\n'));
    this.logText.set(900100, 'Run was cancelled before this job started.');
  }

  /** The harness control channel: one object in, a small state view out. */
  control(cmd: Record<string, unknown>): Record<string, unknown> {
    if (typeof cmd.scenario === 'string') this.scenario(cmd.scenario);
    if (cmd.connection && typeof cmd.connection === 'object') this.setConnection(cmd.connection as Partial<Connection>);
    if (cmd.rate && typeof cmd.rate === 'object') this.setRate(cmd.rate as Partial<Connection['rate']>);
    if (cmd.logs === 'ok' || cmd.logs === 'refused' || cmd.logs === 'expired') this.logsMode = cmd.logs;
    if ('fail' in cmd) this.failNext = cmd.fail ? { error: asGhError(cmd.fail), count: Infinity } : null;
    if (Array.isArray(cmd.privateRepos)) this.privateRepos = new Set(cmd.privateRepos.map(String));
    if (Array.isArray(cmd.missingRepos)) this.missingRepos = new Set(cmd.missingRepos.map(String));
    if (typeof cmd.finish === 'number') this.finishRun(cmd.finish, typeof cmd.conclusion === 'string' ? cmd.conclusion : 'success');
    if (typeof cmd.writes === 'boolean') this.writesOn = cmd.writes;
    if (cmd.resetCalls) { this.calls.length = 0; this.writes.length = 0; }
    return { calls: this.calls.length, writes: this.writes, runs: this.runs.length, auth: this.conn.auth, remaining: this.conn.rate.remaining, logs: this.logsMode, writesEnabled: this.writesOn };
  }
}
