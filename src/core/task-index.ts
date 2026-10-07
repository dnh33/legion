/**
 * In-memory index over the stored tasks, kept up to date by the Store on every create, update and delete (never persisted: the state.json
 * format is unchanged, the index is rebuilt once at startup).
 *
 * Why it exists: `Store.listTasks` copies and sorts every task on every call. The history list pages and searches instead, and that has to stay
 * fast at tens of thousands of tasks. Three structures answer every question:
 *   - `order`: one array of entries, newest first by (updatedAt desc, id desc), a TOTAL order, so a cursor is exact. Plus one such array per agent.
 *     Insert and remove are a binary search and a splice (a memmove of pointers: ~20 us at 20k entries).
 *   - `tokens`: lower-case word of a title -> set of task ids, and `vocab`, the sorted list of those words, so "refac" finds "refactor" with two
 *     binary searches (a prefix is a contiguous range in a sorted list).
 *   - `live`: the ids that are queued or running (the app's state snapshot always ships those).
 * A page is a walk down one array from the cursor, testing a cheap predicate per entry, stopping after `limit + 1` hits: cost is the number of
 * entries skipped (archived, other project, no match), not the size of the history, and a Set lookup is ~50 ns.
 *
 * Each entry keeps its own snapshot of the indexed fields, so a task object the engine mutated in place and then upserted is still found and
 * removed under its OLD key. Search text is the title only: `Task.title` is the first ~60 characters of the first prompt, and the agent's name
 * is matched at query time (agents get renamed; a per-task copy of the name would go stale).
 */
import type { Task } from '../shared/types.js';

interface Entry {
  id: string;
  agentId: string;
  updatedAt: string;
  createdAt: string;
  archived: boolean;
  projectId: string | undefined;
  live: boolean;
  words: string[];
}

/** Newest first; ties broken by id so the order is total. */
const cmp = (a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }): number =>
  a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.id > b.id ? -1 : a.id < b.id ? 1 : 0;

/** First index whose entry is NOT before `key` in the list order (entries before it sort newer or equal-and-earlier). */
function lowerBound(arr: Entry[], key: { updatedAt: string; id: string }): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cmp(arr[mid]!, key) < 0) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The words searched: letters and digits of any script, lower-cased. Capped so one absurd title cannot bloat the index. */
export function tokenize(s: string, max = 64): string[] {
  const out = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return out.slice(0, max).map((w) => (w.length > 40 ? w.slice(0, 40) : w));
}

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

export class BadCursorError extends Error {}
export const encodeCursor = (k: { updatedAt: string; id: string }): string => Buffer.from(`${k.updatedAt}|${k.id}`, 'utf8').toString('base64url');
export function decodeCursor(c: string): { updatedAt: string; id: string } {
  const s = Buffer.from(c, 'base64url').toString('utf8');
  const i = s.indexOf('|');
  if (i <= 0 || i === s.length - 1 || encodeCursor({ updatedAt: s.slice(0, i), id: s.slice(i + 1) }) !== c) throw new BadCursorError('Invalid cursor');
  return { updatedAt: s.slice(0, i), id: s.slice(i + 1) };
}

export interface PageQuery {
  limit?: number;
  cursor?: string;
  agentId?: string;
  projectId?: string;
  includeArchived?: boolean;
  /** Search text: every word must match (a word matches a title word that starts with it, or the name of the task's agent). */
  q?: string;
  /** Names of the agents the caller may see, for matching `q` against agent names. Hidden agents must not be in it. */
  agentNames?: ReadonlyMap<string, string>;
  /** Whether the caller may see tasks of this agent. Applied to every entry, so a hidden agent's tasks are in no page and no search. */
  agentOk?: (agentId: string) => boolean;
}

export class TaskIndex {
  private entries = new Map<string, Entry>();
  private order: Entry[] = [];
  private byAgent = new Map<string, Entry[]>();
  private tokens = new Map<string, Set<string>>();
  private vocab: string[] = [];
  private live = new Set<string>();

