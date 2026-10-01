/**
 * Store for the Library's Inbox and Activity sub-tabs (the Lattice has its own, graphStore). Nothing here is optimistic:
 * every action waits for the core, then both lists are read again, so the screen never shows a state the core does not have.
 */
import { useSyncExternalStore } from 'react';
import type { KgActivityRow, KgInboxRow } from '../../../src/shared/kg';
import { bulkSummary, editDelta, type EditDraft } from '../../../src/shared/kg-library';
import { ApiError, request, subscribe } from '../api';
import { getG, refreshFromServer } from '../graph/graphStore';

export type Sub = 'lattice' | 'inbox' | 'activity';
type Load = 'idle' | 'loading' | 'ready' | 'error';
export interface Flash { kind: 'ok' | 'warn' | 'error'; text: string; detail?: string[]; n: number }

export interface LState {
  sub: Sub;
  inbox: KgInboxRow[] | null;
  inboxState: Load;
  inboxError: string | null;
  activity: KgActivityRow[] | null;
  activityState: Load;
  activityError: string | null;
  /** Inbox filters and selection. */
  agent: string;
  sel: Set<string>;
  includeUntrusted: boolean;
  /** Row ids with a request in flight (inbox node ids and activity entry ids). */
  busy: Set<string>;
  bulkBusy: boolean;
  /** Last error per row (the core's own message). */
  rowErr: Record<string, string>;
  flash: Flash | null;
  actAgent: string;
}

let s: LState = {
  sub: 'lattice', inbox: null, inboxState: 'idle', inboxError: null, activity: null, activityState: 'idle', activityError: null,
  agent: '', sel: new Set(), includeUntrusted: false, busy: new Set(), bulkBusy: false, rowErr: {}, flash: null, actAgent: '',
};
const listeners = new Set<() => void>();
export const getL = () => s;
function set(p: Partial<LState> | ((x: LState) => Partial<LState>)) {
  s = { ...s, ...(typeof p === 'function' ? p(s) : p) };
  listeners.forEach((l) => l());
}
export function useL<T>(sel: (x: LState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => sel(s));
}

const enc = encodeURIComponent;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
let flashN = 0;
const flash = (kind: Flash['kind'], text: string, detail?: string[]) => set({ flash: { kind, text, detail, n: ++flashN } });
export const dismissFlash = () => set({ flash: null });

const withBusy = (id: string, on: boolean) => {
  const b = new Set(s.busy);
  if (on) b.add(id); else b.delete(id);
  return b;
};
const setRowErr = (id: string, msg: string | null) => {
  const next = { ...s.rowErr };
  if (msg) next[id] = msg; else delete next[id];
  set({ rowErr: next });
};

export function setSub(sub: Sub) {
  set({ sub });
  if (sub === 'inbox') void loadInbox();
  if (sub === 'activity') void loadActivity();
}

/* ---------- reads ---------- */
let inboxSeq = 0;
export async function loadInbox(quiet = false) {
  const my = ++inboxSeq;
  if (!quiet || s.inbox === null) set({ inboxState: s.inbox === null ? 'loading' : s.inboxState, inboxError: null });
  try {
    const rows = await request<KgInboxRow[]>('GET', '/api/kg/inbox');
    if (my !== inboxSeq) return;
    const ids = new Set(rows.map((r) => r.id));
    const sel = new Set([...s.sel].filter((id) => ids.has(id)));
    // a filter that no longer matches anything would hide the whole list: drop it
    const agent = s.agent && rows.some((r) => r.agentId === s.agent) ? s.agent : '';
    set({ inbox: rows, inboxState: 'ready', inboxError: null, sel, agent });
  } catch (e) {
    if (my !== inboxSeq) return;
    set({ inboxState: 'error', inboxError: errMsg(e) });
  }
}

let activitySeq = 0;
export async function loadActivity(quiet = false) {
  const my = ++activitySeq;
  if (!quiet || s.activity === null) set({ activityState: s.activity === null ? 'loading' : s.activityState, activityError: null });
  try {
    const rows = await request<KgActivityRow[]>('GET', '/api/kg/activity?limit=100');
    if (my !== activitySeq) return;
    set({ activity: rows, activityState: 'ready', activityError: null });
  } catch (e) {
    if (my !== activitySeq) return;
    set({ activityState: 'error', activityError: errMsg(e) });
  }
}

