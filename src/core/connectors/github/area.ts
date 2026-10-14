/**
 * The GitHub area's core (design 5, 6.4, 13): one view that merges what the read App and the write App can reach, the repos the owner
 * turned on in Legion, the CI summary the poller already saw, and what agents did. Plain data for the routes in ../index.ts.
 *
 * GitHub is asked at most once per 60 s (and not at all while GitHub asks us to wait); the owner's local choices (ticks, the master
 * switch) are read fresh on every view, so a tick never costs a request. A failed or limited refresh keeps the last list and says why.
 * Nothing here returns a token, a device code or an address with a query string.
 */
import type { EventBus } from '../../bus.js';
import { asGhError } from '../../ci/port.js';
import { validRepoString } from '../../ci/repo.js';
import type { RepoRef } from '../../ci/repo.js';
import { HttpError } from '../../server.js';
import type { Project } from '../../../shared/projects.js';
import type { AgentProfile } from '../../../shared/types.js';
import { agentGithubLevel, normRepo } from '../../../shared/github-area.js';
import type { GithubActivityItem, GithubApp, GithubAreaView, GithubLevel, GithubRepoCi, GithubRepoRow } from '../../../shared/github-area.js';
import { readAllowlist, setMaster, setTicked } from './allowlist.js';
import type { GitHubClient } from './client.js';
import { githubInstallSettingsUrl } from './hosts.js';

const CACHE_MS = 60_000;
const APPS: GithubApp[] = ['read', 'write'];
const MAX_CI = 50;

export interface AreaDeps {
  dataDir: string;
  client(app: GithubApp): GitHubClient | undefined;
  now(): number;
  /** Absent in a bare test rig: no CI events then. */
  bus?: Pick<EventBus, 'on'>;
  agents: { list(): AgentProfile[]; save(a: AgentProfile): void };
  projects?: { list(): Project[]; get(id: string): Project | undefined };
  /** The GitHub repo a project folder's git remote names. */
  repoOf(folder: string): RepoRef | null;
  /**
   * What Legion's agents did per repo, newest first. The write tools (write-tools.ts) record each approved write here once they exist;
   * until then there is nothing to read and the list is empty. It never asks GitHub.
   */
  activity(): GithubActivityItem[];
  log(line: string): void;
}

interface Row { fullName: string; private: boolean; htmlUrl: string; settingsUrl: string }
interface AppData { rows: Row[]; truncated: boolean; selection: 'all' | 'selected' }
interface Remote {
  at: number;
  apps: Partial<Record<GithubApp, AppData>>;
  login?: string;
  rate?: { remaining: number; resetAt: string };
  problem?: NonNullable<GithubAreaView['problem']>;
}

const problemOf = (e: unknown): NonNullable<GithubAreaView['problem']> => {
  const g = asGhError(e);
  if (g.kind === 'rate-limited') return { kind: 'rate-limited', resetAt: g.resetAt };
  if (g.kind === 'not-connected' || g.kind === 'auth-expired') return { kind: g.kind };
  return { kind: 'network' };
};

export class GithubArea {
  private remote: Remote | undefined;
  private inflight: Promise<Remote> | undefined;
  private readonly ci = new Map<string, GithubRepoCi>();
  private readonly off: () => void;

  constructor(private readonly d: AreaDeps) {
    // The CI poller says what it saw on every change; keeping the last word per repo costs no request.
    this.off = d.bus?.on((ev) => {
      if (ev.type !== 'ci.updated' || !ev.summary.repo || !validRepoString(ev.summary.repo)) return;
      const key = normRepo(ev.summary.repo);
      this.ci.delete(key);
      this.ci.set(key, { branch: ev.summary.branch, counts: { ...ev.summary.counts }, running: ev.summary.running, problem: !!ev.summary.problem });
      if (this.ci.size > MAX_CI) this.ci.delete(this.ci.keys().next().value as string);
    }) ?? (() => undefined);
  }

