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

export type TipLayout = { mode: 'float'; placed: Placed } | { mode: 'inline' };
const hit = (a: Box, b: Box): boolean => a.left < b.left + b.w && a.left + a.w > b.left && a.top < b.top + b.h && a.top + a.h > b.top;

/**
 * A tip must never cover a control or the page heading. Tries the preferred floating spot, then beside the anchor, then
 * above it; a spot counts only if it stays in the window and its rect meets none of `obstacles` (rects of the interactive
 * elements and the main heading, without the anchor and the tip). When none works the tip is an inline callout under the
 * anchor's row: it takes layout space and pushes the content down once.
 */
export function chooseTipLayout(a: Box, size: { w: number; h: number }, win: { w: number; h: number }, pref: TipPlacement, obstacles: readonly Box[]): TipLayout {
  const real = obstacles.filter((o) => o.w > 0 && o.h > 0);
  const seen = new Set<string>();
  const tries: Array<{ side: TipPlacement; strict: boolean }> = [{ side: pref, strict: false }, { side: 'right', strict: true }, { side: 'top', strict: true }];
  for (const t of tries) {
    const placed = placeTip(a, size, win, t.side);
    if (t.strict && placed.placement !== t.side) continue;
    const box: Box = { left: placed.left, top: placed.top, w: size.w, h: size.h };
    const key = `${box.left},${box.top}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inWindow = box.left >= MARGIN && box.top >= MARGIN && box.left + box.w <= win.w - MARGIN && box.top + box.h <= win.h - MARGIN;
    if (inWindow && !real.some((o) => hit(box, o))) return { mode: 'float', placed };
  }
  return { mode: 'inline' };
}
