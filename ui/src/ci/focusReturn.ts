/**
 * Where focus goes when the CI panel closes: the title-bar chip; if the chip is hidden (no repo), the command palette button; failing that the
 * main content heading, then <main> itself. Never <body>. `q` is document.querySelector (a parameter so it can be tested without a DOM).
 */
export interface Focusable { focus(o?: { preventScroll?: boolean }): void; setAttribute?(n: string, v: string): void; hasAttribute?(n: string): boolean }

export const RETURN_SELECTORS = ['.tb-ci', '.tb-search', 'main h1, main h2, main [role="heading"]', 'main'] as const;

export function pickReturnFocus(q: (sel: string) => Focusable | null): Focusable | null {
  for (const sel of RETURN_SELECTORS) {
    const el = q(sel);
    if (!el) continue;
    // a heading or <main> is not focusable by default
    if (sel !== '.tb-ci' && sel !== '.tb-search' && el.hasAttribute && !el.hasAttribute('tabindex')) el.setAttribute?.('tabindex', '-1');
    return el;
  }
  return null;
}
