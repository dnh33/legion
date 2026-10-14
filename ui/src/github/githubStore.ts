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
import type { GithubApp, GithubAreaView, GithubPickerView } from '../../../src/shared/github-area';
import type { GithubStatusView } from '../../../src/shared/connectors-view';
import { createFailureKind, createFailureText, PAGE } from './areaState';
import { OPEN_GITHUB_EVENT } from './openArea';
import type { CreateFailure } from './areaState';
import { activityFrom, parseCreateReply, parseOrgs, parsePicker, parseProjectsUsing, parseWriteFlow, plainError } from './githubRoutes';
import type { AreaAgent, CreateRepoBody, GithubAreaData, GithubRepoDetail } from './types';

/** The plain reason a call failed. */
const whyText = (e: unknown): string => (e instanceof ApiError ? plainError(e.status, e.message) : e instanceof Error && /\s/.test(e.message) ? e.message : 'Something went wrong.');

/** The "Choose repos" view: each App's candidates, the change being sent (one per App), and the plain reason a box did not take. */
export interface PickerState {
  query: string;
  loading: boolean;
  data: Partial<Record<GithubApp, GithubPickerView>>;
  /** Why the lists could not be read. */
  loadError: string | null;
  /** The repo id being sent on each App. A second change on that App waits (the core refuses it too). */
  sending: Partial<Record<GithubApp, number>>;
  /** `${app}:${repoId}` to the plain reason that box failed. */
  errors: Record<string, string>;
}
export const pickerKey = (app: GithubApp, id: number): string => `${app}:${id}`;

export interface GithubUiState {
  /** The picker, or null while the list is shown. */
  picker: PickerState | null;
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
  /** Repos whose turn on or off is being sent, and whether the agents switch is. Their switches wait. */
  ticking: string[];
  agentsSending: boolean;
  /** Where to remove the write app at GitHub, after the owner turned writes off. */
  writeRevokeUrl: string | null;
  /** Show the title-bar icon (Settings, GitHub). */
  iconShown: boolean;
  /** Screen-reader live text. */
  say: string;
}

const ICON_KEY = 'legion.github.icon';
const readIcon = (): boolean => { try { return localStorage.getItem(ICON_KEY) !== 'off'; } catch { return true; } };

let st: GithubUiState = { picker: null, open: false, view: null, loading: false, signingIn: false, flow: null, flowNote: null, writeFlow: null, why: null, orgs: [], orgsError: null, query: '', shown: PAGE, expanded: null, detail: {}, busy: null, ticking: [], agentsSending: false, writeRevokeUrl: null, iconShown: readIcon(), say: '' };
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
export function closeGithub(): void { set({ open: false, picker: null }); }
export function toggleGithub(): void { if (st.open) closeGithub(); else openGithub(); }

/* ---------- reading ---------- */
const toData = (v: GithubAreaView): GithubAreaData => ({ ...v, activity: activityFrom(v.activity, areaAgents()) });

/** Every request for the view takes a number; a reply older than one already applied is dropped. */
let reqSeq = 0;
let appliedSeq = 0;
/** What the owner just chose and the core has not confirmed yet: laid over any view that arrives meanwhile. */
const pendingTicks = new Map<string, boolean>();
let pendingAgents: boolean | null = null;

function applyView(v: GithubAreaData, seq: number): boolean {
  if (seq < appliedSeq) return false;
  appliedSeq = seq;
  const repos = pendingTicks.size ? v.repos.map((r) => (pendingTicks.has(normRepo(r.fullName)) ? { ...r, ticked: pendingTicks.get(normRepo(r.fullName))! } : r)) : v.repos;
  set({ view: { ...v, repos, ...(pendingAgents !== null ? { agentsEnabled: pendingAgents } : {}) }, loading: false });
  return true;
}

