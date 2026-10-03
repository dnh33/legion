/**
 * Rooms store (comms bridge UI). Tiny useSyncExternalStore store, same pattern as ../store.ts.
 * Owns: room list, per-room transcripts, live comms state, unread tracking, search. Reads agents/approvals/tasks
 * from the main store in the components (never written here).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CommsState, Room, RoomGuards, RoomMessage, RoomStrategy } from '../../../src/shared/comms';
import type { LegionEvent } from '../../../src/shared/types';
import { adminRefusal, ApiError, authHeaders, base, request, subscribe, type ConnStatus } from '../api';
import { setView, toast } from '../store';
import './rooms.css';

export type Load = 'idle' | 'loading' | 'ready' | 'error';

export interface LiveState { state: CommsState; roomId?: string; peerId?: string; at: number }

export interface SearchState {
  q: string;
  loading: boolean;
  error: string | null;
  rooms: Room[];
  messages: RoomMessage[];
}

export interface RoomsState {
  list: Load;
  listError: string | null;
  conn: ConnStatus;
  rooms: Room[];
  /** Transcripts by room id (last 200 messages from the API, then live events). */
  msgs: Record<string, RoomMessage[]>;
  detail: Record<string, Load>;
  detailError: Record<string, string>;
  selectedId: string | null;
  /** Agent id -> what its bust should show right now (comms.state events). */
  live: Record<string, LiveState>;
  /** Room id -> ISO updatedAt the human last saw. */
  seen: Record<string, string>;
  /** True while the Rooms view is mounted. */
  visible: boolean;
  search: SearchState | null;
  /** Message to scroll to and flash after opening a room from a search hit. */
  jump: { roomId: string; messageId: string; n: number } | null;
  newRoomOpen: boolean;
  settingsOpen: boolean;
}

function ls(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* ignore */ } }

function loadSeen(): Record<string, string> {
  try { const o = JSON.parse(ls('legion.rooms.seen') ?? '{}') as unknown; return o && typeof o === 'object' ? (o as Record<string, string>) : {}; } catch { return {}; }
}

let state: RoomsState = {
  list: 'idle', listError: null, conn: 'connecting', rooms: [], msgs: {}, detail: {}, detailError: {},
  selectedId: ls('legion.rooms.sel'), live: {}, seen: loadSeen(), visible: false, search: null, jump: null,
  newRoomOpen: false, settingsOpen: false,
};

