/**
 * Glue between the pure queue (queue.ts) and the app: a tiny store of its own (queue edits never touch the main app store, so a queue
 * change wakes only the queue strip), sessionStorage persistence, and the runner that sends the next message when a thread goes idle.
 *
 * Performance: the runner listens to every main-store write (streaming writes once per frame) but returns after three reference
 * comparisons unless tasks, approvals or `loaded` changed. Nothing here runs per keystroke and nothing here uses a timer except the retry
 * after a 409 (a rare race), which sleeps between attempts.
 */
import { useSyncExternalStore } from 'react';
import type { ModelChoice, Task } from '../../../src/shared/types';
import { api } from '../api';
import { getState, sendPromptTo, subscribeStore, toast } from '../store';
import { busyReason } from './busy';
import * as Q from './queue';

/* ---------- storage ---------- */
function load(): Q.QState {
  try { return Q.restore(sessionStorage.getItem(Q.STORAGE_KEY)); } catch { return Q.emptyState; }
}
function save(s: Q.QState) {
  try {
    const raw = Q.serialize(s);
    if (Object.keys(s.threads).length === 0) sessionStorage.removeItem(Q.STORAGE_KEY); else sessionStorage.setItem(Q.STORAGE_KEY, raw);
  } catch { /* storage blocked or full: the queue still works, it just does not survive a reload */ }
}

/* ---------- the queue store ---------- */
let qs: Q.QState = load();
const subs = new Set<() => void>();
const subQ = (l: () => void) => { subs.add(l); return () => { subs.delete(l); }; };
export const getQueue = (): Q.QState => qs;
function set(next: Q.QState) {
  if (next === qs) return;
  qs = next; save(qs);
  subs.forEach((l) => l());
}
/** One thread's queue. Other threads' edits keep this object's identity, so this does not re-render for them. */
export function useThreadQueue(key: string): Q.QThread | undefined {
  return useSyncExternalStore(subQ, () => qs.threads[key]);
}
/** How many messages wait in all threads (for a global hint). */
export function useQueuedTotal(): number {
  return useSyncExternalStore(subQ, () => totalOf(qs));
}
const totalOf = (s: Q.QState): number => { let n = 0; for (const t of Object.values(s.threads)) n += t.items.length; return n; };

let idSeq = 0;
const newId = () => `q${Date.now().toString(36)}${(idSeq++).toString(36)}`;

/* ---------- owner actions ---------- */
export function enqueueMessage(agentId: string, taskId: string | null, text: string, model: ModelChoice): boolean {
  const r = Q.enqueue(qs, Q.threadKey(agentId, taskId), text, model, newId(), Date.now());
  if (!r.ok) { toast(Q.rejectMessage(r.reason), 'error'); return false; }
  set(r.state); kick();
  return true;
}
export const removeQueued = (key: string, id: string) => { set(Q.remove(qs, key, id)); };
export function editQueued(key: string, id: string, text: string): boolean {
  const r = Q.edit(qs, key, id, text);
  if (!r.ok) { if (r.reason) toast(Q.rejectMessage(r.reason), 'error'); return false; }
  set(r.state); kick();
  return true;
}
/** Pulls the last waiting message out of the queue so it can be edited in the composer. */
export function takeLastQueued(key: string): string | null {
  const r = Q.takeLast(qs, key);
  if (!r) return null;
  set(r.state);
  return r.item.text;
}
export const clearQueue = (key: string) => { set(Q.clear(qs, key)); };
export const resumeQueue = (key: string) => { set(Q.resume(qs, key)); kick(); };
/** The Stop button: pause right away, before the cancel round trip, so a run ending at that very moment cannot send the next message. */
export const pauseQueue = (key: string) => { set(Q.pause(qs, key, 'cancelled')); };