  dispose(): void { this.off(); }

  /** The next view asks GitHub again (after a sign-in or sign-out). */
  invalidate(): void { this.remote = undefined; }

  private async loadApp(app: GithubApp, c: GitHubClient): Promise<AppData> {
    const rows: Row[] = [];
    let truncated = false;
    let selection: AppData['selection'] = 'selected';
    for (const inst of await c.installations()) {
      if (inst.repositorySelection === 'all') selection = 'all';
      const got = await c.installationRepos(inst.id);
      truncated ||= got.truncated;
      for (const r of got.repos) rows.push({ fullName: r.fullName, private: r.private, htmlUrl: r.htmlUrl, settingsUrl: githubInstallSettingsUrl(inst) });
    }
    return { rows, truncated, selection };
  }

  private async refresh(): Promise<Remote> {
    const prev = this.remote;
    const next: Remote = { at: this.d.now(), apps: { ...prev?.apps }, ...(prev?.login ? { login: prev.login } : {}) };
    let signedInAny = false;
    for (const app of APPS) {
      const c = this.d.client(app);
      if (!c || !(await c.signedIn())) { delete next.apps[app]; continue; }
      signedInAny = true;
      try {
        next.apps[app] = await this.loadApp(app, c);
        if (!next.login && app === 'read') {
          // one more request: who is signed in, and what is left of the rate limit
          const u = await c.request('/user');
          const login = (u.json as { login?: unknown } | null)?.login;
          if (typeof login === 'string') next.login = login;
          next.rate = { remaining: u.rate.remaining, resetAt: u.rate.resetAt };
        }
      } catch (e) {
        // keep what this App showed last time; the first problem is the one told (a rate limit outranks the rest)
        const p = problemOf(e);
        if (!next.problem || p.kind === 'rate-limited') next.problem = p;
        this.d.log(`github area: could not read the ${app} installations (${p.kind})`);
      }
    }
    if (!signedInAny) next.problem = { kind: 'not-connected' };
    return next;
  }

  private async remoteNow(force: boolean): Promise<Remote> {
    const r = this.remote;
    const now = this.d.now();
    if (r) {
      if (!force && now - r.at < CACHE_MS) return r;
      // GitHub asked us to wait: no request until then, forced or not
      if (r.problem?.kind === 'rate-limited' && r.problem.resetAt && Date.parse(r.problem.resetAt) > now) return r;
    }
    this.inflight ??= this.refresh().then((x) => { this.remote = x; return x; }).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  async view(force = false): Promise<GithubAreaView> {
    const r = await this.remoteNow(force);
    const list = readAllowlist(this.d.dataDir);
    const ticked = new Set(list.ticked);
    const by = new Map<string, GithubRepoRow>();
    for (const app of APPS) {
      for (const x of r.apps[app]?.rows ?? []) {
        const key = normRepo(x.fullName);
        const row = by.get(key) ?? {
          fullName: x.fullName, private: x.private, installedRead: false, installedWrite: false, ticked: ticked.has(key),
          htmlUrl: x.htmlUrl, installationSettingsUrl: x.settingsUrl,
        };
        if (app === 'read') row.installedRead = true; else row.installedWrite = true;
        row.private ||= x.private;
        const ci = this.ci.get(key);
        if (ci && !row.ci) row.ci = { ...ci, counts: { ...ci.counts } };
        by.set(key, row);
      }
    }
    const datas = APPS.map((a) => r.apps[a]).filter((x): x is AppData => !!x);
    const clients = { read: this.d.client('read'), write: this.d.client('write') };
    const signed = { read: !!r.apps.read, write: !!r.apps.write };
    // an App that is signed in but failed this time has no data: ask the client rather than guess
    for (const app of APPS) if (!signed[app] && clients[app]) signed[app] = await clients[app]!.signedIn();
    return {
      registered: { read: !!clients.read?.deviceFlowAvailable(), write: !!clients.write?.deviceFlowAvailable() },
      signedIn: signed,
      ...(r.login ? { login: r.login } : {}),
      agentsEnabled: list.agentsEnabled,
      selection: datas.length === 0 ? 'unknown' : datas.some((x) => x.selection === 'all') ? 'all' : 'selected',
      repos: [...by.values()].sort((a, b) => a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase())),
      truncated: datas.some((x) => x.truncated),
      activity: this.d.activity().slice(0, 50),
      ...(r.rate ? { rate: r.rate } : {}),
      ...(r.problem ? { problem: r.problem } : {}),
    };
  }

