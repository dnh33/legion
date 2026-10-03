/**
 * UI store for the Blender Bridge. Own small external store, same pattern as bsvStore.
 * Talks to GET /api/blender and POST /api/blender/{config,setup,test,launch} (admin routes: the UI holds the admin key).
 * Status also arrives as `blender.status` events (store.ts forwards them as a window event). Nothing here animates and nothing polls
 * while the bridge is off or the window is hidden.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import type { BlenderBackendKind, BlenderMode, BlenderSetupResult, BlenderSetupStep, BlenderStatusView, BlenderTestResult } from '../../../src/shared/blender';

export type BlenderBusy = 'config' | 'setup' | 'test' | 'launch' | 'get' | null;
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
  /** The last GET /api/blender failed (offline, or an older core). `absent`: the core answered 404, so it has no Blender module. */
  failed: boolean;
  absent: boolean;
  /** The "Turn on Blender?" dialog is open. */
  confirmOpen: boolean;
}

let state: BlenderUiState = { status: null, loaded: false, busy: null, steps: [], stepsTitle: '', error: null, retrust: null, failed: false, absent: false, confirmOpen: false };
const listeners = new Set<() => void>();
const set = (p: Partial<BlenderUiState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getBlender = () => state;
export function useBlender<T>(selector: (s: BlenderUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export const BLENDER_POLL_MS = 30_000;

export function setBlenderStatus(status: BlenderStatusView): void { set({ status, loaded: true, failed: false, absent: false }); }

export async function loadBlender(refresh = false): Promise<void> {
  try { set({ status: await request<BlenderStatusView>('GET', `/api/blender${refresh ? '?refresh=1' : ''}`), loaded: true, failed: false, absent: false }); } catch (e) { /* an older core without the route, or offline: the card stays hidden; the title-bar chip reads these two flags */ set({ failed: true, absent: e instanceof ApiError && e.status === 404 }); }
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
    set({ status: r.status, steps: r.steps, loaded: true, failed: false, absent: false, retrust: (r as { retrustRequired?: BlenderBackendKind }).retrustRequired ?? null });
    return r;
  } catch (e) { set({ error: msg(e) }); return null; } finally { set({ busy: null }); }
}

export async function saveBlenderConfig(patch: { both?: boolean; assets?: { polyhaven?: boolean }; enabled?: boolean; backend?: 'auto' | 'official' | 'community'; mode?: BlenderMode; sandbox?: 'off' | 'vm' | 'auto'; port?: number; installPath?: string | null }): Promise<void> {
  if (state.busy) return;
  set({ busy: 'config', error: null });
  try { set({ status: await request<BlenderStatusView>('POST', '/api/blender/config', patch), loaded: true, failed: false, absent: false }); } catch (e) { set({ error: msg(e) }); } finally { set({ busy: null }); }
}
export const runBlenderSetup = (target: 'live' | 'sandbox' | 'both' = 'both', retrust = false) => act('setup', retrust ? 'Set up (new download trusted)' : 'Set up', () => request<BlenderSetupResult>('POST', '/api/blender/setup', { target, ...(retrust ? { retrust: true } : {}) }));
export const runBlenderTest = () => act('test', 'Connection test', () => request<BlenderTestResult>('POST', '/api/blender/test', {}));
/** Asks the core to fetch the pinned managed Blender: it raises an approval card first (answered with Allow or Deny), and downloads only after Allow. */
export const runBlenderGet = () => act('get', 'Get Blender for Legion', () => request<{ ok: boolean; steps: BlenderSetupStep[]; status: BlenderStatusView }>('POST', '/api/blender/get', {}));
export const runBlenderLaunch = () => act('launch', 'Launch', () => request<{ ok: boolean; steps: BlenderSetupStep[]; status: BlenderStatusView }>('POST', '/api/blender/launch', {}));

export { lightLabel } from './chipModel';

/**
 * The one way to turn Blender ON from the UI (title-bar chip and Settings both call it): it opens the "Turn on Blender?" dialog and writes nothing.
 * Only confirmEnableBlender writes, through saveBlenderConfig. Turning OFF needs no dialog: callers use saveBlenderConfig({ enabled: false }).
 */
export function requestEnableBlender(): void {
  if (state.busy || state.status?.enabled) return;
  set({ confirmOpen: true });
}
export function cancelEnableBlender(): void { set({ confirmOpen: false }); }
export function confirmEnableBlender(): void {
  if (!state.confirmOpen) return;
  set({ confirmOpen: false });
  void saveBlenderConfig({ enabled: true });
}
