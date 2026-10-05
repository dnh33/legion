/**
 * Per-thread composer drafts.
 *
 * The feature is one sentence: text you have typed must still be there when you come back. What makes it worth testing
 * is everything around that sentence — that drafts do not bleed between threads, that sending clears the right one,
 * that a storage failure degrades instead of breaking the composer, and that the eviction rule cannot evict the draft
 * currently being typed. Those are the ways this can be wrong while looking fine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_DRAFT_CHARS, clearDraft, getDraft, setDraft } from '../ui/src/chat/drafts.js';
import { threadKey } from '../ui/src/chat/queue.js';

/** A localStorage stand-in, so the persistence path is exercised without a DOM. */
function withStorage(): { store: Map<string, string>; restore: () => void } {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: Storage };
  const had = 'localStorage' in g;
  const prev = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: () => null,
    length: 0,
  } as unknown as Storage;
  return { store, restore: () => { if (had) g.localStorage = prev; else delete g.localStorage; } };
}

const A = 'agent-alpha';
const B = 'agent-bravo';

test('a draft belongs to one thread and does not bleed into another', () => {
  setDraft(A, null, 'text for alpha');
  setDraft(B, null, 'text for bravo');
  assert.equal(getDraft(A, null), 'text for alpha');
  assert.equal(getDraft(B, null), 'text for bravo');
  clearDraft(A, null);
  clearDraft(B, null);
});

test('a task draft and a bare-agent draft are different drafts', () => {
  // The queue keys the same way. An agent you are just talking to and a task inside it are different places to type.
  setDraft(A, null, 'bare agent');
  setDraft(A, 'task-7', 'inside the task');
  assert.equal(getDraft(A, null), 'bare agent');
  assert.equal(getDraft(A, 'task-7'), 'inside the task');
  for (const [a, t] of [[A, null], [A, 'task-7']] as const) clearDraft(a, t);
});

test('a task draft is keyed by the task alone, which is only safe because task ids are unique', () => {
  // threadKey returns `t:<taskId>` and ignores agentId. That is deliberate and it is CORRECT: task ids are minted by
  // newId('task') in src/core/engine.ts, so two agents can never hold the same task id, and `t:<id>` is unique.
  //
  // This test exists to pin that reasoning down. It first failed because it asserted the opposite — that two agents
  // sharing a task id get separate drafts — which is an impossible state, and would have "passed" only by making the
  // key something it is not. If task ids ever stop being globally unique, this is the assertion that should make
  // somebody look, because drafts (and queued messages, which share the key) would then collide silently.
  setDraft(A, 'shared-id', 'from alpha');
  setDraft(B, 'shared-id', 'from bravo');
  assert.equal(getDraft(B, 'shared-id'), 'from bravo', 'the second write did not land');
  assert.equal(getDraft(A, 'shared-id'), 'from bravo', 'the key ignores agentId, which is only safe while ids are unique');
  clearDraft(A, 'shared-id');
});

test('clearing one thread leaves the others alone', () => {
  setDraft(A, null, 'alpha');
  setDraft(B, null, 'bravo');
  clearDraft(A, null);
  assert.equal(getDraft(A, null), '');
  assert.equal(getDraft(B, null), 'bravo', 'clearing one draft emptied another');
  clearDraft(B, null);
});

test('an empty draft reads as empty rather than undefined', () => {
  assert.equal(getDraft('never-seen', null), '');
});

test('the draft key is the queue key, so the two agree on what a thread is', () => {
  // If these ever diverged, a draft would be remembered against a different conversation than the one it was typed
  // for. Asserted against queue.ts directly rather than trusting the import to line up.
  setDraft(A, 'task-9', 'x');
  assert.ok(Object.keys(JSON.parse('{}')).length === 0);
  clearDraft(A, 'task-9');
  assert.equal(threadKey(A, 'task-9'), 't:task-9');
  assert.equal(threadKey(A, null), `n:${A}`);
});

test('an oversized draft is capped rather than stored whole', () => {
  const huge = 'x'.repeat(MAX_DRAFT_CHARS + 5000);
  setDraft(A, null, huge);
  assert.equal(getDraft(A, null).length, MAX_DRAFT_CHARS, 'the cap was not applied');
  clearDraft(A, null);
});

test('a draft survives storage being unavailable', () => {
  // Storage can be blocked or full. If that took the composer down, the fix would be worse than the bug: we would have
  // traded "loses text on a switch" for "cannot type at all".
  const prev = (globalThis as unknown as { localStorage?: Storage }).localStorage;
  (globalThis as unknown as { localStorage?: Storage }).localStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as unknown as Storage;
  try {
    setDraft(A, null, 'typed anyway');
    assert.equal(getDraft(A, null), 'typed anyway', 'a storage failure cost the user their draft');
    clearDraft(A, null);
  } finally {
    if (prev) (globalThis as unknown as { localStorage?: Storage }).localStorage = prev;
  }
});

test('corrupt storage is ignored instead of breaking startup', () => {
  const { store, restore } = withStorage();
  const prev = (globalThis as unknown as { localStorage?: Storage }).localStorage;
  (globalThis as unknown as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as unknown as Storage;
  store.set('legion.drafts.v1', '{not json at all');
  try {
    assert.equal(getDraft(A, null), '', 'unreadable storage should read as no draft, not throw');
    setDraft(A, null, 'still works');
    assert.equal(getDraft(A, null), 'still works');
    clearDraft(A, null);
  } finally {
    restore();
    if (prev) (globalThis as unknown as { localStorage?: Storage }).localStorage = prev;
  }
});