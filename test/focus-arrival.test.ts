/** A click that opens an Inbox entry or a proposal card: the target is brought into view and takes focus once the layout settles (what the tour's callout shifts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSheet, closeSheetKeepFocus } from '../ui/src/projects/page/sheetState.js';
import { SETTLE_MS, inView, keepSettling } from '../ui/src/projects/focusSettle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...p: string[]): string => readFileSync(join(root, 'ui', 'src', ...p), 'utf8');

test('closing the sheet for an ask returns no focus: the target the click opens keeps it', () => {
  const frames: Array<() => void> = [];
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number };
  const saved = g.requestAnimationFrame;
  g.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  try {
    closeSheetKeepFocus();
    assert.equal(frames.length, 0, 'no frame is queued that would focus "New task" after the Inbox entry');
    closeSheet();
    assert.equal(frames.length, 1, 'the default still hands focus back to the opener');
  } finally {
    g.requestAnimationFrame = saved;
  }
});

test('the settle window runs for about a second after the click and ends early when the owner acts', () => {
  assert.equal(SETTLE_MS, 1000);
  assert.equal(keepSettling(1000, 1000), true);
  assert.equal(keepSettling(1000, 1000 + SETTLE_MS - 1), true, 'a tour callout lands within the window');
  assert.equal(keepSettling(1000, 1000 + SETTLE_MS + 1), false);
  assert.equal(keepSettling(1000, 1200, true), false, 'a key, click or scroll by the owner ends it');
});

test('inView: the target box is fully inside the scroll view, edges included', () => {
  const view = { top: 100, bottom: 400 };
  assert.equal(inView({ top: 120, bottom: 300 }, view), true);
  assert.equal(inView({ top: 380, bottom: 420 }, view), false, 'cut at the bottom');
  assert.equal(inView({ top: 50, bottom: 150 }, view), false, 'cut at the top');
  assert.equal(inView({ top: 120, bottom: 120 }, view), false, 'an empty box is not in view');
});

test('the Board and the proposal card hand their target to settleFocus, and the board opens without returning focus to the sheet', () => {
  assert.match(src('projects', 'board', 'BoardPanel.tsx'), /settleFocus\(el\)/);
  assert.match(src('components', 'ProposalCards.tsx'), /settleFocus\(el\)/);
  assert.match(src('projects', 'projectsStore.ts'), /closeSheetKeepFocus\(\)/);
});
