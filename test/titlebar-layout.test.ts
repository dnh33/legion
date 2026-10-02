/**
 * Title bar: the BSV ticker lives in a position:fixed overlay that is measured from the search box and the right-hand cluster. These tests pin
 * the rules that keep it from overlapping the view tabs (the real-browser proof is test-perf/ui-app/titlebar-shots.mjs: five widths, Doctor
 * chip in both states, geometry asserts and screenshots; it needs Playwright, so it is not part of `npm test`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const overlay = read('ui/src/bsv/ChainOverlay.tsx');
const bsvCss = read('ui/src/bsv/bsv.css');
const appCss = read('ui/src/styles/app.css');

test('the ticker is re-measured when the search box or the right-hand cluster changes width, not only when the bar does', () => {
  // the Doctor chip grows to "1 to fix" after the checks come back; the bar itself does not resize, so observing it alone left a stale slot
  for (const sel of ['.titlebar', '.tb-search', '.tb-right']) assert.match(overlay, new RegExp(`'\\${sel}'`), `${sel} is observed`);
  assert.match(overlay, /ro\.observe\(el\)/);
  assert.match(overlay, /document\.fonts\?\.ready/);
});

test('the ticker keeps a gap on both sides and uses a conservative character width', () => {
  assert.match(overlay, /const TICKER_GAP = 1[4-9]|const TICKER_GAP = [2-9]\d/);
  const ch = Number(/const TICKER_CH = ([\d.]+)/.exec(overlay)?.[1]);
  assert.ok(ch >= 6.2 && ch <= 7, `TICKER_CH ${ch}`);
  assert.match(overlay, /right\.left - TICKER_GAP - left/);
});

test('backstop: ticker lines are clipped inside their slot', () => {
  assert.match(bsvCss, /\.chain-ticker span\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*text-align:\s*center/);
  assert.match(bsvCss, /\.chain-ticker\s*\{[^}]*align-items:\s*stretch/); // lines span the slot, so the ellipsis has a width to clip against
  assert.match(bsvCss, /\.chain-ticker\s*\{[^}]*overflow:\s*hidden/);
});

test('the search box keeps its left edge in narrow windows (the brand has a fixed width there, it no longer absorbs the free space)', () => {
  const m = /@media \(max-width: 1100px\) \{ \.tb-search[^\n]*/.exec(appCss);
  assert.ok(m, 'narrow title-bar rule found');
  assert.match(m[0], /\.tb-brand \{ flex: none; width: \d+px; \}/);
  assert.doesNotMatch(m[0], /\.tb-brand \{ flex: 1/);
});
