/**
 * UI store for the GitHub area and its title-bar button. Own small external store, same pattern as ciStore.
 * Every call goes to the core routes in src/core/connectors/index.ts; answers are checked in githubRoutes.ts. Nothing polls GitHub from here:
 * the core answers from its cache. A failed call always ends in a plain message (a toast, or a line in the panel), never in nothing.
 */
import { useSyncExternalStore } from 'react';
import { api, ApiError, openExternal, request } from '../api';
import { getState as getApp, openSettings, toast } from '../store';
import * as ci from '../ci/ciStore';
import { githubAgentsFor, normRepo } from '../../../src/shared/github-area';
import type { GithubAreaView } from '../../../src/shared/github-area';
import type { GithubStatusView } from '../../../src/shared/connectors-view';
import { createFailureKind, createFailureText, PAGE } from './areaState';
import type { CreateFailure } from './areaState';
import { activityFrom, parseCreateReply, parseOrgs, parseProjectsUsing, parseWriteFlow, plainError } from './githubRoutes';
import type { AreaAgent, CreateRepoBody, GithubAreaData, GithubRepoDetail } from './types';

/** The plain reason a call failed. */
const whyText = (e: unknown): string => (e instanceof ApiError ? plainError(e.status, e.message) : e instanceof Error && /\s/.test(e.message) ? e.message : 'Something went wrong.');