/** After any write: read everything again from the core (and the Lattice, if it has been opened). */
async function afterAction() {
  await Promise.all([loadInbox(true), loadActivity(true)]);
  if (getG().stats) refreshFromServer();
}

/* ---------- filters and selection ---------- */
export const setAgent = (agent: string) => set((x) => ({ agent, sel: new Set([...x.sel].filter((id) => !agent || x.inbox?.find((r) => r.id === id)?.agentId === agent)) }));
export const setActAgent = (actAgent: string) => set({ actAgent });
export const toggleSel = (id: string) => set((x) => { const n = new Set(x.sel); if (n.has(id)) n.delete(id); else n.add(id); return { sel: n }; });
export const setSel = (ids: string[]) => set({ sel: new Set(ids) });
export const setIncludeUntrusted = (includeUntrusted: boolean) => set({ includeUntrusted });

/* ---------- inbox actions ---------- */
export async function acceptOne(row: KgInboxRow, draft?: EditDraft): Promise<boolean> {
  const id = row.id;
  set({ busy: withBusy(id, true), flash: null });
  setRowErr(id, null);
  const edit = draft ? editDelta(row.node, draft) : undefined;
  try {
    await request('POST', `/api/kg/inbox/${enc(id)}/accept`, edit ? { edit } : {});
    flash('ok', edit ? `Accepted "${row.node.title}" with your edits. It now counts as your note.` : `Accepted "${row.node.title}".`);
    return true;
  } catch (e) {
    setRowErr(id, errMsg(e));
    return false;
  } finally {
    set({ busy: withBusy(id, false) });
    await afterAction();
  }
}

export async function rejectOne(row: KgInboxRow): Promise<boolean> {
  const id = row.id;
  set({ busy: withBusy(id, true), flash: null });
  setRowErr(id, null);
  try {
    await request('POST', `/api/kg/inbox/${enc(id)}/reject`);
    flash('ok', `Rejected "${row.node.title}". It is kept for 30 days, hidden from every bot.`);
    return true;
  } catch (e) {
    setRowErr(id, errMsg(e));
    return false;
  } finally {
    set({ busy: withBusy(id, false) });
    await afterAction();
  }
}

export async function acceptSelected() {
  const ids = [...s.sel];
  if (!ids.length || s.bulkBusy) return;
  set({ bulkBusy: true, flash: null });
  try {
    const r = await request<{ accepted: string[]; skipped: Array<{ id: string; reason: string }> }>('POST', '/api/kg/inbox/accept', { ids, overrideUntrusted: s.includeUntrusted });
    const title = (id: string) => s.inbox?.find((x) => x.id === id)?.node.title ?? id;
    flash(r.skipped.length ? 'warn' : 'ok', bulkSummary(r), r.skipped.map((k) => `${title(k.id)}: ${k.reason}`));
    set({ sel: new Set(r.skipped.map((k) => k.id)), includeUntrusted: false });
  } catch (e) {
    flash('error', `Bulk accept failed. ${errMsg(e)}`);
  } finally {
    set({ bulkBusy: false });
    await afterAction();
  }
}

/* ---------- activity actions ---------- */
export async function undoEntry(row: KgActivityRow): Promise<boolean> {
  set({ busy: withBusy(row.id, true) });
  setRowErr(row.id, null);
  try {
    await request('POST', `/api/kg/activity/${enc(row.id)}/undo`);
    return true;
  } catch (e) {
    setRowErr(row.id, errMsg(e));
    return false;
  } finally {
    set({ busy: withBusy(row.id, false) });
    await afterAction();
  }
}

/* ---------- live ---------- */
let started = false;
let timer: number | undefined;
/** Starts once at app boot: the title-bar badge needs the pending count even while the Library is closed. */
export function initLibrary() {
  if (started) return;
  started = true;
  let online = false;
  subscribe((e) => {
    if (e.type !== 'kg.updated') return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void loadInbox(true);
      if (s.activity !== null) void loadActivity(true);
    }, 350);
  }, (conn) => {
    if (conn === 'online' && !online) { online = true; void loadInbox(true); if (s.activity !== null) void loadActivity(true); }
    if (conn !== 'online') online = false;
  });
  void loadInbox(true).catch(() => undefined);
}

export const isApiOffline = (e: unknown) => e instanceof ApiError && e.status === 0;