  get size(): number { return this.entries.size; }

  private entryOf(t: Task): Entry {
    return {
      id: t.id, agentId: t.agentId, updatedAt: t.updatedAt, createdAt: t.createdAt, archived: t.archived === true, projectId: t.projectId,
      live: t.status === 'running' || t.status === 'queued', words: [...new Set(tokenize(t.title ?? ''))],
    };
  }

  /** One sort for the whole history (startup). Replaces everything. */
  rebuild(tasks: Iterable<Task>): void {
    this.entries.clear(); this.order = []; this.byAgent.clear(); this.tokens.clear(); this.live.clear();
    for (const t of tasks) {
      const e = this.entryOf(t);
      this.entries.set(e.id, e);
      this.order.push(e);
      for (const w of e.words) this.addWord(w, e.id);
      if (e.live) this.live.add(e.id);
    }
    this.order.sort(cmp);
    for (const e of this.order) { let a = this.byAgent.get(e.agentId); if (!a) this.byAgent.set(e.agentId, a = []); a.push(e); }
    this.vocab = [...this.tokens.keys()].sort();
  }

  /** Create or update. */
  set(t: Task): void {
    const old = this.entries.get(t.id);
    if (old) this.drop(old);
    const e = this.entryOf(t);
    this.entries.set(e.id, e);
    this.insertSorted(this.order, e);
    let a = this.byAgent.get(e.agentId); if (!a) this.byAgent.set(e.agentId, a = []);
    this.insertSorted(a, e);
    for (const w of e.words) this.addWordSorted(w, e.id);
    if (e.live) this.live.add(e.id);
  }

  remove(id: string): void {
    const old = this.entries.get(id);
    if (old) this.drop(old);
  }

  liveIds(): string[] { return [...this.live]; }

  /** Ids of the newest `k` entries of one agent by `updatedAt` or `createdAt`. A single pass with a small sorted buffer (no sort of the history). */
  newest(k: number, opts: { agentId?: string; by: 'updatedAt' | 'createdAt'; includeArchived: boolean; projectId?: string; agentOk?: (agentId: string) => boolean }): string[] {
    if (k <= 0) return [];
    const arr = opts.agentId ? this.byAgent.get(opts.agentId) ?? [] : this.order;
    const ok = (e: Entry) => (opts.includeArchived || !e.archived) && (opts.projectId === undefined || e.projectId === opts.projectId) && (!opts.agentOk || opts.agentOk(e.agentId));
    if (opts.by === 'updatedAt') { const out: string[] = []; for (const e of arr) { if (ok(e)) { out.push(e.id); if (out.length >= k) break; } } return out; }
    const top: Entry[] = []; // sorted newest-created first, at most k long
    for (const e of arr) {
      if (!ok(e)) continue;
      if (top.length === k && !(e.createdAt > top[k - 1]!.createdAt || (e.createdAt === top[k - 1]!.createdAt && e.id > top[k - 1]!.id))) continue;
      let i = top.length;
      while (i > 0 && (e.createdAt > top[i - 1]!.createdAt || (e.createdAt === top[i - 1]!.createdAt && e.id > top[i - 1]!.id))) i--;
      top.splice(i, 0, e);
      if (top.length > k) top.pop();
    }
    return top.map((e) => e.id);
  }

