// test/gates-copy.test.ts: spec test 13. Plain copy on the Gates and goals pages: no em dash, never "this computer".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { GATES, PRESET_LINES, NO_SANDBOX_LINE, DENY_LINE } from '../src/shared/gates-registry.js';

const walk = (d: string): string[] => !existsSync(d) ? [] : readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|css)$/.test(n) ? [p] : []; });
const dashed = (t: string): boolean => t.includes('\u2014') || /\u2014/i.test(t) || t.includes('&mdash;');

test('no em dash, also as an escape, anywhere under ui/src/gates and ui/src/goals', () => {
  for (const f of [...walk('ui/src/gates'), ...walk('ui/src/goals')]) assert.ok(!dashed(readFileSync(f, 'utf8')), `${f} has an em dash`);
});

test('the Marshal panel has no em dash either (spec section 6)', () => {
  const f = 'ui/src/projects/board/MarshalPanel.tsx';
  assert.ok(!dashed(readFileSync(f, 'utf8')), `${f} has an em dash`);
});

test('every registry string a person reads has no em dash and no "this computer"', () => {
  const all = [...GATES.flatMap((g) => [g.label, g.protects, g.ifOff]), ...Object.values(PRESET_LINES), NO_SANDBOX_LINE, DENY_LINE];
  for (const s of all) {
    assert.ok(!s.includes('\u2014'), `em dash in: ${s}`);
    assert.ok(!/this computer/i.test(s), `"this computer" in: ${s}`);
  }
});
