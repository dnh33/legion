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
import { bulkDone, bulkUndone, endSentence, licenceNameFromText, withSwitch, wouldReset } from '../../../src/shared/house-view';
import { restorePayload } from '../../../src/shared/armory-view';
import type { HouseCategory, HouseFileView, HouseTrust } from '../../../src/shared/house-view';

export type { HouseCategory, HouseFileView, HouseTrust };

/** What the "Read it" dialog shows: the whole file, as the owner sees it (switches do not hide it). */
export interface HouseFileText {
  path: string;
  title: string;
  status: 'loading' | 'ready' | 'error';
  text: string;
  clipped: boolean;
  trust: HouseTrust | null;
  error: string | null;
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
  /** Last approve/withdraw failure per path, shown on that row until the next try. */
  trustErrors: Record<string, string>;
  /** Why the last GET /api/house failed, or null. With a list already loaded the list stays and this says it may be stale. */
  loadError: string | null;
  loading: boolean;
  /** An older core answered 404 and has no house module. */
  absent: boolean;
  /** Switches with a request in flight. The switch is disabled meanwhile, so one path never has two writes racing. */
  switching: string[];
  /** Last failure per path, shown on that row until the next try. */
  switchErrors: Record<string, string>;
  /** Reset scopes ("category:history", "group:review") with a request in flight, and their last failure. */
  resetting: string | null;
  resetErrors: Record<string, string>;
  reading: HouseFileText | null;
  /** The last bulk change (turn all off, reset), kept for a few seconds so it can be undone exactly. */
  undo: BulkUndo | null;
  /** One polite message for screen readers: what the last bulk change or undo did. */
  notice: string;
  /** Short licence names ("MIT") read from the licence files, by path. Missing until read; the screen numbers licences meanwhile. */
  licenceNames: Record<string, string>;
  /** The drill just written, so its row can be found and drawn with a highlight for a few seconds. */
  justAdded: string | null;
  /** A drill to move keyboard focus to once its row is on screen (Promote, then Open Doctrine). */
  focusPath: string | null;
  /** A drill of yours being removed, and the last one removed (kept a few seconds so Remove can be undone). */
  removingPath: string | null;
  removedDrill: RemovedDrill | null;
  drillError: string | null;
}
export interface RemovedDrill { path: string; name: string; text: string; message: string; busy: boolean; error?: string }
export interface BulkUndo {
  key: string;
  scope: ResetScope;
  message: string;
  /** The files the change flipped, with the state each had before. */
  items: { path: string; on: boolean }[];
  /** How many files the change flipped in all (`items` shrinks to the ones still to put back after a failed Undo). */
  total: number;
  /** Set after an Undo that did not fully work: "Undo failed: <why>. Try again." The offer stays until it succeeds. */
  error?: string;
}

