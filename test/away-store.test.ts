import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { periodEnd } from '../src/shared/spend-periods.js';
import { AwayError, AwayStore, DEFAULT_PROJECT_AWAY } from '../src/core/away/store.js';

const dir = (): string => join(mkdtempSync(join(tmpdir(), 'away-')), 'away');
const write = (d: string, v: unknown): void => { writeFileSync(join(d, 'policy.json'), typeof v === 'string' ? v : JSON.stringify(v), 'utf8'); };
const mkd = (d: string): void => { mkdirSync(d, { recursive: true }); };

test('defaults: deny at 10 min, not paused, no budget, notify problems, quiet off', () => {
  const s = new AwayStore(dir());
  const p = s.project('p1');
  assert.deepEqual(p.onSilence, { mode: 'deny', parkMinutes: 3 });
  assert.equal(p.paused, false);
  assert.equal(p.budget, null);
  assert.equal(p.notify, 'problems');
  assert.equal(s.app().quiet.enabled, false);
  assert.equal(s.looked('p1'), undefined);
  assert.deepEqual(DEFAULT_PROJECT_AWAY.onSilence.mode, 'deny');
});

test('a patch is validated and kept across a restart', async () => {
  const d = dir();
  const s = new AwayStore(d);
  s.patchProject('p1', { onSilence: { mode: 'park', parkMinutes: 5 }, paused: true, budget: { limit: 50, period: 'week' }, notify: 'everything' });
  s.patchApp({ quiet: { enabled: true, from: '22:00', to: '07:00' } });
  await s.flush();
  const again = new AwayStore(d);
  const p = again.project('p1');
  assert.deepEqual(p.onSilence, { mode: 'park', parkMinutes: 5 });
  assert.equal(p.paused, true);
  assert.deepEqual(p.budget, { limit: 50, period: 'week' });
  assert.equal(p.notify, 'everything');
  assert.equal(again.app().quiet.enabled, true);
});

test('bad patches are refused with 400 and change nothing', () => {
  const s = new AwayStore(dir());
  const bad: unknown[] = [
    { onSilence: { mode: 'allow', parkMinutes: 3 } }, { onSilence: { mode: 'park', parkMinutes: 0 } }, { onSilence: { mode: 'park', parkMinutes: 121 } },
    { onSilence: { mode: 'park', parkMinutes: 2.5 } }, { paused: 'yes' }, { budget: { limit: 0, period: 'week' } }, { budget: { limit: -5, period: 'week' } },
    { budget: { limit: Infinity, period: 'week' } }, { budget: { limit: 5, period: 'year' } }, { notify: 'all' },
  ];
  for (const b of bad) assert.throws(() => s.patchProject('p1', b as never), (e: unknown) => e instanceof AwayError && e.status === 400, JSON.stringify(b));
  for (const q of [{ enabled: true, from: '22:00', to: '22:00' }, { enabled: true, from: '25:00', to: '07:00' }, { enabled: 'x', from: '22:00', to: '07:00' }]) {
    assert.throws(() => s.patchApp({ quiet: q as never }), (e: unknown) => e instanceof AwayError && e.status === 400);
  }
  assert.deepEqual(s.project('p1'), s.project('never-touched'));
});

test('a budget can be switched off with null', () => {
  const s = new AwayStore(dir());
  s.patchProject('p1', { budget: { limit: 10, period: 'day' } });
  s.patchProject('p1', { budget: null });
  assert.equal(s.project('p1').budget, null);
});

test('a tampered file cannot allow anything: allow-like or out-of-bounds values fall back to the defaults', () => {
  const d = dir();
  mkd(d);
  write(d, {
    version: 1,
    app: { quiet: { enabled: true, from: '22:00', to: '22:00' }, notify: { enabled: 'maybe' } },
    projects: {
      p1: { onSilence: { mode: 'allow', parkMinutes: 99999 }, paused: 'no', budget: { limit: -1, period: 'week' }, notify: 'always' },
      p2: { onSilence: { mode: 'park', parkMinutes: 500 }, budget: { limit: 20, period: 'month' }, paused: true },
    },
    looked: { p1: 'not a date', p2: '2026-10-01T00:00:00.000Z' },
  });
  const s = new AwayStore(d);
  const p1 = s.project('p1');
  assert.equal(p1.onSilence.mode, 'deny', 'mode allow is not a mode');
  assert.equal(p1.paused, false);
  assert.equal(p1.budget, null);
  assert.equal(p1.notify, 'problems');
  assert.equal(s.app().quiet.enabled, false, 'from == to is replaced by the default (off)');
  const p2 = s.project('p2');
  assert.deepEqual(p2.onSilence, { mode: 'deny', parkMinutes: 3 }, 'minutes out of 1..120 replace the whole wait policy with the default');
  assert.deepEqual(p2.budget, { limit: 20, period: 'month' });
  assert.equal(p2.paused, true);
  assert.equal(s.looked('p1'), undefined);
  assert.equal(s.looked('p2'), '2026-10-01T00:00:00.000Z');
});

