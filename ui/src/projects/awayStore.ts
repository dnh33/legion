/** The project page's away data (a small external store, like projectsStore): per-project settings, when each project was last looked at, spend. All of it is the core's copy; nothing here decides authority. */
import { useSyncExternalStore } from 'react';
import { api, ApiError } from '../api';
import type { AwayProject, AwayView, ProjectSpend } from '../api';
import { tapEvents, toast } from '../store';

export interface AwayState { loaded: boolean; view: AwayView | null; spend: Record<string, ProjectSpend | undefined> }
let state: AwayState = { loaded: false, view: null, spend: {} };
const subs = new Set<() => void>();
const set = (p: Partial<AwayState> | ((s: AwayState) => Partial<AwayState>)): void => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; subs.forEach((f) => f()); };
export const getAway = (): AwayState => state;
export function useAway<T>(sel: (s: AwayState) => T): T { return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => sel(state)); }
const errText = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export const DEFAULT_AWAY: AwayProject = { onSilence: { mode: 'deny', parkMinutes: 3 }, paused: false, budget: null, notify: 'problems' };
export const projectAway = (s: AwayState, id: string): AwayProject => s.view?.projects[id] ?? DEFAULT_AWAY;

export async function loadAway(): Promise<void> {
  try { const view = await api.away(); set({ view, loaded: true }); } catch { set({ loaded: true }); /* no admin access: defaults */ }
}

/** The spend of one project; `since` is the digest window start (ISO), so "$6.10 spent" comes from the ledger. */
const lastSince = new Map<string, string | undefined>();
export async function loadSpend(projectId: string, since?: string): Promise<void> {
  lastSince.set(projectId, since);
  try { const spend = await api.projectSpend(projectId, since); set((s) => ({ spend: { ...s.spend, [projectId]: spend } })); } catch { /* the page shows what it has */ }
}

/** Explicit only: the digest window moves when the owner says so (spec 4.2). */
export async function markSeen(projectId: string): Promise<boolean> {
  try {
    const { looked } = await api.markSeen(projectId);
    set((s) => s.view ? { view: { ...s.view, looked: { ...s.view.looked, [projectId]: looked } } } : {});
    void loadSpend(projectId, looked);
    return true;
  } catch (e) { toast(errText(e), 'error'); return false; }
}

export async function patchAway(projectId: string, patch: Record<string, unknown>): Promise<boolean> {
  try { await api.patchAwayProject(projectId, patch); await loadAway(); void loadSpend(projectId, lastSince.get(projectId)); return true; } catch (e) { toast(errText(e), 'error'); return false; }
}
export const setPaused = (projectId: string, paused: boolean): Promise<boolean> => patchAway(projectId, { paused });
export async function runAnyway(projectId: string): Promise<boolean> {
  try { await api.budgetOverride(projectId); await loadAway(); void loadSpend(projectId, lastSince.get(projectId)); return true; } catch (e) { toast(errText(e), 'error'); return false; }
}

let started = false;
/** Keeps the copy current: the core says when settings change, a budget is reached, or a run finishes (spend moved). */
export function initAway(): void {
  if (started) return;
  started = true;
  void loadAway();
  let timer: number | undefined;
  const soon = (ids: string[]): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { for (const id of ids) if (lastSince.has(id)) void loadSpend(id, lastSince.get(id)); }, 1500);
  };
  tapEvents((e) => {
    if (e.type === 'away.updated') void loadAway();
    else if (e.type === 'budget.reached') { void loadAway(); soon([e.projectId]); }
    else if (e.type === 'task.updated' && e.task.projectId && (e.task.status === 'done' || e.task.status === 'error')) soon([e.task.projectId]);
  });
}
