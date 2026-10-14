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
