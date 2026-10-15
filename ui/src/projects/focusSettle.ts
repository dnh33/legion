/**
 * A click that opens one Inbox entry or one proposal card brings it into view and gives it focus. The page can still move after that: the
 * tour's inline callout pushes the content down, and a closing sheet used to hand focus back to "New task". So the target is placed again on
 * each layout change for SETTLE_MS, and the placing stops as soon as the owner acts. The rules are pure (tested); settleFocus is the DOM part.
 */
import { canTakeFocus } from './railRoute.js';

export const SETTLE_MS = 1000;

/** Still inside the window, and the owner has not pressed, clicked or scrolled: place the target again. */
export function keepSettling(startedAt: number, now: number, interacted = false): boolean {
  return !interacted && now - startedAt <= SETTLE_MS;
}

/** The box lies fully inside the scroll view. An empty box is not in view. */
export function inView(box: { top: number; bottom: number }, view: { top: number; bottom: number }): boolean {
  return box.bottom > box.top && box.top >= view.top && box.bottom <= view.bottom;
}

const OWNER_EVENTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;

/** The nearest ancestor that scrolls, as the box to test against; the window when none does. */
function viewOf(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
      const r = p.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * Brings `el` into view and focuses it now, then again on each layout change for SETTLE_MS, until the owner presses a key, clicks, scrolls, or
 * the element leaves the page. Focus moves unless a text field has it (canTakeFocus). Returns the stop function (safe to call twice).
 */
export function settleFocus(el: HTMLElement): () => void {
  const startedAt = performance.now();
  let frame = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let mo: MutationObserver | undefined;
  let ro: ResizeObserver | undefined;
  const queue = (): void => { if (!frame && !stopped) frame = requestAnimationFrame(place); };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(timer);
    mo?.disconnect();
    ro?.disconnect();
    window.removeEventListener('resize', queue);
    for (const t of OWNER_EVENTS) document.removeEventListener(t, stop, true);
  };
  function place(): void {
    frame = 0;
    if (!el.isConnected || !keepSettling(startedAt, performance.now())) { stop(); return; }
    if (!inView(el.getBoundingClientRect(), viewOf(el))) el.scrollIntoView?.({ block: 'nearest' });
    const active = document.activeElement as HTMLElement | null;
    if (active !== el && canTakeFocus(active)) el.focus({ preventScroll: true });
  }
  for (const t of OWNER_EVENTS) document.addEventListener(t, stop, true);
  window.addEventListener('resize', queue);
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(queue);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(queue); ro.observe(el); }
  timer = setTimeout(stop, SETTLE_MS + 16);
  queue();
  return stop;
}
