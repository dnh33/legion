/**
 * UI store for the GitHub area and its title-bar button. Own small external store, same pattern as ciStore.
 * The routes (design 6.4) are not merged yet, so everything goes through USE_MOCK: true reads the typed stand-in in githubMock.ts, false calls the
 * real core through api.ts. Flip that one constant when the routes land. Nothing polls GitHub from here; the core answers from its cache.
 */
import { useSyncExternalStore } from 'react';
import { api, ApiError, openExternal, request } from '../api';
import { errText, getState as getApp, openSettings, toast } from '../store';
import * as ci from '../ci/ciStore';
import { githubAgentsFor, normRepo } from '../../../src/shared/github-area';
import type { GithubStatusView } from '../../../src/shared/connectors-view';
import { createFailureKind, createFailureText, PAGE } from './areaState';
import type { CreateFailure } from './areaState';
import { MOCK_AGENTS, mockDetail, mockScenario, mockView } from './githubMock';
import type { AreaAgent, CreateRepoBody, GithubAreaData, GithubRepoDetail } from './types';

/** The one switch: true until the area routes are merged (Task 3 and 6). */
export const USE_MOCK = true;

export interface GithubUiState {
  open: boolean;
  view: GithubAreaData | null;
  /** First load in flight with nothing cached. */
  loading: boolean;
  /** The read sign-in waits for the owner on github.com. */
  signingIn: boolean;
  flow: { userCode: string; verificationUri: string } | null;
  query: string;
  shown: number;
  expanded: string | null;
  detail: Record<string, GithubRepoDetail>;
  busy: string | null;
  /** Show the title-bar icon (Settings, GitHub). */
  iconShown: boolean;
  /** Screen-reader live text. */
  say: string;
}

const ICON_KEY = 'legion.github.icon';
const readIcon = (): boolean => { try { return localStorage.getItem(ICON_KEY) !== 'off'; } catch { return true; } };

