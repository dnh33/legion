/**
 * UI store for Settings, Providers. Own small external store, same pattern as blenderStore. Talks to GET/PUT/DELETE/POST /api/providers/*
 * (admin routes: this window holds the admin key). A key or an address change goes through the Electron main process
 * (window.legion.providerChange), which shows a native confirmation and holds the secret the core demands for those changes;
 * the key leaves this file only through that call and is dropped from the form right after.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import type { ProviderView, ProvidersView } from '../../../src/shared/providers-view';

export interface ProvidersUiState { view: ProvidersView | null; loaded: boolean; busy: string | null; error: string | null; notes: Record<string, string>; /** The picker's background model refresh is in flight. */ refreshing: boolean }
let state: ProvidersUiState = { view: null, loaded: false, busy: null, error: null, notes: {}, refreshing: false };
const listeners = new Set<() => void>();
const set = (p: Partial<ProvidersUiState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getProviders = () => state;
export function useProviders<T>(selector: (s: ProvidersUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export async function loadProviders(): Promise<void> {
  try { set({ view: await request<ProvidersView>('GET', '/api/providers'), loaded: true }); } catch { set({ loaded: true }); /* an older core without the route: no provider groups are shown */ }
}

async function act(id: string, fn: () => Promise<ProvidersView | void>): Promise<boolean> {
  if (state.busy) return false;
  set({ busy: id, error: null });
  try { const v = await fn(); if (v) set({ view: v }); return true; } catch (e) { set({ error: msg(e) }); return false; } finally { set({ busy: null }); }
}
const setNote = (id: string, text: string) => set({ notes: { ...state.notes, [id]: text } });

/** Changes that never move a key or data somewhere new need only the admin key, so they go straight to the core. */
export const needsConfirmation = (patch: Record<string, unknown>): boolean => 'baseUrl' in patch || patch.allowPrivateNetwork === true || patch.keyless === true;

export function saveEntry(id: string, patch: Record<string, unknown>): Promise<boolean> {
  return act(id, async () => {
    if (!needsConfirmation(patch)) return request<ProvidersView>('PUT', `/api/providers/${id}`, patch);
    const bridge = window.legion?.providerChange;
    if (!bridge) throw new Error('Changing an address needs the Legion app window (it shows a confirmation). Open the app to do this.');
    const r = await bridge({ kind: 'entry', id, patch });
    if (r.cancelled) { setNote(id, 'Cancelled. Nothing changed.'); return; }
    if (!r.ok) throw new Error(r.error ?? 'The change failed.');
    await loadProviders();
  });
}

export function saveKey(id: string, key: string): Promise<boolean> {
  return act(id, async () => {
    const bridge = window.legion?.providerChange;
    if (!bridge) throw new Error('Saving a key needs the Legion app window (it shows a confirmation). Open the app to do this.');
    const r = await bridge({ kind: 'key', id, key });
    if (r.cancelled) { setNote(id, 'Cancelled. No key was saved.'); return; }
    if (!r.ok) throw new Error(r.error ?? 'The key was not saved.');
    setNote(id, 'Key saved.');
    await loadProviders();
  });
}

/** The key store did not unlock: set the unreadable key files aside and start with new keys. Main shows the confirmation and restarts the core. */
export function startOverKeys(): Promise<boolean> {
  return act('keys', async () => {
    const bridge = window.legion?.providerChange;
    if (!bridge) throw new Error('Starting over needs the Legion app window (it shows a confirmation). Open the app to do this.');
    const r = await bridge({ kind: 'start-over' });
    if (r.cancelled) { setNote('keys', 'Cancelled. Nothing changed.'); return; }
    if (!r.ok) throw new Error(r.error ?? 'Could not start over.');
    setNote('keys', 'Started over. Paste your keys again.');
    await loadProviders();
  });
}

export const removeKey = (id: string) => act(id, async () => { const v = await request<ProvidersView>('DELETE', `/api/providers/${id}/key`); setNote(id, 'Key removed.'); return v; });
export const removeProvider = (id: string) => act(id, () => request<ProvidersView>('DELETE', `/api/providers/${id}`));
export const saveLimits = (maxTurns: number, maxToolCallsPerTurn: number) => act('limits', () => request<ProvidersView>('PUT', '/api/providers/limits', { maxTurns, maxToolCallsPerTurn }));
export const testProvider = (id: string) => act(id, async () => { await request('POST', `/api/providers/${id}/test`); await loadProviders(); });
export const refreshModels = (id: string) => act(id, async () => { await request('POST', `/api/providers/${id}/models`); await loadProviders(); });
/** The picker's Retry for one provider: the loading state shows while the refresh runs, then the new result. */
export async function retryModels(id: string): Promise<void> {
  set({ refreshing: true });
  try { await refreshModels(id); } finally { set({ refreshing: false }); }
}
/**
 * The picker's daily refresh: fetches only the lists that are missing or a day old, and answers with the view. Never fails the picker,
 * and it does not set `busy`: the fetch can take a while, and Settings actions must stay open while it runs.
 */
export async function refreshStaleModels(): Promise<void> {
  // The loading line shows only when a list will really be fetched, not on every open.
  set({ refreshing: modelsStale(state.view) });
  try { set({ view: await request<ProvidersView>('POST', '/api/providers/auto-models') }); } catch { /* the saved lists stay; a failure shows as the provider's last error */ } finally { set({ refreshing: false }); }
}

/** The model values the pickers offer for providers that are switched on: `<provider>:<model>`. */
export function providerModelGroups(v: ProvidersView | null): Array<{ id: string; label: string; models: string[] }> {
  return (v?.providers ?? []).filter((p) => p.enabled && p.models.length > 0).map((p) => ({ id: p.id, label: p.label, models: p.models }));
}
/** "OpenAI · gpt-x" for a provider model value, or undefined for a Claude one. */
export function providerModelLabel(value: string | undefined, v: ProvidersView | null = state.view): string | undefined {
  const m = /^([a-z][a-z0-9-]{1,31}):(.+)$/.exec(value ?? '');
  if (!m || m[1] === 'arn') return undefined;
  const p: ProviderView | undefined = v?.providers.find((x) => x.id === m[1]);
  return p ? `${p.label} · ${m[2]}` : undefined;
}
/** Whether the picker's daily refresh has anything to fetch: an on provider with a key (or keyless) whose list is missing or a day old (the core's MODELS_TTL_MS). */
export function modelsStale(v: ProvidersView | null, now: number = Date.now()): boolean {
  return (v?.providers ?? []).some((p) => p.enabled && (p.keySet || p.keyless)
    && (!p.modelsFetchedAt || now - Date.parse(p.modelsFetchedAt) >= 24 * 60 * 60 * 1000));
}
