/** Keyboard-only focus rings: the module that sets data-kbd-nav, and a source guard that every ring in the UI CSS sits under it. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { KBD_ATTR, startKbdNav } from '../ui/src/a11y/kbdNav.js';
import { FOCUS_RINGS_ATTR, FOCUS_RINGS_KEY, applyFocusRings, readFocusRings, setFocusRings } from '../ui/src/a11y/focusRings.js';

function fakeDoc() {
  const attrs = new Set<string>();
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  return {
    attrs,
    documentElement: { setAttribute: (n: string) => { attrs.add(n); }, removeAttribute: (n: string) => { attrs.delete(n); } },
    addEventListener: (t: string, f: (e: never) => void) => { handlers.set(t, [...(handlers.get(t) ?? []), f as (e: unknown) => void]); },
    removeEventListener: (t: string, f: (e: never) => void) => { handlers.set(t, (handlers.get(t) ?? []).filter((h) => h !== (f as (e: unknown) => void))); },
    fire: (t: string, e: unknown = {}) => { for (const h of handlers.get(t) ?? []) h(e); },
    count: (t: string) => (handlers.get(t) ?? []).length,
  };
}

describe('kbdNav', () => {
  it('Tab and Shift+Tab set the attribute; a pointer press clears it; Escape and other keys do not set it', () => {
    const d = fakeDoc();
    startKbdNav(d);
    d.fire('keydown', { key: 'Escape' });
    d.fire('keydown', { key: 'Enter' });
    assert.equal(d.attrs.has(KBD_ATTR), false);
    d.fire('keydown', { key: 'Tab' });
    assert.equal(d.attrs.has(KBD_ATTR), true);
    d.fire('keydown', { key: 'Escape' });
    assert.equal(d.attrs.has(KBD_ATTR), true, 'Escape alone does not change it');
    d.fire('pointerdown');
    assert.equal(d.attrs.has(KBD_ATTR), false);
    d.fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(d.attrs.has(KBD_ATTR), true);
  });
  it('arrow keys between controls set it (a keyboard user in a menu keeps rings after a click); arrows in a text field, Space and typing do not', () => {
    const d = fakeDoc();
    startKbdNav(d);
    d.fire('keydown', { key: 'ArrowDown', target: { tagName: 'TEXTAREA' } });
    d.fire('keydown', { key: 'ArrowLeft', target: { tagName: 'INPUT', type: 'text' } });
    d.fire('keydown', { key: ' ', target: { tagName: 'BUTTON' } });
    d.fire('keydown', { key: 'a', target: { tagName: 'DIV' } });
    assert.equal(d.attrs.has(KBD_ATTR), false);
    d.fire('keydown', { key: 'ArrowDown', target: { tagName: 'BUTTON' } });
    assert.equal(d.attrs.has(KBD_ATTR), true);
    d.fire('pointerdown');
    d.fire('keydown', { key: 'ArrowRight', target: { tagName: 'INPUT', type: 'radio' } });
    assert.equal(d.attrs.has(KBD_ATTR), true, 'arrows in a radio group are navigation');
  });
  it('stop removes the listeners and the attribute', () => {
    const d = fakeDoc();
    const stop = startKbdNav(d);
    d.fire('keydown', { key: 'Tab' });
    stop();
    assert.equal(d.attrs.has(KBD_ATTR), false);
    assert.equal(d.count('keydown') + d.count('pointerdown'), 0);
    d.fire('keydown', { key: 'Tab' });
    assert.equal(d.attrs.has(KBD_ATTR), false);
  });
});

/* ---------- CSS source guard ---------- */
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith('.css') ? [p] : []; });
}
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
function splitTop(sel: string): string[] {
  const parts: string[] = []; let d = 0; let cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') d++;
    if (ch === ')' || ch === ']') d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur); return parts;
}

const FOCUS_STATE = /:focus(?:-visible|-within)?(?![-\w])/;
/** A declaration that draws a ring: an outline, a box-shadow, or a coloured border (any border shorthand, side or colour, but not none or 0). */
const RING_DECL = [
  /(^|;)\s*outline\s*:(?!\s*(none|0)\b)/,
  /(^|;)\s*box-shadow\s*:(?!\s*none\b)/,
  /(^|;)\s*border(-(top|right|bottom|left|inline|block))?(-color)?\s*:(?!\s*(none|0)\b)/,
];
/** The selector with its :not(...) clauses removed, so that :not([data-focus-rings]) cannot pass as the setting's gate. */
const positive = (sel: string): string => sel.replace(/:not\([^()]*\)/g, '');