let st: GithubUiState = { open: false, view: null, loading: false, signingIn: false, flow: null, query: '', shown: PAGE, expanded: null, detail: {}, busy: null, iconShown: readIcon(), say: '' };
const listeners = new Set<() => void>();
const set = (p: Partial<GithubUiState>) => { st = { ...st, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getGithub = () => st;
export function useGithub<T>(selector: (s: GithubUiState) => T): T { return useSyncExternalStore(sub, () => selector(st)); }

let mockAgents: AreaAgent[] = MOCK_AGENTS.map((a) => ({ ...a, connectors: [...(a.connectors ?? [])], githubWrite: [...(a.githubWrite ?? [])] }));
let mockStarted = false;

/** The agents the area counts: the app's own, or the stand-in's. */
export const areaAgents = (): AreaAgent[] => (USE_MOCK ? mockAgents : getApp().agents.map((a) => ({ id: a.id, name: a.name, connectors: a.connectors, githubWrite: a.githubWrite })));
export function agentsOn(repo: string): { read: AreaAgent[]; write: AreaAgent[] } {
  const all = areaAgents();
  const g = githubAgentsFor(repo, all);
  const pick = (ids: string[]) => ids.map((id) => all.find((a) => a.id === id)).filter((a): a is AreaAgent => !!a);
  return { read: pick(g.read), write: pick(g.write) };
}

/* ---------- open and close ---------- */
export function openGithub(repo?: string): void {
  set({ open: true, ...(repo ? { expanded: repo, query: '' } : {}) });
  void loadArea().then(() => { if (repo) void loadDetail(repo); });
}
export function closeGithub(): void { set({ open: false }); }
export function toggleGithub(): void { if (st.open) closeGithub(); else openGithub(); }

/* ---------- reading ---------- */
export async function loadArea(force = false): Promise<void> {
  if (!st.view) set({ loading: true });
  try {
    if (USE_MOCK) {
      const sc = mockScenario();
      if (sc === 'loading') return; // stays on the skeleton, for the picture
      // the first read picks the scenario; later reads keep the edited copy
      if (!mockStarted) { mockStarted = true; set({ view: mockView(sc), loading: false, ...(sc === 'signing-in' ? { signingIn: true, flow: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device' } } : {}) }); }
      else set({ loading: false });
      return;
    }
    set({ view: await api.githubArea(force), loading: false });
  } catch (e) {
    // routes missing (an older core): the build cannot sign in. Offline or any other failure: keep what we had, say so in plain words.
    if (e instanceof ApiError && e.status === 404) set({ view: { ...(st.view ?? emptyView()), registered: { read: false, write: false, create: false } }, loading: false });
    else set({ view: { ...(st.view ?? emptyView()), problem: { kind: 'network' } }, loading: false });
  }
}

function emptyView(): GithubAreaData {
  return { registered: { read: true, write: true, create: false }, signedIn: { read: false, write: false, create: false }, agentsEnabled: false, selection: 'unknown', repos: [], truncated: false, activity: [] };
}

export async function loadDetail(repo: string): Promise<void> {
  if (USE_MOCK) { set({ detail: { ...st.detail, [repo]: st.detail[repo] ?? mockDetail(repo) } }); return; }
  let projects: GithubRepoDetail['projects'] = [];
  try { projects = await api.githubProjectsUsing(repo); } catch { /* the list stays empty; the rest still shows */ }
  const c = ci.getCi();
  const watched = c.state?.repo ? `${c.state.repo.owner}/${c.state.repo.name}` : null;
  if (watched && normRepo(watched) === normRepo(repo) && c.runs) {
    const runs = c.runs.runs.slice(0, 3);
    await Promise.all(runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out').map((r) => ci.loadJobs(r.id)));
    const jobs = ci.getCi().jobs;
    const failed: Record<number, string[]> = {};
    for (const r of runs) failed[r.id] = (jobs[r.id]?.jobs ?? []).filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out').map((j) => j.name);
    set({ detail: { ...st.detail, [repo]: { projects, ci: { runs, failed, problem: c.runs.problem, source: 'here' } } } });
  } else set({ detail: { ...st.detail, [repo]: { projects, ci: { runs: [], failed: {}, problem: null, source: 'watch-needed' } } } });
}

export function toggleRepo(repo: string): void {
  if (st.expanded === repo) { set({ expanded: null }); return; }
  set({ expanded: repo });
  void loadDetail(repo);
}
export const setQuery = (query: string): void => set({ query, shown: PAGE });
export const showMore = (): void => set({ shown: st.shown + PAGE });

/* ---------- connection ---------- */
async function pollFlow(): Promise<void> {
  try {
    const s = await request<GithubStatusView>('GET', '/api/connectors/github');
    set({ flow: s.flow.phase === 'pending' ? { userCode: s.flow.userCode, verificationUri: s.flow.verificationUri } : null });
  } catch { /* the next beat tries again */ }
}

export async function connectRead(): Promise<void> {
  if (st.signingIn) return;
  if (USE_MOCK) { set({ signingIn: true, flow: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device' } }); return; }
  set({ signingIn: true });
  const timer = window.setInterval(() => { void pollFlow(); }, 2000);
  try {
    const fn = (window as unknown as { legion?: { connectorConnect?: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }> } }).legion?.connectorConnect;
    if (!fn) throw new Error('Connecting needs the Legion app window. Open Legion from its shortcut.');
    const r = await fn();
    if (!r.ok && !r.cancelled) throw new Error(r.error ?? 'The connect failed.');
  } catch (e) { toast(errText(e), 'error'); } finally { window.clearInterval(timer); set({ signingIn: false, flow: null }); void loadArea(true); }
}
export function cancelSignIn(): void {
  set({ signingIn: false, flow: null });
  if (!USE_MOCK) void request('POST', '/api/connectors/github/cancel').catch(() => undefined);
}
/** The mock only: the owner "approved" on github.com. */
export function mockApprove(): void {
  if (!USE_MOCK || !st.view) return;
  const v = mockView('ready');
  set({ view: { ...v, signedIn: { read: true, write: false, create: false } }, signingIn: false, flow: null });
}
export async function disconnectRead(): Promise<void> {
  if (USE_MOCK) { set({ view: st.view ? { ...st.view, signedIn: { read: false, write: false, create: false }, repos: [] } : null }); return; }
  try { await request('POST', '/api/connectors/github/disconnect'); } catch (e) { toast(errText(e), 'error'); }
  await loadArea(true);
}
export async function connectWrite(): Promise<void> {
  if (st.busy) return;
  set({ busy: 'write-app' });
  try {
    if (USE_MOCK) { if (st.view) set({ view: { ...st.view, signedIn: { ...st.view.signedIn, write: true } } }); toast('Writes are on. Every write still asks you first.'); return; }
    await api.githubConnectWrite();
    toast('Check github.com to finish turning on writes');
  } catch (e) { toast(errText(e), 'error'); } finally { set({ busy: null }); if (!USE_MOCK) void loadArea(true); }
}
export async function disconnectWrite(): Promise<void> {
  if (USE_MOCK) { if (st.view) set({ view: { ...st.view, signedIn: { ...st.view.signedIn, write: false } } }); return; }
  try { await api.githubDisconnectWrite(); } catch (e) { toast(errText(e), 'error'); }
  await loadArea(true);
}
export async function setAgentsEnabled(on: boolean): Promise<void> {
  if (st.view) set({ view: { ...st.view, agentsEnabled: on } });
  if (USE_MOCK) return;
  try { await api.githubAgentsSwitch(on); } catch (e) { toast(errText(e), 'error'); await loadArea(true); }
}
export async function setTick(repo: string, on: boolean): Promise<void> {
  const before = st.view;
  if (before) set({ view: { ...before, repos: before.repos.map((r) => (r.fullName === repo ? { ...r, ticked: on } : r)) } });
  if (USE_MOCK) return;
  try { await api.githubTick(repo, on); } catch (e) { toast(errText(e), 'error'); set({ view: before }); }
}

/* ---------- create ---------- */
export type CreateResult = { ok: true; fullName: string } | { ok: false; kind: CreateFailure; text: string };

export async function createRepo(body: CreateRepoBody): Promise<CreateResult> {
  // one request per click, however fast the clicks come, and no retry after it was sent
  if (st.busy === 'create') return { ok: false, kind: 'unknown', text: 'Already creating. One moment.' };
  set({ busy: 'create' });
  const fail = (kind: CreateFailure): CreateResult => ({ ok: false, kind, text: createFailureText(kind) });
  try {
    if (USE_MOCK) {
      await new Promise((r) => setTimeout(r, 450));
      if (body.name.toLowerCase() === 'taken') return fail('name-taken');
      const owner = body.owner || st.view?.login || 'dnh33';
      const full = `${owner}/${body.name}`;
      const row = { fullName: full, private: body.private, installedRead: true, installedWrite: true, ticked: body.tick, htmlUrl: `https://github.com/${full}`, installationSettingsUrl: st.view?.repos[0]?.installationSettingsUrl ?? 'https://github.com/settings/installations' };
      if (st.view) set({ view: { ...st.view, repos: [row, ...st.view.repos] }, expanded: full });
      void loadDetail(full);
      return { ok: true, fullName: full };
    }
    const r = await api.githubCreateRepo(body);
    await loadArea(true);
    set({ expanded: r.fullName });
    void loadDetail(r.fullName);
    return { ok: true, fullName: r.fullName };
  } catch (e) {
    return e instanceof ApiError ? fail(createFailureKind(e.status, e.message)) : fail('unknown');
  } finally { set({ busy: null }); }
}

/* ---------- CI and agents ---------- */
export async function rerunFailed(repo: string, runId: number): Promise<void> {
  if (!USE_MOCK) { await ci.rerunFailed(runId); await loadDetail(repo); return; }
  const d = st.detail[repo]; if (!d) return;
  toast('Re-running the failed jobs');
  set({ detail: { ...st.detail, [repo]: { ...d, ci: { ...d.ci, runs: d.ci.runs.map((r) => (r.id === runId ? { ...r, status: 'in_progress', conclusion: null, attempt: r.attempt + 1, durationMs: null, startedAt: new Date().toISOString() } : r)) } } } });
}
export async function cancelRun(repo: string, runId: number): Promise<void> {
  if (!USE_MOCK) { await ci.cancelRun(runId); await loadDetail(repo); return; }
  const d = st.detail[repo]; if (!d) return;
  toast('Cancel requested');
  set({ detail: { ...st.detail, [repo]: { ...d, ci: { ...d.ci, runs: d.ci.runs.map((r) => (r.id === runId ? { ...r, status: 'completed', conclusion: 'cancelled', durationMs: 60_000 } : r)) } } } });
}
/** The CI panel watches a repo of its own. This points it at this one and opens it. */
export async function watchInCi(repo: string): Promise<void> {
  if (USE_MOCK) { toast('The CI panel now watches ' + repo); return; }
  await ci.saveRepo(repo);
  ci.openCi();
}

export async function grantProject(repo: string, projectId: string, level: 'read' | 'write'): Promise<void> {
  const d = st.detail[repo];
  const proj = d?.projects.find((p) => p.id === projectId);
  if (USE_MOCK) {
    if (!proj) return;
    mockAgents = mockAgents.map((a) => {
      if (!proj.agentIds.includes(a.id)) return a;
      const connectors = a.connectors?.includes('github') ? a.connectors : [...(a.connectors ?? []), 'github'];
      const w = (a.githubWrite ?? []).filter((x) => normRepo(x) !== normRepo(repo));
      return { ...a, connectors, githubWrite: level === 'write' ? [...w, repo] : w };
    });
    toast(level === 'write' ? `Agents in ${proj.name} can now write to ${repo}. Each write still asks you first.` : `Agents in ${proj.name} can now read ${repo}.`);
    set({ say: `${proj.name} agents: ${level}` });
    return;
  }
  try { await api.githubProjectAccess(projectId, repo, level); toast(level === 'write' ? 'Agents can write here. Each write still asks you first.' : 'Agents can read this repo.'); await loadDetail(repo); } catch (e) { toast(errText(e), 'error'); }
}

/* ---------- links ---------- */
export const openAtGithub = (url: string): void => openExternal(url);
export function openGithubSettings(): void { closeGithub(); openSettings('github'); }
export const GITHUB_NEW_REPO_URL = 'https://github.com/new';

/* ---------- the icon switch ---------- */
export function setIconShown(on: boolean): void {
  set({ iconShown: on });
  try { localStorage.setItem(ICON_KEY, on ? 'on' : 'off'); } catch { /* not remembered */ }
}

/* ---------- start ---------- */
let started = false;
/** The chip needs the view to colour its dot; one read at start, then on open. */
export function initGithub(): void {
  if (started) return;
  started = true;
  void loadArea();
  window.addEventListener('focus', () => { if (st.open) void loadArea(true); });
}