export async function loadArea(force = false): Promise<void> {
  const seq = ++reqSeq;
  if (!st.view) set({ loading: true });
  try {
    const v = toData(await api.githubArea(force));
    if (applyView(v, seq)) set({ why: null });
  } catch (e) {
    if (seq < appliedSeq) return;
    const why = whyText(e);
    // an older core without the routes: the build cannot sign in
    if (e instanceof ApiError && e.status === 404) set({ view: { ...(st.view ?? emptyView()), registered: { read: false, write: false } }, loading: false, why });
    // the core did not answer: the list stays, marked as the last one Legion had
    else if (e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504)) set({ view: st.view ? { ...st.view, problem: { kind: 'network' } } : null, loading: false, why });
    // any other failure keeps what the view already says (a sign-in that ended stays ended) and tells the plain reason
    else set({ loading: false, why });
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
/** Only the latest sign-in run may touch signingIn and flow: a Cancel then Connect must not be undone by the first run ending. */
let signInRun = 0;
let signInTimer: number | undefined;
const stopSignInPoll = (): void => { if (signInTimer !== undefined) { window.clearInterval(signInTimer); signInTimer = undefined; } };

const endSignIn = (run: number): void => {
  if (run !== signInRun) return;
  stopSignInPoll();
  set({ signingIn: false, flow: null, flowNote: null });
  void loadArea(true);
};

/** One look at the read sign-in. The code shows while the core's flow is pending; the wait ends only when the core says signed in, failed or stopped. */
async function pollFlow(run: number): Promise<void> {
  try {
    const s = await request<GithubStatusView>('GET', '/api/connectors/github');
    if (run !== signInRun) return;
    if (s.signedIn) { endSignIn(run); return; }
    if (s.flow.phase === 'pending') { set({ flow: { userCode: s.flow.userCode, verificationUri: s.flow.verificationUri }, flowNote: null }); return; }
    if (s.flow.phase === 'failed') toast(s.flow.message, 'error');
    endSignIn(run);
  } catch { if (run === signInRun) set({ flowNote: 'Legion cannot check the sign-in right now. It keeps trying.' }); }
}
/** Reads the sign-in state now (the poll also does this every 2 seconds while signing in). */
export const pollSignIn = (): Promise<void> => pollFlow(signInRun);

export async function connectRead(): Promise<void> {
  if (st.signingIn) return;
  const run = ++signInRun;
  set({ signingIn: true, flowNote: null });
  stopSignInPoll();
  try {
    const fn = (window as unknown as { legion?: { connectorConnect?: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }> } }).legion?.connectorConnect;
    if (!fn) throw new Error('Connecting needs the Legion app window. Open Legion from its shortcut.');
    // the app starts the flow on the core, opens github.com and returns at once: the code comes from the core, so keep reading it
    const r = await fn();
    if (!r.ok) { if (!r.cancelled) throw new Error(r.error ?? 'The connect failed.'); endSignIn(run); return; }
    if (run !== signInRun) return;
    signInTimer = window.setInterval(() => { void pollFlow(run); }, 2000);
    await pollFlow(run);
  } catch (e) { if (run === signInRun) { toast(whyText(e), 'error'); endSignIn(run); } }
}
export function cancelSignIn(): void {
  signInRun++;
  stopSignInPoll();
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
  // one sign-in at a time: not while one is being asked for, and not while its code is still open
  if (st.busy || st.writeFlow) return;
  set({ busy: 'write-app', writeRevokeUrl: null });
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
  try {
    const r = await api.githubDisconnectWrite();
    set({ writeRevokeUrl: typeof r?.revokeUrl === 'string' ? r.revokeUrl : null });
  } catch (e) { toast(whyText(e), 'error'); }
  await loadArea(true);
}

/** The core answers a change with the whole view; that view is shown as it is. Anything else is read again. */
function applyReply(r: unknown, seq: number): void {
  if (r && typeof r === 'object' && Array.isArray((r as GithubAreaView).repos)) applyView(toData(r as GithubAreaView), seq);
  else void loadArea(true);
}

export async function setAgentsEnabled(on: boolean): Promise<void> {
  if (st.agentsSending) return;
  const before = st.view?.agentsEnabled;
  pendingAgents = on;
  set({ agentsSending: true, ...(st.view ? { view: { ...st.view, agentsEnabled: on } } : {}) });
  const seq = ++reqSeq;
  try {
    const reply = await api.githubAgentsSwitch(on);
    pendingAgents = null;
    applyReply(reply, seq);
  } catch (e) {
    pendingAgents = null;
    toast(whyText(e), 'error');
    if (st.view && before !== undefined) set({ view: { ...st.view, agentsEnabled: before } });
  } finally { pendingAgents = null; set({ agentsSending: false }); }
}

export async function setTick(repo: string, on: boolean): Promise<void> {
  const key = normRepo(repo);
  if (pendingTicks.has(key)) return;
  const was = st.view?.repos.find((r) => normRepo(r.fullName) === key)?.ticked;
  pendingTicks.set(key, on);
  set({ ticking: [...st.ticking, repo], ...(st.view ? { view: { ...st.view, repos: st.view.repos.map((r) => (normRepo(r.fullName) === key ? { ...r, ticked: on } : r)) } } : {}) });
  const seq = ++reqSeq;
  try {
    const reply = await api.githubTick(repo, on);
    pendingTicks.delete(key);
    applyReply(reply, seq);
  } catch (e) {
    pendingTicks.delete(key);
    toast(whyText(e), 'error');
    // only this repo goes back; the rest of the list stays as it is
    if (st.view && was !== undefined) set({ view: { ...st.view, repos: st.view.repos.map((r) => (normRepo(r.fullName) === key ? { ...r, ticked: was } : r)) } });
  } finally { pendingTicks.delete(key); set({ ticking: st.ticking.filter((x) => x !== repo) }); }
}

/* ---------- choose repos ---------- */
let pickerSeq = 0;
let pickerTimer: number | undefined;
/** What the owner just chose and the core has not confirmed yet: laid over any list that arrives meanwhile. */
const pendingPicks = new Map<string, boolean>();
const setPicker = (p: Partial<PickerState>): void => { if (st.picker) set({ picker: { ...st.picker, ...p } }); };

