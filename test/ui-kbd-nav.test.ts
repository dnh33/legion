/** Keyboard-only focus rings: the module that sets data-kbd-nav, and a source guard that every ring in the UI CSS sits under it. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { KBD_ATTR, startKbdNav } from '../ui/src/a11y/kbdNav.js';

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

/** Every selector part that mentions :focus-visible and is not under :root[data-kbd-nav], with its declaration body. */
function ungatedFocusRings(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of stripComments(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const pre = m[1]!.trim(); const body = m[2]!.trim();
    if (pre.startsWith('@') || !pre.includes(':focus-visible')) continue;
    // a bare suppression ("outline: none") is not a ring
    if (/^outline\s*:\s*(none|0)\s*;?$/.test(body)) continue;
    for (const part of splitTop(pre)) if (part.includes(':focus-visible') && !part.includes(':root[data-kbd-nav]')) out.push({ selector: part.trim(), body });
  }
  return out;
}

/** Documented exceptions (selector text). Keep empty unless a ring must show for a mouse user too, and say why here. */
// .mx lives in the Relic stylesheet, which test/relic-*.test pins by hash (the mascot is not edited); its ring stays as it is.
const ALLOWLIST: string[] = ['.mx:focus-visible'];

describe('every focus ring is keyboard-only', () => {
  const files = cssFiles(join(process.cwd(), 'ui', 'src'));
  it('finds the CSS files', () => assert.ok(files.length >= 14, `${files.length} files`));
  for (const f of files) {
    it(`${f.split(/[\\/]ui[\\/]src[\\/]/)[1]}: no :focus-visible rule outside :root[data-kbd-nav]`, () => {
      const bad = ungatedFocusRings(readFileSync(f, 'utf8')).filter((r) => !ALLOWLIST.includes(r.selector));
      assert.deepEqual(bad, []);
    });
  }
  it('the guard sees an ungated ring, also inside forced-colors, and accepts a gated one and a bare suppression', () => {
    assert.equal(ungatedFocusRings('.a:focus-visible { outline: 2px solid red; }').length, 1);
    assert.equal(ungatedFocusRings('@media (forced-colors: active) { .a:focus-visible, .b:focus-visible { outline: 2px solid Highlight; } }').length, 2);
    assert.equal(ungatedFocusRings(':root[data-kbd-nav] .a:focus-visible { outline: 2px solid red; }').length, 0);
    assert.equal(ungatedFocusRings('input:focus-visible { outline: none; }').length, 0);
    assert.equal(ungatedFocusRings('.a:has(input:focus-visible) { outline: 2px solid red; }').length, 1);
  });
  it('a forced-colors fallback is gated and visible, and no :focus rule draws a box-shadow ring outside the gate', () => {
    const app = readFileSync(join(process.cwd(), 'ui', 'src', 'styles', 'app.css'), 'utf8');
    assert.match(app, /@media \(forced-colors: active\)\s*\{\s*:root\[data-kbd-nav\] :focus-visible\s*\{[^}]*outline: 2px solid Highlight/);
    for (const f of files) {
      for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        const pre = m[1]!; const body = m[2]!;
        if (/:focus(-within)?(?![-\w])/.test(pre) && !pre.includes('data-kbd-nav') && /box-shadow:\s*0 0 0 3px/.test(body)) assert.fail(`${f}: ${pre.trim()} draws a ring for the mouse`);
      }
    }
  });
});
