/**
 * UI store for the CI panel and its title-bar chip. Own small external store, same pattern as blenderStore.
 * Talks to the admin routes under /api/ci. The core cannot see this window, so the store tells it who is watching: a heartbeat every 30 s while
 * the window is visible ('panel' when the panel is open, else 'chip'). Changes arrive as `ci.updated` events (store.ts forwards them as the window
 * event `legion:ci`); nothing here polls GitHub and nothing runs while the window is hidden.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import { getState as getApp, openSettings, toast, errText } from '../store';
import type { CiJobsView, CiLogView, CiRunsView, CiStateView, CiUpdateSummary } from '../../../src/shared/ci';
import { CI_HEARTBEAT_MS } from '../../../src/shared/ci';

export interface CiUiState {
  loaded: boolean;
  /** The core has no CI routes (an older core). */
  absent: boolean;
  /** Cannot reach the core. */
  offline: boolean;
  state: CiStateView | null;
  runs: CiRunsView | null;
  /** The chip's numbers, from the last `ci.updated` or the last runs read. */
  summary: CiUpdateSummary | null;
  panelOpen: boolean;
  expanded: number | null;
  jobs: Record<number, CiJobsView>;
  logs: Record<number, CiLogView | 'loading'>;
  openLogs: Record<number, true>;
  busy: string | null;
  refreshing: boolean;
  /** Text for the screen-reader live region. */
  say: string;
}