test('the policy type has no way to allow anything', () => {
  const src = readFileSync(join(process.cwd(), 'src/core/away/store.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/approvals|questions|ApprovalBroker|QuestionBroker/.test(code), 'the store cannot reach a broker');
  assert.ok(!/allow\s*:|allowed|\.approve/.test(code), 'the store has no allow-shaped setting');
});

test('a corrupt file is renamed aside and the defaults are used', async () => {
  const d = dir();
  mkd(d);
  write(d, '{ this is not json');
  const s = new AwayStore(d);
  assert.equal(s.project('p1').paused, false);
  const files = readdirSync(d);
  assert.ok(files.some((f) => f.startsWith('policy.json.corrupt-')), files.join(','));
  assert.ok(!files.includes('policy.json'));
  s.patchProject('p1', { paused: true });
  await s.flush();
  assert.ok(existsSync(join(d, 'policy.json')));
});

test('unknown fields are kept when the file is written again', async () => {
  const d = dir();
  mkd(d);
  write(d, { version: 1, futureTop: { a: 1 }, app: { quiet: { enabled: false, from: '22:00', to: '07:00' }, futureApp: 7 }, projects: { p1: { paused: true, futureProject: 'x' } }, looked: {} });
  const s = new AwayStore(d);
  s.patchProject('p1', { notify: 'nothing' });
  await s.flush();
  const out = JSON.parse(readFileSync(join(d, 'policy.json'), 'utf8'));
  assert.deepEqual(out.futureTop, { a: 1 });
  assert.equal(out.app.futureApp, 7);
  assert.equal(out.projects.p1.futureProject, 'x');
  assert.equal(out.projects.p1.notify, 'nothing');
});

test('the write is atomic: no temp file is left behind', async () => {
  const d = dir();
  const s = new AwayStore(d);
  s.patchProject('p1', { paused: true });
  await s.flush();
  assert.deepEqual(readdirSync(d).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(JSON.parse(readFileSync(join(d, 'policy.json'), 'utf8')).projects.p1.paused, true);
});

test('mark as seen uses the given time and prune drops projects that are gone', async () => {
  const s = new AwayStore(dir());
  s.markSeen('p1', '2026-10-14T09:40:00.000Z');
  s.patchProject('p1', { paused: true });
  s.patchProject('gone', { paused: true });
  s.markSeen('gone', '2026-10-14T09:40:00.000Z');
  assert.equal(s.looked('p1'), '2026-10-14T09:40:00.000Z');
  s.prune(['p1']);
  assert.equal(s.project('gone').paused, false);
  assert.equal(s.looked('gone'), undefined);
  assert.equal(s.project('p1').paused, true);
});

test('budget override and the once-per-period note', () => {
  const s = new AwayStore(dir());
  s.setBudgetOverride('p1', '2026-10-19T00:00:00.000Z');
  assert.equal(s.project('p1').budgetOverrideUntil, '2026-10-19T00:00:00.000Z');
  s.setBudgetOverride('p1', undefined);
  assert.equal(s.project('p1').budgetOverrideUntil, undefined);
  assert.equal(s.budgetNoted('p1'), undefined);
  s.noteBudget('p1', '2026-10-12T00:00:00.000Z');
  assert.equal(s.budgetNoted('p1'), '2026-10-12T00:00:00.000Z');
});

test('a hostile file cannot keep a budget off for long: the override is cut to the end of the current period and dropped without a budget', () => {
  const d = dir();
  mkd(d);
  write(d, {
    version: 1,
    projects: {
      far: { budget: { limit: 5, period: 'week' }, budgetOverrideUntil: '2999-01-01T00:00:00.000Z' },
      none: { budgetOverrideUntil: '2999-01-01T00:00:00.000Z' },
      junk: { budget: { limit: 5, period: 'day' }, budgetOverrideUntil: 'not a date' },
      ok: { budget: { limit: 5, period: 'month' } },
    },
  });
  const s = new AwayStore(d);
  const now = Date.now();
  const far = s.project('far').budgetOverrideUntil!;
  assert.ok(Date.parse(far) <= periodEnd('week', now), `cut to the week end, got ${far}`);
  assert.equal(s.project('none').budgetOverrideUntil, undefined, 'no budget, no override');
  assert.equal(s.project('junk').budgetOverrideUntil, undefined, 'not a date is not an override');
  assert.equal(s.project('ok').budgetOverrideUntil, undefined);
});

test('the doc comment says the truth about the file', () => {
  const src = readFileSync(join(process.cwd(), 'src/core/away/store.ts'), 'utf8');
  assert.match(src, /undo the owner's own pause or budget/);
  assert.doesNotMatch(src, /can only RESTRICT/);
});

test('sounds: defaults on, Forge, 60 percent; a patch is validated and kept across a restart', async () => {
  const d = dir();
  const s = new AwayStore(d);
  assert.deepEqual(s.app().sounds, { enabled: true, pack: 'forge', volume: 0.6 });
  s.patchApp({ sounds: { enabled: false, pack: 'zen', volume: 0.25 } });
  await s.flush();
  assert.deepEqual(new AwayStore(d).app().sounds, { enabled: false, pack: 'zen', volume: 0.25 });
  s.patchApp({ sounds: { volume: 1 } });
  assert.deepEqual(s.app().sounds, { enabled: false, pack: 'zen', volume: 1 });
  for (const bad of [{ sounds: 'on' }, { sounds: { enabled: 'yes' } }, { sounds: { volume: 1.5 } }, { sounds: { volume: -0.1 } }, { sounds: { volume: Number.NaN } }, { sounds: { pack: '../x' } }, { sounds: { pack: '' } }, { sounds: { pack: 5 } }]) {
    assert.throws(() => s.patchApp(bad as never), (e: unknown) => e instanceof AwayError && e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(s.app().sounds, { enabled: false, pack: 'zen', volume: 1 });
});

test('sounds: a damaged stored value falls back to the defaults', () => {
  const d = dir(); mkd(d);
  write(d, { version: 1, app: { sounds: { enabled: 'x', pack: 7, volume: 9 } }, projects: {} });
  assert.deepEqual(new AwayStore(d).app().sounds, { enabled: true, pack: 'forge', volume: 0.6 });
});
