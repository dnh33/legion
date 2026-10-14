/**
 * Dialogs must never reach the title bar: it is an Electron drag region, which swallows clicks over its rectangle even when something is drawn
 * above it. The shared scrim starts below the bar and the dialog is capped to what is left, so the Work item dialog (and every other one) stays
 * whole and clickable in a short window. The project task sheet sits in .pg-area, a grid row under the bar, so it cannot overlap it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const app = read('ui/src/styles/app.css');
const tokens = read('ui/src/styles/tokens.css');
const rule = (css: string, sel: string): string => { const at = css.indexOf(`
${sel} {`); return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1); };

test('one --titlebar-h token sizes the title bar row', () => {
  assert.match(tokens, /--titlebar-h: 40px;/);
  assert.match(rule(app, '.app'), /grid-template-rows: var\(--titlebar-h\) minmax\(0, 1fr\)/);
});

test('.scrim starts below the title bar and .modal is capped to the space left', () => {
  assert.match(rule(app, '.scrim'), /position: fixed; inset: var\(--titlebar-h\) 0 0 0;/);
  const modal = rule(app, '.modal');
  assert.match(modal, /max-height: calc\(100vh - var\(--titlebar-h\) - 48px\)/);
  assert.match(modal, /flex-direction: column/);
  assert.match(app, /\.modal-body \{[^}]*overflow-y: auto/);
});

test('the project task sheet stays inside .pg-area, which is not positioned over the title bar', () => {
  const sheet = read('ui/src/projects/page/sheet.css');
  assert.match(sheet, /\.pg-sheet \{ position: absolute; top: 0;/);
  assert.match(read('ui/src/projects/page/page.css'), /\.pg-area \{ position: relative;[^}]*overflow: clip;/);
});

test('the command palette keeps its place: 12vh measured from the window top, not pushed down by the inset', () => {
  assert.match(rule(app, '.scrim.top'), /padding-top: max\(24px, calc\(12vh - var\(--titlebar-h\)\)\)/);
});
