/**
 * The snackbar slot the Armory and Doctrine share for the bars that appear after an action (Undo, Promote). It sits at the END of the
 * section and sticks to the bottom of the scrolling column: it adds no height until a bar is in it (so the list never shifts), it never
 * covers the top of the page, and the end of the page keeps its own room for it. `.set-scroll` has a scroll-padding that keeps a
 * focused element from landing behind it.
 */
import { createPortal } from 'react-dom';

export function SnackSlot({ onEl }: { onEl: (el: HTMLDivElement | null) => void }) {
  return <div ref={onEl} className="arm-snack" />;
}

/** Draws its children in the slot. Before the slot exists they are drawn in place. */
export function Toast({ el, children }: { el: HTMLElement | null; children: React.ReactNode }) {
  return el ? createPortal(children, el) : <>{children}</>;
}