/* ---------- sending ---------- */
const inflight = new Map<string, Promise<void>>();
/** Tasks whose coming 'cancelled' status is our own Ctrl+Enter, not a stop by the owner (task id -> expiry, so a flag whose event never came cannot excuse a later stop). */
const overrides = new Map<string, number>();
const OVERRIDE_TTL_MS = 15_000;
const markOverride = (taskId: string) => { overrides.set(taskId, Date.now() + OVERRIDE_TTL_MS); };
const takeOverride = (taskId: string): boolean => { const exp = overrides.get(taskId); overrides.delete(taskId); return exp !== undefined && Date.now() < exp; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function targetOf(key: string): { agentId: string; taskId: string | null } | null {
  const k = Q.parseKey(key);
  if (k.taskId) { const t = getState().tasks.find((x) => x.id === k.taskId); return t ? { agentId: t.agentId, taskId: k.taskId } : null; }
  return k.agentId ? { agentId: k.agentId, taskId: null } : null;
}
const viewing = (at: { agentId: string; taskId: string | null }): boolean => {
  const s = getState();
  return at.taskId ? s.selectedTaskId === at.taskId : s.selectedTaskId === null && s.selectedAgentId === at.agentId;
};

/** Sends one message to a thread. A 409 (the core still has the thread running although our copy says idle) is retried a few times. */
async function sendItem(at: { agentId: string; taskId: string | null }, text: string, model: string) {
  const select = viewing(at);
  let r = await sendPromptTo(at, text, { model, select });
  for (let i = 0; !r.ok && r.status === 409 && i < 5; i++) { await sleep(600); r = await sendPromptTo(at, text, { model, select }); }
  return r;
}

async function drain(key: string, at: { agentId: string; taskId: string | null }) {
  const began = Q.beginSend(qs, key);
  if (!began) return;
  set(began.state);
  const item = began.item;
  const run = (async () => {
    const r = await sendItem(at, item.text, item.model);
    if (r.ok) {
      set(Q.finishSend(qs, key, item.id, true));
      if (!at.taskId) set(Q.rekey(qs, key, Q.threadKey(at.agentId, r.task.id)));
    } else {
      set(Q.finishSend(qs, key, item.id, false, r.message));
      toast(`Queued message not sent: ${r.message}`, 'error');
    }
  })();
  inflight.set(key, run);
  try { await run; } finally { if (inflight.get(key) === run) inflight.delete(key); kick(); }
}

/** Sends the next message of every thread that may go (idle, no hold, nothing in flight). */
function evaluate() {
  const s = getState();
  if (!s.loaded) return;
  for (const key of Object.keys(qs.threads)) {
    if (!Q.canDrain(qs.threads[key], false)) continue;
    const at = targetOf(key);
    if (!at || busyReason(at.agentId, at.taskId, s.tasks, s.approvals)) continue;
    void drain(key, at);
  }
}
let kicked = false;
function kick() { if (kicked) return; kicked = true; queueMicrotask(() => { kicked = false; evaluate(); }); }

/**
 * Ctrl+Enter: cancel the thread's own run through the normal cancel path, then send this message. The thread is locked meanwhile so the
 * next queued message cannot overtake it; afterwards the queue carries on behind it. Resolves false when nothing was sent.
 */
export async function interruptAndSend(agentId: string, taskId: string | null, text: string, model: ModelChoice): Promise<boolean> {
  const key = Q.threadKey(agentId, taskId);
  await inflight.get(key);
  set(Q.lock(qs, key));
  let failure: string | undefined;
  let sentTask: Task | undefined;
  try {
    const st = getState();
    const live = taskId ? busyReason(agentId, taskId, st.tasks, st.approvals) : null;
    if (live === 'run' || live === 'approval') {
      markOverride(taskId!);
      try { const c = await api.cancelTask(taskId!); if (!c.ok) overrides.delete(taskId!); }
      catch (e) { overrides.delete(taskId!); throw e; }
    }
    const r = await sendPromptTo({ agentId, taskId }, text, { model, select: true });
    if (r.ok) sentTask = r.task; else failure = r.message;
  } catch (e) { failure = e instanceof Error ? e.message : String(e); }
  if (failure) toast(failure, 'error');
  if (sentTask && !taskId) set(Q.rekey(qs, key, Q.threadKey(agentId, sentTask.id)));
  set(Q.unlock(qs, key, failure));
  kick();
  return !failure;
}

/** "Send now" on a queued message: the same as Ctrl+Enter, for that message. It stays visible as "Sending" until it is on its way. */
export async function sendQueuedNow(key: string, itemId: string): Promise<void> {
  const at = targetOf(key);
  if (!at) return;
  await inflight.get(key);
  const item = qs.threads[key]?.items.find((i) => i.id === itemId);
  const began = Q.beginSend(qs, key, itemId);
  if (!began || !item) return;
  set(began.state);
  const run = (async () => {
    let failure: string | undefined;
    try {
      const st = getState();
      const live = at.taskId ? busyReason(at.agentId, at.taskId, st.tasks, st.approvals) : null;
      if (live === 'run' || live === 'approval') {
        markOverride(at.taskId!);
        try { const c = await api.cancelTask(at.taskId!); if (!c.ok) overrides.delete(at.taskId!); } catch (e) { overrides.delete(at.taskId!); throw e; }
      }
      const r = await sendPromptTo(at, item.text, { model: item.model, select: true });
      if (!r.ok) failure = r.message;
      else if (!at.taskId) { set(Q.finishSend(qs, key, itemId, true)); set(Q.rekey(qs, key, Q.threadKey(at.agentId, r.task.id))); return; }
    } catch (e) { failure = e instanceof Error ? e.message : String(e); }
    set(Q.finishSend(qs, key, itemId, !failure, failure));
    if (failure) toast(`Queued message not sent: ${failure}`, 'error');
  })();
  inflight.set(key, run);
  try { await run; } finally { if (inflight.get(key) === run) inflight.delete(key); kick(); }
}

/* ---------- runner ---------- */
const prevStatus = new Map<string, Task['status']>();
const isLive = (s: Task['status'] | undefined) => s === 'running' || s === 'queued';

/** Watches task statuses for the two transitions that pause a queue: a stop by the owner (or another window) and a failed run. */
function observe(tasks: readonly Task[]) {
  for (const t of tasks) {
    const prev = prevStatus.get(t.id);
    prevStatus.set(t.id, t.status);
    if (prev === undefined || prev === t.status || !isLive(prev)) continue;
    const key = Q.threadKey(t.agentId, t.id);
    if (t.status === 'cancelled') {
      const ours = takeOverride(t.id);
      if (qs.threads[key]) set(Q.cancelObserved(qs, key, ours));
    } else if (t.status === 'error') {
      if (qs.threads[key]) set(Q.failureObserved(qs, key, t.error));
    }
  }
}

let started = false;
/** Idempotent. Starts watching the app store; call once when the chat UI mounts. */
export function startQueueRunner() {
  if (started) return;
  started = true;
  let tasks = getState().tasks, approvals = getState().approvals, loaded = getState().loaded;
  observe(tasks);
  subscribeStore(() => {
    const s = getState();
    if (s.tasks === tasks && s.approvals === approvals && s.loaded === loaded) return;
    if (s.tasks !== tasks) observe(s.tasks);
    tasks = s.tasks; approvals = s.approvals; loaded = s.loaded;
    evaluate();
  });
  kick();
}
