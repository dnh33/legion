/** CI panel UI: its pure view logic, and source guards for the accessibility and copy rules (no browser here; the browser pass is by hand). */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ago, clampGeometry, formatDuration, problemText, runLook } from '../src/shared/ci-view.js';
import type { PanelGeometry } from '../src/shared/ci-view.js';
import { pickReturnFocus, RETURN_SELECTORS } from '../ui/src/ci/focusReturn.js';

const DIR = join(process.cwd(), 'ui', 'src', 'ci');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
const css = read('ci.css');
const sources = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f)).map((f) => [f, read(f)] as const);

describe('view logic', () => {
  it('formats durations', () => {
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration(-5), '');
    assert.equal(formatDuration(42_000), '42s');
    assert.equal(formatDuration(185_000), '3m 05s');
    assert.equal(formatDuration(3_720_000), '1h 02m');
  });
  it('gives every status a word, so colour is never the only signal', () => {
    assert.deepEqual(runLook('in_progress', null), { tone: 'run', word: 'Running' });
    assert.deepEqual(runLook('queued', null), { tone: 'run', word: 'Queued' });
    assert.deepEqual(runLook('completed', 'success'), { tone: 'ok', word: 'Passed' });
    for (const c of ['failure', 'timed_out', 'startup_failure']) assert.deepEqual(runLook('completed', c), { tone: 'bad', word: 'Failed' });
    assert.equal(runLook('completed', 'cancelled').word, 'Cancelled');
    assert.ok(runLook('completed', 'something-new').word.length > 0);
  });
  it('says each problem in a plain sentence', () => {
    for (const kind of ['not-connected', 'auth-expired', 'forbidden', 'rate-limited', 'budget', 'not-found', 'network'] as const) {
      const t = problemText({ kind, resetAt: '2026-10-07T12:30:00Z' });
      assert.ok(t.length > 20 && !/undefined|\[object/.test(t), t);
    }
    assert.match(problemText({ kind: 'not-connected' }), /Connect GitHub/);
    assert.equal(ago(null), '');
    assert.equal(ago('2026-10-07T10:00:00Z', Date.parse('2026-10-07T10:05:00Z')), '5 min ago');
  });
  it('keeps a floating panel inside the window, even after the window shrinks, and keeps the minimum size', () => {
    const g: PanelGeometry = { mode: 'float', x: 5000, y: -300, w: 900, h: 2000, dockW: 3000 };
    const c = clampGeometry(g, 1000, 700);
    assert.ok(c.x >= 8 && c.x + c.w <= 1000, JSON.stringify(c));
    assert.ok(c.y >= 44 && c.y + c.h <= 700, JSON.stringify(c));
    assert.ok(c.dockW <= 600);
    const tiny = clampGeometry({ ...g, w: 10, h: 10, dockW: 10 }, 1000, 700);
    assert.ok(tiny.w >= 320 && tiny.h >= 260 && tiny.dockW >= 320);
    const small = clampGeometry({ mode: 'float', x: 600, y: 400, w: 480, h: 600, dockW: 400 }, 360, 500);
    assert.ok(small.x >= 8 && small.y >= 44, JSON.stringify(small));
  });
});

