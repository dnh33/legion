/** The app-level hold chip sits in the page's own flow (top of the centre column), so it can never cover the composer, the thread header or the title bar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r/g, '');

test('the chip is not fixed or absolute: it is a row in the flow', () => {
  const css = read('ui', 'src', 'projects', 'page', 'page.css');
  const rule = /\.pg-holdchip \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.ok(rule, 'the rule exists');
  assert.equal(/position:\s*(fixed|absolute)/.test(rule), false, rule);
  assert.equal(/\bbottom:/.test(rule), false, 'no bottom offset that would put it over the composer');
});

test('App renders the chip inside the centre column, before the views, not at the end of the frame', () => {
  const app = read('ui', 'src', 'App.tsx');
  const main = app.slice(app.indexOf('<main className="center">'), app.indexOf('</main>'));
  assert.ok(main.includes('<HoldChip />'), 'inside main');
  assert.ok(main.indexOf('<HoldChip />') < main.indexOf('<Thread />'), 'before the thread');
  assert.equal(app.slice(app.indexOf('</main>')).includes('<HoldChip />'), false, 'not after main');
});