const withPending = (app: GithubApp, v: GithubPickerView): GithubPickerView => {
  if (v.phase !== 'ready' || pendingPicks.size === 0) return v;
  return { ...v, rows: v.rows.map((r) => (pendingPicks.has(pickerKey(app, r.id)) ? { ...r, installed: pendingPicks.get(pickerKey(app, r.id))! } : r)) };
};

export function openPicker(): void {
  set({ picker: { query: '', loading: true, data: {}, loadError: null, sending: {}, errors: {} } });
  void loadPicker();
}
export function closePicker(): void {
  if (pickerTimer !== undefined) { window.clearTimeout(pickerTimer); pickerTimer = undefined; }
  pickerSeq++;
  set({ picker: null });
}
/** The search runs at the core; a short wait keeps one request per pause in typing. */
export function setPickerQuery(query: string): void {
  setPicker({ query });
  if (pickerTimer !== undefined) window.clearTimeout(pickerTimer);
  pickerTimer = window.setTimeout(() => { pickerTimer = undefined; void loadPicker(); }, 250);
}
export async function loadPicker(): Promise<void> {
  if (!st.picker) return;
  const seq = ++pickerSeq;
  const q = st.picker.query;
  const apps: GithubApp[] = st.view?.signedIn.write ? ['read', 'write'] : ['read'];
  setPicker({ loading: true });
  try {
    const got = await Promise.all(apps.map(async (a) => [a, parsePicker(await api.githubPicker(a, q))] as const));
    if (seq !== pickerSeq || !st.picker) return;
    const data: PickerState['data'] = {};
    for (const [a, v] of got) data[a] = withPending(a, v);
    setPicker({ data, loading: false, loadError: null });
  } catch (e) {
    if (seq !== pickerSeq || !st.picker) return;
    setPicker({ loading: false, loadError: whyText(e) });
  }
}

/** Tick or untick one repo on one App. It is sent at once; on a failure only that box goes back, with the reason under its row. */
export async function setPickerRepo(app: GithubApp, repoId: number, on: boolean): Promise<void> {
  const p = st.picker;
  const key = pickerKey(app, repoId);
  if (!p || p.sending[app] !== undefined) return;
  const mark = (installed: boolean): void => {
    const cur = st.picker?.data[app];
    if (cur?.phase === 'ready') setPicker({ data: { ...st.picker!.data, [app]: { ...cur, rows: cur.rows.map((r) => (r.id === repoId ? { ...r, installed } : r)) } } });
  };
  const { [key]: _gone, ...rest } = p.errors;
  pendingPicks.set(key, on);
  setPicker({ sending: { ...p.sending, [app]: repoId }, errors: rest });
  mark(on);
  try {
    await api.githubPickerSet(app, repoId, on);
    pendingPicks.delete(key);
    set({ say: on ? 'Repo added' : 'Repo removed' });
    void loadArea(true);
  } catch (e) {
    pendingPicks.delete(key);
    mark(!on);
    setPicker({ errors: { ...(st.picker?.errors ?? {}), [key]: whyText(e) } });
    // no answer or a server error: GitHub may still have made the change, so show what it really holds
    if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) void loadPicker();
  } finally {
    pendingPicks.delete(key);
    if (st.picker) { const { [app]: _s, ...left } = st.picker.sending; setPicker({ sending: left }); }
  }
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
    // the write sign-in is gone on the core's side: read the area again, so the form shows Turn on writes
    if (r.phase === 'needs-write') { await loadArea(true); return { ok: false, kind: 'sign-in', text: r.message }; }
    await loadArea(true);
    set({ expanded: r.fullName });
    void loadDetail(r.fullName);
    if (body.tick && !r.ticked) toast(`${r.fullName} was created. It could not be turned on here; turn it on in the list.`, 'error');
    return { ok: true, fullName: r.fullName };
  } catch (e) {
    return e instanceof ApiError ? fail(createFailureKind(e.status, e.message)) : { ok: false, kind: 'unsure', text: createFailureText('unsure') };
  } finally { if (st.busy === 'create') set({ busy: null }); }
}

/* ---------- CI and agents ---------- */
export async function rerunFailed(repo: string, runId: number): Promise<void> { await ci.rerunFailed(runId); await loadDetail(repo); }
export async function cancelRun(repo: string, runId: number): Promise<void> { await ci.cancelRun(runId); await loadDetail(repo); }
/** The CI panel watches a repo of its own. This points it at this one and opens it. */
export async function watchInCi(repo: string): Promise<void> {
  const err = await ci.saveRepo(repo);
  if (err) { toast(err, 'error'); return; }
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
/** The one way out to GitHub: only an address on https://github.com opens. Anything else says so and stays shut. */
export function openAtGithub(url: string): boolean {
  let fine = false;
  try { fine = new URL(url).origin === 'https://github.com'; } catch { fine = false; }
  if (!fine) { toast('Legion only opens links on github.com.', 'error'); return false; }
  openExternal(url);
  return true;
}
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
  window.addEventListener(OPEN_GITHUB_EVENT, (e) => { openGithub((e as CustomEvent<{ repo?: string }>).detail?.repo); });
}
