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
  // Tab always means keyboard navigation. Arrow keys do too when they move between controls (a menu, a list, a radio group), but not
  // inside a text field, where they move the caret. Enter, Space, Escape and typing do not: people who use the mouse press those all
  // the time (the maintainer's rule, 2026-10-07: rings only for keyboard navigation, never for a mouse user, not even after Escape).
  const NAV = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  const inText = (t: unknown): boolean => {
    const el = t as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName ?? '').toUpperCase();
    return tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes((el.type ?? 'text').toLowerCase()));
  };
  const key = ((e: { key?: string; target?: unknown }): void => {
    if (!e.key || !NAV.has(e.key)) return;
    if (e.key !== 'Tab' && inText(e.target)) return;
    doc.documentElement.setAttribute(KBD_ATTR, '');
  }) as Handler;
  const pointer = ((): void => doc.documentElement.removeAttribute(KBD_ATTR)) as Handler;
  doc.addEventListener('keydown', key, true);
  doc.addEventListener('pointerdown', pointer, true);
  return () => {
    doc.removeEventListener('keydown', key, true);
    doc.removeEventListener('pointerdown', pointer, true);
    doc.documentElement.removeAttribute(KBD_ATTR);
  };
}
