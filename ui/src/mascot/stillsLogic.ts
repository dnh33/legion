/**
 * Pure naming for the pre-rendered bust stills (no Vite, no DOM, so node tests can import it).
 * The pictures live in ui/src/mascot/stills/<theme>/<bust>-<state>.webp and are made by scripts/build-bust-stills.mjs.
 */
/** Painted busts, by agent id (zealot is the Marshal). Keep in step with busts.ts; test/bust-still.test.ts checks it. */
export const STILL_BUSTS = ['zealot', 'archivist', 'assayer', 'builder', 'exorcist', 'forgemaster', 'herald', 'inquisitor', 'preceptor', 'scout', 'scribe', 'sculptor', 'sentinel'] as const;
export const STILL_STATES = ['idle', 'awaiting', 'sleeping', 'hacking', 'thinking', 'error'] as const;
export const STILL_THEMES = ['dark', 'light'] as const;
export type StillState = (typeof STILL_STATES)[number];
export type StillTheme = (typeof STILL_THEMES)[number];

/** The picture a pose rests on: the six with their own still, else idle (a brief victory or listening pose shows idle). */
export const stillState = (s: string): StillState => ((STILL_STATES as readonly string[]).includes(s) ? (s as StillState) : 'idle');

/** Path of one still, relative to the stills folder. */
export const stillFile = (bust: string, state: StillState, theme: StillTheme): string => `${theme}/${bust}-${state}.webp`;

/** The square slot the stills were painted in (css px, scripts/build-bust-stills.mjs). The live bust at rest is laid out by the same maths so both land on the same pixels. */
export const STILL_SLOT = 80;
/** Host box of a live resting bust, scaled from the box the still was painted in: the still's host is rounded at SLOT px, so the live one is that, scaled to `size` (not rounded again). */
export function stillBox(frame: readonly number[], size: number): { w: number; h: number } {
  const k = Math.min(STILL_SLOT / frame[2], STILL_SLOT / frame[3]);
  const f = size / STILL_SLOT;
  return { w: Math.round(frame[2] * k) * f, h: Math.round(frame[3] * k) * f };
}
