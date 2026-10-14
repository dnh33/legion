/**
 * Dialogs sit under the title bar and are never clipped by the page they were opened from.
 *
 * The Work item dialog on a project's Board tab rendered in place, inside `.pg-scroll`. That element has a `mask-image`, and a mask clips every
 * descendant, `position: fixed` ones included: the dialog was cut off and faded at the top of the pane and the scrim only dimmed the pane.
 * So every `.scrim` renderer must go through a portal to document.body. The scrim covers the whole window; only the dialog box is kept below
 * the title bar (the bar is 40px, `--titlebar-h`).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const app = read('ui/src/styles/app.css');
const tokens = read('ui/src/styles/tokens.css');
const rule = (css: string, sel: string): string => { const at = css.indexOf(`\n${sel} {`); return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1); };
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : []; });
const tsx = walk(join(process.cwd(), 'ui/src')).map((p) => ({ p, src: readFileSync(p, 'utf8') }));

test('every component that renders className="scrim" portals it to document.body', () => {
  const renderers = tsx.filter(({ src }) => /className="scrim[ "]/.test(src));
  assert.ok(renderers.length >= 2, 'found Modal and CommandPalette');
  for (const { p, src } of renderers) {
    assert.match(src, /from 'react-dom'/, `${p} imports createPortal`);
    assert.match(src, /createPortal\([\s\S]*document\.body,?\s*\)/, `${p} portals to document.body`);
  }
});

test('Modal returns the portal, not the bare scrim, so a masked or transformed ancestor cannot clip it', () => {
  const modal = read('ui/src/components/Modal.tsx');
  assert.match(modal, /createPortal\(dialog, document\.body\)/);
  assert.doesNotMatch(modal, /return dialog;|return \(\s*<div className="scrim"/);
});

test('one --titlebar-h token sizes the title bar row', () => {
  assert.match(tokens, /--titlebar-h: 40px;/);
  assert.match(rule(app, '.app'), /grid-template-rows: var\(--titlebar-h\) minmax\(0, 1fr\)/);
});

test('.scrim covers the whole window; the dialog box starts below the title bar and is capped to the space left', () => {
  const scrim = rule(app, '.scrim');
  assert.match(scrim, /position: fixed; inset: 0;/);
  assert.match(scrim, /padding: calc\(var\(--titlebar-h\) \+ 16px\) 24px 24px/);
  const modal = rule(app, '.modal');
  assert.match(modal, /max-height: calc\(100vh - var\(--titlebar-h\) - 48px\)/);
  assert.match(modal, /flex-direction: column/);
  assert.match(app, /\.modal-body \{[^}]*overflow-y: auto/);
});

test('the command palette keeps its place, 12vh from the window top', () => {
  assert.match(rule(app, '.scrim.top'), /padding-top: 12vh/);
});

test('other fixed pieces use the token instead of a hard-coded 40px or 48px', () => {
  assert.match(read('ui/src/ci/ci.css'), /\.fp-dock \{[^}]*top: var\(--titlebar-h\)/);
  assert.match(read('ui/src/bsv/bsv.css'), /\.chain-overlay \{[^}]*height: var\(--titlebar-h\)/);
  assert.match(read('ui/src/bsv/bsv.css'), /\.bsv-pill \{[^}]*top: calc\(var\(--titlebar-h\) \+ 8px\)/);
  assert.match(read('ui/src/mascot/takeover.css'), /\.takeover \{[^}]*top: calc\(var\(--titlebar-h\) \+ 8px\)/);
  assert.match(read('src/electron/main.ts'), /--titlebar-h/, 'main.ts points at --titlebar-h');
});
