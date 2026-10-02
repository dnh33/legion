/**
 * The composer's message queue as a small PURE state machine (no React, no DOM, no fetch; types only), so node tests can run it directly.
 *
 * One queue per thread. A thread is a task ("t:<taskId>"), or an agent's not-yet-created task ("n:<agentId>") when the agent is busy
 * elsewhere and the owner typed into the New task view. Every function takes a QState and returns a new one (threads that did not change
 * keep their identity, so a subscriber to one thread is not woken by another).
 *
 * Rules the tests pin down:
 *  - Messages leave the queue only in order, one at a time, and only when canDrain() says so: items waiting, no hold, nothing in flight,
 *    and the thread is not busy.
 *  - A hold stops all automatic sending until the owner resumes or clears: 'cancelled' (the owner stopped a run), 'error' (the run failed,
 *    or sending a queued message failed), 'restored' (the queue came back from storage after a reload). Nothing is ever sent
 *    "silently" after a stop, a failure or a reload.
 *  - Ctrl+Enter (override) is not a queue item: it locks the thread (so the next queued message cannot jump ahead of it), the caller
 *    cancels the run and sends, then unlocks. The rest of the queue stays queued behind it.
 */

export const MAX_QUEUE = 20;
export const MAX_TEXT = 50_000;
const MAX_THREADS = 60;
export const STORAGE_KEY = 'legion.queue.v1';
/** The `sending` token of a Ctrl+Enter override (it is not a queue item id). */
export const OVERRIDE = '\u0000override';

export type Hold = 'cancelled' | 'error' | 'restored';

export interface QItem { id: string; text: string; model: string; at: number }
export interface QThread {
  items: QItem[];
  /** Why automatic sending is stopped (null = running normally). */
  hold: Hold | null;
  /** The id of the item being sent right now, or OVERRIDE while a Ctrl+Enter send is in progress. */
  sending: string | null;
  /** Last failure, shown with the 'error' hold. */
  error?: string;
}
export interface QState { threads: Readonly<Record<string, QThread>> }

export const emptyState: QState = { threads: {} };

export const threadKey = (agentId: string, taskId: string | null | undefined): string => (taskId ? `t:${taskId}` : `n:${agentId}`);
export function parseKey(key: string): { taskId: string | null; agentId: string | null } {
  if (key.startsWith('t:')) return { taskId: key.slice(2), agentId: null };
  if (key.startsWith('n:')) return { taskId: null, agentId: key.slice(2) };
  return { taskId: null, agentId: null };
}

export type RejectReason = 'empty' | 'full' | 'too-long';
export const rejectMessage = (r: RejectReason): string =>
  r === 'full' ? `The queue is full (${MAX_QUEUE} messages). Remove one or wait for the agent to catch up.`
    : r === 'too-long' ? `That message is too long to queue (limit ${MAX_TEXT.toLocaleString('en-US')} characters).`
      : 'Nothing to queue.';

const THREAD0: QThread = { items: [], hold: null, sending: null };

function put(s: QState, key: string, t: QThread): QState {
  const threads = { ...s.threads };
  // a thread with nothing in it and nothing in flight is not kept
  if (t.items.length === 0 && t.sending === null) delete threads[key]; else threads[key] = t;
  return { threads };
}
const get = (s: QState, key: string): QThread => s.threads[key] ?? THREAD0;

export const queueOf = (s: QState, key: string): QThread | undefined => s.threads[key];
export const countOf = (s: QState, key: string): number => s.threads[key]?.items.length ?? 0;

export type EnqueueResult = { ok: true; state: QState; item: QItem } | { ok: false; state: QState; reason: RejectReason };

export function enqueue(s: QState, key: string, text: string, model: string, id: string, now: number): EnqueueResult {
  const t = get(s, key);
  if (!text.trim()) return { ok: false, state: s, reason: 'empty' };
  if (text.length > MAX_TEXT) return { ok: false, state: s, reason: 'too-long' };
  if (t.items.length >= MAX_QUEUE) return { ok: false, state: s, reason: 'full' };
  const item: QItem = { id, text, model, at: now };
  return { ok: true, item, state: put(s, key, { ...t, items: [...t.items, item] }) };
}

