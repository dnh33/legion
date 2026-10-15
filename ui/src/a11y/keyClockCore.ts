/**
 * The arm of a card, as pure functions (no DOM, no React). keyClock.ts holds the page's one clock and one appearance store, and wires them to
 * the window; the components call createCardArm through useCardArm.
 */
import { ARM_MS, isArmed } from '../../../src/shared/approval-keys.js';

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift', 'Control', 'Alt', 'Meta']);
/** Keys that move the focus or the highlight. They restart nothing: arrows between a question's options do not make it wait again. */
export const isNavKey = (key: string): boolean => NAV_KEYS.has(key);

export interface KeyClock {
  /** Records a key once (keyed by its event) and returns the time of the key recorded before it. Navigation keys record nothing. */
  note(event: object, now: number, keyName: string): number;
  /** The time of the last key or stamp on the page. */
  last(): number;
  /** A moment that counts as activity (the window coming back, becoming visible): the quiet period starts there. */
  stamp(now: number): void;
}

/** A clock of key presses. Each key is recorded once, so every reader of the same key gets the same answer, in any order. */
export function createKeyClock(): KeyClock {
  let current: object | null = null;
  let at = 0;
  let before = 0;
  return {
    note(event, now, keyName) {
      if (isNavKey(keyName)) return at;
      if (event !== current) { before = at; at = now; current = event; }
      return before;
    },
    last: () => at,
    stamp(now) { if (now > at) at = now; },
  };
}

export interface Appearances {
  /** When the item first appeared: set on first sight, kept after a remount or a view change. */
  appearedAt(key: string, now: number): number;
  /** The item was revealed: its arm starts again from `now`. */
  restart(key: string, now: number): void;
  /** Forgets the items under `prefix` that are not in `live`, and no other owner's items. */
  prune(prefix: string, live: ReadonlySet<string>): void;
}

export function createAppearances(): Appearances {
  const map = new Map<string, number>();
  return {
    appearedAt(key, now) { if (!map.has(key)) map.set(key, now); return map.get(key)!; },
    restart(key, now) { map.set(key, now); },
    prune(prefix, live) { for (const k of [...map.keys()]) if (k.startsWith(prefix) && !live.has(k)) map.delete(k); },
  };
}

export interface CardArm {
  /** True when the card answers now: ARM_MS after its appearance or its focus from outside, and after the last key. Records nothing. */
  armedNow(now: number): boolean;
  /** Milliseconds until `armedNow` turns true (0 when it is). */
  untilArmed(now: number): number;
  /** Focus moved onto the card: `container` is the card, `related` the element focus came from. Only a move from outside counts. */
  enterFrom(container: { contains(node: unknown): boolean }, related: unknown, now: number): void;
  /**
   * A key pressed on the card (or its controls). Records the key, and returns whether it may answer: not on a repeat (a held key), and only
   * when armed. The verdict is kept for the click the key may cause (see click).
   */
  key(event: object, keyName: string, repeat: boolean, now: number): boolean;
  /**
   * A click. A mouse click (detail 1 or more) is always allowed. A keyboard-synthesised click (detail 0) is allowed when the key that caused it
   * was allowed; with no key before it (an assistive activation), when the card is armed now. Each verdict is used once.
   */
  click(detail: number, now: number): boolean;
}

/** `appearedAt` gives the card's appearance (read each time: a reveal may move it). `clock` is the page's clock. */
export function createCardArm(clock: KeyClock, appearedAt: () => number): CardArm {
  let focusedAt = 0;
  let verdict: boolean | null = null;
  const since = (): number => Math.max(appearedAt(), focusedAt);
  const armedAt = (now: number, quiet: number): boolean => isArmed(since(), quiet, now);
  return {
    armedNow: (now) => armedAt(now, clock.last()),
    untilArmed: (now) => Math.max(0, ARM_MS - (now - Math.max(since(), clock.last()))),
    enterFrom: (container, related, now) => {
      if (!related || !container.contains(related)) focusedAt = now;
    },
    key: (event, keyName, repeat, now) => {
      const quiet = clock.note(event, now, keyName);
      const ok = !repeat && armedAt(now, quiet);
      if (!isNavKey(keyName)) verdict = ok;
      return ok;
    },
    click: (detail, now) => {
      if (detail !== 0) return true;
      const ok = verdict ?? armedAt(now, clock.last());
      verdict = null;
      return ok;
    },
  };
}
