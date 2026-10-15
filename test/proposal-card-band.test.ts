/**
 * The proposal card and its sticky action row share one solid tint, so the row never shows as a band over the card (the card's warn gradient
 * used to make a flat row stand out in light mode). A guard on the CSS: the row takes the card's token, and has no gradient of its own except
 * the fade above it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'ui/src/styles/app.css'), 'utf8');
const rule = (selector: string): string => {
  const i = css.indexOf(`${selector} {`);
  assert.ok(i >= 0, `${selector} is in app.css`);
  return css.slice(i, css.indexOf('}', i));
};

test('the proposal card and its action row take the same tint token; the card has no gradient over it', () => {
  assert.match(css, /\.proposal-cards \{ --card-tint: color-mix\(in srgb, var\(--warn\) 10%, var\(--surface\)\); \}/);
  assert.match(rule('.proposal-cards .approval'), /background: var\(--card-tint\)/);
  assert.match(rule('.proposal-actions'), /background: var\(--card-tint\)/, 'the row is the card\'s own colour at its position');
  assert.doesNotMatch(rule('.proposal-actions'), /linear-gradient/, 'the row has no gradient of its own');
  assert.doesNotMatch(rule('.proposal-cards .approval'), /linear-gradient/, 'the card has no gradient to differ from');
});
