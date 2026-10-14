/**
 * Focus never falls to the body after a re-render removes the control that had it (spec 3.2, 8). Controls inside the region carry
 * `data-fk`. After every commit, if focus was lost, it goes to the same control, else the next surviving sibling, else the previous,
 * else the region itself (give it tabindex -1).
 */
import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { pickFocusKey } from '../focus';

const keysIn = (root: HTMLElement): string[] => Array.from(root.querySelectorAll<HTMLElement>('[data-fk]')).map((e) => e.dataset.fk!);
const REGION = '\u0000region';

export function useFocusKeeper(ref: RefObject<HTMLElement | null>): void {
  const anchor = useRef<string | null>(null);
  const prev = useRef<string[]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onIn = (e: FocusEvent): void => { const k = (e.target as HTMLElement).closest<HTMLElement>('[data-fk]')?.dataset.fk; if (k) anchor.current = k; };
    const onOut = (e: FocusEvent): void => { const to = e.relatedTarget as Node | null; if (to && !root.contains(to)) anchor.current = null; };
    root.addEventListener('focusin', onIn);
    root.addEventListener('focusout', onOut);
    return () => { root.removeEventListener('focusin', onIn); root.removeEventListener('focusout', onOut); };
  }, [ref]);
  // every commit
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const keys = keysIn(root);
    const ae = document.activeElement;
    if (anchor.current && (!ae || ae === document.body)) {
      const key = pickFocusKey(prev.current, anchor.current, keys, REGION);
      const target = key === REGION ? root : root.querySelector<HTMLElement>(`[data-fk="${CSS.escape(key)}"]`);
      target?.focus({ preventScroll: true });
      if (key !== REGION) anchor.current = key;
    }
    prev.current = keys;
  });
}
