/**
 * No coloured side-stripe accents ("fingernails") in the UI stylesheets.
 *
 * ## What this exists for
 *
 * A 2-4 px `border-left` (or `border-inline-start`, or `box-shadow: inset 2px 0 0 <colour>`) in an accent colour on a
 * card, banner, row or tip is a generic "AI-made" marker, and the owner rejected it. State is shown with a full
 * hairline border, a tinted background, an icon or a label instead. About two dozen of these had crept in, one per
 * feature, because nothing stopped the next one.
 *
 * ## The rule
 *
 * No rule in `the ui/src stylesheets` may declare a side border thicker than 1 px, or an inset side-shadow, unless its
 * selector is in QUOTE_RAILS below. A quote rail is the one justified use: a neutral line (`--line-strong`, never an
 * accent or state colour) that indents a reply or a thread against the main column, the way a blockquote does. It
 * carries no state, so it is not a fingernail. Adding to the allowlist needs the same justification.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** Works from test/ (tsx) and from dist/test (compiled). */
const REPO = existsSync(resolve(fileURLToPath(import.meta.url), '..', '..', 'ui', 'vite.config.ts')) ? resolve(fileURLToPath(import.meta.url), '..', '..') : resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const UI = join(REPO, 'ui', 'src');

/** Neutral reply/thread rails. Each must use var(--line-strong) and nothing else. */
const QUOTE_RAILS = new Set(['.msg.from-agent', '.rm-reply']);

/** Owned by a separate in-flight change (selected settings link); remove this line when that lands. */
const PENDING_ELSEWHERE = new Set(['.set-link.sel']);

const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? cssFiles(p) : n.endsWith('.css') ? [p] : [];
  });

const STRIPE_DECL = [
  /border-(?:left|inline-start)\s*:\s*(?:[2-9]|\d{2,})(?:\.\d+)?px\b[^;]*/gi,
  /border-(?:left|inline-start)-width\s*:\s*(?:[2-9]|\d{2,})px/gi,
  /box-shadow\s*:[^;]*\binset\s+-?(?:[2-9]|\d{2,})px\s+0(?:px)?\s+0/gi,
];

interface Hit { file: string; selector: string; decl: string }

const findStripes = (): Hit[] => {
  const hits: Hit[] = [];
  for (const f of cssFiles(UI)) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1]!.replace(/^[\s\S]*\{/, '').trim().split(/\s*,\s*/).map((s) => s.replace(/\s+/g, ' ')).join(', ');
      for (const re of STRIPE_DECL) {
        for (const d of m[2]!.matchAll(re)) hits.push({ file: relative(REPO, f).split(sep).join('/'), selector, decl: d[0].trim() });
      }
    }
  }
  return hits;
};

describe('ui stylesheets: no accent side stripes', () => {
  it('no rule draws a side stripe thicker than 1px, except neutral quote rails', () => {
    const bad = findStripes().filter((h) => !QUOTE_RAILS.has(h.selector) && !PENDING_ELSEWHERE.has(h.selector));
    assert.deepEqual(bad.map((h) => `${h.file}: ${h.selector} { ${h.decl} }`), [], 'side-stripe accents found; use a full hairline border, tint, icon or label');
  });

  it('allowlisted quote rails use only the neutral line colour', () => {
    const rails = findStripes().filter((h) => QUOTE_RAILS.has(h.selector));
    assert.ok(rails.length >= 1, 'the allowlist names rails that no longer exist; trim it');
    for (const h of rails) assert.match(h.decl, /var\(--line-strong\)\s*$/, `${h.selector} must be a neutral rail: ${h.decl}`);
  });

  it('no pseudo-element draws a narrow accent bar down an edge', () => {
    const bars: string[] = [];
    for (const f of cssFiles(UI)) {
      const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)::(?:before|after)\s*\{([^{}]*)\}/g)) {
        const body = m[2]!;
        const narrow = /(?:^|;)\s*width\s*:\s*[2-4]px/.test(body) && /(?:^|;)\s*(?:top|bottom)\s*:/.test(body);
        if (narrow && /background\s*:\s*var\(--(?:accent|live|ok|warn|danger|chain)/.test(body)) bars.push(relative(REPO, f).split(sep).join('/') + ': ' + m[1]!.trim());
      }
    }
    assert.deepEqual(bars, [], 'a 2-4px accent bar on a pseudo-element is a side stripe');
  });

  it('the detector sees the shapes it is meant to catch', () => {
    const sample = ['border-left: 3px solid var(--accent)', 'border-inline-start: 2px dashed red', 'box-shadow: inset 2px 0 0 var(--accent)', 'border-left-width: 4px'];
    for (const s of sample) assert.ok(STRIPE_DECL.some((re) => ((re.lastIndex = 0), re.test(s))), s);
    assert.ok(!STRIPE_DECL.some((re) => ((re.lastIndex = 0), re.test('border-left: 1px solid var(--line)'))));
  });
});

describe('ui strings: no em dashes in user-facing text', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? sources(p) : /.(ts|tsx)$/.test(n) ? [p] : [];
    });
  it('no string in ui/src contains an em dash (comments are exempt)', () => {
    const bad: string[] = [];
    for (const f of sources(UI)) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
      code.split('\n').forEach((l, i) => { if (l.includes('\u2014')) bad.push(relative(REPO, f).split(sep).join('/') + ':' + (i + 1)); });
    }
    assert.deepEqual(bad, [], 'em dash in UI text; rewrite the sentence plainly');
  });
});
