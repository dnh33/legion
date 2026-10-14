/**
 * A small popup menu anchored to its button: role=menu, Arrow/Home/End move, Esc closes and returns focus to the button, a click outside
 * closes. It clamps to the window and flips above the button when there is no room below (spec 3.7, 8). Items are children with
 * role=menuitem / menuitemcheckbox / menuitemradio.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

export function Menu({ anchor, label, onClose, children, align = 'start', minWidth, kind = 'menu' }: { anchor: RefObject<HTMLElement | null>; label: string; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; minWidth?: number; kind?: 'menu' | 'dialog' }) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current, m = el.current;
    if (!a || !m) return;
    const r = a.getBoundingClientRect();
    const w = Math.max(m.offsetWidth, minWidth ?? 0), h = m.scrollHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(align === 'end' ? r.right - w : r.left, vw - w - 8));
    const below = vh - r.bottom - 12, above = r.top - 12;
    const flip = h > below && above > below;
    const maxHeight = Math.max(120, flip ? above : below);
    setPos({ left, top: flip ? Math.max(8, r.top - Math.min(h, maxHeight) - 4) : r.bottom + 4, maxHeight });
  }, [anchor, align, minWidth, children]);
  useEffect(() => {
    const items = (): HTMLElement[] => Array.from(el.current?.querySelectorAll<HTMLElement>(kind === 'dialog' ? 'input, button' : '[role^="menuitem"]:not(:disabled)') ?? []);
    const first = kind === 'dialog' ? items()[0] : items().find((i) => i.getAttribute('aria-checked') === 'true') ?? items()[0];
    const opener = document.activeElement as HTMLElement | null;
    first?.focus();
    const down = (e: PointerEvent): void => { const t = e.target as Node; if (!el.current?.contains(t) && !anchor.current?.contains(t)) onClose(); };
    document.addEventListener('pointerdown', down);
    // focus goes back to what had it (the button that opened the menu) unless the action moved it somewhere on purpose
    return () => {
      document.removeEventListener('pointerdown', down);
      requestAnimationFrame(() => { const ae = document.activeElement; if ((!ae || ae === document.body) && opener?.isConnected) opener.focus(); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const key = (e: React.KeyboardEvent): void => {
    if (kind === 'dialog') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } return; }
    const items = Array.from(el.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number): void => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'Tab') onClose();
  };
  return (
    <div ref={el} className={`pg-menu${kind === 'dialog' ? ' dlg' : ''}`} role={kind} aria-label={label} onKeyDown={key}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, maxHeight: pos?.maxHeight, minWidth }}>
      {children}
    </div>
  );
}
