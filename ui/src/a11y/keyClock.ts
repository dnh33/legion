/**
 * The page's key clock, wired to the window. One clock and one appearance store per page: a card's arm, the thread's shortcut and the digest
 * read the same ones. The pure rules are in keyClockCore.ts (tested); this file only holds the state and the listeners.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CardArm, type Appearances, createAppearances, createCardArm, createKeyClock, type KeyClock } from './keyClockCore.js';

/** Kept on globalThis: a hot reload evaluates this module again, and the listeners below must be installed once. */
const shared = ((globalThis as { __legionKeyClock?: { clock: KeyClock; appear: Appearances; installed: boolean } }).__legionKeyClock ??= {
  clock: createKeyClock(),
  appear: createAppearances(),
  installed: false,
});
const page = shared.clock;
export const appearances = shared.appear;

/** The time of the key before this one. Every keydown on the page is recorded, in capture phase, so a key a list stops from bubbling still counts. */
export const quietBefore = (event: object, now: number, keyName: string): number => page.note(event, now, keyName);
export const appearedAt = (key: string, now: number): number => appearances.appearedAt(key, now);
export const pruneAppearances = (prefix: string, live: ReadonlySet<string>): void => appearances.prune(prefix, live);
/** A reveal: the item's arm starts again from `now`. */
export const restartAppearance = (key: string, now: number): void => appearances.restart(key, now);

const onKeyForClock = (e: KeyboardEvent): void => { quietBefore(e, performance.now(), e.key); };
if (typeof window !== 'undefined' && !shared.installed) {
  shared.installed = true;
  window.addEventListener('keydown', onKeyForClock, true);
  // the window coming back, or the page becoming visible: the quiet period starts there (a card focused in another window is not armed at once)
  window.addEventListener('focus', () => page.stamp(performance.now()));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) page.stamp(performance.now()); });
}

/** A card's arm. The card's appearance is taken on first render; a remount keeps it. */
export function useCardArm(key: string): CardArm {
  const arm = useRef<CardArm | null>(null);
  appearances.appearedAt(key, performance.now());
  if (!arm.current) arm.current = createCardArm(page, () => appearances.appearedAt(key, performance.now()));
  return arm.current;
}

/**
 * The arm as the card shows it: `armed` (the hints undim, the card answers), and `refresh`, to call after a key or a focus. While the card is
 * not armed, it re-checks when the wait is due, so the hints undim by themselves.
 */
export function useArmUi(arm: CardArm): { armed: boolean; refresh: () => void } {
  const [armed, setArmed] = useState(() => arm.armedNow(performance.now()));
  const timer = useRef<number | undefined>(undefined);
  const refresh = useCallback((): void => {
    const now = performance.now();
    const ok = arm.armedNow(now);
    setArmed(ok);
    window.clearTimeout(timer.current);
    if (!ok) timer.current = window.setTimeout(() => refresh(), arm.untilArmed(now) + 5);
  }, [arm]);
  useEffect(() => { refresh(); return () => window.clearTimeout(timer.current); }, [refresh]);
  return { armed, refresh };
}
