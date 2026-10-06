/**
 * The boot splash draws the takeover from src/shared/takeover-art.ts through a generated inline block (the splash's CSP allows only
 * inline script). If the module changes and the splash was not regenerated, the splash would show stale art: this re-bundles and
 * compares. It also keeps the parts the main process depends on (window.splash.*, the strict CSP) and the Ŧ mark.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const gen = () => import(pathToFileURL(join(ROOT, 'scripts', 'gen-splash-art.mjs')).href) as Promise<{
  bundle(): Promise<string>; current(html?: string): string | null;
}>;
const html = () => readFileSync(join(ROOT, 'assets', 'splash.html'), 'utf8');

test('the splash carries the current takeover art (rerun: node scripts/gen-splash-art.mjs)', async () => {
  const g = await gen();
  const inSplash = g.current(html());
  assert.ok(inSplash, 'the generated block is in assets/splash.html');
  assert.equal(inSplash, await g.bundle(), 'assets/splash.html is stale: run node scripts/gen-splash-art.mjs (also needed after an esbuild or vite update, which changes the bundle bytes)');
});

test('the splash keeps the main-process API, the strict CSP, reduced motion and the Ŧ mark', () => {
  const h = html();
  for (const fn of ['line:', 'error:', 'reset:', 'fade:']) assert.ok(h.includes(fn), `window.splash.${fn}`);
  assert.ok(h.includes(`content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"`), 'CSP unchanged');
  assert.match(h, /prefers-reduced-motion/);
  assert.ok(h.includes('Ŧ'), 'the Legion mark');
  assert.ok(!h.includes('⛨'), 'not the shield glyph terminal fonts lack');
});

test('a boot error shows the still helm, not a glitch frame caught mid-sweep', () => {
  const h = html();
  const error = /error:function\(t\)\{([^}]*)/.exec(h)?.[1] ?? '';
  assert.match(error, /stopArt\(\);if\(still\)still\(\)/, 'error() stops the loop and draws the still frame');
  assert.match(h, /still=function\(\)\{draw\(T\.stillFrame\(\)\)\}/);
});

test('the title-bar egg honours reduced motion and stays under dialogs', () => {
  const css = readFileSync(join(ROOT, 'ui', 'src', 'mascot', 'takeover.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.takeover, \.tk-caret \{ animation: none; \}/, 'no slide and no blinking caret under reduced motion');
  const z = Number(/\.takeover \{[^}]*z-index: (\d+)/.exec(css)?.[1]);
  const app = readFileSync(join(ROOT, 'ui', 'src', 'styles', 'app.css'), 'utf8');
  const scrim = Number(/\.scrim \{[^}]*z-index: (\d+)/.exec(app)?.[1]);
  assert.ok(z < scrim, `the egg (z ${z}) sits under the modal scrim (z ${scrim})`);
});