let state: HouseUiState = {
  status: null, loaded: false, busyPath: null, trustErrors: {}, loadError: null, loading: false, absent: false,
  switching: [], switchErrors: {}, resetting: null, resetErrors: {}, reading: null, undo: null, notice: '', licenceNames: {}, justAdded: null,
  focusPath: null, removingPath: null, removedDrill: null, drillError: null,
};
const listeners = new Set<() => void>();
const set = (p: Partial<HouseUiState>): void => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getHouse = (): HouseUiState => state;
export function useHouse<T>(selector: (s: HouseUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }
const msg = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** How long "Turned off 2 skills. Undo" stays. */
export const UNDO_MS = 10_000;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
/** Who is holding the offer open right now ("focus", "hover"). The clock runs only while nobody is (WCAG 2.2.1). */
const undoHolds = new Set<string>();
const stopClock = (): void => { if (undoTimer) clearTimeout(undoTimer); undoTimer = undefined; };
const startClock = (): void => { stopClock(); if (state.undo && !undoHolds.size) undoTimer = setTimeout(expireUndo, UNDO_MS); };
/** Drops the Undo offer (the next change was made, or it was used). */
export function clearUndo(): void {
  stopClock();
  undoHolds.clear();
  if (state.undo) set({ undo: null });
}
/** The time ran out: the offer goes, and a screen reader is told, because the button just vanished from under it. */
function expireUndo(): void {
  if (!state.undo) return;
  clearUndo();
  announce('Undo is no longer available.');
}
/** The pointer or keyboard focus is on the offer: stop the clock until it leaves. */
export function holdUndo(who: string): void { undoHolds.add(who); stopClock(); }
/** It left: the full time starts again. */
export function releaseUndo(who: string): void { undoHolds.delete(who); if (!undoHolds.size) startClock(); }
let flip = false;
/** A live-region message. The same words twice would not be read again, so every other one carries an invisible space. */
const announce = (text: string): void => { flip = !flip; set({ notice: flip ? `${text} ` : text }); };

/** A retry shows "Trying…" at least this long, so a try that fails again does not look like nothing happened. */
export const RETRY_MIN_MS = 400;

/**
 * Reads /api/house. `maxAgeMs` is for a screen that re-reads on entry: it takes the answer already on screen when that is fresh, and
 * joins a read that is under way, so opening Doctrine right after the Armory changed it (Promote) is one request, not three. A caller
 * that has just changed something passes no `maxAgeMs` and always asks again.
 */
let inflight: Promise<void> | null = null;
let loadedAt = 0;
export function loadHouse(opts: { minBusyMs?: number; maxAgeMs?: number } = {}): Promise<void> {
  if (opts.maxAgeMs !== undefined) {
    if (state.loaded && !state.loadError && Date.now() - loadedAt < opts.maxAgeMs) return Promise.resolve();
    if (inflight) return inflight;
  }
  const p = readHouse(opts);
  inflight = p;
  void p.finally(() => { if (inflight === p) inflight = null; });
  return p;
}
/** The caller has just read Doctrine for the owner (Promote does) and is about to open it: the screen's entry read takes that answer instead of asking again. */
export const markHouseFresh = (): void => { loadedAt = Date.now(); };
async function readHouse(opts: { minBusyMs?: number }): Promise<void> {
  const started = Date.now();
  set({ loading: true });
  try {
    const status = await request<HouseView>('GET', '/api/house');
    loadedAt = Date.now();
    // What the core says now is the truth, so a failure shown from an earlier try no longer describes anything.
    set({ status, loaded: true, loadError: null, absent: false, switchErrors: {}, resetErrors: {}, trustErrors: {} });
  } catch (e) {
    // An older core without the route: the section says so rather than showing an empty list that reads as "no files".
    // Any other failure keeps the list (if there is one) and says why it may be out of date.
    set({ loadError: msg(e), absent: e instanceof ApiError && e.status === 404 });
  } finally {
    const wait = (opts.minBusyMs ?? 0) - (Date.now() - started);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    set({ loading: false });
  }
}

/** The Try again buttons: reload, keep the busy state visible, and tell a screen reader how it went. */
export async function retryLoad(): Promise<boolean> {
  await loadHouse({ minBusyMs: RETRY_MIN_MS });
  const ok = !state.loadError;
  announce(ok ? 'Doctrine files reloaded.' : 'Still could not read your doctrine files.');
  return ok;
}

/**
 * Approve the current bytes of one file, or withdraw that approval.
 *
 * Reloads after the call rather than patching the row locally: withdrawing an approval from a file the app also shipped
 * leaves it trusted, so what the file is *now* is the core's answer and not something the UI should guess.
 */
export async function setHouseTrust(path: string, adopt: boolean): Promise<void> {
  if (state.busyPath) return;
  clearUndo();
  const { [path]: _gone, ...left } = state.trustErrors;
  set({ busyPath: path, trustErrors: left });
  try {
    await request('POST', adopt ? '/api/house/adopt' : '/api/house/unadopt', { path });
    await loadHouse();
  } catch (e) {
    set({ trustErrors: { ...state.trustErrors, [path]: msg(e) } });
  } finally {
    set({ busyPath: null });
  }
}

/**
 * Flip one switch. Optimistic: the row moves at once, and a failure puts it back and says why on that row. A skill's
 * reference files move with it, as the core does. The core's answer is the last word on what `on` is.
 */
export async function setHouseSwitch(path: string, on: boolean): Promise<void> {
  if (state.switching.includes(path) || !state.status) return;
  clearUndo();
  await flipSwitch(path, on);
}

/** The switch itself, without dropping an Undo offer: Undo uses it, so a failed Undo can be tried again. */
async function flipSwitch(path: string, on: boolean): Promise<void> {
  if (state.switching.includes(path) || !state.status) return;
  const before = state.status.files.find((f) => f.path === path)?.on;
  const { [path]: _drop, ...rest } = state.switchErrors;
  set({ status: { ...state.status, files: withSwitch(state.status.files, path, on) }, switching: [...state.switching, path], switchErrors: rest });
  try {
    const res = await request<{ path: string; on: boolean }>('POST', '/api/house/switch', { path, on });
    if (state.status) set({ status: { ...state.status, files: withSwitch(state.status.files, path, res.on) } });
  } catch (e) {
    if (state.status && before !== undefined) set({ status: { ...state.status, files: withSwitch(state.status.files, path, before) } });
    set({ switchErrors: { ...state.switchErrors, [path]: msg(e) } });
  } finally {
    set({ switching: state.switching.filter((p) => p !== path) });
  }
}

export type ResetScope = { category: HouseCategory } | { group: string };
export const resetKey = (s: ResetScope): string => ('group' in s ? `group:${s.group}` : `category:${s.category}`);

/** How many switches a reset would flip, from what the screen shows now. 0 means "already at the defaults". */
export const resetCount = (s: ResetScope): number => (state.status ? wouldReset(state.status.files, s).length : 0);

/**
 * Put a category, or one skill group, back to its defaults, then re-read: the core says what that is.
 *
 * It runs at once and offers Undo for UNDO_MS (or until the next change). Undo puts back exactly the files it flipped,
 * one switch at a time through the same switch route, so it cannot do more than the owner could by hand.
 */
export async function resetHouse(scope: ResetScope): Promise<void> {
  if (state.resetting || !state.status) return;
  const hit = wouldReset(state.status.files, scope);
  if (!hit.length) return;
  const key = resetKey(scope);
  const items = hit.map((f) => ({ path: f.path, on: f.on }));
  clearUndo();
  const { [key]: _drop, ...rest } = state.resetErrors;
  set({ resetting: key, resetErrors: rest });
  try {
    await request('POST', '/api/house/switch/reset', scope);
    await loadHouse();
    const message = bulkDone(scope, items.length);
    set({ undo: { key, scope, message, items, total: items.length } });
    startClock();
    announce(message);
  } catch (e) {
    set({ resetErrors: { ...state.resetErrors, [key]: msg(e) } });
  } finally {
    set({ resetting: null });
  }
}

/**
 * Undo the last bulk change: each file goes back to the state it had, through the same switch route as a click.
 *
 * The offer is kept until every file is back. If one fails, the offer stays (now listing only the files still to put
 * back) with "Undo failed: <why>. Try again.", and a second try picks up where this one stopped. Dropping it would leave
 * the owner with no way back and a row that says the opposite of what they asked for.
 */
export async function undoBulk(): Promise<void> {
  const u = state.undo;
  if (!u || state.resetting) return;
  stopClock();
  set({ resetting: u.key, undo: { ...u, error: undefined } });
  const left: { path: string; on: boolean }[] = [];
  let why = '';
  try {
    for (const it of u.items) {
      await flipSwitch(it.path, it.on);
      const err = state.switchErrors[it.path];
      if (err) { left.push(it); why ||= err; }
    }
    if (!left.length) await loadHouse();
  } finally {
    set({ resetting: null });
  }
  if (left.length) {
    const error = `${endSentence(`Undo failed: ${why}`)} Try again.`;
    set({ undo: { ...u, items: left, error } });
    announce(error);
    return;
  }
  clearUndo();
  announce(bulkUndone(u.scope, u.total));
}

/**
 * Read the short name of each licence file ("MIT", "Apache-2.0") once, so a skill's Licence button can say which it is
 * and search can find "MIT". A file that cannot be read is skipped: the button keeps a number instead.
 */
const licenceTried = new Set<string>();
export async function loadLicenceNames(paths: readonly string[]): Promise<void> {
  const todo = paths.filter((p) => !licenceTried.has(p));
  if (!todo.length) return;
  todo.forEach((p) => licenceTried.add(p));
  const found: Record<string, string> = {};
  await Promise.all(todo.map(async (p) => {
    try {
      const r = await request<{ text: string }>('GET', `/api/house/file?path=${encodeURIComponent(p)}`);
      const name = licenceNameFromText(r.text);
      if (name) found[p] = name;
    } catch { /* the button keeps its number */ }
  }));
  if (Object.keys(found).length) set({ licenceNames: { ...state.licenceNames, ...found } });
}

/** Open the full text of one file, to read before switching it on. A late answer for a file that was closed is dropped. */
export async function openHouseFile(path: string, title: string): Promise<void> {
  set({ reading: { path, title, status: 'loading', text: '', clipped: false, trust: null, error: null } });
  try {
    const r = await request<{ path: string; text: string; clipped: boolean; trust: HouseTrust }>('GET', `/api/house/file?path=${encodeURIComponent(path)}`);
    if (state.reading?.path === path) set({ reading: { path, title, status: 'ready', text: r.text, clipped: r.clipped, trust: r.trust, error: null } });
  } catch (e) {
    if (state.reading?.path === path) set({ reading: { path, title, status: 'error', text: '', clipped: false, trust: null, error: msg(e) } });
  }
}
export function closeHouseFile(): void { set({ reading: null }); }

/**
 * Your drills. A drill the owner writes is saved as skills/yours/<name>/SKILL.md through POST /api/house/drill. It is NOT shipped, so it
 * starts not approved, and it is off until switched on; this function never approves or switches anything. Saving over an existing
 * drill changes its bytes, which drops its approval: the message says so. Throws the core's message for the editor to show inline.
 */
let justTimer: ReturnType<typeof setTimeout> | undefined;
export async function saveDrill(f: { name: string; description: string; whenToUse: string; body: string }, edited: boolean): Promise<string> {
  clearUndo();
  // New sends no `replace`, so the core refuses a name that is taken (409). Edit sends replace:true, the one way to overwrite.
  const body = { name: f.name, description: f.description, ...(f.whenToUse.trim() ? { whenToUse: f.whenToUse } : {}), body: f.body, ...(edited ? { replace: true } : {}) };
  const res = await request<{ path: string; name: string }>('POST', '/api/house/drill', body);
  await loadHouse();
  if (justTimer) clearTimeout(justTimer);
  set({ justAdded: res.path });
  justTimer = setTimeout(() => { if (state.justAdded === res.path) set({ justAdded: null }); }, 8000);
  announce(edited ? `Saved ${res.name}. Your approval no longer applies, so approve it again.` : `Added ${res.name}. It is not approved and it is off.`);
  return res.path;
}
/** Show a drill that exists already: its group opens, its row is drawn with the highlight and takes keyboard focus. */
export function revealDrill(path: string): void {
  if (justTimer) clearTimeout(justTimer);
  set({ justAdded: path, focusPath: path });
  justTimer = setTimeout(() => { if (state.justAdded === path) set({ justAdded: null }); }, 8000);
}
export const clearFocusPath = (): void => { if (state.focusPath) set({ focusPath: null }); };

/** How long "Removed x. Undo" stays; the clock waits while the pointer or focus is on the offer. */
let drillTimer: ReturnType<typeof setTimeout> | undefined;
const drillHolds = new Set<string>();
const stopDrill = (): void => { if (drillTimer) clearTimeout(drillTimer); drillTimer = undefined; };
const startDrill = (): void => {
  stopDrill();
  if (state.removedDrill && !drillHolds.size) drillTimer = setTimeout(() => { drillHolds.clear(); set({ removedDrill: null }); announce('Undo is no longer available.'); }, UNDO_MS);
};
export const holdDrill = (who: string): void => { drillHolds.add(who); stopDrill(); };
export const releaseDrill = (who: string): void => { drillHolds.delete(who); startDrill(); };
export function dismissRemovedDrill(): void { stopDrill(); drillHolds.clear(); if (state.removedDrill) set({ removedDrill: null }); }

/**
 * Remove one of your own drills (DELETE /api/house/drill). The row says "Removing…" at once; the core hands back the text, and Undo posts
 * it again with replace. A restored drill is not approved and is off, whatever it was before: the approval was of those exact bytes.
 */
export async function removeDrill(path: string, name: string): Promise<boolean> {
  if (state.removingPath) return false;
  dismissRemovedDrill();
  set({ removingPath: path, drillError: null });
  try {
    const res = await request<{ removed: string; name: string; text: string }>('DELETE', `/api/house/drill?path=${encodeURIComponent(path)}`);
    await loadHouse();
    const message = `Removed ${name}.`;
    set({ removedDrill: { path, name, text: res.text, message, busy: false } });
    startDrill();
    announce(message);
    return true;
  } catch (e) {
    set({ drillError: `${name}: ${msg(e)}` });
    return false;
  } finally {
    set({ removingPath: null });
  }
}
export async function undoRemoveDrill(): Promise<void> {
  const r = state.removedDrill;
  if (!r || r.busy) return;
  stopDrill();
  set({ removedDrill: { ...r, busy: true, error: undefined } });
  try {
    const p = restorePayload(r.text);
    await request('POST', '/api/house/drill', { name: p.name || r.name, description: p.description, body: p.body, replace: true });
    await loadHouse();
    drillHolds.clear();
    set({ removedDrill: null });
    revealDrill(r.path);
    announce(`Put ${r.name} back. It is not approved and it is off.`);
  } catch (e) {
    const error = `${endSentence(`Undo failed: ${msg(e)}`)} Try again.`;
    set({ removedDrill: { ...r, busy: false, error } });
    announce(error);
  }
}

/** The text of one drill, for the editor. */
export async function readDrillText(path: string): Promise<string> {
  const r = await request<{ text: string }>('GET', `/api/house/file?path=${encodeURIComponent(path)}`);
  return r.text;
}

let started = false;
export function initHouse(): void {
  if (started) return;
  started = true;
  void loadHouse();
}