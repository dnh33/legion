/**
 * The takeover lives in the title-bar easter egg (ui/src/mascot/Takeover.tsx) and in the Legion Mod for Claude Code. The desktop
 * app's boot splash is NOT part of it (owner, 2026-10-06): it stays the Zealot splash (owner's pick 02 for 0.2.5-f), and this file keeps it that way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('the desktop splash is the Zealot splash: no takeover art, and the main-process API and strict CSP are intact', () => {
  const h = read('assets', 'splash.html');
  assert.ok(!/takeover|LegionTakeover|TAKING OVER CLAUDE/i.test(h), 'the takeover art belongs to the egg and the mod, never the splash');
  assert.match(h, /Your order of agents\./);
  for (const fn of ['line:', 'error:', 'reset:', 'fade:']) assert.ok(h.includes(fn), `window.splash.${fn}`);
  assert.ok(h.includes(`content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"`), 'CSP unchanged');
});

test('the title-bar egg honours reduced motion and stays under dialogs', () => {
  const css = read('ui', 'src', 'mascot', 'takeover.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.takeover, \.tk-caret \{ animation: none; \}/, 'no slide and no blinking caret under reduced motion');
  const z = Number(/\.takeover \{[^}]*z-index: (\d+)/.exec(css)?.[1]);
  const scrim = Number(/\.scrim \{[^}]*z-index: (\d+)/.exec(read('ui', 'src', 'styles', 'app.css'))?.[1]);
  assert.ok(z < scrim, `the egg (z ${z}) sits under the modal scrim (z ${scrim})`);
});

test("the splash (owner's pick 02, 2026-10-06): the title-bar blackletter name, errors that wrap and scroll, still under reduced motion", () => {
  const h = read('assets', 'splash.html');
  assert.match(h, /<svg class="wm"[^>]*role="img" aria-label="Legion"/, 'the name is the title bar\'s Grenze Gotisch "Legion", drawn as paths (no font load under the CSP)');
  assert.match(h, /\.log div\{[^}]*overflow-wrap:anywhere/, 'a long path breaks instead of running off the window');
  assert.match(h, /\.log:has\(\.err\)\{[^}]*overflow-y:auto[^}]*-webkit-app-region:no-drag/, 'in an error the log scrolls and takes the wheel');
  assert.match(h, /@media \(prefers-reduced-motion:reduce\)\{[^@]*animation:none/, 'no animation under reduced motion');
  assert.ok(!/::first-line/.test(h), 'an error reads in one colour, not red then grey mid-sentence');
});