/** True when the next message may go out now. `busy` comes from the caller (own run, approval wait, or another source). */
export function canDrain(t: QThread | undefined, busy: boolean): boolean {
  return !!t && t.items.length > 0 && t.hold === null && t.sending === null && !busy;
}

/** Whether a message typed with plain Enter must join the queue (instead of being sent at once). */
export function shouldQueue(t: QThread | undefined, busy: boolean): boolean {
  // Items already waiting without a hold also force queueing: a new message may never jump ahead of them.
  return busy || (!!t && t.items.length > 0 && t.hold === null) || t?.sending === OVERRIDE;
}

/** Marks the first item as in flight. Returns the item to send, or null when nothing can go. */
export function beginSend(s: QState, key: string, itemId?: string): { state: QState; item: QItem } | null {
  const t = s.threads[key];
  if (!t || t.sending !== null) return null;
  const item = itemId ? t.items.find((i) => i.id === itemId) : t.items[0];
  if (!item) return null;
  return { item, state: put(s, key, { ...t, sending: item.id }) };
}

/** The send finished. ok: the item is gone. Failure: it stays, in flight no more, and the queue is held with the reason. */
export function finishSend(s: QState, key: string, itemId: string, ok: boolean, error?: string): QState {
  const t = s.threads[key];
  if (!t || t.sending !== itemId) return s;
  if (ok) return put(s, key, { ...t, items: t.items.filter((i) => i.id !== itemId), sending: null });
  return put(s, key, { ...t, sending: null, hold: 'error', error: error ?? 'Sending failed' });
}

/** Ctrl+Enter: while the run is being cancelled and the new message sent, nothing queued may go out. */
export function lock(s: QState, key: string): QState {
  const t = s.threads[key];
  if (!t || t.sending !== null) return s;
  return put(s, key, { ...t, sending: OVERRIDE });
}
export function unlock(s: QState, key: string, failed?: string): QState {
  const t = s.threads[key];
  if (!t || t.sending !== OVERRIDE) return s;
  return put(s, key, { ...t, sending: null, ...(failed ? { hold: 'error' as const, error: failed } : {}) });
}

export function remove(s: QState, key: string, id: string): QState {
  const t = s.threads[key];
  if (!t || t.sending === id || !t.items.some((i) => i.id === id)) return s;
  return put(s, key, { ...t, items: t.items.filter((i) => i.id !== id) });
}

/** Edits an item in place. Empty text removes it. Over-long text or an item in flight is refused (state unchanged). */
export function edit(s: QState, key: string, id: string, text: string): { state: QState; ok: boolean; reason?: RejectReason } {
  const t = s.threads[key];
  if (!t || t.sending === id) return { state: s, ok: false };
  const i = t.items.findIndex((x) => x.id === id);
  if (i < 0) return { state: s, ok: false };
  if (!text.trim()) return { state: remove(s, key, id), ok: true };
  if (text.length > MAX_TEXT) return { state: s, ok: false, reason: 'too-long' };
  if (text === t.items[i]!.text) return { state: s, ok: true };
  const items = t.items.slice(); items[i] = { ...items[i]!, text };
  return { state: put(s, key, { ...t, items }), ok: true };
}

/** Pulls the last waiting item back (for the composer). The item in flight cannot be taken. */
export function takeLast(s: QState, key: string): { state: QState; item: QItem } | null {
  const t = s.threads[key];
  if (!t) return null;
  for (let i = t.items.length - 1; i >= 0; i--) {
    const item = t.items[i]!;
    if (item.id === t.sending) continue;
    return { item, state: put(s, key, { ...t, items: t.items.filter((x) => x !== item) }) };
  }
  return null;
}

/** Drops everything waiting (the item in flight stays, it is already on its way) and lifts the hold. */
export function clear(s: QState, key: string): QState {
  const t = s.threads[key];
  if (!t) return s;
  return put(s, key, { ...t, items: t.items.filter((i) => i.id === t.sending), hold: null, error: undefined });
}

/** Stops automatic sending. A thread with nothing queued has nothing to protect and is left alone. The first reason stands. */
export function pause(s: QState, key: string, reason: Hold = 'cancelled', error?: string): QState {
  const t = s.threads[key];
  if (!t || t.items.length === 0 || t.hold !== null) return s;
  return put(s, key, { ...t, hold: reason, ...(error ? { error } : {}) });
}

