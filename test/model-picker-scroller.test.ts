/** Model picker layout guards (PR #165 round 3): one scrolling list with the Older head pinned in it, and a highlight that is a tint, never a ring. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/** The pinned Older head (27.75px border-box at 960x600) plus the list's own 4px bottom padding, which the head sits above. */
const OLDER_HEAD_HEIGHT = 32;

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

describe('model picker: the highlight is never hidden behind the pinned head (round 4)', () => {
  it("the list reserves the pinned Older head's height at its bottom, so a keyboard-scrolled row stops above it", () => {
    const list = rulesMentioning('.pop-list').find((r) => /overflow-y:\s*auto/.test(r.body));
    assert.ok(list, 'no .pop-list rule');
    const pad = /scroll-padding-bottom:\s*(\d+)px/.exec(list.body);
    assert.ok(pad, `.pop-list has no scroll-padding-bottom: ${list.body}`);
    // the pinned head's border-box height (its 1px top border included), measured in the harness at 960x600
    assert.equal(Number(pad[1]), OLDER_HEAD_HEIGHT);
  });
});

describe('model picker: mouse and focus (round 4)', () => {
  const rowBody = (name: string) => {
    const i = tsx.indexOf(`const ${name} = `);
    assert.ok(i >= 0, `no ${name} in ModelPicker.tsx`);
    return tsx.slice(i, tsx.indexOf('return (', i));
  };
  it('a mouse press on a head or a row does not move focus out of the search field', () => {
    for (const name of ['itemRow', 'headRow']) assert.match(rowBody(name), /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/, name);
  });
  it('only a key moves the list to the highlight: hover never scrolls it', () => {
    assert.match(tsx, /scrollOnKey/, 'the highlight scroll must be gated by a key-set flag');
  });
});

describe('model picker: accessibility (round 4)', () => {
  it('the search field is the combobox: it carries expanded, controls and the active option', () => {
    const input = /<input className="mp-search"[\s\S]*?\/>/.exec(tsx)?.[0] ?? '';
    assert.match(input, /role="combobox"/);
    assert.match(input, /aria-expanded=/);
    assert.match(input, /aria-controls="mp-listbox"/);
    assert.match(input, /aria-activedescendant=/);
  });
  it('the listbox does not carry aria-activedescendant, and the no-match status sits outside it', () => {
    const listbox = /<div className="pop-body"[^>]*>/.exec(tsx)?.[0] ?? '';
    assert.match(listbox, /role="listbox"/);
    assert.doesNotMatch(listbox, /aria-activedescendant/);
    const empty = tsx.indexOf('className="mp-empty"');
    const foot = tsx.indexOf('<div className="pop-foot">');
    assert.ok(empty > tsx.indexOf('role="listbox"') && empty < foot, 'the no-match line must follow the listbox, not sit inside it');
    assert.doesNotMatch(tsx.slice(tsx.indexOf('role="listbox"'), empty), /role="status"/, 'the status is not inside the listbox');
  });
  it('a group head reports whether it is open', () => {
    assert.match(tsx, /aria-expanded=\{h\.open\}/);
  });
});

describe('model picker: failed refresh (round 4)', () => {
  it('the failed line offers Retry for that provider, and shows no raw error text', () => {
    assert.match(tsx, /retryModels\(failed\.id\)/);
    assert.doesNotMatch(tsx, /\{failed\.modelsError\}/, 'the raw error must not reach the footer');
  });
});