const listeners = new Set<() => void>();
function set(p: Partial<RoomsState> | ((s: RoomsState) => Partial<RoomsState>)) {
  const patch = typeof p === 'function' ? p(state) : p;
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
function sub(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useRooms<T>(selector: (s: RoomsState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const byRecent = (a: Room, b: Room) => b.updatedAt.localeCompare(a.updatedAt);

function upsertRoom(rooms: Room[], r: Room): Room[] {
  const i = rooms.findIndex((x) => x.id === r.id);
  const next = i === -1 ? [r, ...rooms] : rooms.map((x) => (x.id === r.id ? r : x));
  return next.sort(byRecent);
}

/* ---------- unread ---------- */
function persistSeen(seen: Record<string, string>) { lsSet('legion.rooms.seen', JSON.stringify(seen)); }
export function isUnread(s: RoomsState, r: Room): boolean {
  if (s.visible && s.selectedId === r.id) return false;
  const seen = s.seen[r.id];
  return !!seen && r.updatedAt > seen;
}
function markSeen(roomId: string) {
  const r = state.rooms.find((x) => x.id === roomId);
  if (!r || state.seen[roomId] === r.updatedAt) return;
  const seen = { ...state.seen, [roomId]: r.updatedAt };
  persistSeen(seen);
  set({ seen });
}

/* ---------- events ---------- */
const ACTIVE: CommsState[] = ['listening', 'speaking', 'queued', 'waiting-bot'];

function handleEvent(e: LegionEvent) {
  switch (e.type) {
    case 'room.updated': {
      set((s) => {
        const live = { ...s.live };
        // A frozen/paused room has cancelled its work: do not leave stale "speaking" markers behind.
        if (e.room.paused) for (const [a, v] of Object.entries(live)) if (v.roomId === e.room.id) delete live[a];
        return { rooms: upsertRoom(s.rooms, e.room), live };
      });
      if (state.visible && state.selectedId === e.room.id) markSeen(e.room.id);
      break;
    }
    case 'room.deleted': {
      set((s) => {
        const rooms = s.rooms.filter((r) => r.id !== e.roomId);
        const { [e.roomId]: _m, ...msgs } = s.msgs;
        const gone = s.selectedId === e.roomId;
        if (gone) lsSet('legion.rooms.sel', rooms[0]?.id ?? '');
        return { rooms, msgs, selectedId: gone ? (rooms[0]?.id ?? null) : s.selectedId };
      });
      if (state.selectedId) void loadRoom(state.selectedId);
      break;
    }
    case 'room.message': {
      const m = e.message;
      set((s) => {
        const list = s.msgs[m.roomId];
        if (!list || list.some((x) => x.id === m.id)) return {};
        return { msgs: { ...s.msgs, [m.roomId]: [...list, m] } };
      });
      break;
    }
    case 'comms.state': {
      set((s) => {
        const live = { ...s.live };
        if (e.state === 'idle') delete live[e.agentId];
        else live[e.agentId] = { state: e.state, roomId: e.roomId, peerId: e.peerId, at: Date.now() };
        return { live };
      });
      break;
    }
    default: break;
  }
}

let started = false;
let prevConn: ConnStatus = 'connecting';
export function initRooms() {
  if (started) return;
  started = true;
  subscribe(handleEvent, (conn) => {
    const back = conn === 'online' && prevConn === 'offline';
    prevConn = conn;
    set(conn === 'online' ? { conn, live: back ? {} : state.live } : { conn });
    if (back) { void loadRooms(); if (state.selectedId) void loadRoom(state.selectedId, true); }
  });
  void loadRooms();
}

export async function loadRooms() {
  if (state.list !== 'ready') set({ list: 'loading', listError: null });
  try {
    const rooms = (await request<Room[]>('GET', '/api/rooms')).sort(byRecent);
    set((s) => {
      // First ever run: nothing is "unread" yet. Seed so only later activity lights a dot.
      let seen = s.seen; let changed = false;
      for (const r of rooms) if (!seen[r.id]) { if (!changed) seen = { ...seen }; seen[r.id] = r.updatedAt; changed = true; }
      if (changed) persistSeen(seen);
      const stillThere = s.selectedId && rooms.some((r) => r.id === s.selectedId);
      return { rooms, list: 'ready', listError: null, seen, selectedId: stillThere ? s.selectedId : (rooms[0]?.id ?? null) };
    });
    const sel = state.selectedId;
    if (sel) { void loadRoom(sel); }
  } catch (e) {
    set({ list: state.rooms.length ? 'ready' : 'error', listError: errText(e) });
  }
}

/** Headless loader for places outside the Rooms view (e.g. the approval card wants a room name). */
export function ensureRoomList() { if (state.list === 'idle') { initRooms(); } }
export function useRoomName(roomId: string | undefined): string | undefined {
  useEffect(() => { if (roomId) ensureRoomList(); }, [roomId]);
  return useRooms((s) => (roomId ? s.rooms.find((r) => r.id === roomId)?.name : undefined));
}

export async function loadRoom(id: string, force = false) {
  if (!force && (state.detail[id] === 'loading' || (state.detail[id] === 'ready' && state.msgs[id]))) {
    if (state.visible && state.selectedId === id) markSeen(id);
    return;
  }
  set((s) => ({ detail: { ...s.detail, [id]: s.msgs[id] ? 'ready' : 'loading' }, detailError: { ...s.detailError, [id]: '' } }));
  try {
    const d = await request<{ room: Room; messages: RoomMessage[] }>('GET', `/api/rooms/${encodeURIComponent(id)}`);
    set((s) => {
      // Keep events that landed while the fetch was in flight.
      const have = new Set(d.messages.map((m) => m.id));
      const extra = (s.msgs[id] ?? []).filter((m) => !have.has(m.id) && m.at > (d.messages[d.messages.length - 1]?.at ?? ''));
      return { rooms: upsertRoom(s.rooms, d.room), msgs: { ...s.msgs, [id]: [...d.messages, ...extra] }, detail: { ...s.detail, [id]: 'ready' } };
    });
    if (state.visible && state.selectedId === id) markSeen(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      set((s) => ({ rooms: s.rooms.filter((r) => r.id !== id), detail: { ...s.detail, [id]: 'idle' }, selectedId: s.selectedId === id ? null : s.selectedId }));
      return;
    }
    set((s) => ({ detail: { ...s.detail, [id]: 'error' }, detailError: { ...s.detailError, [id]: errText(e) } }));
  }
}

export function selectRoom(id: string | null) {
  lsSet('legion.rooms.sel', id ?? '');
  set({ selectedId: id });
  if (id) void loadRoom(id);
}

export function setVisible(v: boolean) {
  set({ visible: v });
  if (v && state.selectedId) markSeen(state.selectedId);
}

/** Jump from anywhere (approval card, search hit) to a room, optionally flashing one message. */
export function openRoom(roomId: string, messageId?: string) {
  initRooms();
  setView('rooms');
  selectRoom(roomId);
  set({ search: null, jump: messageId ? { roomId, messageId, n: Date.now() } : null });
}
export const clearJump = () => set({ jump: null });
export const setNewRoomOpen = (open: boolean) => set({ newRoomOpen: open });
export const setSettingsOpen = (open: boolean) => set({ settingsOpen: open });

/* ---------- drafts (not reactive on purpose) ---------- */
const drafts = new Map<string, string>();
export const getDraft = (roomId: string) => drafts.get(roomId) ?? '';
export const setDraft = (roomId: string, text: string) => { if (text) drafts.set(roomId, text); else drafts.delete(roomId); };

/* ---------- actions (each throws the API error message for the caller to show inline) ---------- */
export interface NewRoomInput { name: string; members: string[]; lead?: string; strategy?: RoomStrategy; guards?: Partial<RoomGuards> }

export async function createRoom(input: NewRoomInput): Promise<Room> {
  const room = await request<Room>('POST', '/api/rooms', input);
  set((s) => ({ rooms: upsertRoom(s.rooms, room), msgs: { ...s.msgs, [room.id]: s.msgs[room.id] ?? [] }, detail: { ...s.detail, [room.id]: 'idle' } }));
  selectRoom(room.id);
  return room;
}

export async function sendMessage(roomId: string, text: string): Promise<void> {
  const m = await request<RoomMessage>('POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, { text });
  set((s) => {
    const list = s.msgs[roomId];
    if (!list || list.some((x) => x.id === m.id)) return {};
    return { msgs: { ...s.msgs, [roomId]: [...list, m] } };
  });
}

export async function freezeRoom(roomId: string) {
  try {
    const r = await request<Room>('POST', `/api/rooms/${encodeURIComponent(roomId)}/freeze`);
    set((s) => ({ rooms: upsertRoom(s.rooms, r) }));
    toast('Room frozen. Bots stopped.');
  } catch (e) { toast(errText(e), 'error'); }
}

export async function resumeRoom(roomId: string) {
  try {
    const r = await request<Room>('POST', `/api/rooms/${encodeURIComponent(roomId)}/resume`);
    set((s) => ({ rooms: upsertRoom(s.rooms, r) }));
  } catch (e) { toast(errText(e), 'error'); }
}

export async function saveRoomSettings(roomId: string, p: {
  name?: string; strategy?: RoomStrategy; lead?: string; guards?: Partial<RoomGuards>; add?: string[]; remove?: string[];
}): Promise<void> {
  const rid = encodeURIComponent(roomId);
  // Members first: a new lead must already be a member when the PATCH lands.
  if ((p.add?.length ?? 0) > 0 || (p.remove?.length ?? 0) > 0) {
    const r = await request<Room>('POST', `/api/rooms/${rid}/members`, { add: p.add, remove: p.remove });
    set((s) => ({ rooms: upsertRoom(s.rooms, r) }));
  }
  const patch: Record<string, unknown> = {};
  if (p.name !== undefined) patch.name = p.name;
  if (p.strategy !== undefined) patch.strategy = p.strategy;
  if (p.lead !== undefined) patch.lead = p.lead;
  if (p.guards && Object.keys(p.guards).length) patch.guards = p.guards;
  if (Object.keys(patch).length) {
    const r = await request<Room>('PATCH', `/api/rooms/${rid}`, patch);
    set((s) => ({ rooms: upsertRoom(s.rooms, r) }));
  }
}

export async function deleteRoom(roomId: string): Promise<void> {
  await request<{ ok: true }>('DELETE', `/api/rooms/${encodeURIComponent(roomId)}`);
  handleEvent({ type: 'room.deleted', roomId });
}

/* ---------- search ---------- */
let searchSeq = 0;
let searchTimer: number | undefined;
export function runSearch(q: string) {
  window.clearTimeout(searchTimer);
  const query = q.trim();
  if (!query) { searchSeq++; set({ search: null }); return; }
  set((s) => ({ search: { q, loading: true, error: null, rooms: s.search?.rooms ?? [], messages: s.search?.messages ?? [] } }));
  const mine = ++searchSeq;
  searchTimer = window.setTimeout(async () => {
    try {
      const r = await request<{ q: string; rooms: Room[]; messages: RoomMessage[] }>('GET', `/api/rooms/search?q=${encodeURIComponent(query)}`);
      if (mine !== searchSeq) return;
      set({ search: { q, loading: false, error: null, rooms: r.rooms, messages: r.messages } });
    } catch (e) {
      if (mine !== searchSeq) return;
      set({ search: { q, loading: false, error: errText(e), rooms: [], messages: [] } });
    }
  }, 220);
}

/* ---------- export (needs the bearer header, so no plain link) ---------- */
export async function exportRoom(roomId: string, format: 'md' | 'json'): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/export?format=${format}`, { headers: authHeaders() });
  } catch { throw new Error('Cannot reach Legion core'); }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (JSON.parse(await res.text()) as { error?: string }).error ?? msg; } catch { /* keep */ }
    throw new Error(adminRefusal(res.status, msg)?.message ?? msg);
  }
  let text = await res.text();
  if (format === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ } }
  const room = state.rooms.find((r) => r.id === roomId);
  const slug = (room?.name ?? 'room').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';
  const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${slug}.${format}`;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- derived helpers ---------- */
export function activeIn(live: Record<string, LiveState>, room: Room): Array<{ agentId: string } & LiveState> {
  return room.members.filter((a) => live[a]?.roomId === room.id && ACTIVE.includes(live[a]!.state)).map((a) => ({ agentId: a, ...live[a]! }));
}

export const PAUSE_LABEL = { frozen: 'Frozen', 'max-hops': 'Hop limit', budget: 'Budget', cycle: 'Loop' } as const;
