/**
 * The title-bar usage panel hangs BELOW the bar and overrides the shared `.popover` placement (bottom, left/right, z-index, overflow).
 * Vite bundles usage.css (imported by the component) BEFORE app.css, so a rule with the same specificity as `.popover` loses and the
 * panel collapsed to a clipped 26px sliver (top and bottom both set). Pin that the override out-ranks `.popover` whatever the order.
 * The real-browser proof is the computed-style check in the fix report; this is the cheap source-level guard.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const usageCss = read('ui/src/styles/usage.css');
const appCss = read('ui/src/styles/app.css');

/** Specificity (ids, classes, elements) of a plain selector made of .class / tag parts. */
function specificity(sel: string): number {
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const tags = (sel.replace(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length;
  return classes * 100 + tags;
}

test('the usage panel placement rule out-ranks the shared .popover rule (CSS bundle order must not matter)', () => {
  const popover = /(^|\n)(\.popover)\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\)/.exec(appCss);
  assert.ok(popover, 'shared .popover rule (bottom-anchored) found in app.css');
  const m = /(^|\n)([^{\n/][^{\n]*?)\s*\{[^}]*top:\s*calc\(100% \+ 8px\)[^}]*bottom:\s*auto[^}]*\}/.exec(usageCss);
  assert.ok(m, 'usage panel placement rule found in usage.css');
  assert.ok(specificity(m![2]) > specificity('.popover'), `"${m![2]}" must be more specific than .popover, or the later-loaded app.css wins`);
  assert.match(m![0], /overflow:\s*visible/);
  assert.match(m![0], /z-index:\s*40/);
});
