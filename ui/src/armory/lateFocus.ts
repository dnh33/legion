/**
 * Focus after a slow action (Remove): remembers where focus was when the action started, and at the end says whether moving focus is
 * still the right thing. It is not when a key was pressed since (the owner is already doing something else, and a late move would
 * hand the next keypress to a button) or when focus has moved somewhere outside `scope`. Focus that fell to the page because the
 * control went away counts as "still ours".
 */
export interface FocusIntent { still(): boolean; done(): void }

export function focusIntent(scope: Element | null): FocusIntent {
  let typed = false;
  const onKey = (): void => { typed = true; };
  window.addEventListener('keydown', onKey, true);
  return {
    still(): boolean {
      const a = document.activeElement;
      return !typed && (!a || a === document.body || !!scope?.contains(a));
    },
    done(): void { window.removeEventListener('keydown', onKey, true); },
  };
}

export interface FocusWhenReady {
  /** The element to focus, looked up again on every try: it may not be on screen yet (a list still loading, a group still opening). */
  find: () => HTMLElement | null;
  /** Where focus goes when the element never comes. Never the page itself. */
  fallback?: () => HTMLElement | null;
  /** Asked before every try: false means the owner has gone elsewhere, and focus is left alone. */
  wanted?: () => boolean;
  /** How many tries (one per frame). Default 90, about one and a half seconds. */
  tries?: number;
  /** Test hook: how the next try is scheduled. */
  schedule?: (run: () => void) => void;
  /** Called once, whatever the outcome ('element', 'fallback' or 'gone'). */
  done?: (how: 'element' | 'fallback' | 'gone') => void;
}

const nextFrame = (run: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
  else setTimeout(run, 16);
};
const focused = (el: HTMLElement): boolean => document.activeElement === el;

/**
 * Focus an element that may not exist yet, or may exist but not be focusable yet (a row in a group that has not opened). It tries on
 * every frame until the element really holds focus (a focus() on a hidden element does nothing, so a call is not proof), then stops.
 * When it never does, focus goes to `fallback`, so a keyboard user is never left on the page itself. Returns a cancel function.
 */
export function focusWhenReady(o: FocusWhenReady): () => void {
  const schedule = o.schedule ?? nextFrame;
  let left = o.tries ?? 90;
  let over = false;
  const finish = (how: 'element' | 'fallback' | 'gone'): void => { if (over) return; over = true; o.done?.(how); };
  const step = (): void => {
    if (over) return;
    if (o.wanted && !o.wanted()) { finish('gone'); return; }
    const el = o.find();
    if (el) {
      el.focus();
      if (focused(el)) { finish('element'); return; }
    }
    if (--left > 0) { schedule(step); return; }
    const fb = o.fallback?.();
    if (fb) { fb.focus(); finish(focused(fb) ? 'fallback' : 'gone'); } else finish('gone');
  };
  step();
  return () => { over = true; };
}
