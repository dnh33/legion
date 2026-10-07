/**
 * Paging and search over one task's messages (a thread can reach thousands of rows). Pure functions over the in-order list the Store keeps in memory
 * (`Store.loadMessages` parses a thread's jsonl once, on first read; append-only, so a message's position never changes and a position is a stable cursor).
 *
 * A window is [start, end) of positions. Tool calls (`toolUseId`) and their results (`resultFor`) are separate rows that the UI draws as one chip, so a
 * window never splits a pair: a result whose call is older than the window pulls `start` back to that call, and in `from` mode (a jump into the middle,
 * detached from the live end) a call whose result is newer pulls `end` forward. The window can therefore be a few rows larger than `limit`.
 */
import type { ChatMessage } from '../shared/types.js';

export const MSG_PAGE_DEFAULT = 100;
export const MSG_PAGE_MAX = 300;
export const HITS_MAX = 100;

export interface MsgWindow { start: number; end: number; total: number }
export interface MsgHit { index: number; id: string; role: ChatMessage['role']; snippet: string }

const clampInt = (n: number | undefined, lo: number, hi: number, dflt: number): number => (n === undefined || !Number.isFinite(n) ? dflt : Math.min(hi, Math.max(lo, Math.floor(n))));

export function messageWindow(list: readonly ChatMessage[], o: { before?: number; from?: number; limit?: number }): MsgWindow {
  const total = list.length;
  const limit = clampInt(o.limit, 1, MSG_PAGE_MAX, MSG_PAGE_DEFAULT) || MSG_PAGE_DEFAULT;
  let start: number, end: number;
  if (o.from !== undefined && Number.isFinite(o.from)) { start = clampInt(o.from, 0, total, 0); end = Math.min(total, start + limit); }
  else { end = clampInt(o.before, 0, total, total); start = Math.max(0, end - limit); }
  // results whose call is older than the window
  const callAt = new Map<string, number>();
  const needed = new Set<string>();
  for (let i = start; i < end; i++) { const m = list[i]!; if (m.toolUseId) callAt.set(m.toolUseId, i); }
  for (let i = start; i < end; i++) { const r = list[i]!.resultFor; if (r && !callAt.has(r)) needed.add(r); }
  for (let i = start - 1; i >= 0 && needed.size; i--) { const u = list[i]!.toolUseId; if (u && needed.delete(u)) start = i; }
  // calls whose result is newer than a detached window
  if (o.from !== undefined && end < total) {
    const resultIn = new Set<string>();
    for (let i = start; i < end; i++) { const r = list[i]!.resultFor; if (r) resultIn.add(r); }
    const wait = new Set<string>();
    for (let i = start; i < end; i++) { const u = list[i]!.toolUseId; if (u && !resultIn.has(u)) wait.add(u); }
    for (let i = end; i < total && wait.size; i++) { const r = list[i]!.resultFor; if (r && wait.delete(r)) end = i + 1; }
  }
  return { start, end, total };
}

/** Case-insensitive substring search of what the caller may read (`view` applies the withholding), newest first, at most HITS_MAX. */
export function searchMessages(list: readonly ChatMessage[], q: string, view: (m: ChatMessage) => ChatMessage = (m) => m): { hits: MsgHit[]; total: number } {
  const needle = q.trim().toLowerCase().slice(0, 200);
  const hits: MsgHit[] = [];
  if (!needle) return { hits, total: list.length };
  for (let i = list.length - 1; i >= 0 && hits.length < HITS_MAX; i--) {
    const m = view(list[i]!);
    const at = m.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const from = Math.max(0, at - 40);
    hits.push({ index: i, id: m.id, role: m.role, snippet: (from > 0 ? '…' : '') + m.text.slice(from, from + 120).replace(/\s+/g, ' ') });
  }
  return { hits, total: list.length };
}
