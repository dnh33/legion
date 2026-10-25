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
test('W6 P4: a zoomed-narrow window gives the thread its room back, so the Hermes head keeps one row', () => {
  // At 1.5x a 1280x820 window is 853x547 CSS px: the two side rails left the thread 357 px, and the header (name, chips,
  // usage line) took two rows, 109 px of the 547. Below 900 px the rails are narrower and the tail keeps to the chips' row,
  // which is what brings the head back to one row (measured: 81 px). The rails hold no reading task, the thread does.
  const narrow = ALL.filter((r) => r.selectors.includes('.app') && r.decls.get('--rail-w') === '176px');
  assert.ok(narrow.length > 0, 'a narrow-window .app rule sets the narrower rail');
  assert.equal(narrow.map((r) => r.decls.get('--ops-w')).find(Boolean), '252px', 'both rails give way together');

  // In that width the tail takes a zero basis: its own 200px basis is what pushed it onto a second row.
  const tailNarrow = ALL.filter((r) => r.selectors.includes('.th-right.is-hermes .th-tail') && r.decls.get('flex') === '1 1 0' && r.decls.get('min-width') === undefined);
  assert.ok(tailNarrow.length > 0, 'the narrow rule gives the tail a zero basis, so it shares the chips row');

  // Above 900 px nothing changes: the 200px basis is what lets the usage line wrap whole and be read at 960 at 1x,
  // and the 1100 px rail step keeps its widths.
  const base = ALL.filter((r) => r.selectors.includes('.th-right.is-hermes .th-tail') && r.decls.get('flex') === '1 1 200px');
  assert.ok(base.length > 0, 'the base tail rule keeps its 200px basis');
  const mid = ALL.filter((r) => r.selectors.includes('.app') && r.decls.get('--rail-w') === '208px');
  assert.ok(mid.length > 0 && mid.some((r) => r.decls.get('--ops-w') === '288px'), 'the 1100 px step is unchanged');
});

test('W6 P4b: the narrow-window ops rail holds the bust plus the scrollbar gutter, so a change to any of them is caught', () => {
  // The arithmetic, so it cannot silently stop fitting:
  //   --ops-w 252
  //   - ops-inner padding 12 left + 12 right      = 24
  //   - mascot-stage border 1 left + 1 right      =  2
  //   - scrollbar gutter of .ops (overflow-y auto) = 15 (a classic Windows bar; overlay bars take none)
  //   = 211 of room for a 210 bust. The first version of this rail was 236 and left 0: it forgot the scrollbar, and the bust
  //   clipped 4px a side at 880x800 in a real render. An exact fit is a red flag, so the check below needs slack, not equality.
  // A premise this test also pins: 'short' is a HEIGHT query (max-height: 700px), not a width one.
  const opsRule = ALL.filter((r) => r.selectors.includes('.app') && r.decls.get('--ops-w') === '252px');
  assert.equal(opsRule.length, 1, 'exactly one narrow-window rule sets the 252px ops rail');
  const OPS_W = 252;
  const SCROLLBAR = 15;

  const inner = ruleFor('.ops-inner').map((r) => r.decls.get('padding')).find(Boolean);
  assert.equal(inner, '12px', 'the ops inner padding the budget is built on');
  const pad = 12 * 2;

  const stage = ruleFor('.mascot-stage').map((r) => r.decls.get('border')).find(Boolean);
  assert.ok(stage && /^1px\b/.test(stage), 'the mascot stage border the budget is built on (' + stage + ')');
  const border = 1 * 2;

  // the two bust widths, read from the component that draws them
  const panel = readFileSync(join(REPO, 'ui/src/components/OpsPanel.tsx'), 'utf8');
  const widths = [...panel.matchAll(/width=\{short \? (\d+) : (\d+)\}/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(widths.length > 0, 'OpsPanel draws a bust with a short and a tall width');
  const tall = Math.max(...widths.map((w) => w[1]!));
  const shortBust = Math.min(...widths.map((w) => w[0]!));
  assert.equal(tall, 210, 'the tall bust width the budget is built on');

  // the relationship itself: the tall bust fits with the scrollbar present
  assert.ok(OPS_W - pad - border - SCROLLBAR >= tall, OPS_W + ' - ' + pad + ' padding - ' + border + ' border - ' + SCROLLBAR + ' scrollbar must hold the ' + tall + 'px bust');
  assert.ok(shortBust <= OPS_W - pad - border - SCROLLBAR, 'the short bust also fits');

  // and the premise: 'short' is a height query, so a narrow window still draws the tall bust
  assert.match(panel, /const q = '\(max-height: 700px\)'/, 'short is a height query, so a narrow tall window keeps the 210px bust');
});
