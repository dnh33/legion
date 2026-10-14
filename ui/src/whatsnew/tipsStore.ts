/**
 * What's new tips, the small store: the tour in progress and the "Show tips after updates" switch. The rules are in
 * tipsLogic.ts (pure, tested); this file only holds state, reads and writes storage, and tells React.
 */
import { useSyncExternalStore } from 'react';
import { tipsFor } from './releases';
import type { Tip } from './releases';
import { decideStart, nextTip, startTour } from './tipsLogic';
import type { Tour } from './tipsLogic';
import { markSeen, readEnabled, readSeen, writeEnabled } from './tipsStorage';
import type { Kv } from './tipsStorage';

export interface TipsState {
  enabled: boolean;
  /** The tour in progress, or null. */
  tour: Tour | null;
  version: string;
  tips: Tip[];
  /** How many tips the user has moved past; 0 means the next one shown is the first. */
  moved: number;
}

const kv = (): Kv | null => { try { return window.localStorage; } catch { return null; } };
const noKv: Kv = { length: 0, key: () => null, getItem: () => null, setItem: () => undefined };
const store = (): Kv => kv() ?? noKv;

let state: TipsState = { enabled: readEnabled(store()), tour: null, version: '', tips: [], moved: 0 };
const subs = new Set<() => void>();
function set(p: Partial<TipsState>): void { state = { ...state, ...p }; subs.forEach((f) => f()); }
export const getTips = (): TipsState => state;
export function useTips(): TipsState { return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state); }

/**
 * Once the app has loaded and knows its version: start the tour, or quietly record a fresh install. Safe to call again.
 * `usedBefore` reads the evidence the core's own data gives of an earlier version (tasks, projects) or that the welcome screen was
 * dismissed. The core keeps no last-version record, and the old key scan of localStorage was a guess a cleared cache breaks.
 */
let settling = false;
export function autoStartTips(version: string, usedBefore: () => boolean): void {
  if (state.tour || !version || settling) return;
  const tips = tipsFor(version);
  const decide = (): 'start' | 'mark-seen' | 'none' => decideStart({ enabled: state.enabled, version, seen: readSeen(store()), priorUse: usedBefore(), tipCount: tips.length });
  const d = decide();
  if (d === 'start') set({ tour: startTour(tips.map((t) => t.id)), version, tips, moved: 0 });
  else if (d === 'mark-seen') {
    // Projects and tasks arrive a moment after the app says it is loaded: look again before calling this a fresh install.
    settling = true;
    setTimeout(() => {
      settling = false;
      const again = decide();
      if (again === 'start') set({ tour: startTour(tips.map((t) => t.id)), version, tips, moved: 0 });
      else if (again === 'mark-seen') markSeen(store(), version);
    }, 2500);
  }
}

/** The "What's new" button: this release's tips again, whatever was seen. Each shows when its page is on screen. */
export function replayTips(version: string): boolean {
  const tips = tipsFor(version);
  if (!tips.length) return false;
  set({ tour: startTour(tips.map((t) => t.id)), version, tips, moved: 0 });
  return true;
}

export function tipNext(id: string): void {
  if (!state.tour) return;
  markSeen(store(), state.version);
  const tour = nextTip(state.tour, id);
  set({ tour: tour.pending.length ? tour : null, moved: state.moved + 1 });
}
/** End tour (and Escape): stop, and this version counts as seen. */
export function tipEnd(): void {
  if (!state.tour) return;
  markSeen(store(), state.version);
  set({ tour: null });
}
export function setTipsEnabled(on: boolean): void { writeEnabled(store(), on); set({ enabled: on }); }
/** The first tip's link: turn the switch off and end the tour. */
export function tipsNeverAgain(): void { setTipsEnabled(false); tipEnd(); }
