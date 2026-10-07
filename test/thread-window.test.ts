/** The long-conversation window (ui/src/chat/threadWindow.ts): paging merges, variable-height windowing, scroll anchoring, hit lookup. Pure, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/shared/types.js';
import {
  OLDER_THRESHOLD_PX, ROW_ESTIMATE, ROW_GAP, anchoredScrollTop, hasOlder, layoutOffsets, loadedHas, metaDetached, prependPage, reconcileNewest, rowAt, rowIndexOfMessage, scrollForRow,
  shouldLoadOlder, visibleRange, type ThreadMeta,
} from '../ui/src/chat/threadWindow.js';

const m = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, taskId: 't', role: 'assistant', text: id, at: '2026-01-01T00:00:' + id.replace(/\D/g, '').padStart(2, '0') + 'Z', ...over });
const meta = (o: Partial<ThreadMeta> = {}): ThreadMeta => ({ start: 100, end: 200, total: 200, loadingOlder: false, ...o });

test('prependPage puts older rows above and keeps a row that is in both pages once', () => {
  const out = prependPage([m('m5'), m('m6')], [m('m3'), m('m4'), m('m5')]);
  assert.deepEqual(out.map((x) => x.id), ['m3', 'm4', 'm5', 'm6']);
});

test('reconcileNewest keeps rows that arrived live after the page, drops optimistic echoes and rows from older pages', () => {
  const page = [m('m10'), m('m11')];
  const live = [m('m2'), m('m10'), m('m11'), m('m12'), m('tmp-1', { at: '2026-01-01T00:00:59Z' })];
  assert.deepEqual(reconcileNewest(live, page).map((x) => x.id), ['m10', 'm11', 'm12']);
});

test('shouldLoadOlder: near the top, more above, not already loading, no error', () => {
  assert.equal(shouldLoadOlder(100, meta()), true);
  assert.equal(shouldLoadOlder(OLDER_THRESHOLD_PX + 1, meta()), false);
  assert.equal(shouldLoadOlder(0, meta({ start: 0 })), false, 'nothing above');
  assert.equal(shouldLoadOlder(0, meta({ loadingOlder: true })), false);
  assert.equal(shouldLoadOlder(0, meta({ error: 'x' })), false, 'no retry loop on an error');
  assert.equal(shouldLoadOlder(0, undefined), false);
  assert.equal(hasOlder(meta()), true); assert.equal(metaDetached(meta({ end: 150 })), true); assert.equal(metaDetached(meta()), false);
  assert.equal(loadedHas(meta(), 100), true); assert.equal(loadedHas(meta(), 99), false); assert.equal(loadedHas(meta(), 200), false);
});

test('offsets use measured heights and the estimate for rows not drawn yet; rowAt finds the row at a y', () => {
  const heights = new Map([['a', 50], ['c', 300]]);
  const off = layoutOffsets(['a', 'b', 'c', 'd'], heights);
  assert.deepEqual(off, [0, 50 + ROW_GAP, 50 + ROW_GAP + ROW_ESTIMATE + ROW_GAP, 50 + ROW_GAP + ROW_ESTIMATE + ROW_GAP + 300 + ROW_GAP, 50 + ROW_GAP + ROW_ESTIMATE + ROW_GAP + 300 + ROW_GAP + ROW_ESTIMATE + ROW_GAP]);
  assert.equal(rowAt(off, 0), 0); assert.equal(rowAt(off, off[1]! - 1), 0); assert.equal(rowAt(off, off[1]!), 1); assert.equal(rowAt(off, 1e9), 3); assert.equal(rowAt(off, -5), 0);
  assert.equal(rowAt([0], 10), 0, 'no rows');
});

test('visibleRange draws a small slice of a long list, with spacers that add up to the whole', () => {
  const keys = Array.from({ length: 5000 }, (_, i) => 'k' + i);
  const heights = new Map(keys.map((k, i) => [k, 40 + (i % 7) * 30] as [string, number]));
  const off = layoutOffsets(keys, heights);
  const total = off[off.length - 1]!;
  for (const top of [0, 12345, 400000, total - 700, 1e12]) {
    const w = visibleRange(off, top, 700);
    assert.ok(w.end - w.start < 60, `drew ${w.end - w.start} rows at ${top}`);
    const drawn = off[w.end]! - off[w.start]!;
    assert.equal(w.padTop + drawn + w.padBottom, total, 'spacers + rows = total height');
    const eff = Math.min(top, total - 700);
    assert.ok(off[w.start]! <= eff && off[w.end]! >= eff + 700, 'the viewport is covered');
  }
  assert.deepEqual(visibleRange([0], 0, 700), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  const tail = visibleRange(off, Number.MAX_SAFE_INTEGER, 700);
  assert.equal(tail.end, 5000, 'far down means the tail');
});

test('anchoring: after rows are put above, the row the reader was on keeps its place on screen', () => {
  const keys = ['a', 'b', 'c', 'd'];
  const before = layoutOffsets(keys, new Map(), 100, 10); // rows 110 apart
  const scrollTop = 150;
  const i = rowAt(before, scrollTop); // row b (offset 110)
  const rowTop = before[i]! - scrollTop; // -40: partly scrolled out
  const after = layoutOffsets(['x', 'y', 'z', ...keys], new Map(), 100, 10); // three older rows above
  const j = ['x', 'y', 'z', ...keys].indexOf(keys[i]!);
  const next = anchoredScrollTop(after[j]!, rowTop);
  assert.equal(after[j]! - next, rowTop, 'same distance from the top of the viewport');
  assert.equal(next, scrollTop + 330);
  assert.equal(anchoredScrollTop(5, 100), 0, 'never negative');
  assert.equal(scrollForRow(after, 3, 60), after[3]! - 60);
  assert.equal(scrollForRow(after, 0, 60), 0);
});

test('rowIndexOfMessage: a result row resolves to its call\'s chip, a missing id to -1', () => {
  const messages = [m('u1', { role: 'user' }), m('c1', { role: 'tool', toolUseId: 'x' }), m('a1'), m('r1', { role: 'tool', resultFor: 'x' }), m('c2', { role: 'tool', toolUseId: 'y' })];
  const items = [{ k: 'msg' as const, m: messages[0]! }, { k: 'tools' as const, items: [messages[1]!] }, { k: 'msg' as const, m: messages[2]! }, { k: 'tools' as const, items: [messages[4]!] }];
  assert.equal(rowIndexOfMessage(items, messages, 'u1'), 0);
  assert.equal(rowIndexOfMessage(items, messages, 'c1'), 1);
  assert.equal(rowIndexOfMessage(items, messages, 'r1'), 1);
  assert.equal(rowIndexOfMessage(items, messages, 'a1'), 2);
  assert.equal(rowIndexOfMessage(items, messages, 'gone'), -1);
});
