/**
 * Store for BSV mode v0 (knowledge and visibility only; there is no wallet in this app).
 * Own tiny external store, same pattern as the main store. Talks to GET/POST /api/bsv.
 * The frozen event union has no "BSV changed" event, so after every toggle the UI refetches /api/state
 * (the server hides the Assayer while off) and re-reads /api/bsv every 30 s to follow changes made elsewhere.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import { getState, refresh, selectAgent, toast } from '../store';

export interface BsvStatus {
  enabled: boolean;
  network: 'testnet';
  assayerAvailable: boolean;
  knowledgeLoaded: boolean;
  knowledgeNodes: number;
}
interface SeedResult { status: 'loaded' | 'already-loaded' | 'no-kg' | 'error'; nodes?: number; error?: string }

export interface BsvUiState extends BsvStatus {
  /** First /api/bsv answer has arrived. */
  loaded: boolean;
  /** A toggle request is in flight. */
  busy: boolean;
  /** The first-enable confirmation dialog is open. */
  confirmOpen: boolean;
}

export const BSV_TIP = 'BSV Dev Kit: testnet, knowledge only. No wallet.';
const CONFIRMED_KEY = 'legion.bsv.confirmed';
const POLL_MS = 30_000;

let state: BsvUiState = {
  loaded: false, busy: false, confirmOpen: false,
  enabled: false, network: 'testnet', assayerAvailable: false, knowledgeLoaded: false, knowledgeNodes: 0,
};
const listeners = new Set<() => void>();
const set = (p: Partial<BsvUiState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getBsv = () => state;
export function useBsv<T>(selector: (s: BsvUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore: the dialog just shows again */ } }
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Re-reads /api/state (agent list) and keeps the selection coherent if the selected agent vanished or appeared. */
export async function syncAgents(): Promise<void> {
  const before = getState().selectedAgentId;
  await refresh();
  const after = getState().selectedAgentId;
  if (after !== before) selectAgent(after);
}

const pick = (s: BsvStatus): BsvStatus => ({
  enabled: s.enabled, network: 'testnet', assayerAvailable: s.assayerAvailable, knowledgeLoaded: s.knowledgeLoaded, knowledgeNodes: s.knowledgeNodes ?? 0,
});

export async function loadBsv(): Promise<void> {
  try {
    const s = await request<BsvStatus>('GET', '/api/bsv');
    const changedElsewhere = state.loaded && s.enabled !== state.enabled && !state.busy;
    set({ ...pick(s), loaded: true });
    if (changedElsewhere) await syncAgents();
  } catch { /* offline or an older core without /api/bsv: stay off, the main connection chip already says so */ }
}

let started = false;
export function initBsv(): void {
  if (started) return;
  started = true;
  void loadBsv();
  window.setInterval(() => { if (!document.hidden) void loadBsv(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadBsv(); });
}

export async function setBsv(enabled: boolean): Promise<void> {
  if (state.busy) return;
  set({ busy: true, confirmOpen: false });
  try {
    const r = await request<BsvStatus & { seed?: SeedResult }>('POST', '/api/bsv', { enabled });
    set({ ...pick(r), loaded: true });
    await syncAgents();
    if (enabled && r.seed?.status === 'error') toast(`BSV mode is on, but the knowledge pack did not load: ${r.seed.error ?? 'unknown error'}`, 'error');
    else toast(enabled ? 'BSV mode on (testnet, knowledge only)' : 'BSV mode off');
  } catch (e) {
    toast(`Could not change BSV mode: ${msg(e)}`, 'error');
    await loadBsv();
  } finally {
    set({ busy: false });
  }
}

/** The title-bar switch. Turning on the first time asks first; turning off is immediate. */
export function requestToggle(): void {
  if (state.busy) return;
  if (state.enabled) { void setBsv(false); return; }
  if (lsGet(CONFIRMED_KEY) === '1') { void setBsv(true); return; }
  set({ confirmOpen: true });
}
export function confirmEnable(): void { lsSet(CONFIRMED_KEY, '1'); void setBsv(true); }
export function cancelConfirm(): void { set({ confirmOpen: false }); }
