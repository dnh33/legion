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
  assert.match(s, /aria-pressed=\{choice === 'run'\}[^
]*>Run anyway</);
  assert.match(s, /aria-pressed=\{choice === 'after'\}[^
]*>Queue after it</);
});
