/** Model picker layout guards (PR #165 round 3): one scrolling list with the Older head pinned in it, and a highlight that is a tint, never a ring. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const tsx = readFileSync(join(process.cwd(), 'ui', 'src', 'components', 'ModelPicker.tsx'), 'utf8');
const css = readFileSync(join(process.cwd(), 'ui', 'src', 'styles', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule (selector and declarations) whose selector list mentions `needle`. */
function rulesMentioning(needle: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    if (!selector.startsWith('@') && selector.includes(needle)) out.push({ selector, body: m[2]!.trim() });
  }
  return out;
}

describe('model picker: one scroller', () => {
  it('the Older models rows no longer have a scroller of their own', () => {
    assert.equal(tsx.includes('mp-older-rows'), false, 'ModelPicker.tsx still renders a second list container');
  });
  it('the only scrolling element in the picker is the list', () => {
    const scrollers = css.match(/[^{};]+\{[^{}]*overflow-y:\s*(auto|scroll)[^{}]*\}/g) ?? [];
    const picker = scrollers.map((r) => r.slice(0, r.indexOf('{')).trim()).filter((s) => /\.(mp-|pop-|model-pop)/.test(s));
    assert.deepEqual(picker, ['.pop-list']);
  });
  it('the Older head is a sticky row of the list, pinned to its bottom edge', () => {
    const head = rulesMentioning('.mp-older-head');
    assert.ok(head.length >= 1, 'no .mp-older-head rule');
    const sticky = head.find((r) => /position:\s*sticky/.test(r.body) && /bottom:\s*0/.test(r.body));
    assert.ok(sticky, `no sticky bottom:0 rule for the Older head: ${JSON.stringify(head)}`);
    assert.match(sticky.body, /background:\s*var\(--surface-2\)/, 'the pinned head must be opaque');
  });
  it('the list grows the Older head to the top when it expands (the scroll is in ModelPicker)', () => {
    assert.match(tsx, /useLayoutEffect/, 'expand and collapse scroll in a layout effect');
  });
});

describe('model picker: the highlight is a tint, never a ring', () => {
  it('no highlighted row draws an outline, border ring or box-shadow, with or without kbd-nav', () => {
    const rows = rulesMentioning('.hl').filter((r) => /\.mp-(item|head)\.hl/.test(r.selector));
    assert.ok(rows.length >= 2, 'expected rules for the item and head highlight');
    for (const r of rows) {
      assert.doesNotMatch(r.body, /outline\s*:\s*(?!none|0)/, `${r.selector} draws an outline`);
      assert.doesNotMatch(r.body, /box-shadow/, `${r.selector} draws a box-shadow ring`);
    }
  });
  it('a highlighted head gets the same tint as a highlighted row', () => {
    const headTint = rulesMentioning('.mp-head.hl').find((r) => /background:\s*var\(--surface-3\)/.test(r.body));
    assert.ok(headTint, 'no tint rule for a highlighted head');
  });
});
