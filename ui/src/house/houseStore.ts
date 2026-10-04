/**
 * UI store for the house context layer. Own small external store, same pattern as blenderStore.
 *
 * Talks to GET /api/house and POST /api/house/{adopt,unadopt} (admin routes: the UI holds the admin key).
 *
 * This is the ONLY place adoption is reachable from. There is no MCP tool for it, deliberately: an agent runs as the same
 * OS user and could reach a file-based marker anyway, so the approval is the hash of specific bytes (ADR 0010). What
 * makes it meaningful is that only the owner can produce that decision -- so the button here is the whole boundary, and
 * a run must not be able to draw it.
 *
 * No polling: the layer changes when the owner edits a file or approves one, both of which happen on this screen.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';

export type HouseTrust = 'shipped' | 'adopted' | 'untrusted';

export interface HouseFileView {
  path: string;
  bytes: number;
  trust: HouseTrust;
}
export interface HouseView {
  root: string;
  files: HouseFileView[];
  /** Files the app expected to ship and did not find: a broken install, not an empty folder. */
  missing: string[];
  synced: { written: number; skipped: number; keptNewer: number; unchanged: number } | null;
}

export interface HouseUiState {
  status: HouseView | null;
  loaded: boolean;
  /** A path being approved or withdrawn, so only that row shows as busy. */
  busyPath: string | null;
  error: string | null;
  /** The last GET /api/house failed. `absent` means an older core answered 404 and has no house module. */
  failed: boolean;
  absent: boolean;
}

let state: HouseUiState = { status: null, loaded: false, busyPath: null, error: null, failed: false, absent: false };
const listeners = new Set<() => void>();
const set = (p: Partial<HouseUiState>): void => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getHouse = (): HouseUiState => state;
export function useHouse<T>(selector: (s: HouseUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }
const msg = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export async function loadHouse(): Promise<void> {
  try {
    set({ status: await request<HouseView>('GET', '/api/house'), loaded: true, failed: false, absent: false });
  } catch (e) {
    // An older core without the route: the section says so rather than showing an empty list that reads as "no files".
    set({ failed: true, absent: e instanceof ApiError && e.status === 404 });
  }
}

/**
 * Approve the current bytes of one file, or withdraw that approval.
 *
 * Reloads after the call rather than patching the row locally: withdrawing an approval from a file the app also shipped
 * leaves it trusted, so what the file is *now* is the core's answer and not something the UI should guess.
 */
export async function setHouseTrust(path: string, adopt: boolean): Promise<void> {
  if (state.busyPath) return;
  set({ busyPath: path, error: null });
  try {
    await request('POST', adopt ? '/api/house/adopt' : '/api/house/unadopt', { path });
    await loadHouse();
  } catch (e) {
    set({ error: msg(e) });
  } finally {
    set({ busyPath: null });
  }
}

let started = false;
export function initHouse(): void {
  if (started) return;
  started = true;
  void loadHouse();
}