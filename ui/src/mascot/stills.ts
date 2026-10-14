/**
 * URLs of the pre-rendered bust stills (made by scripts/build-bust-stills.mjs). Vite emits them as files next to the bundle and
 * resolves each URL relative to the page, so they load from file:// in the packaged app (vite.config.ts keeps them out of data URIs).
 */
import { STILL_BUSTS, STILL_THEMES, stillFile, stillState, type StillState, type StillTheme } from './stillsLogic';

const files = import.meta.glob('./stills/*/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The resting picture for a bust in a pose and theme, or undefined when there is none (a custom agent: keep the live bust). */
export const stillUrl = (bust: string, pose: string, theme: StillTheme): string | undefined => files[`./stills/${stillFile(bust, stillState(pose), theme)}`];

export const hasStill = (bust: string): boolean => stillUrl(bust, 'idle', 'dark') !== undefined;

let warmed = false;
/** Decode the poses a rail shows most, once, when the browser is idle, so the first visit paints without a pop-in. */
export function warmStills(theme: StillTheme): void {
  if (warmed || typeof window === 'undefined') return;
  warmed = true;
  const poses: StillState[] = ['idle', 'awaiting', 'hacking', 'thinking'];
  const urls = STILL_BUSTS.flatMap((b) => poses.map((p) => stillUrl(b, p, theme))).filter((u): u is string => !!u);
  const run = () => { for (const u of urls) { const i = new Image(); i.decoding = 'async'; i.src = u; } };
  const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run); else setTimeout(run, 400);
}

export { STILL_THEMES };
