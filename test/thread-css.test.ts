/**
 * Thread styling checks that a static render cannot see (0.2.5-g):
 * - a failed tell reply (`.fa-body.err-s`) must resolve to the danger colour, not `.fa-body`'s text-2;
 * - the working row must grow when its text wraps, and its clock must not split across lines.
 * The rules are read from the real ui/src/styles/app.css and resolved with a small cascade for plain class selectors
 * (specificity, then source order). A browser render of the same CSS backs these up (see the 0.2.5-g report).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CSS = readFileSync(join(REPO, 'ui/src/styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { selectors: string[]; decls: Map<string, string>; order: number };
/** Innermost `selector { decls }` blocks in source order. Rules inside @media keep their selector, which is fine for these checks. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const decls = new Map<string, string>();
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    out.push({ selectors: m[1]!.split(',').map((s) => s.trim()).filter(Boolean), decls, order: out.length });
  }
  return out;
}
const ALL = rules(CSS);

/** The winning value of `prop` for an element with exactly these classes, over rules whose selector is a plain compound of classes. */
function resolve(classes: string[], prop: string): string | undefined {
  let best: { spec: number; order: number; value: string } | undefined;
  for (const r of ALL) {
    const v = r.decls.get(prop);
    if (v === undefined) continue;
    for (const s of r.selectors) {
      if (!/^(\.[\w-]+)+$/.test(s)) continue;
      const need = s.slice(1).split('.');
      if (!need.every((c) => classes.includes(c))) continue;
      if (!best || need.length > best.spec || (need.length === best.spec && r.order > best.order)) best = { spec: need.length, order: r.order, value: v };
    }
  }
  return best?.value;
}
const ruleFor = (selector: string) => ALL.filter((r) => r.selectors.includes(selector));

test('0.2.5-g: a failed reply from another agent (.fa-body.err-s) is drawn in the danger colour', () => {
  assert.equal(resolve(['fa-body', 'err-s'], 'color'), 'var(--danger)');
  // the plain reply keeps its own colour, and a lone .err-s is unchanged
  assert.equal(resolve(['fa-body'], 'color'), 'var(--text-2)');
  assert.equal(resolve(['err-s'], 'color'), 'var(--danger)');
});

test('0.2.5-g: the working row grows when its text wraps (min-height, not a fixed height)', () => {
  const working = ruleFor('.working');
  assert.ok(working.length > 0, '.working rule exists');
  for (const r of working) assert.equal(r.decls.get('height'), undefined, '.working sets no fixed height');
  assert.equal(working.map((r) => r.decls.get('min-height')).find(Boolean), '22px', 'the normal one-line row is still 22 px');
});

test('0.2.5-g: the working row clock never splits across lines', () => {
  const clock = ruleFor('.working .working-clock');
  assert.ok(clock.some((r) => r.decls.get('white-space') === 'nowrap'), '.working .working-clock is nowrap');
  assert.ok(clock.some((r) => r.decls.get('flex') === 'none' || r.decls.get('flex-shrink') === '0'), 'the clock does not shrink');
});
