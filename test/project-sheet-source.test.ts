/** Source checks for the sheet and the Settings tab: the accessibility roles and the "mint only on New task" rule. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string): string => readFileSync(join(process.cwd(), 'ui', 'src', 'projects', 'page', f), 'utf8').replace(/\r/g, '');

test('the sheet is a non-modal dialog region with a way to close it', () => {
  const s = read('Sheet.tsx');
  assert.match(s, /role="dialog" aria-modal="false"/);
  assert.match(s, /data-region="sheet"/);
  assert.match(s, /aria-label="Close the task"/);
  assert.match(s, /Escape/);
});

test('Start task and Confirm are neutral: only the page\'s New task button is mint', () => {
  const s = read('Sheet.tsx') + read('SettingsTab.tsx') + read('Digest.tsx');
  assert.equal(/className="pg-btn primary"/.test(s), false);
  const css = read('settings.css') + read('sheet.css');
  assert.equal(/var\(--accent|var\(--live/.test(css.replace(/\.pg-card\[data-kind=working\][^}]*\}/, '')), false, 'switches, segments and the sheet use no mint');
  assert.match(read('ProjectPage.tsx'), /className="pg-btn primary"/);
});

test('settings controls are real switches and radios with names', () => {
  const s = read('SettingsTab.tsx');
  assert.match(s, /role="switch"/);
  assert.match(s, /role="radiogroup"/);
  assert.match(s, /aria-label="Minutes before the run parks"/);
  assert.match(s, /role="alert"/);
});

test('the second-run box offers exactly the two spec choices as pressed buttons', () => {
  const s = read('Sheet.tsx');
  assert.match(s, /aria-pressed=\{choice === 'run'\}.*>Run anyway</);
  assert.match(s, /aria-pressed=\{choice === 'after'\}.*>Queue after it</);
});

test('the Best fit copy says what the code does: the member with the fewest running tasks, chosen by Legion, not read by the Marshal', () => {
  const s = read('Sheet.tsx');
  assert.equal(/Marshal/.test(s), false, 'Best fit is chosen in the window by counting runs; no Marshal is involved');
  assert.match(s, /Legion picks the member with the fewest running tasks/);
  assert.equal(/[–—]/.test(s), false, 'no em or en dash');
});

test('the Settings section nav wraps in the narrow layout: no sideways scroll, so the legend is never clipped', () => {
  const css = read('settings.css');
  const narrow = /@container pg \(max-width: 760px\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
  const snav = /\.pg-snav \{[^}]*\}/.exec(narrow)?.[0] ?? '';
  assert.ok(snav, 'the narrow .pg-snav rule exists');
  assert.match(snav, /flex-wrap:\s*wrap/);
  assert.equal(/overflow-x:\s*(auto|scroll)/.test(snav), false, snav);
});
