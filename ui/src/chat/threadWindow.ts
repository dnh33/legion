/**
 * A long conversation (thousands of rows) is paged from the core and drawn through a window. Pure (types only), so node tests can run it.
 *   - paging: what the store knows about one thread (`ThreadMeta`) and how pages merge into the loaded list;
 *   - windowing: rows have variable heights, so offsets come from measured heights (an estimate for rows not yet drawn) and the visible range is a
 *     binary search over them;
 *   - anchoring: after older rows are put above, the scroll position is moved so the row the reader was looking at stays where it was.
 */
import type { ChatMessage } from '../../../src/shared/types.js';

/** Positions are in the core's stored order, which only grows at the end: start is the first loaded position, end one past the last, total the thread's length. */
export interface ThreadMeta { start: number; end: number; total: number; loadingOlder: boolean; error?: string }

export const OLDER_THRESHOLD_PX = 600;
export const ROW_GAP = 14;
export const ROW_ESTIMATE = 96;

export const metaDetached = (m: ThreadMeta | undefined): boolean => !!m && m.end < m.total;
export const hasOlder = (m: ThreadMeta | undefined): boolean => !!m && m.start > 0;

/** Put an older page above what is loaded. Rows already loaded (same id) are kept once, from the new page. */
export function prependPage(cur: readonly ChatMessage[], page: readonly ChatMessage[]): ChatMessage[] {
  const have = new Set(page.map((m) => m.id));
  return [...page, ...cur.filter((m) => !have.has(m.id))];
}

/** A reload of the newest page: the page, then rows that arrived live after it (never the older pages loaded before, never optimistic `tmp-` echoes). */
export function reconcileNewest(live: readonly ChatMessage[], page: readonly ChatMessage[]): ChatMessage[] {
  const ids = new Set(page.map((m) => m.id));
  const last = page[page.length - 1]?.at ?? '';
  return [...page, ...live.filter((m) => !ids.has(m.id) && !m.id.startsWith('tmp-') && m.at > last)];
}

/** An older page is due when the reader is near the top and there is more above. */
export const shouldLoadOlder = (scrollTop: number, m: ThreadMeta | undefined): boolean => !!m && m.start > 0 && !m.loadingOlder && !m.error && scrollTop < OLDER_THRESHOLD_PX;

/** offsets[i] is the top of row i, offsets[n] the total height. Heights not measured yet use the estimate. */
export function layoutOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate = ROW_ESTIMATE, gap = ROW_GAP): number[] {
  const off = new Array<number>(keys.length + 1);
  let y = 0;
  for (let i = 0; i < keys.length; i++) { off[i] = y; y += (heights.get(keys[i]!) ?? estimate) + gap; }
  off[keys.length] = y;
  return off;
}

/** Index of the row containing y (clamped). */
export function rowAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (offsets[mid]! <= y) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Rows to draw for a scroll position, with `overscan` px above and below, and the spacer heights that stand in for the rest. */
export function visibleRange(offsets: readonly number[], scrollTop: number, viewH: number, overscan = 600): { start: number; end: number; padTop: number; padBottom: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const total = offsets[n]!;
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total - viewH));
  const start = rowAt(offsets, top - overscan);
  const end = Math.min(n, rowAt(offsets, top + viewH + overscan) + 1);
  return { start, end, padTop: offsets[start]!, padBottom: total - offsets[end]! };
}

/** New scrollTop that keeps a row where it was: `rowTop` is where the row sat relative to the viewport before the change, `newOffset` its offset now. */
export const anchoredScrollTop = (newOffset: number, rowTop: number): number => Math.max(0, newOffset - rowTop);

/** Scroll position that shows row `i` near the top, with a little room. */
export const scrollForRow = (offsets: readonly number[], i: number, room = 60): number => Math.max(0, (offsets[Math.max(0, Math.min(i, offsets.length - 1))] ?? 0) - room);

/**
 * The index of the drawn row (a message, or a group of tool rows with their results) that holds message `id`. A result row is drawn inside its call's
 * chip, so it resolves to the call's row. -1 when it is not loaded.
 */
export function rowIndexOfMessage(items: ReadonlyArray<{ k: 'msg'; m: ChatMessage } | { k: 'tools'; items: ChatMessage[] }>, messages: readonly ChatMessage[], id: string): number {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return -1;
  const target = msg.resultFor ? messages.find((m) => m.toolUseId === msg.resultFor)?.id ?? id : id;
  return items.findIndex((it) => (it.k === 'msg' ? it.m.id === target : it.items.some((x) => x.id === target)));
}

/** The loaded range as a message-array index window containing position `index` (positions map to the array through meta.start). */
export const loadedHas = (m: ThreadMeta | undefined, index: number): boolean => !!m && index >= m.start && index < m.end;
