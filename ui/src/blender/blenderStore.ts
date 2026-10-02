/**
 * UI store for the Blender Bridge. Own small external store, same pattern as bsvStore.
 * Talks to GET /api/blender and POST /api/blender/{config,setup,test,launch} (admin routes: the UI holds the admin key).
 * Status also arrives as `blender.status` events (store.ts forwards them as a window event). Nothing here animates and nothing polls
 * while the bridge is off or the window is hidden.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import type { BlenderBackendKind, BlenderMode, BlenderSetupResult, BlenderSetupStep, BlenderStatusView, BlenderTestResult } from '../../../src/shared/blender';

export type BlenderBusy = 'config' | 'setup' | 'test' | 'launch' | null;
export interface BlenderUiState {
  status: BlenderStatusView | null;
  loaded: boolean;
  busy: BlenderBusy;
  /** Steps of the last Set up / Test / Launch, shown under the buttons. */
  steps: BlenderSetupStep[];
  stepsTitle: string;
  error: string | null;
  /** Set when Set up found a download that differs from the one trusted before: the UI offers "Trust the new download". */
  retrust: BlenderBackendKind | null;
}

let state: BlenderUiState = { status: null, loaded: false, busy: null, steps: [], stepsTitle: '', error: null, retrust: null };
const listeners = new Set<() => void>();
const set = (p: Partial<BlenderUiState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getBlender = () => state;
export function useBlender<T>(selector: (s: BlenderUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export const BLENDER_POLL_MS = 30_000;

export function setBlenderStatus(status: BlenderStatusView): void { set({ status, loaded: true }); }

export async function loadBlender(refresh = false): Promise<void> {
  try { set({ status: await request<BlenderStatusView>('GET', `/api/blender${refresh ? '?refresh=1' : ''}`), loaded: true }); } catch { /* an older core without the route, or offline: the card stays hidden */ }
}

let started = false;
export function initBlender(): void {
  if (started) return;
  started = true;
  void loadBlender();
  window.addEventListener('legion:blender', (e) => { const s = (e as CustomEvent<BlenderStatusView>).detail; if (s && typeof s === 'object') setBlenderStatus(s); });
  window.setInterval(() => { if (!document.hidden && state.status?.enabled) void loadBlender(); }, BLENDER_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.status?.enabled) void loadBlender(); });
}

async function act<T extends { status: BlenderStatusView; steps: BlenderSetupStep[]; ok: boolean }>(busy: Exclude<BlenderBusy, null>, title: string, fn: () => Promise<T>): Promise<T | null> {
  if (state.busy) return null;
  set({ busy, error: null, steps: [], stepsTitle: title, retrust: null });
  try {
    const r = await fn();
    set({ status: r.status, steps: r.steps, loaded: true, retrust: (r as { retrustRequired?: BlenderBackendKind }).retrustRequired ?? null });
    return r;
  } catch (e) { set({ error: msg(e) }); return null; } finally { set({ busy: null }); }
}

export async function saveBlenderConfig(patch: { enabled?: boolean; backend?: 'auto' | 'official' | 'community'; mode?: BlenderMode; sandbox?: 'off' | 'vm' | 'auto'; port?: number; installPath?: string | null }): Promise<void> {
  if (state.busy) return;
  set({ busy: 'config', error: null });
  try { set({ status: await request<BlenderStatusView>('POST', '/api/blender/config', patch), loaded: true }); } catch (e) { set({ error: msg(e) }); } finally { set({ busy: null }); }
}
export const runBlenderSetup = (target: 'live' | 'sandbox' | 'both' = 'both', retrust = false) => act('setup', retrust ? 'Set up (new download trusted)' : 'Set up', () => request<BlenderSetupResult>('POST', '/api/blender/setup', { target, ...(retrust ? { retrust: true } : {}) }));
export const runBlenderTest = () => act('test', 'Connection test', () => request<BlenderTestResult>('POST', '/api/blender/test', {}));
export const runBlenderLaunch = () => act('launch', 'Launch', () => request<{ ok: boolean; steps: BlenderSetupStep[]; status: BlenderStatusView }>('POST', '/api/blender/launch', {}));

/** Label and tone for the status light (shared by the Ops card and Settings so they always say the same). */
export function lightLabel(l: BlenderStatusView['light']): { label: string; tone: 'on' | 'bad' | 'off' | 'warn' } {
  switch (l) {
    case 'connected': return { label: 'Connected', tone: 'on' };
    case 'sandbox': return { label: 'VM ready', tone: 'on' };
    case 'local': return { label: 'Local ready', tone: 'on' };
    case 'busy': return { label: 'Running a script', tone: 'warn' };
    case 'disconnected': return { label: 'Not listening', tone: 'warn' };
    case 'needs-setup': return { label: 'Needs setup', tone: 'warn' };
    case 'not-found': return { label: 'Not found', tone: 'bad' };
    case 'error': return { label: 'Problem', tone: 'bad' };
    default: return { label: 'Off', tone: 'off' };
  }
}
