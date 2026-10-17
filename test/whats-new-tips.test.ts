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
import { decideStart, hasTipsFor, endTour, isIdle, nextTip, pickTip, placeTip, chooseTipLayout, startTour, tipDone } from '../ui/src/whatsnew/tipsLogic.js';
import { markSeen, readEnabled, readSeen, writeEnabled } from '../ui/src/whatsnew/tipsStorage.js';

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
  it('Next moves on and never repeat a tip; the end of the list ends the tour', () => {
    let t = nextTip(startTour(ids), 'a');
    assert.deepEqual(t.pending, ['b', 'c']);
    t = nextTip(nextTip(t, 'b'), 'c');
    assert.equal(tipDone(t), true);
    assert.equal(pickTip(t, new Set(ids)), null);
  });
  it('End tour stops everything; there is no skip-for-now path', () => {
    const t = endTour(startTour(ids));
    assert.equal(t.pending.length, 0);
    assert.equal(pickTip(t, new Set(ids)), null);
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
  it('when storage throws: nothing throws (switch on, nothing seen)', () => {
    assert.deepEqual(readSeen(brokenKv), []);
    assert.equal(readEnabled(brokenKv), true);
    assert.doesNotThrow(() => { markSeen(brokenKv, '0.3.0'); writeEnabled(brokenKv, false); });
  });
});

describe('placement: flips, clamps, never covers the anchor', () => {
  const win = { w: 1000, h: 700 };
  const size = { w: 300, h: 120 };
  type R = { left: number; top: number; w: number; h: number };
  const overlaps = (a: R, b: R): boolean => a.left < b.left + b.w && a.left + a.w > b.left && a.top < b.top + b.h && a.top + a.h > b.top;
  it('sits under the anchor start edge, with a caret pointing at the anchor', () => {
    const a = { left: 264, top: 114, w: 900, h: 36 };
    const p = placeTip(a, size, win, 'bottom');
    assert.equal(p.left, 264);
    assert.equal(p.caret, 18);
    const near = placeTip({ left: 960, top: 200, w: 30, h: 30 }, size, win, 'bottom');
    assert.ok(near.caret >= 14 && near.caret <= size.w - 14);
    assert.ok(near.left + size.w <= win.w - 8);
  });
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
      assert.ok(all.includes(`data-tip="${name}"`) || all.includes(`? '${name}' : undefined`), `no data-tip="${name}" in the source`);
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
  it('Next (Done on the last), End tour, and on the first tip the link that turns the switch off; Escape ends; no Skip', () => {
    assert.match(tsx, /'Done' : 'Next'/);
    assert.match(tsx, /End tour/);
    assert.doesNotMatch(tsx, /Skip/);
    assert.match(tsx, /Don.t show tips after updates/);
    assert.match(tsx, /'Escape'/);
  });
  it('a caret ties the tip to its anchor, in CSS only', () => {
    assert.match(css, /\.wn-tip::before/);
    assert.match(css, /--wn-caret/);
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

describe('layout: a floating tip never covers a control or the page heading', () => {
  const win = { w: 1280, h: 800 };
  const size = { w: 320, h: 130 };
  const hits = (a: { left: number; top: number; w: number; h: number }, b: { left: number; top: number; w: number; h: number }): boolean => a.left < b.left + b.w && a.left + a.w > b.left && a.top < b.top + b.h && a.top + a.h > b.top;
  // The reported layout: tabs row, then the heading and the primary button right under it.
  const tabs = { left: 264, top: 114, w: 960, h: 36 }; // the row runs to the window edge, so nothing fits beside it
  const heading = { left: 264, top: 168, w: 200, h: 32 };
  const primary = { left: 264, top: 212, w: 120, h: 32 };
  it('chooses inline when the heading and the primary button sit under the anchor row', () => {
    const l = chooseTipLayout(tabs, size, win, 'bottom', [heading, primary]);
    assert.equal(l.mode, 'inline');
  });
  it('stays floating when the preferred spot covers nothing', () => {
    const l = chooseTipLayout(tabs, size, win, 'bottom', [{ left: 264, top: 500, w: 100, h: 30 }]);
    assert.equal(l.mode, 'float');
    if (l.mode === 'float') assert.equal(l.placed.placement, 'bottom');
  });
  it('tries the right of the anchor next, when that spot is clear', () => {
    const narrow = { left: 264, top: 114, w: 360, h: 36 };
    const l = chooseTipLayout(narrow, size, win, 'bottom', [heading, primary]);
    assert.equal(l.mode, 'float');
    if (l.mode === 'float') {
      assert.equal(l.placed.placement, 'right');
      for (const o of [heading, primary]) assert.equal(hits({ left: l.placed.left, top: l.placed.top, ...size }, o), false);
    }
  });
  it('falls back to above when below and right are covered, and above is clear', () => {
    const a = { left: 264, top: 300, w: 900, h: 36 };
    const l = chooseTipLayout(a, size, win, 'bottom', [{ left: 264, top: 350, w: 120, h: 32 }]);
    assert.equal(l.mode, 'float');
    if (l.mode === 'float') assert.equal(l.placed.placement, 'top');
  });
  it('goes inline when every floating spot is covered or off the window', () => {
    const a = { left: 264, top: 40, w: 1000, h: 36 };
    const l = chooseTipLayout(a, size, win, 'bottom', [{ left: 264, top: 90, w: 120, h: 32 }]);
    assert.equal(l.mode, 'inline');
  });
  it('ignores empty obstacle boxes', () => {
    const l = chooseTipLayout(tabs, size, win, 'bottom', [{ left: 0, top: 0, w: 0, h: 0 }]);
    assert.equal(l.mode, 'float');
  });
});

describe('the What is new button', () => {
  it('shows only when this version brings at least one tip', () => {
    const rel = [{ version: '1.0.0', tips: [{}] }, { version: '1.1.0', tips: [] }];
    assert.equal(hasTipsFor('1.0.0', rel), true);
    assert.equal(hasTipsFor('1.1.0', rel), false);
    assert.equal(hasTipsFor('9.9.9', rel), false);
    assert.equal(hasTipsFor('', rel), false);
  });
  it('Settings gates the button on it', () => {
    assert.match(src('components/Settings.tsx'), /hasTipsFor\(version, RELEASES\)/);
  });
});
