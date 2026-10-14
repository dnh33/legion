/**
 * "What's new" tips after an update: the pure rules (when a tour starts, the idle gate, fresh install, per-version seen,
 * skip / end / never again, where the tip sits) and a source guard for the accessibility promises (not modal, no dimming,
 * no focus trap, labelled) and for the data-tip anchors the 0.3.0 tips point at.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { RELEASES, tipsFor } from '../ui/src/whatsnew/releases.js';
import { decideStart, endTour, isIdle, nextTip, pickTip, placeTip, skipTour, startTour, tipDone } from '../ui/src/whatsnew/tipsLogic.js';
import { hasPriorUse, markSeen, readEnabled, readSeen, writeEnabled } from '../ui/src/whatsnew/tipsStorage.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (p: string): string => readFileSync(join(REPO, 'ui', 'src', p), 'utf8');

function memKv(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}
const brokenKv = {
  get length(): number { throw new Error('denied'); },
  key: (): string | null => { throw new Error('denied'); },
  getItem: (): string | null => { throw new Error('denied'); },
  setItem: (): void => { throw new Error('denied'); },
};

describe('when a tour starts', () => {
  const base = { enabled: true, version: '0.3.0', seen: [] as string[], priorUse: true, tipCount: 5 };
  it('starts for an updated user who has not seen this version', () => assert.equal(decideStart(base), 'start'));
  it('never on a fresh install: marks the version seen instead', () => assert.equal(decideStart({ ...base, priorUse: false }), 'mark-seen'));
  it('not again once this version is seen', () => assert.equal(decideStart({ ...base, seen: ['0.3.0'] }), 'none'));
  it('seen is per version: seeing 0.2.0 does not hide 0.3.0', () => assert.equal(decideStart({ ...base, seen: ['0.2.0'] }), 'start'));
  it('a fresh install that later updates still gets the next release tips', () => assert.equal(decideStart({ ...base, version: '0.4.0', seen: ['0.3.0'], priorUse: false }), 'start'));
  it('nothing when the switch is off, the version is unknown, or the release has no tips', () => {
    assert.equal(decideStart({ ...base, enabled: false }), 'none');
    assert.equal(decideStart({ ...base, version: '' }), 'none');
    assert.equal(decideStart({ ...base, tipCount: 0 }), 'none');
  });
});

describe('the idle gate', () => {
  it('idle only with no ask, no question and no hold countdown', () => {
    assert.equal(isIdle({ approvals: 0, questions: 0, holding: false }), true);
    assert.equal(isIdle({ approvals: 1, questions: 0, holding: false }), false);
    assert.equal(isIdle({ approvals: 0, questions: 2, holding: false }), false);
    assert.equal(isIdle({ approvals: 0, questions: 0, holding: true }), false);
  });
});

describe('the tour: skip, end, never again', () => {
  const ids = ['a', 'b', 'c'];
  it('shows the first tip whose anchor is on screen, in order; a missing anchor waits', () => {
    const t = startTour(ids);
    assert.equal(pickTip(t, new Set(['a', 'b'])), 'a');
    assert.equal(pickTip(t, new Set(['b', 'c'])), 'b');
    assert.equal(pickTip(t, new Set()), null);
  });
  it('Next and Skip move on and never repeat a tip; the end of the list ends the tour', () => {
    let t = nextTip(startTour(ids), 'a');
    assert.deepEqual(t.pending, ['b', 'c']);
    t = nextTip(nextTip(t, 'b'), 'c');
    assert.equal(tipDone(t), true);
    assert.equal(pickTip(t, new Set(ids)), null);
  });
  it('End tour stops everything and asks to mark this version seen', () => {
    const r = endTour(startTour(ids));
    assert.equal(r.tour.pending.length, 0);
    assert.equal(r.markSeen, true);
    assert.equal(pickTip(r.tour, new Set(ids)), null);
  });
  it('Skip tour stops for now and does not mark the version seen', () => {
    const r = skipTour(startTour(ids));
    assert.equal(r.tour.pending.length, 0);
    assert.equal(r.markSeen, false);
  });
  it('an unknown id passed to Next changes nothing', () => assert.deepEqual(nextTip(startTour(ids), 'zzz').pending, ids));
});

describe('seen state and settings storage', () => {
  it('remembers versions and reads them back; a version is stored once', () => {
    const kv = memKv();
    markSeen(kv, '0.3.0'); markSeen(kv, '0.3.0'); markSeen(kv, '0.4.0');
    assert.deepEqual(readSeen(kv), ['0.3.0', '0.4.0']);
  });
  it('survives junk in storage', () => {
    assert.deepEqual(readSeen(memKv({ 'legion.tips.seen': '{nope' })), []);
    assert.deepEqual(readSeen(memKv({ 'legion.tips.seen': '[1,"0.3.0",null]' })), ['0.3.0']);
  });
  it('the switch defaults to on and keeps its value', () => {
    const kv = memKv();
    assert.equal(readEnabled(kv), true);
    writeEnabled(kv, false);
    assert.equal(readEnabled(kv), false);
    writeEnabled(kv, true);
    assert.equal(readEnabled(kv), true);
  });
  it('when storage throws: nothing throws (switch on, nothing seen, no prior use)', () => {
    assert.deepEqual(readSeen(brokenKv), []);
    assert.equal(readEnabled(brokenKv), true);
    assert.equal(hasPriorUse(brokenKv), false);
    assert.doesNotThrow(() => { markSeen(brokenKv, '0.3.0'); writeEnabled(brokenKv, false); });
  });
  it('prior use means other legion.* keys exist; our own keys do not count', () => {
    assert.equal(hasPriorUse(memKv()), false);
    assert.equal(hasPriorUse(memKv({ 'legion.tips.seen': '[]', unrelated: '1' })), false);
    assert.equal(hasPriorUse(memKv({ 'legion.theme': 'dark' })), true);
    assert.equal(hasPriorUse(memKv({ 'legion.onboarded': '1' })), true);
  });
});

describe('placement: flips, clamps, never covers the anchor', () => {
  const win = { w: 1000, h: 700 };
  const size = { w: 300, h: 120 };
  type R = { left: number; top: number; w: number; h: number };
  const overlaps = (a: R, b: R): boolean => a.left < b.left + b.w && a.left + a.w > b.left && a.top < b.top + b.h && a.top + a.h > b.top;
  it('uses the preferred side when it fits', () => {
    const a = { left: 400, top: 200, w: 100, h: 30 };
    const p = placeTip(a, size, win, 'bottom');
    assert.equal(p.placement, 'bottom');
    assert.ok(p.top >= a.top + a.h);
    assert.equal(overlaps({ left: p.left, top: p.top, ...size }, a), false);
  });
  it('flips to the other side when the preferred side has no room', () => {
    const a = { left: 400, top: 640, w: 100, h: 30 };
    const p = placeTip(a, size, win, 'bottom');
    assert.equal(p.placement, 'top');
    assert.equal(overlaps({ left: p.left, top: p.top, ...size }, a), false);
  });
  it('clamps into the window on the cross axis', () => {
    const p = placeTip({ left: 960, top: 200, w: 30, h: 30 }, size, win, 'bottom');
    assert.ok(p.left + size.w <= win.w - 8);
    const q = placeTip({ left: 2, top: 200, w: 30, h: 30 }, size, win, 'bottom');
    assert.ok(q.left >= 8);
  });
  it('a right-hand preference near the right edge flips to the left and does not cover the anchor', () => {
    const a = { left: 900, top: 300, w: 80, h: 30 };
    const p = placeTip(a, size, win, 'right');
    assert.equal(p.placement, 'left');
    assert.equal(overlaps({ left: p.left, top: p.top, ...size }, a), false);
  });
  it('in a narrow window (960) a wide anchor still gets a side that does not cover it', () => {
    const a = { left: 100, top: 100, w: 700, h: 40 };
    const p = placeTip(a, size, { w: 960, h: 600 }, 'right');
    assert.equal(overlaps({ left: p.left, top: p.top, ...size }, a), false);
  });
});

describe('releases', () => {
  it('0.3.0 declares the five tips in order, with unique ids, a data-tip anchor and plain text', () => {
    const tips = tipsFor('0.3.0');
    assert.deepEqual(tips.map((t) => t.id), ['project-tabs', 'allow-hold', 'project-away', 'app-notifications', 'spending']);
    assert.equal(new Set(tips.map((t) => t.id)).size, tips.length);
    for (const t of tips) {
      assert.match(t.anchor, /^\[data-tip="[a-z-]+"\]$/);
      assert.doesNotMatch(t.text, /—|–/);
    }
    assert.equal(tipsFor('9.9.9').length, 0);
    assert.ok(RELEASES.length >= 1);
  });
  it('every anchor exists as a data-tip attribute in the UI source', () => {
    const all = ['projects/page/ProjectPage.tsx', 'components/ApprovalCard.tsx', 'projects/page/SettingsTab.tsx', 'away/NotificationsSection.tsx', 'away/SpendingSection.tsx'].map(src).join('\n');
    for (const t of tipsFor('0.3.0')) {
      const name = /"([a-z-]+)"/.exec(t.anchor)![1]!;
      assert.ok(all.includes(`data-tip="${name}"`), `no data-tip="${name}" in the source`);
    }
  });
});

describe('accessibility promises (source guard)', () => {
  const tsx = src('whatsnew/WhatsNew.tsx');
  const css = src('whatsnew/whatsnew.css');
  it('a labelled, non-modal dialog', () => {
    assert.match(tsx, /role="dialog"/);
    assert.match(tsx, /aria-label=/);
    assert.doesNotMatch(tsx, /aria-modal/);
  });
  it('no dimming, no blocking overlay, no focus trap, no auto focus, no auto advance', () => {
    assert.doesNotMatch(css, /scrim|backdrop|inset:\s*0/);
    assert.doesNotMatch(tsx, /autoFocus|focusTrap|\.focus\(/);
    assert.doesNotMatch(tsx, /setTimeout|auto-?advance/i);
  });
  it('the first tip offers Skip tour, End tour and the link that turns the switch off; Escape ends', () => {
    assert.match(tsx, /Skip tour/);
    assert.match(tsx, /End tour/);
    assert.match(tsx, /Don.t show tips after updates/);
    assert.match(tsx, /'Escape'/);
  });
  it('motion only when the user has not asked for less', () => {
    assert.match(css, /prefers-reduced-motion:\s*no-preference/);
    assert.doesNotMatch(css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/, ''), /animation|transition/);
  });
  it('the switch and the replay entry live in Settings', () => {
    const settings = src('components/Settings.tsx');
    assert.match(settings, /Show tips after updates/);
    assert.match(settings, /What.s new/);
  });
});