export function resume(s: QState, key: string): QState {
  const t = s.threads[key];
  if (!t || t.hold === null) return s;
  return put(s, key, { ...t, hold: null, error: undefined });
}

/**
 * A task was seen going from running/queued to cancelled. If the owner (or anyone) stopped it, the queue pauses; if our own Ctrl+Enter
 * did it (`overridden`) it does not.
 */
export function cancelObserved(s: QState, key: string, overridden: boolean): QState {
  return overridden ? s : pause(s, key, 'cancelled');
}
/** A task was seen going from running/queued to error: queued follow-ups wait for the owner. */
export function failureObserved(s: QState, key: string, message?: string): QState {
  return pause(s, key, 'error', message);
}

/** A "new task" queue whose first message created a task continues as that task's queue. Items keep their order after any already there. */
export function rekey(s: QState, from: string, to: string): QState {
  const a = s.threads[from];
  if (!a || from === to) return s;
  const b = s.threads[to];
  const merged: QThread = b
    ? { ...b, items: [...b.items, ...a.items].slice(0, MAX_QUEUE), hold: b.hold ?? a.hold, error: b.error ?? a.error }
    : { items: a.items, hold: a.hold, sending: null, ...(a.error ? { error: a.error } : {}) };
  const threads = { ...s.threads }; delete threads[from]; threads[to] = merged;
  return put({ threads }, to, merged);
}

/** Drops the queues of threads that are gone (deleted task, deleted agent). */
export function prune(s: QState, keep: (key: string) => boolean): QState {
  let changed = false;
  const threads: Record<string, QThread> = {};
  for (const [k, t] of Object.entries(s.threads)) { if (keep(k)) threads[k] = t; else changed = true; }
  return changed ? { threads } : s;
}

/** The task is gone (deleted): its queue goes with it, so nothing can be sent to a dead task or reappear after a reload. */
export const pruneTask = (s: QState, taskId: string): QState => prune(s, (k) => k !== `t:${taskId}`);
/** The agent is gone: its New task queue and the queues of all its tasks (`taskIds`, looked up before the agent left the store) go. */
export function pruneAgent(s: QState, agentId: string, taskIds: Iterable<string>): QState {
  const dead = new Set<string>([`n:${agentId}`]);
  for (const id of taskIds) dead.add(`t:${id}`);
  return prune(s, (k) => !dead.has(k));
}

/* ---------- persistence ---------- */

/** Only items and holds are stored. What was in flight is not (see restore): the owner decides about it after a reload. */
export function serialize(s: QState): string {
  const threads: Record<string, { items: QItem[]; hold: Hold | null; error?: string }> = {};
  for (const [k, t] of Object.entries(s.threads)) if (t.items.length) threads[k] = { items: t.items, hold: t.hold, ...(t.error ? { error: t.error } : {}) };
  return JSON.stringify({ v: 1, threads });
}

/**
 * Reads what serialize wrote. Anything malformed is dropped, sizes are clamped again (storage is not trusted), and every thread that
 * has items comes back HELD as 'restored': after a reload nothing is sent until the owner has seen the list and pressed Resume.
 */
export function restore(raw: string | null | undefined): QState {
  if (!raw) return emptyState;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return emptyState; }
  if (!data || typeof data !== 'object' || (data as { v?: unknown }).v !== 1) return emptyState;
  const src = (data as { threads?: unknown }).threads;
  if (!src || typeof src !== 'object') return emptyState;
  const threads: Record<string, QThread> = {};
  for (const [k, v] of Object.entries(src as Record<string, unknown>).slice(0, MAX_THREADS)) {
    if (!/^[tn]:.+/.test(k) || !v || typeof v !== 'object') continue;
    const arr = (v as { items?: unknown }).items;
    if (!Array.isArray(arr)) continue;
    const items: QItem[] = [];
    for (const it of arr) {
      if (items.length >= MAX_QUEUE) break;
      if (!it || typeof it !== 'object') continue;
      const { id, text, model, at } = it as Record<string, unknown>;
      if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) continue;
      items.push({ id, text, model: typeof model === 'string' && model ? model : 'auto', at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
    }
    if (items.length) threads[k] = { items, hold: 'restored', sending: null };
  }
  return { threads };
}
