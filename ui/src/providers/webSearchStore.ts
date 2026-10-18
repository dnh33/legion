/**
 * UI store for Settings, Web search. Same small external-store pattern as providersStore. Talks to /api/settings/web-search (admin routes).
 * A provider key, a private-network SearXNG address and a higher spending cap go through the Electron main process (window.legion.webSearchChange): it shows a native
 * confirmation and holds the secret the core demands for those changes. The key leaves this file only through that call.
 * The one-time provider notice is learned from the core (POST .../check) before anything is sent, then the change is sent again with the acknowledgement.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import type { WebProviderId } from '../../../src/shared/web-search-config';
import { ENABLE_LABEL } from '../../../src/shared/web-search-copy';
import type { WebJob, WebSearchView } from './webSearchModel';

interface Check { ok: boolean; error?: string; needsNotice?: WebProviderId; notice?: string; needsNative?: boolean }
/** A change that waits for the owner to read the provider notice and click "Use <name>". */
export interface PendingNotice { id: WebProviderId; name: string; notice: string; enableLabel: string; body: Record<string, unknown>; needsNative: boolean }
export interface TestResult { id: string; ok: boolean; detail: string }

export interface WebSearchUiState {
  view: WebSearchView | null; loaded: boolean; loadError: string | null; busy: string | null; error: string | null;
  notes: Record<string, string>; pending: PendingNotice | null; test: TestResult | null;
}
let state: WebSearchUiState = { view: null, loaded: false, loadError: null, busy: null, error: null, notes: {}, pending: null, test: null };
const listeners = new Set<() => void>();
const set = (p: Partial<WebSearchUiState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getWebSearch = () => state;
export function useWebSearch<T>(selector: (s: WebSearchUiState) => T): T { return useSyncExternalStore(sub, () => selector(state), () => selector(state)); }
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const BASE = '/api/settings/web-search';

export async function loadWebSearch(): Promise<void> {
  try { set({ view: await request<WebSearchView>('GET', BASE), loaded: true, loadError: null }); }
  // an older core without the route (404): the section stays hidden; any other failure says so
  catch (e) { set({ loaded: true, loadError: e instanceof ApiError && e.status === 404 ? null : `Web search settings did not load: ${msg(e)}` }); }
}

async function act(id: string, fn: () => Promise<WebSearchView | void>): Promise<boolean> {
  if (state.busy) return false;
  set({ busy: id, error: null });
  try { const v = await fn(); if (v) set({ view: v }); return true; } catch (e) { set({ error: msg(e) }); return false; } finally { set({ busy: null }); }
}
const setNote = (id: string, text: string) => set({ notes: { ...state.notes, [id]: text } });
/** What a sent change did, in words: every action shows a result. */
const doneNote = (body: Record<string, unknown>): string =>
  body.searxng === null ? 'Address removed.' : body.searxng !== undefined ? 'Address saved.' : body.tregMaxCostUsd !== undefined ? 'Cap saved.' : 'Saved.';
async function sendAndNote(body: Record<string, unknown>, needsNative: boolean, id: string): Promise<WebSearchView | void> {
  const v = await send(body, needsNative, id);
  if (v) setNote(id, doneNote(body));
  return v;
}

/** Sends a change the core has already accepted a check for. A private SearXNG address goes through the app's native confirmation. */
async function send(body: Record<string, unknown>, needsNative: boolean, id: string): Promise<WebSearchView | void> {
  const sx = body.searxng as { baseUrl?: string } | null | undefined;
  if (needsNative && sx && typeof sx.baseUrl === 'string') {
    const bridge = window.legion?.webSearchChange;
    if (!bridge) throw new Error('A private-network address needs the Legion app window (it shows a confirmation). Open the app to do this.');
    const r = await bridge({ kind: 'address', baseUrl: sx.baseUrl, ...(body.acknowledge === 'searxng' ? { acknowledge: 'searxng' } : {}) });
    if (r.cancelled) { setNote(id, 'Cancelled. Nothing changed.'); return; }
    if (!r.ok) throw new Error(r.error ?? 'The change failed.');
    return request<WebSearchView>('GET', BASE);
  }
  // A higher spending cap also goes through the app's native confirmation; a lower one goes straight to the core.
  if (needsNative && typeof body.tregMaxCostUsd === 'number') {
    const bridge = window.legion?.webSearchChange;
    if (!bridge) throw new Error('Raising the cap needs the Legion app window (it shows a confirmation). Open the app to do this.');
    const r = await bridge({ kind: 'cap', usd: body.tregMaxCostUsd });
    if (r.cancelled) { setNote(id, 'Cancelled. Nothing changed.'); return; }
    if (!r.ok) throw new Error(r.error ?? 'The change failed.');
    return request<WebSearchView>('GET', BASE);
  }
  return request<WebSearchView>('PATCH', BASE, body);
}

/** Checks a change with the core, shows the notice first when one is due, and only then sends it. */
function change(id: string, body: Record<string, unknown>): Promise<boolean> {
  return act(id, async () => {
    const chk = await request<Check>('POST', `${BASE}/check`, body);
    if (!chk.ok) throw new Error(chk.error ?? 'That change was not understood.');
    if (chk.needsNotice && chk.notice) {
      const name = state.view?.providers.find((p) => p.id === chk.needsNotice)?.label ?? chk.needsNotice;
      set({ pending: { id: chk.needsNotice, name, notice: chk.notice, enableLabel: ENABLE_LABEL(name), body, needsNative: chk.needsNative === true } });
      return;
    }
    set({ pending: null });
    return sendAndNote(body, chk.needsNative === true, id);
  });
}

// a test result belongs to the provider it ran on: a new pick or key clears it
export const chooseProvider = (job: WebJob, value: string): Promise<boolean> => { set({ pending: null, test: null }); return change(job, { [job]: value }); };
export const saveCap = (usd: number): Promise<boolean> => change('cap', { tregMaxCostUsd: usd });
export const saveAddress = (baseUrl: string): Promise<boolean> => change('searxng', { searxng: { baseUrl } });
export const clearAddress = (): Promise<boolean> => change('searxng', { searxng: null });
export const dismissNotice = (): void => set({ pending: null });

/** The "Use <name>" click: the same change again, now with the acknowledgement. */
export function acceptNotice(): Promise<boolean> {
  const p = state.pending;
  if (!p) return Promise.resolve(false);
  return act(p.id, async () => {
    set({ pending: null });
    // the note goes with the select or address that changed, not under the provider's key row
    const noteId = p.body.search !== undefined ? 'search' : p.body.read !== undefined ? 'read' : p.body.searxng !== undefined ? 'searxng' : p.id;
    return sendAndNote({ ...p.body, acknowledge: p.id }, p.needsNative, noteId);
  });
}

export function saveKey(provider: WebProviderId, key: string): Promise<boolean> {
  set({ test: null });
  return act(provider, async () => {
    const bridge = window.legion?.webSearchChange;
    if (!bridge) throw new Error('Saving a key needs the Legion app window (it shows a confirmation). Open the app to do this.');
    const r = await bridge({ kind: 'key', provider, key });
    if (r.cancelled) { setNote(provider, 'Cancelled. No key was saved.'); return; }
    if (!r.ok) throw new Error(r.error ?? 'The key was not saved.');
    setNote(provider, 'Key saved.');
    return request<WebSearchView>('GET', BASE);
  });
}
export const removeKey = (provider: WebProviderId): Promise<boolean> => act(provider, async () => { const v = await request<WebSearchView>('POST', `${BASE}/key`, { provider, key: null }); setNote(provider, 'Key removed.'); return v; });

export function runTest(provider?: WebProviderId): Promise<boolean> {
  return act('test', async () => {
    const r = await request<{ ok: boolean; detail: string }>('POST', `${BASE}/test`, provider ? { provider } : {});
    set({ test: { id: provider ?? 'picked', ok: r.ok, detail: r.detail } });
  });
}
