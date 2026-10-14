/**
 * Focus never falls to the page body after a re-render (spec 3.2, 8). Every focusable control inside a region carries `data-fk`. Before a
 * render, `captureFocus` notes the focused control and the keys in order; after it, `restoreFocus` finds the same control, else the next
 * surviving sibling, else the previous one, else the region itself.
 */

/** Pure: the key that should hold focus after the list changed from `before` to `after`. Never null. */
export function pickFocusKey(before: readonly string[], anchor: string, after: readonly string[], region: string): string {
  if (after.includes(anchor)) return anchor;
  const i = before.indexOf(anchor);
  if (i < 0) return region;
  for (let j = i + 1; j < before.length; j++) if (after.includes(before[j]!)) return before[j]!;
  for (let j = i - 1; j >= 0; j--) if (after.includes(before[j]!)) return before[j]!;
  return region;
}

export interface FocusSnapshot { anchor: string; keys: string[] }

const keysIn = (root: HTMLElement): string[] => Array.from(root.querySelectorAll<HTMLElement>('[data-fk]')).map((e) => e.dataset.fk!).filter(Boolean);

/** Call before the render. Returns null when focus is not inside `root` (nothing to restore). */
export function captureFocus(root: HTMLElement | null): FocusSnapshot | null {
  const ae = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
  if (!root || !ae || !root.contains(ae)) return null;
  const anchor = ae.closest<HTMLElement>('[data-fk]')?.dataset.fk;
  return anchor ? { anchor, keys: keysIn(root) } : null;
}

/** Call after the render. `region` is the element to fall back on (give it tabindex -1). */
export function restoreFocus(root: HTMLElement | null, snap: FocusSnapshot | null, region: HTMLElement | null = root): void {
  if (!root || !snap) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && root.contains(ae) && (ae as HTMLElement).dataset?.fk === snap.anchor) return;
  const after = keysIn(root);
  const key = pickFocusKey(snap.keys, snap.anchor, after, '\u0000region');
  const target = key === '\u0000region' ? region : root.querySelector<HTMLElement>(`[data-fk="${CSS.escape(key)}"]`);
  target?.focus({ preventScroll: true });
}