  /** Turn a repo on or off for agents. Turning on needs the repo to be in the installed list; turning off always works (a stale tick can be cleared). */
  async tick(owner: string, name: string, on: boolean): Promise<GithubAreaView> {
    const full = `${owner}/${name}`;
    if (!validRepoString(full)) throw new HttpError(400, 'That is not a repository name.');
    if (on && !(await this.view(false)).repos.some((x) => normRepo(x.fullName) === normRepo(full))) throw new HttpError(404, 'not-installed');
    setTicked(this.d.dataDir, full, on);
    return this.view(false);
  }

  async agentsSwitch(on: boolean): Promise<GithubAreaView> {
    setMaster(this.d.dataDir, on);
    return this.view(false);
  }

  // ---------------------------------------------------------------------------------------------- projects

  private projectLevel(p: Project, repo: string): GithubLevel {
    const key = normRepo(repo);
    let level: GithubLevel = 'none';
    for (const id of p.members) {
      const a = this.d.agents.list().find((x) => x.id === id);
      if (!a) continue;
      const l = agentGithubLevel(a);
      if (l === 'write' && (a.githubWrite ?? []).map(normRepo).includes(key)) return 'write';
      if (l !== 'none') level = 'read';
    }
    return level;
  }

  projectsUsing(owner: string, name: string): { projects: { id: string; name: string; level: GithubLevel }[] } {
    const full = `${owner}/${name}`;
    if (!validRepoString(full)) throw new HttpError(400, 'That is not a repository name.');
    const key = normRepo(full);
    const out: { id: string; name: string; level: GithubLevel }[] = [];
    for (const p of this.d.projects?.list() ?? []) {
      const r = p.folder ? this.d.repoOf(p.folder) : null;
      if (r && normRepo(`${r.owner}/${r.name}`) === key) out.push({ id: p.id, name: p.name, level: this.projectLevel(p, full) });
    }
    return { projects: out };
  }

  /** Give a project's agents GitHub: read (the connector) or write (the connector plus this project's repo in their write list). */
  projectAccess(projectId: string, level: unknown): { ok: true; level: 'read' | 'write'; repo: string; agents: number } {
    if (level !== 'read' && level !== 'write') throw new HttpError(400, "level must be 'read' or 'write'");
    const p = this.d.projects?.get(projectId);
    if (!p) throw new HttpError(404, 'Unknown project');
    const r = p.folder ? this.d.repoOf(p.folder) : null;
    if (!r) throw new HttpError(409, 'This project has no GitHub repository. Set its git remote first.');
    const repo = normRepo(`${r.owner}/${r.name}`);
    if (level === 'write' && !readAllowlist(this.d.dataDir).ticked.includes(repo)) throw new HttpError(409, 'Turn this repo on in the GitHub area first.');
    let n = 0;
    for (const id of p.members) {
      const cur = this.d.agents.list().find((x) => x.id === id);
      if (!cur) continue;
      const next: AgentProfile = { ...cur, connectors: [...new Set([...(cur.connectors ?? []), 'github'])] };
      const others = (cur.githubWrite ?? []).filter((x) => normRepo(x) !== repo);
      const writes = level === 'write' ? [...others, repo] : others;
      if (writes.length) next.githubWrite = writes; else delete next.githubWrite;
      this.d.agents.save(next);
      n++;
    }
    return { ok: true, level, repo, agents: n };
  }
}
