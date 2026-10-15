/**
 * The focus-ring setting (Settings > Accessibility). Off by default: keyboard focus shows a soft tint, and no ring. On: the rings that
 * kbdNav.ts gates (every `:root[data-kbd-nav][data-focus-rings]` rule in the UI CSS) come back. Stored like the theme (localStorage),
 * and mirrored as `data-focus-rings` on <html>. The stores and the root are passed in so the logic runs without a browser.
 */
export const FOCUS_RINGS_KEY = 'legion.focusRings';
export const FOCUS_RINGS_ATTR = 'data-focus-rings';

export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface AttrTarget { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }

const browserStore = (): KeyValueStore | null => {
  try { return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null; } catch { return null; }
};

/** Only the stored '1' turns the rings on. A missing, unreadable or odd value is off. */
export function readFocusRings(store: Pick<KeyValueStore, 'getItem'> | null = browserStore()): boolean {
  try { return store?.getItem(FOCUS_RINGS_KEY) === '1'; } catch { return false; }
}

export function applyFocusRings(on: boolean, root: AttrTarget = document.documentElement): void {
  if (on) root.setAttribute(FOCUS_RINGS_ATTR, '');
  else root.removeAttribute(FOCUS_RINGS_ATTR);
}

/** Stores the choice and applies it to the page at once. */
export function setFocusRings(on: boolean, store: KeyValueStore | null = browserStore(), root: AttrTarget = document.documentElement): void {
  try { store?.setItem(FOCUS_RINGS_KEY, on ? '1' : '0'); } catch { /* the page still follows the choice for this session */ }
  applyFocusRings(on, root);
}
