/**
 * The page's key clock. A card's own keys and the window's thread shortcut both wait ARM_MS after the last key (approval-keys isArmed), so
 * one clock answers both. Each key is recorded once, keyed by its native event: whichever reader comes first records it, and every reader of
 * the same key gets the time of the key before it. So the order of the readers does not matter.
 */
import { useRef } from 'react';
import { isArmed } from '../../../src/shared/approval-keys.js';

export interface KeyClock { note(key: object, now: number): number }

/** A clock of key presses. `note(key, now)` records `key` at `now` (once) and returns the time of the key recorded before it. */
export function createKeyClock(): KeyClock {
  let current: object | null = null;
  let at = 0;
  let before = 0;
  return {
    note(key, now) {
      if (key !== current) { before = at; at = now; current = key; }
      return before;
    },
  };
}

const page = createKeyClock();
/** The time of the key before this one. Every keydown on the page is recorded here (a window listener below), whichever card or view it reaches. */
export const quietBefore = (nativeEvent: object, now: number): number => page.note(nativeEvent, now);

if (typeof window !== 'undefined') window.addEventListener('keydown', (e) => { quietBefore(e, performance.now()); });

/**
 * A card's arm. `armed(nativeEvent)` is true when the card may answer this key: ARM_MS after it appeared or took focus, and after the last key.
 * Call it first in the card's key handler; it records the key, so keys the card ignores still restart the quiet period.
 */
export function useCardArm(): { armed: (nativeEvent: object) => boolean; onFocus: () => void } {
  const appeared = useRef(performance.now());
  const focused = useRef(0);
  return {
    armed: (nativeEvent) => {
      const now = performance.now();
      const quiet = quietBefore(nativeEvent, now);
      return isArmed(Math.max(appeared.current, focused.current), quiet, now);
    },
    onFocus: () => { focused.current = performance.now(); },
  };
}