  /** One page, newest first. `nextCursor` is null on the last page. Throws BadCursorError for a cursor that is not one of ours. */
  page(q: PageQuery): { ids: string[]; nextCursor: string | null } {
    const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(q.limit ?? PAGE_DEFAULT) || PAGE_DEFAULT));
    const arr = q.agentId ? this.byAgent.get(q.agentId) ?? [] : this.order;
    const start = q.cursor ? lowerBoundAfter(arr, decodeCursor(q.cursor)) : 0;
    const words = q.q ? tokenize(q.q, 8) : [];
    // per query word: the ids of tasks whose title has a word starting with it, and the agents whose name does
    const sets: Array<{ ids: Set<string>; agents: Set<string> }> = [];
    for (const w of words) {
      const ids = this.prefixIds(w);
      const agents = new Set<string>();
      if (q.agentNames) for (const [id, name] of q.agentNames) if (tokenize(name).some((x) => x.startsWith(w))) agents.add(id);
      if (ids.size === 0 && agents.size === 0) return { ids: [], nextCursor: null }; // a word nothing has: no scan at all
      sets.push({ ids, agents });
    }
    const seenAgent = new Map<string, boolean>();
    const agentOk = (id: string): boolean => { if (!q.agentOk) return true; let v = seenAgent.get(id); if (v === undefined) seenAgent.set(id, v = q.agentOk(id)); return v; };
    const out: Entry[] = [];
    for (let i = start; i < arr.length && out.length <= limit; i++) {
      const e = arr[i]!;
      if (e.archived && !q.includeArchived) continue;
      if (q.projectId !== undefined && e.projectId !== q.projectId) continue;
      if (!agentOk(e.agentId)) continue;
      let hit = true;
      for (const s of sets) if (!s.ids.has(e.id) && !s.agents.has(e.agentId)) { hit = false; break; }
      if (hit) out.push(e);
    }
    const more = out.length > limit;
    const page = more ? out.slice(0, limit) : out;
    return { ids: page.map((e) => e.id), nextCursor: more ? encodeCursor(page[page.length - 1]!) : null };
  }

  // ---- internals ----
  private drop(e: Entry): void {
    this.entries.delete(e.id);
    removeFrom(this.order, e);
    const a = this.byAgent.get(e.agentId);
    if (a) { removeFrom(a, e); if (a.length === 0) this.byAgent.delete(e.agentId); }
    for (const w of e.words) this.removeWord(w, e.id);
    this.live.delete(e.id);
  }

  private insertSorted(arr: Entry[], e: Entry): void { arr.splice(lowerBound(arr, e), 0, e); }

  private addWord(w: string, id: string): void { let s = this.tokens.get(w); if (!s) this.tokens.set(w, s = new Set()); s.add(id); }
  private addWordSorted(w: string, id: string): void {
    const had = this.tokens.has(w);
    this.addWord(w, id);
    if (!had) this.vocab.splice(vocabLower(this.vocab, w), 0, w);
  }
  private removeWord(w: string, id: string): void {
    const s = this.tokens.get(w);
    if (!s) return;
    s.delete(id);
    if (s.size === 0) { this.tokens.delete(w); const i = vocabLower(this.vocab, w); if (this.vocab[i] === w) this.vocab.splice(i, 1); }
  }

  /** Union of the id sets of every vocabulary word that starts with `prefix`. */
  private prefixIds(prefix: string): Set<string> {
    const exact = this.tokens.get(prefix);
    let i = vocabLower(this.vocab, prefix);
    const hits: Array<Set<string>> = [];
    for (; i < this.vocab.length && this.vocab[i]!.startsWith(prefix); i++) hits.push(this.tokens.get(this.vocab[i]!)!);
    if (hits.length === 1 && exact === hits[0]) return exact; // the common whole-word case: no copy (never mutated)
    const out = new Set<string>();
    for (const s of hits) for (const id of s) out.add(id);
    return out;
  }
}

/** First index of an entry strictly AFTER (older than) the key in list order. */
function lowerBoundAfter(arr: Entry[], key: { updatedAt: string; id: string }): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cmp(arr[mid]!, key) <= 0) lo = mid + 1; else hi = mid; }
  return lo;
}

function removeFrom(arr: Entry[], e: Entry): void {
  const i = lowerBound(arr, e);
  if (arr[i] === e) arr.splice(i, 1);
  else { const j = arr.indexOf(e); if (j >= 0) arr.splice(j, 1); } // unreachable while the order is consistent; never leave a ghost
}

function vocabLower(v: string[], w: string): number {
  let lo = 0, hi = v.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (v[mid]! < w) lo = mid + 1; else hi = mid; }
  return lo;
}