/** Every selector part of a focus state (:focus, :focus-visible, :focus-within) that draws a ring. A bare suppression (outline: none) and a background-only tint are not rings. */
function focusRingParts(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of stripComments(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const pre = m[1]!.trim(); const body = m[2]!.trim();
    if (pre.startsWith('@') || !FOCUS_STATE.test(pre)) continue;
    if (!RING_DECL.some((re) => re.test(body))) continue;
    for (const part of splitTop(pre)) if (FOCUS_STATE.test(part)) out.push({ selector: part.trim(), body });
  }
  return out;
}
/** Ring parts with no positive [data-focus-rings] gate: the setting must gate every ring. */
function ungatedFocusRings(css: string): Array<{ selector: string; body: string }> {
  return focusRingParts(css).filter((r) => !positive(r.selector).includes('[data-focus-rings]'));
}
/** Ring parts gated by the setting but not by keyboard navigation: a mouse click would show them, so they must also need [data-kbd-nav]. */
function ringsOutsideKbdNav(css: string): Array<{ selector: string; body: string }> {
  return focusRingParts(css).filter((r) => positive(r.selector).includes('[data-focus-rings]') && !positive(r.selector).includes('[data-kbd-nav]'));
}

/**
 * Documented exceptions (selector text). The Relic stylesheet's line 6 (`.mx:focus-visible { box-shadow: ring }`) is pinned by hash in
 * test/mascot.test.ts, so it stays; mascot.css line 229 suppresses it (`box-shadow: none`), and the ring returns only under [data-focus-rings].
 * The forced-colors fallback (app.css) is the one ring that is not behind the setting: Windows high contrast strips the tint, so it is
 * drawn for every user under kbd-nav. The test below pins that it stays inside a forced-colors block.
 */
const FORCED_COLORS_FALLBACK = ':root[data-kbd-nav] :focus-visible';
const ALLOWLIST: string[] = ['.mx:focus-visible', FORCED_COLORS_FALLBACK];