describe('source guards', () => {
  it('log text is rendered as a text node: nothing in the CI UI sets HTML', () => {
    for (const [f, src] of sources) { assert.ok(!/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/.test(src), f); }
    assert.match(read('CiPanel.tsx'), /<pre className="ci-log"[^>]*>\{log\.text\}<\/pre>/);
  });
  it('focus rings use :focus-visible only', () => {
    assert.ok(!/:focus(?!-visible)(?![\w-])/.test(css), 'a bare :focus rule');
    assert.ok(/:focus-visible/.test(css));
  });
  it('honours reduced motion and forced colors; the running pulse is opt-in motion and stops while the window is away', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
    const pulse = /@media \(prefers-reduced-motion: no-preference\)\s*\{[^}]*ci-pulse[^}]*\}[^}]*data-win='away'[^}]*\}/.exec(css);
    assert.ok(pulse, 'the pulse is inside no-preference and paused while away');
    assert.ok(!/animation:[^;]*infinite/.test(css.replace(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\n\}\n/, '').replace(/\.ci-spin[^\n]*\n/, '')), 'no other endless animation');
  });
  it('reuses the global .sr-only and has a polite live region for status changes', () => {
    assert.ok(!/\.sr-only\s*\{/.test(css), 'not redefined');
    assert.match(read('CiPanel.tsx'), /className="sr-only" role="status" aria-live="polite"/);
    assert.match(read('FloatPanel.tsx'), /className="sr-only" role="status" aria-live="polite"/);
  });
  it('the float panel closes on Escape, hands focus back, and has keyboard move, resize and dock', () => {
    const f = read('FloatPanel.tsx');
    assert.match(f, /e\.key === 'Escape'/);
    assert.match(f, /returnFocus\?\.\(\)\?\.focus\(\)/);
    assert.match(f, /ArrowLeft/);
    assert.match(f, /e\.shiftKey/);
    assert.match(f, /Dock the panel to the right edge/);
    assert.match(f, /role="dialog" aria-modal="false"/);
  });
  it('product text names no testing status', () => {
    for (const [f, src] of sources) {
      const strings = [...src.matchAll(/(?:>|=\{?['"`])([^<>{}'"`\n]{12,})/g)].map((m) => m[1]!);
      for (const t of strings) assert.ok(!/\b(fake|mock|stub|not tested|untested|placeholder)\b/i.test(t), `${f}: ${t}`);
    }
    assert.match(read('CiPanel.tsx'), /Logs are not available yet\./);
    assert.match(read('CiPanel.tsx'), /Connect with write access/);
    assert.match(read('CiPanel.tsx'), /Connect GitHub for live updates/);
  });
  it('the chip shows only with a repo, and is wired after the Blender chip', () => {
    assert.match(read('ciStore.ts'), /chipVisible[^\n]*available[^\n]*repo/);
    const bar = readFileSync(join(process.cwd(), 'ui', 'src', 'components', 'TitleBar.tsx'), 'utf8');
    assert.ok(bar.indexOf('<BlenderChip />') < bar.indexOf('<CiChip />'));
  });
});

describe('focus return', () => {
  const el = (name: string, log: string[]) => ({ name, focus() { log.push(name); }, attrs: new Map<string, string>(), setAttribute(n: string, v: string) { this.attrs.set(n, v); }, hasAttribute(n: string) { return this.attrs.has(n); } });
  const pick = (present: string[]) => {
    const log: string[] = [];
    const els = new Map<string, ReturnType<typeof el>>(RETURN_SELECTORS.filter((s) => present.includes(s as string)).map((s) => [s, el(s, log)]));
    return { got: pickReturnFocus((sel) => els.get(sel) ?? null), els };
  };
  it('goes to the chip, else the command palette button, else the main heading, else main; never body', () => {
    assert.equal((pick(['.tb-ci', '.tb-search']).got as any).name, '.tb-ci');
    assert.equal((pick(['.tb-search', 'main']).got as any).name, '.tb-search', 'chip hidden (no repo)');
    const h = pick([RETURN_SELECTORS[2], 'main']);
    assert.equal((h.got as any).name, RETURN_SELECTORS[2]);
    assert.equal((h.got as any).attrs.get('tabindex'), '-1', 'a heading is made focusable');
    assert.equal((pick(['main']).got as any).name, 'main');
    assert.equal(pick([]).got, null);
  });
  it('the panel uses it for returnFocus', () => {
    assert.match(read('CiPanel.tsx'), /pickReturnFocus\(/);
    assert.ok(!/querySelector<HTMLElement>\('\.tb-ci'\)/.test(read('CiPanel.tsx')));
  });
});
