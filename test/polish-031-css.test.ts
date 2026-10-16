/**
 * 0.3.1 layout polish, read from the real ui/src/styles/app.css (the same comment-stripped source thread-css.test.ts uses):
 * - the approval card's auto-deny note wraps inside the card at narrow widths and at 1.5x zoom, never past its border;
 * - the welcome step titles take the full row when the button no longer fits beside them (a container query on the firstrun card).
 * The browser render of the same CSS is the state matrix in the 0.3.1 polish report.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CSS = readFileSync(join(REPO, 'ui/src/styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration block whose selector list names `selector` exactly, joined in source order. */
function declsOf(selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    const sels = m[1]!.split(',').map((s) => s.trim().split(/\s+/).pop());
    if (sels.includes(selector)) out.push(m[2]!);
  }
  return out.join(';');
}

test('0.3.1 the approval actions wrap, and the auto-deny note can never be wider than the card', () => {
  assert.match(declsOf('.approval-actions'), /flex-wrap:\s*wrap/, 'the action row wraps when the note does not fit beside the buttons');
  const note = declsOf('.approval-note');
  assert.match(note, /max-width:\s*100%/, 'the note is at most the card width');
  assert.match(note, /min-width:\s*0/, 'the note may shrink, so it never pushes the buttons out');
});

test('0.3.1 the welcome step titles get the full row when the button wraps below them', () => {
  assert.match(declsOf('.firstrun'), /container-type:\s*inline-size/, 'the card is a size container');
  // the @container block, found by brace matching (its rules nest inside it)
  const at = CSS.indexOf('@container');
  assert.ok(at >= 0, 'a @container rule exists for the narrow card');
  let depth = 0; let end = -1;
  for (let i = CSS.indexOf('{', at); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) { end = i; break; }
  }
  const block = CSS.slice(at, end + 1);
  assert.match(block, /\.steps li\s*\{[^}]*grid-template-columns/, 'the narrow card lays the step out on a grid');
  assert.match(block, /\.steps li > \.btn\s*\{[^}]*grid-column:\s*2/, 'the button moves under the title, in the text column');
});

test('0.3.1 a dialog never wider than the window: the scrim grid track shrinks to the viewport, so a 640px dialog at 640 CSS px keeps its close button on screen', () => {
  assert.match(declsOf('.scrim'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'the one column is at most the scrim width, so the modal max-width:100% applies');
});
