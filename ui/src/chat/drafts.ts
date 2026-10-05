/**
 * Per-thread composer drafts.
 *
 * ## Why this exists
 *
 * The composer's text was `useState('')`, which lives in the component. Switching agents swaps which thread the
 * composer targets, the component re-renders, and anything half-typed went with it. That is the worst possible moment
 * to lose text: you had just worked out what to ask and were moving to where it belonged.
 *
 * ## Keying
 *
 * Keyed by `threadKey(agentId, taskId)` — the same key the message queue already uses, deliberately. A draft is
 * about where you were typing, exactly like a queued message is, so the two agreeing means one mental model instead
 * of two: `t:<task>` while you are in a task, `n:<agent>` while you are just talking to an agent.
 *
 * ## Persistence
 *
 * Backed by localStorage so the draft survives a restart, not only a switch. If storage is unavailable or full — a
 * real possibility, since this is per-thread and unbounded in principle — the in-memory map still works for the
 * lifetime of the window. Losing the draft across a restart is regrettable; losing it on a switch would be a
 * regression against what we had, and must not happen.
 */
import { useSyncExternalStore } from 'react';

/**
 * The same key `chat/queue.ts` builds, written out rather than imported.
 *
 * Importing it dragged the renderer's module graph into the root type-check, which resolves under NodeNext and rejects
 * the extensionless specifiers the whole UI tree uses. queue.ts is standalone, so the TEST imports both and asserts
 * these two agree — which is a stronger guarantee than a shared import, because drift now fails a test instead of
 * silently unifying.
 */
const threadKey = (agentId: string, taskId: string | null | undefined): string => (taskId ? `t:${taskId}` : `n:${agentId}`);

const STORE_KEY = 'legion.drafts.v1';

/** A single draft is capped so one enormous paste cannot crowd every other thread out of storage. */
export const MAX_DRAFT_CHARS = 20_000;

/** And so can the total, because localStorage is shared with the rest of the app and a failure there is not ours to pay for. */
const MAX_TOTAL_CHARS = 200_000;

const memory = new Map<string, string>();
let loaded = false;

/** Populate the memory map from storage exactly once. Memory is the single source of truth from then on. */
function hydrate(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string' && v) memory.set(k, v);
    return;
  } catch {
    // Unparseable storage is not worth recovering: it means someone else owns this key, or it is corrupt. Either way
    // an empty draft is a far better outcome than a startup failure.
  }
}

function writeStore(): void {
  const next: Record<string, string> = Object.fromEntries(memory);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked. The memory map below is authoritative for this window either way, so there is nothing
    // to report to a user and nothing to roll back.
  }
}

const listeners = new Set<() => void>();
const emit = (): void => { for (const l of listeners) l(); };

export function getDraft(agentId: string, taskId: string | null | undefined): string {
  hydrate();
  return memory.get(threadKey(agentId, taskId)) ?? '';
}

export function setDraft(agentId: string, taskId: string | null | undefined, text: string): void {
  hydrate();
  const key = threadKey(agentId, taskId);
  const value = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text;

  // Re-insert so the map's iteration order reflects last write, which is what the eviction below relies on.
  memory.delete(key);
  if (value) memory.set(key, value);

  let total = 0;
  for (const v of memory.values()) total += v.length;
  // Evict oldest-first until there is room. A draft from three hours ago is the right victim; the one being typed
  // now is the least likely to be the one that matters least.
  for (const k of [...memory.keys()]) {
    if (total <= MAX_TOTAL_CHARS) break;
    if (k === key) continue;
    total -= memory.get(k)?.length ?? 0;
    memory.delete(k);
  }
  writeStore();
  emit();
}

export function clearDraft(agentId: string, taskId: string | null | undefined): void {
  setDraft(agentId, taskId, '');
}

/**
 * The composer's text, kept per thread.
 *
 * Returns a setter shaped like `setState`'s, so call sites that already do `setText(fn)` or `setText('')` are unchanged.
 */
export function useDraft(agentId: string, taskId: string | null | undefined): [string, (next: string | ((cur: string) => string)) => void] {
  // Hoisted: a new function identity every render would make React tear down and re-add the listener each time.
  const subscribe = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
  const text = useSyncExternalStore(subscribe, () => getDraft(agentId, taskId), () => '');

  const setText = (next: string | ((cur: string) => string)): void => {
    const cur = getDraft(agentId, taskId);
    const value = typeof next === 'function' ? next(cur) : next;
    if (value !== cur) setDraft(agentId, taskId, value);
  };

  return [text, setText];
}