describe('every focus ring and coloured focus border is behind the setting', () => {
  const files = cssFiles(join(process.cwd(), 'ui', 'src'));
  it('finds the CSS files', () => assert.ok(files.length >= 14, `${files.length} files`));
  for (const f of files) {
    it(`${f.split(/[\\/]ui[\\/]src[\\/]/)[1]}: no focus ring or focus border outside [data-focus-rings]`, () => {
      const bad = ungatedFocusRings(readFileSync(f, 'utf8')).filter((r) => !ALLOWLIST.includes(r.selector));
      assert.deepEqual(bad, []);
    });
    it(`${f.split(/[\\/]ui[\\/]src[\\/]/)[1]}: a ring behind the setting also needs keyboard navigation (no mouse ring)`, () => {
      assert.deepEqual(ringsOutsideKbdNav(readFileSync(f, 'utf8')).map((r) => r.selector), []);
    });
  }
  it('the guard sees an ungated ring, a focus border and a focus glow; accepts a gated one, a bare suppression and a tint', () => {
    assert.equal(ungatedFocusRings('.a:focus-visible { outline: 2px solid red; }').length, 1);
    assert.equal(ungatedFocusRings('@media (forced-colors: active) { .a:focus-visible, .b:focus-visible { outline: 2px solid Highlight; } }').length, 2);
    assert.equal(ungatedFocusRings(':root[data-kbd-nav] .a:focus-visible { outline: 2px solid red; }').length, 1, 'kbd-nav alone is not the gate any more');
    assert.equal(ungatedFocusRings(':root[data-kbd-nav][data-focus-rings] .a:focus-visible { outline: 2px solid red; }').length, 0);
    assert.equal(ungatedFocusRings('input:focus-visible { outline: none; }').length, 0);
    assert.equal(ungatedFocusRings('.a:has(input:focus-visible) { outline: 2px solid red; }').length, 1);
    assert.equal(ungatedFocusRings('.f:focus { border-color: var(--accent-line); }').length, 1, 'a coloured focus border is a ring for this purpose');
    assert.equal(ungatedFocusRings('.f:focus-within { box-shadow: 0 0 0 3px var(--accent-soft); }').length, 1);
    assert.equal(ungatedFocusRings(':root[data-focus-rings] .f:focus { border-color: var(--accent-line); }').length, 0);
    assert.equal(ungatedFocusRings(':root[data-kbd-nav]:not([data-focus-rings]) :is(button, a, [role=tab]):focus-visible { background-image: linear-gradient(var(--focus-tint), var(--focus-tint)); }').length, 0);
  });
  it('F8: a ring under :not([data-focus-rings]) is ungated, and a border shorthand (any side) is a ring', () => {
    assert.equal(ungatedFocusRings(':root[data-kbd-nav]:not([data-focus-rings]) .a:focus-visible { outline: 2px solid red; }').length, 1, 'the "off" state is not the gate');
    assert.equal(ungatedFocusRings(':root:not([data-focus-rings]) .f:focus-within { box-shadow: 0 0 0 3px var(--accent-soft); }').length, 1);
    assert.equal(ungatedFocusRings('.f:focus { border: 1px solid var(--accent-line); }').length, 1, 'border shorthand');
    assert.equal(ungatedFocusRings('.f:focus-visible { border-bottom: 2px solid var(--accent); }').length, 1, 'side border');
    assert.equal(ungatedFocusRings('.f:focus { border: none; }').length, 0);
    assert.equal(ungatedFocusRings('.f:focus { border-top: 0; }').length, 0);
    assert.equal(ungatedFocusRings('.f:focus { border-radius: 6px; }').length, 0, 'a radius is not a ring');
  });
  it('F3: a ring gated only by the setting (no kbd-nav) is flagged, a ring under both is not', () => {
    assert.equal(ringsOutsideKbdNav(':where(:root[data-focus-rings]) .f:focus-within { border-color: var(--accent-line); }').length, 1);
    assert.equal(ringsOutsideKbdNav(':where(:root[data-focus-rings]) :is(.form input:focus, .form select:focus) { border-color: var(--accent-line); }').length, 1, 'one part, the :is() commas stay inside it');
    assert.equal(ringsOutsideKbdNav(':root[data-kbd-nav][data-focus-rings] .f:focus { border-color: var(--accent-line); }').length, 0);
    assert.equal(ringsOutsideKbdNav(':root[data-kbd-nav]:not([data-focus-rings]) .f:focus-visible { outline: 2px solid red; }').length, 0, 'not a setting gate at all: left to the ungated check');
  });
  it('the forced-colors fallback draws a system-colour outline for keyboard focus whatever the setting, and is the only such ring', () => {
    const app = readFileSync(join(process.cwd(), 'ui', 'src', 'styles', 'app.css'), 'utf8');
    assert.match(app, /@media \(forced-colors: active\)\s*\{\s*:root\[data-kbd-nav\] :focus-visible\s*\{[^}]*outline: 2px solid Highlight/);
    assert.deepEqual(ungatedFocusRings(app).map((r) => r.selector), [FORCED_COLORS_FALLBACK]);
  });
});

describe('R64: rings are off by default whatever kbd-nav says', () => {
  const app = stripComments(readFileSync(join(process.cwd(), 'ui', 'src', 'styles', 'app.css'), 'utf8'));
  it('the browser default outline is removed for every :focus-visible while data-focus-rings is absent, outside forced colours, without needing data-kbd-nav', () => {
    // live check 2026-10-22: a button focused by code after typing (no Tab yet, so no data-kbd-nav) drew the default ring
    const m = app.match(/@media not all and \(forced-colors: active\)\s*\{\s*([^{]*?:focus-visible)\s*\{\s*outline: none;?\s*\}\s*\}/);
    assert.ok(m, 'the rule is there');
    assert.match(m![1]!, /:not\(\[data-focus-rings\]\)/);
    assert.doesNotMatch(m![1]!, /data-kbd-nav/, 'a programmatic focus before any key press is covered');
  });
  it('the opt-in ring and the forced-colours ring stay', () => {
    assert.match(app, /:where\(:root\[data-kbd-nav\]\[data-focus-rings\]\) :focus-visible \{ outline: 2px solid var\(--accent\)/);
    assert.match(app, /@media \(forced-colors: active\)\s*\{\s*:root\[data-kbd-nav\] :focus-visible\s*\{[^}]*outline: 2px solid Highlight/);
  });
});

describe('the tint shown while rings are off', () => {
  const app = readFileSync(join(process.cwd(), 'ui', 'src', 'styles', 'app.css'), 'utf8');
  const tokens = readFileSync(join(process.cwd(), 'ui', 'src', 'styles', 'tokens.css'), 'utf8');
  const tintRule = () => stripComments(app).match(/:root\[data-kbd-nav\]:not\(\[data-focus-rings\]\) :is\(button[^{]*:focus-visible[^{]*\{([^}]*)\}/);
  it('app.css has one shared tint rule under kbd-nav without the setting, for the focusable controls', () => {
    const rule = tintRule();
    assert.ok(rule, 'tint rule present');
    assert.match(rule![0], /button/);
    assert.match(rule![0], /\[role=option\]/);
    assert.match(rule![0], /summary/);
    assert.match(rule![1]!, /background-image:\s*linear-gradient\(var\(--focus-tint\),\s*var\(--focus-tint\)\)/);
  });
  it('F2: the tint list covers select and the non-text inputs (range, date, file), not text fields', () => {
    const sel = tintRule()![0];
    assert.match(sel, /[\s(,]select[\s,)]/, 'select');
    assert.match(sel, /input\[type=range\]/, 'range');
    assert.match(sel, /input\[type=date\]/, 'date');
    assert.match(sel, /input\[type=file\]/, 'file');
    assert.doesNotMatch(sel, /[\s(,]input[\s,)]/, 'a bare input (a text field) gets no tint, the caret is its cue');
  });
  it('F6: rows that code focuses with tabindex=-1 show the tint under kbd-nav, and the generic tabindex=-1 stays out of the list', () => {
    const sel = tintRule()![0];
    assert.match(sel, /li\[tabindex="-1"\]/);
    assert.match(sel, /\[tabindex\]:not\(\[tabindex="-1"\]\)/);
  });
  it('F1: a filled accent control (.btn.primary, .pg-btn.primary) gets an on-accent tint, which comes after the shared tint so it wins the tie', () => {
    const tint = stripComments(app).indexOf('background-image: linear-gradient(var(--focus-tint), var(--focus-tint))');
    const onAccent = stripComments(app).match(/:root\[data-kbd-nav\]:not\(\[data-focus-rings\]\)[^{]*\.btn\.primary[^{]*:focus-visible[^{]*\{([^}]*)\}/);
    assert.ok(onAccent, 'on-accent tint rule for .btn.primary');
    assert.match(onAccent![1]!, /background-image:\s*linear-gradient\(var\(--focus-tint-on-accent\),\s*var\(--focus-tint-on-accent\)\)/);
    assert.match(onAccent![0], /\.pg-btn\.primary/, 'the project page primary button too');
    assert.ok(stripComments(app).indexOf(onAccent![0]) > tint, 'after the shared tint rule');
  });
  it('F5: a card with its own gradient (approval, question, blender) keeps it under the tint, instead of going flat', () => {
    const card = stripComments(app).match(/:root\[data-kbd-nav\]:not\(\[data-focus-rings\]\)\s*\.approval\[tabindex\]:focus-visible\s*\{([^}]*)\}/);
    assert.ok(card, 'approval card rule');
    assert.match(card![1]!, /linear-gradient\(var\(--focus-tint\),\s*var\(--focus-tint\)\),\s*linear-gradient\(var\(--warn-soft\)/);
    const live = stripComments(app).match(/\.approval\.blender\.is-live\[tabindex\]:focus-visible\s*\{([^}]*)\}/);
    assert.ok(live, 'live blender approval rule');
    assert.match(live![1]!, /var\(--danger-soft\)/);
  });
  it('F1: --focus-tint-on-accent is a token in both themes', () => {
    const [dark, light] = [tokens.split(':root[data-theme=\'light\']')[0]!, tokens.split(':root[data-theme=\'light\']')[1]!];
    assert.match(dark, /--focus-tint-on-accent:/);
    assert.match(light!, /--focus-tint-on-accent:/);
  });
  it('--focus-tint is a token in both themes', () => {
    const [dark, light] = [tokens.split(':root[data-theme=\'light\']')[0]!, tokens.split(':root[data-theme=\'light\']')[1]!];
    assert.match(dark, /--focus-tint:/);
    assert.match(light!, /--focus-tint:/);
  });
  it('a checkbox or radio shows the tint on the row that holds it (its label or row wrapper) while rings are off', () => {
    const rule = stripComments(app).match(/:root\[data-kbd-nav\]:not\(\[data-focus-rings\]\)\s*:is\(label[^{]*:has\(>\s*input:is\(\[type=checkbox\],\s*\[type=radio\]\):focus-visible\)\s*\{([^}]*)\}/);
    assert.ok(rule, 'row tint rule present');
    assert.match(rule![1]!, /background-image:\s*linear-gradient\(var\(--focus-tint\),\s*var\(--focus-tint\)\)/);
  });
  it('with rings off the browser default focus outline is suppressed, but not under forced colours (where the fallback must show)', () => {
    assert.match(stripComments(app), /@media not all and \(forced-colors: active\)\s*\{\s*:root:not\(\[data-focus-rings\]\) :focus-visible\s*\{\s*outline: none;?\s*\}\s*\}/);
  });
  it('F4: the outline suppression for inputs is narrowed to text-like fields, so a checkbox, radio, range, date or select gets the ring when the setting is on', () => {
    const rule = stripComments(app).match(/([^{};]*textarea:focus-visible[^{};]*)\{\s*outline:\s*none;?\s*\}/);
    assert.ok(rule, 'the text-field suppression rule');
    const parts = splitTop(rule![1]!).map((s) => s.trim());
    assert.ok(!parts.includes('input:focus-visible'), 'no bare input suppression');
    assert.doesNotMatch(rule![1]!, /checkbox|radio|range|date|file|select/, 'only text-like inputs and textarea are suppressed');
    assert.ok(parts.some((s) => /^input:is\(/.test(s) && /\[type=text\]/.test(s) && /:not\(\[type\]\)/.test(s)), 'text-like input types are suppressed');
  });
  it('text fields show a caret, not a coloured border, when the setting is off: the only ungated ring in app.css is the forced-colors fallback', () => {
    assert.deepEqual(ungatedFocusRings(app).map((r) => r.selector), [FORCED_COLORS_FALLBACK]);
  });
});

describe('focus rings setting', () => {
  const memory = (initial: Record<string, string> = {}) => {
    const m = new Map(Object.entries(initial));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
  };
  const root = () => {
    const attrs = new Set<string>();
    return { attrs, setAttribute: (n: string) => { attrs.add(n); }, removeAttribute: (n: string) => { attrs.delete(n); } };
  };
  it('is off by default: nothing stored, an unreadable store, or any value but "1"', () => {
    assert.equal(readFocusRings(memory()), false);
    assert.equal(readFocusRings({ getItem: () => { throw new Error('denied'); } }), false);
    assert.equal(readFocusRings(memory({ [FOCUS_RINGS_KEY]: 'yes' })), false);
    assert.equal(readFocusRings(null), false);
  });
  it('is on only when stored as "1"', () => {
    assert.equal(readFocusRings(memory({ [FOCUS_RINGS_KEY]: '1' })), true);
  });
  it('the attribute follows applyFocusRings: set when on, removed when off', () => {
    const r = root();
    applyFocusRings(true, r);
    assert.equal(r.attrs.has(FOCUS_RINGS_ATTR), true);
    applyFocusRings(false, r);
    assert.equal(r.attrs.has(FOCUS_RINGS_ATTR), false);
  });
  it('setFocusRings stores the choice and sets the attribute at once; the store is written as the reader reads it', () => {
    const s = memory(); const r = root();
    setFocusRings(true, s, r);
    assert.equal(r.attrs.has(FOCUS_RINGS_ATTR), true);
    assert.equal(readFocusRings(s), true);
    setFocusRings(false, s, r);
    assert.equal(r.attrs.has(FOCUS_RINGS_ATTR), false);
    assert.equal(readFocusRings(s), false);
  });
  it('the Settings switch sits in an Accessibility section with the agreed label and hint', () => {
    const nav = readFileSync(join(process.cwd(), 'ui', 'src', 'components', 'settingsNav.ts'), 'utf8');
    assert.match(nav, /accessibility: \{ label: 'Accessibility'/);
    const src = readFileSync(join(process.cwd(), 'ui', 'src', 'a11y', 'AccessibilitySection.tsx'), 'utf8');
    assert.match(src, /Show focus rings/);
    assert.match(src, /Outlines around the focused item when you use the keyboard/);
  });
});
