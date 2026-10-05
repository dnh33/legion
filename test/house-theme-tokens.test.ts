/**
 * The house context list must be themed by the app's tokens, not by colours invented in its own stylesheet.
 *
 * ## What this exists for
 *
 * `ui/src/house/house.css` used `var(--card, #fff)`, `var(--border, #e5e7eb)` and `var(--muted, #6b7280)`. **None of
 * those three variables exists.** The app's palette is in `ui/src/styles/tokens.css` and calls them `--surface`,
 * `--line` and `--muted`. So every fallback fired at once: each row rendered `background: #fff` and
 * `border: 1px solid #e5e7eb` — a light-mode card, inside a dark application, with the filename inheriting a
 * near-white body colour and therefore sitting at roughly 1.3:1 against that white. The trust tags had the same
 * cause: three hardcoded light-mode hues (`#15803d`, `#b45309`, `#6b7280`) that no theme could reach.
 *
 * A screenshot of the owner's own install is what surfaced it. The panel was usable and the copy was right, which is
 * exactly why nothing caught it: nothing asserts that a stylesheet uses the palette the app actually ships.
 *
 * ## The rule
 *
 * A component stylesheet may not name a CSS custom property that `tokens.css` does not define. A var() with a
 * fallback is how an invented name hides: it still renders, just in the wrong theme, so nothing errors and no test
 * fails. This asserts the names resolve.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const TOKENS = readFileSync(join(REPO, 'ui', 'src', 'styles', 'tokens.css'), 'utf8');

/** Every custom property tokens.css declares, in either theme block. */
const declared = new Set([...TOKENS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]!));

/** Every component stylesheet under ui/src. */
const componentCss = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSyncShim(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      if (isDirShim(full)) walk(full);
      else if (name.endsWith('.css')) out.push(full);
    }
  };
  walk(join(REPO, 'ui', 'src'));
  return out;
};

// Small shims so the test needs no fs imports beyond readFileSync, which keeps the failure output about CSS.
import { readdirSync, statSync } from 'node:fs';
function readdirSyncShim(d: string): string[] { try { return readdirSync(d); } catch { return []; } }
function isDirShim(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

describe('house settings panel: the palette the app actually ships', () => {
  it('tokens.css declares the variables the components rely on', () => {
    // The three the house panel needs, named by the app rather than invented at the call site.
    for (const v of ['--bg', '--surface', '--surface-2', '--line', '--text', '--text-2', '--muted', '--accent', '--warn']) {
      assert.ok(declared.has(v), `tokens.css does not declare ${v}, which components use`);
    }
  });

  it('house.css resolves every custom property it names', () => {
    const css = readFileSync(join(REPO, 'ui', 'src', 'house', 'house.css'), 'utf8');
    const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]!);
    assert.ok(used.length > 0, 'house.css names no custom properties at all, which cannot be right');
    const unknown = [...new Set(used)].filter((v) => !declared.has(v));
    assert.deepEqual(unknown, [], `house.css names variables tokens.css does not declare: ${unknown.join(', ')}`);
  });

  it('house.css hardcodes no colour, so one theme drives every state', () => {
    const css = readFileSync(join(REPO, 'ui', 'src', 'house', 'house.css'), 'utf8');
    // Strip comments first: a hex inside a comment is documentation, not a style.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hexes = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(hexes, [], `house.css hardcodes ${hexes.join(', ')}; a hardcoded colour cannot follow the theme`);
  });

  it('no stylesheet falls back to a light colour for a token the app themes', () => {
    // Scoped deliberately. A component may define its OWN variables (`--r`, `--bs`) and use them; that is ordinary
    // CSS and several panels do it. The defect is narrower and worse: `var(--token, <light hex>)` where `--token`
    // is a global the palette does not define. The fallback then always wins, silently, in BOTH themes - which is
    // how the house rows rendered white on a dark app with no error and no failing test.
    const offenders: string[] = [];
    for (const file of componentCss()) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      // A var() with a fallback: var(--name, <something>). The name must be a real token or locally defined.
      const withFallback = [...code.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,\s*([^)]*)\)/gi)];
      // A component-local variable is one it DECLARES anywhere in the file, including inside a media or keyframes
      // block, and including one declared with a leading indent. Collect every `--name:` occurrence, not just
      // top-level ones, so a local is never mistaken for a missing global.
      const local = new Set([...code.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
      for (const [, name, fallback] of withFallback) {
        if (declared.has(name!) || local.has(name!)) continue;
        // A theme query in the fallback is fine; a raw light-mode colour is the bug.
        if (/(prefers-color-scheme|data-theme)/.test(fallback!)) continue;
        // Only a COLOUR fallback is this defect. `var(--mx-font, system-ui)` is a font, `var(--bs, 1.9)` a scale
        // factor; neither can render a light card on a dark app.
        if (!/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(fallback!)) continue;
        offenders.push(`${file.replace(REPO, '.')}: ${name} -> ${fallback!.trim()}`);
      }
    }
    assert.deepEqual(offenders, [],
      `these name a variable the palette does not define, so the fallback colour always wins:\n  ${offenders.join('\n  ')}`);
  });

  it('the three trust states are distinguished by token, and each is also named in text', () => {
    // Colour alone would leave "is this approved" to somebody who cannot distinguish the hues, so the tag text
    // carries it too. That is why this asserts the class exists rather than only the colour.
    const css = readFileSync(join(REPO, 'ui', 'src', 'house', 'house.css'), 'utf8');
    for (const state of ['t-shipped', 't-adopted', 't-untrusted']) {
      assert.ok(css.includes(`.${state}`), `house.css has no rule for .${state}`);
    }
  });
});