let st: CiUiState = { loaded: false, absent: false, offline: false, state: null, runs: null, summary: null, panelOpen: false, expanded: null, jobs: {}, logs: {}, openLogs: {}, busy: null, refreshing: false, say: '' };
const listeners = new Set<() => void>();
const set = (p: Partial<CiUiState>) => { st = { ...st, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getCi = () => st;
export function useCi<T>(selector: (s: CiUiState) => T): T { return useSyncExternalStore(sub, () => selector(st)); }

const projectParam = (): string | undefined => { const p = getApp().projectFilter; return p && /^proj_[a-f0-9]{12}$/.test(p) ? p : undefined; };

/** Whether the title-bar chip shows: the core knows a repo and has a GitHub client. */
export const chipVisible = (s: CiUiState): boolean => !s.absent && !!s.state && s.state.available && !!s.state.repo;

export const describeCounts = (c: { success: number; failure: number; running: number } | undefined): string => {
  if (!c) return 'no runs';
  const parts: string[] = [];
  if (c.failure) parts.push(`${c.failure} failing`);
  if (c.running) parts.push(`${c.running} running`);
  if (c.success) parts.push(`${c.success} passing`);
  return parts.join(', ') || 'no runs';
};

function announce(prev: CiUpdateSummary | null, next: CiUpdateSummary): void {
  if (!prev || (prev.counts.failure === next.counts.failure && prev.counts.running === next.counts.running && prev.counts.success === next.counts.success)) return;
  set({ say: `CI${next.branch ? ` for ${next.branch}` : ''}: ${describeCounts(next.counts)}` });
}

function noteError(e: unknown): void {
  if (e instanceof ApiError && e.status === 404) { set({ absent: true, loaded: true }); return; }
  if (e instanceof ApiError && e.status === 0) { set({ offline: true, loaded: true }); return; }
  set({ loaded: true });
}

export async function loadState(): Promise<void> {
  try { set({ state: await request<CiStateView>('GET', '/api/ci/state'), loaded: true, offline: false, absent: false }); } catch (e) { noteError(e); }
}

export async function loadRuns(): Promise<void> {
  if (!st.state?.available) return;
  try {
    const runs = await request<CiRunsView>('GET', '/api/ci/runs');
    const summary: CiUpdateSummary = { repo: st.state.repo ? `${st.state.repo.owner}/${st.state.repo.name}` : null, branch: st.state.branch, counts: runs.counts, running: runs.runs.some((r) => r.status !== 'completed'), problem: runs.problem, rev: st.summary?.rev ?? 0 };
    set({ runs, offline: false, summary: st.summary && st.summary.rev >= summary.rev && st.summary.repo === summary.repo ? st.summary : summary });
  } catch (e) { noteError(e); }
}

export async function loadJobs(runId: number): Promise<void> {
  try { const jobs = await request<CiJobsView>('GET', `/api/ci/runs/${runId}/jobs`); set({ jobs: { ...st.jobs, [runId]: jobs } }); } catch (e) { noteError(e); }
}

/** Reload everything the panel shows (the core answers from its cache, so this costs no GitHub request by itself). */
async function reloadView(): Promise<void> {
  await loadState();
  await loadRuns();
  if (st.expanded !== null) await loadJobs(st.expanded);
}

/** Asks the core to fetch now (it decides whether the budget allows). Open, focus and the Refresh button come through here. */
export async function refreshCi(reason: 'open' | 'focus' | 'manual' = 'manual'): Promise<void> {
  if (!st.state?.available || st.refreshing) return;
  set({ refreshing: true });
  try { await request('POST', '/api/ci/refresh', { reason }); await reloadView(); } catch (e) { noteError(e); } finally { set({ refreshing: false }); }
}

export function openCi(): void {
  if (st.panelOpen) return;
  set({ panelOpen: true });
  void heartbeat();
  void refreshCi('open');
}
export function closeCi(): void { set({ panelOpen: false }); void heartbeat(); }
export function toggleCi(): void { if (st.panelOpen) closeCi(); else openCi(); }

export function toggleRun(id: number): void {
  if (st.expanded === id) { set({ expanded: null }); return; }
  set({ expanded: id });
  void loadJobs(id);
}

export async function toggleLog(jobId: number): Promise<void> {
  if (st.openLogs[jobId]) { const { [jobId]: _gone, ...rest } = st.openLogs; set({ openLogs: rest }); return; }
  set({ openLogs: { ...st.openLogs, [jobId]: true } });
  const have = st.logs[jobId];
  if (have && have !== 'loading' && have.available) return; // an unavailable answer is asked again next time
  set({ logs: { ...st.logs, [jobId]: 'loading' } });
  try { const log = await request<CiLogView>('GET', `/api/ci/jobs/${jobId}/log`); set({ logs: { ...st.logs, [jobId]: log } }); }
  catch (e) { set({ logs: { ...st.logs, [jobId]: { available: false, reason: 'problem' } } }); noteError(e); }
}

async function write(kind: 'rerun-failed' | 'cancel', runId: number, done: string): Promise<void> {
  if (st.busy) return;
  set({ busy: `${kind}:${runId}` });
  try { await request('POST', `/api/ci/runs/${runId}/${kind}`); toast(done); await reloadView(); }
  catch (e) { toast(errText(e), 'error'); }
  finally { set({ busy: null }); }
}
export const rerunFailed = (runId: number): Promise<void> => write('rerun-failed', runId, 'Re-running the failed jobs');
export const cancelRun = (runId: number): Promise<void> => write('cancel', runId, 'Cancel requested');

export async function saveRepo(text: string): Promise<string | null> {
  try { set({ state: await request<CiStateView>('PUT', '/api/ci/repo', { repo: text.trim() || null }) }); await loadRuns(); return null; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
}

export function connectGithub(): void { closeCi(); openSettings('connections'); }

/* ---------- watching ---------- */
async function heartbeat(): Promise<void> {
  if (document.hidden || st.absent || (st.state && !st.state.available)) return;
  try {
    await request('POST', '/api/ci/watch', { mode: st.panelOpen ? 'panel' : 'chip', ...(projectParam() ? { projectId: projectParam() } : {}) });
    if (st.offline) set({ offline: false });
  } catch (e) { noteError(e); }
}

let started = false;
export function initCi(): void {
  if (started) return;
  started = true;
  void loadState().then(async () => { await heartbeat(); await reloadView(); });
  window.addEventListener('legion:ci', (e) => {
    const s = (e as CustomEvent<CiUpdateSummary>).detail;
    if (!s || typeof s !== 'object') return;
    announce(st.summary, s);
    set({ summary: s });
    void reloadView();
  });
  window.setInterval(() => { if (!document.hidden) void heartbeat(); }, CI_HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void heartbeat(); if (st.panelOpen) void refreshCi('focus'); } });
  window.addEventListener('focus', () => { if (st.panelOpen) void refreshCi('focus'); });
}

/** The project filter changed: the repo may be another one. */
export function ciProjectChanged(): void { void heartbeat().then(() => reloadView()); }
