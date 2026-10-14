/** The app-level hold chip sits in the page's own flow (top of the centre column), so it can never cover the composer, the thread header or the title bar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r/g, '');

test('the chip takes no height: it floats over the thread bottom, so nothing moves when a hold starts, and it stays clear of the composer', () => {
  const css = read('ui', 'src', 'projects', 'page', 'page.css');
  const rule = /\.pg-holdchip \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.ok(rule, 'the rule exists');
  assert.match(rule, /position:\s*absolute/, 'out of flow: no layout shift');
  assert.equal(/position:\s*fixed/.test(rule), false, 'anchored to the centre column, not the window');
  assert.match(rule, /bottom:/);
  assert.equal(/top:/.test(rule), false, 'not over the thread header or the page tabs');
  // with a composer under it, the chip sits above the composer block (composer, its bar and the hint row)
  const above = /\.center:has\(\.composer-wrap\) > \.pg-holdchip \{[^}]*bottom:\s*(\d+)px/.exec(css);
  assert.ok(above, 'a rule lifts the chip above the composer');
  assert.ok(Number(above![1]) >= 150, 'clear of the composer block');
  assert.match(read('ui', 'src', 'styles', 'app.css'), /\.center \{[^}]*position:\s*relative/, 'the centre column anchors it');
});

test('App renders the chip inside the centre column, not at the end of the frame', () => {
  const app = read('ui', 'src', 'App.tsx');
  const main = app.slice(app.indexOf('<main className="center">'), app.indexOf('</main>'));
  assert.ok(main.includes('<HoldChip />'), 'inside main');
  assert.equal(app.slice(app.indexOf('</main>')).includes('<HoldChip />'), false, 'not after main');
});
