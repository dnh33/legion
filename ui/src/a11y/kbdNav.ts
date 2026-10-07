/**
 * Keyboard-only focus rings. A ring is for people who navigate with the keyboard: Tab or Shift+Tab sets `data-kbd-nav` on <html>, any pointer
 * press removes it. Every focus ring in the CSS sits under `:root[data-kbd-nav]` (test/ui-kbd-nav.test.ts keeps it so), which means a mouse
 * user never sees one, not even after pressing Escape (focus returning to a button is not a reason to draw a ring).
 * The target is passed in so the logic runs without a browser.
 */
export const KBD_ATTR = 'data-kbd-nav';

type Handler = (e: never) => void;

export interface KbdTarget {
  documentElement: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void };
  addEventListener(type: string, fn: Handler, capture?: boolean): void;
  removeEventListener(type: string, fn: Handler, capture?: boolean): void;
}

/** Starts the tracking; returns the stop function, which also clears the attribute. */
export function startKbdNav(doc: KbdTarget = document as unknown as KbdTarget): () => void {
  const key = ((e: { key?: string }): void => { if (e.key === 'Tab') doc.documentElement.setAttribute(KBD_ATTR, ''); }) as Handler;
  const pointer = ((): void => doc.documentElement.removeAttribute(KBD_ATTR)) as Handler;
  doc.addEventListener('keydown', key, true);
  doc.addEventListener('pointerdown', pointer, true);
  return () => {
    doc.removeEventListener('keydown', key, true);
    doc.removeEventListener('pointerdown', pointer, true);
    doc.documentElement.removeAttribute(KBD_ATTR);
  };
}
