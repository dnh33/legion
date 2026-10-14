/**
 * What's new tips, pure: when a tour may start, the idle gate, the tour's own state (Next, End tour) and
 * where a tip sits. No React, no DOM, no clock; test/whats-new-tips.test.ts runs it as it is.
 */
import type { TipPlacement } from './releases.js';

export interface StartInput { enabled: boolean; version: string; seen: readonly string[]; priorUse: boolean; tipCount: number }
export type StartDecision = 'start' | 'mark-seen' | 'none';

/** A fresh install (nothing seen, nothing used before) never gets a tour: that version is marked seen instead. */
export function decideStart(i: StartInput): StartDecision {
  if (!i.enabled || !i.version || i.tipCount === 0 || i.seen.includes(i.version)) return 'none';
  if (i.seen.length === 0 && !i.priorUse) return 'mark-seen';
  return 'start';
}

export interface BusyInput { approvals: number; questions: number; holding: boolean }
/** Nothing needs the user and no hold countdown runs. */
export function isIdle(b: BusyInput): boolean { return b.approvals === 0 && b.questions === 0 && !b.holding; }

export interface Tour { pending: string[] }
export const startTour = (ids: readonly string[]): Tour => ({ pending: [...ids] });
/** The first pending tip whose anchor is on screen; null when none is (a tip waits for its view). */
export function pickTip(t: Tour, present: ReadonlySet<string>): string | null { return t.pending.find((id) => present.has(id)) ?? null; }
/** Next leaves this tip behind for good. */
export const nextTip = (t: Tour, id: string): Tour => (t.pending.includes(id) ? { pending: t.pending.filter((x) => x !== id) } : t);
export const tipDone = (t: Tour): boolean => t.pending.length === 0;
/** End tour, Escape: stop, and this version counts as seen. There is no postpone-until-next-launch path. */
export const endTour = (_t: Tour): Tour => ({ pending: [] });

export interface Box { left: number; top: number; w: number; h: number }
export interface Placed { left: number; top: number; placement: TipPlacement; /** Distance of the caret from the tip's start edge (top or left), in px. */ caret: number }
const GAP = 12;
const MARGIN = 8;
const CARET_MIN = 14;
const OPPOSITE: Record<TipPlacement, TipPlacement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function room(a: Box, win: { w: number; h: number }, side: TipPlacement): number {
  if (side === 'top') return a.top - MARGIN - GAP;
  if (side === 'bottom') return win.h - MARGIN - GAP - (a.top + a.h);
  if (side === 'left') return a.left - MARGIN - GAP;
  return win.w - MARGIN - GAP - (a.left + a.w);
}
const need = (side: TipPlacement, s: { w: number; h: number }): number => (side === 'top' || side === 'bottom' ? s.h : s.w);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * Puts the tip on its preferred side of the anchor, flips to the opposite side (then the sides across) when it does not
 * fit, and aligns it with the anchor's start edge (clamped into the window) with a caret that points at the anchor.
 * Never on top of the anchor when any side has room.
 */
export function placeTip(a: Box, size: { w: number; h: number }, win: { w: number; h: number }, pref: TipPlacement): Placed {
  const cross: TipPlacement[] = pref === 'top' || pref === 'bottom' ? ['right', 'left'] : ['bottom', 'top'];
  const order: TipPlacement[] = [pref, OPPOSITE[pref], ...cross];
  const side = order.find((s) => room(a, win, s) >= need(s, size)) ?? order.reduce((best, s) => (room(a, win, s) > room(a, win, best) ? s : best));
  const horizontal = side === 'top' || side === 'bottom';
  const fixed = horizontal
    ? (side === 'top' ? a.top - GAP - size.h : a.top + a.h + GAP)
    : (side === 'left' ? a.left - GAP - size.w : a.left + a.w + GAP);
  const start = horizontal ? a.left : a.top;
  const pointAt = horizontal ? a.left + Math.min(a.w / 2, 18) : a.top + Math.min(a.h / 2, 18);
  const span = horizontal ? size.w : size.h;
  const best = clamp(start, MARGIN, (horizontal ? win.w - size.w : win.h - size.h) - MARGIN);
  const at = (v: number): Box => (horizontal ? { left: v, top: fixed, ...size } : { left: fixed, top: v, ...size });
  const box = at(best);
  const caret = clamp(pointAt - best, CARET_MIN, span - CARET_MIN);
  return { left: box.left, top: box.top, placement: side, caret };
}