export interface GithubUiState {
  open: boolean;
  view: GithubAreaData | null;
  /** First load in flight with nothing cached. */
  loading: boolean;
  /** The read sign-in waits for the owner on github.com. */
  signingIn: boolean;
  flow: { userCode: string; verificationUri: string } | null;
  /** Why the read sign-in check could not run, while it waits. */
  flowNote: string | null;
  /** The write app's sign-in, waiting for the owner on github.com. */
  writeFlow: { userCode: string; verificationUri: string; expiresAt: number } | null;
  /** The plain reason the last read failed. Cleared by the next good read. */
  why: string | null;
  /** The organisations the account can create repos in, and why that list is missing. */
  orgs: string[];
  orgsError: string | null;
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

let st: GithubUiState = { open: false, view: null, loading: false, signingIn: false, flow: null, flowNote: null, writeFlow: null, why: null, orgs: [], orgsError: null, query: '', shown: PAGE, expanded: null, detail: {}, busy: null, iconShown: readIcon(), say: '' };
const listeners = new Set<() => void>();
const set = (p: Partial<GithubUiState>) => { st = { ...st, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getGithub = () => st;
export function useGithub<T>(selector: (s: GithubUiState) => T): T { return useSyncExternalStore(sub, () => selector(st)); }

/** The agents the area counts: the app's own. */
export const areaAgents = (): AreaAgent[] => getApp().agents.map((a) => ({ id: a.id, name: a.name, connectors: a.connectors, githubWrite: a.githubWrite }));
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
const toData = (v: GithubAreaView): GithubAreaData => ({ ...v, activity: activityFrom(v.activity, areaAgents()) });

export async function loadArea(force = false): Promise<void> {
  if (!st.view) set({ loading: true });
  try {
    set({ view: toData(await api.githubArea(force)), loading: false, why: null });
  } catch (e) {
    const why = whyText(e);
    // an older core without the routes: the build cannot sign in. Any other failure keeps the last list and says why; with no list it is an error with Try again.
    if (e instanceof ApiError && e.status === 404) set({ view: { ...(st.view ?? emptyView()), registered: { read: false, write: false } }, loading: false, why });
    else set({ view: st.view ? { ...st.view, problem: { kind: 'network' } } : null, loading: false, why });
  }
}

function emptyView(): GithubAreaData {
  return { registered: { read: true, write: true }, signedIn: { read: false, write: false }, agentsEnabled: false, selection: 'unknown', repos: [], truncated: false, activity: [] };
}

export async function loadDetail(repo: string): Promise<void> {
  let projects: GithubRepoDetail['projects'] = [];
  let projectsError: string | undefined;
  try { projects = parseProjectsUsing(await api.githubProjectsUsing(repo)); } catch (e) { projectsError = whyText(e); }
  const c = ci.getCi();
  const watched = c.state?.repo ? `${c.state.repo.owner}/${c.state.repo.name}` : null;
  const err = projectsError ? { projectsError } : {};
  if (watched && normRepo(watched) === normRepo(repo) && c.runs) {
    const runs = c.runs.runs.slice(0, 3);
    await Promise.all(runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out').map((r) => ci.loadJobs(r.id)));
    const jobs = ci.getCi().jobs;
    const failed: Record<number, string[]> = {};
    for (const r of runs) failed[r.id] = (jobs[r.id]?.jobs ?? []).filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out').map((j) => j.name);
    set({ detail: { ...st.detail, [repo]: { projects, ...err, ci: { runs, failed, problem: c.runs.problem, source: 'here' } } } });
  } else set({ detail: { ...st.detail, [repo]: { projects, ...err, ci: { runs: [], failed: {}, problem: null, source: 'watch-needed' } } } });
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
    set({ flow: s.flow.phase === 'pending' ? { userCode: s.flow.userCode, verificationUri: s.flow.verificationUri } : null, flowNote: null });
  } catch { set({ flowNote: 'Legion cannot check the sign-in right now. It keeps trying.' }); }
}

export async function connectRead(): Promise<void> {
  if (st.signingIn) return;
  set({ signingIn: true, flowNote: null });
  const timer = window.setInterval(() => { void pollFlow(); }, 2000);
  try {
    const fn = (window as unknown as { legion?: { connectorConnect?: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }> } }).legion?.connectorConnect;
    if (!fn) throw new Error('Connecting needs the Legion app window. Open Legion from its shortcut.');
    const r = await fn();
    if (!r.ok && !r.cancelled) throw new Error(r.error ?? 'The connect failed.');
  } catch (e) { toast(whyText(e), 'error'); } finally { window.clearInterval(timer); set({ signingIn: false, flow: null, flowNote: null }); void loadArea(true); }
}
export function cancelSignIn(): void {
  set({ signingIn: false, flow: null, flowNote: null });
  void request('POST', '/api/connectors/github/cancel').catch((e: unknown) => toast(`The sign-in may still be waiting. ${whyText(e)}`, 'error'));
}
export async function disconnectRead(): Promise<void> {
  try { await request('POST', '/api/connectors/github/disconnect'); } catch (e) { toast(whyText(e), 'error'); }
  await loadArea(true);
}

let writeTimer: number | undefined;
const stopWritePoll = (): void => { if (writeTimer !== undefined) { window.clearInterval(writeTimer); writeTimer = undefined; } };
/** The write app signs in like the read app: a code on github.com. The area is read again every few seconds until the core says it is on. */
export async function connectWrite(): Promise<void> {
  if (st.busy) return;
  set({ busy: 'write-app' });
  try {
    const flow = parseWriteFlow(await api.githubConnectWrite());
    if (flow.phase === 'failed') { toast(flow.message, 'error'); return; }
    if (flow.phase === 'idle') { await loadArea(true); return; }
    set({ writeFlow: { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: flow.expiresAt } });
    stopWritePoll();
    writeTimer = window.setInterval(() => {
      void loadArea(true).then(() => {
        const done = !!st.view?.signedIn.write;
        const expired = !!st.writeFlow && Date.now() > st.writeFlow.expiresAt;
        if (done || expired || !st.writeFlow) {
          stopWritePoll();
          if (expired && !done) toast('The Legion (write) code ran out. Turn on writes again.', 'error');
          if (done) toast('Writes are on. Every write still asks you first.');
          set({ writeFlow: null });
        }
      });
    }, 4000);
  } catch (e) { toast(whyText(e), 'error'); } finally { set({ busy: null }); }
}
export function cancelWriteSignIn(): void {
  stopWritePoll();
  set({ writeFlow: null });
  void api.githubCancelWrite().catch((e: unknown) => toast(`The sign-in may still be waiting. ${whyText(e)}`, 'error'));
}
export async function disconnectWrite(): Promise<void> {
  try { await api.githubDisconnectWrite(); } catch (e) { toast(whyText(e), 'error'); }
  await loadArea(true);
}
export async function setAgentsEnabled(on: boolean): Promise<void> {
  if (st.view) set({ view: { ...st.view, agentsEnabled: on } });
  try { await api.githubAgentsSwitch(on); } catch (e) { toast(whyText(e), 'error'); await loadArea(true); }
}
export async function setTick(repo: string, on: boolean): Promise<void> {
  const before = st.view;
  if (before) set({ view: { ...before, repos: before.repos.map((r) => (r.fullName === repo ? { ...r, ticked: on } : r)) } });
  try { await api.githubTick(repo, on); } catch (e) { toast(whyText(e), 'error'); set({ view: before }); }
}

/* ---------- create ---------- */
export type CreateResult = { ok: true; fullName: string } | { ok: false; kind: CreateFailure; text: string };

/** The organisations to offer in the create form. A failure leaves only the personal account, and says so. */
export async function loadOrgs(): Promise<void> {
  try { set({ orgs: parseOrgs(await api.githubOrgs()), orgsError: null }); } catch (e) { set({ orgs: [], orgsError: `Your organisations could not be listed. ${whyText(e)}` }); }
}

export async function createRepo(body: CreateRepoBody): Promise<CreateResult> {
  // one request per click, however fast the clicks come, and no retry after it was sent
  if (st.busy === 'create') return { ok: false, kind: 'busy', text: 'Already creating. One moment.' };
  set({ busy: 'create' });
  const fail = (kind: CreateFailure): CreateResult => ({ ok: false, kind, text: createFailureText(kind) });
  try {
    const r = parseCreateReply(await api.githubCreateRepo(body));
    if (r.phase === 'needs-write') return { ok: false, kind: 'sign-in', text: r.message };
    await loadArea(true);
    set({ expanded: r.fullName });
    void loadDetail(r.fullName);
    if (body.tick && !r.ticked) toast(`${r.fullName} was created. It could not be turned on here; turn it on in the list.`, 'error');
    return { ok: true, fullName: r.fullName };
  } catch (e) {
    return e instanceof ApiError ? fail(createFailureKind(e.status, e.message)) : { ok: false, kind: 'unsure', text: createFailureText('unsure') };
  } finally { set({ busy: null }); }
}

/* ---------- CI and agents ---------- */
export async function rerunFailed(repo: string, runId: number): Promise<void> { await ci.rerunFailed(runId); await loadDetail(repo); }
export async function cancelRun(repo: string, runId: number): Promise<void> { await ci.cancelRun(runId); await loadDetail(repo); }
/** The CI panel watches a repo of its own. This points it at this one and opens it. */
export async function watchInCi(repo: string): Promise<void> {
  await ci.saveRepo(repo);
  ci.openCi();
}

export async function grantProject(repo: string, projectId: string, level: 'read' | 'write'): Promise<void> {
  try {
    await api.githubProjectAccess(projectId, level);
    toast(level === 'write' ? 'Agents can write here. Each write still asks you first.' : 'Agents can read this repo.');
    set({ say: level === 'write' ? 'Agents can write here' : 'Agents can read this repo' });
    await loadDetail(repo);
  } catch (e) { toast(whyText(e), 'error'); }
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
