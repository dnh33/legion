import { useEffect, useRef, type ReactNode } from 'react';
import { closeOverlays } from '../store';

export function Modal({ title, onClose = closeOverlays, children, width = 560, footer }: {
  title: string; onClose?: () => void; children: ReactNode; width?: number; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass inline arrows, so `onClose` is a new function on every render. Reading it through a ref keeps the
  // effect below mounted once: with `[onClose]` as the dependency it re-ran on every keystroke (the field's state
  // change re-renders the dialog), and each re-run moved focus again and restored it to the opener in between.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // [data-autofocus] wins over document order (a comma selector returns the first match in the document, which is the Close button)
    const root = ref.current;
    // then the first field or button of the body, and the Close button only when there is nothing else
    const first = root?.querySelector<HTMLElement>('[data-autofocus]')
      ?? root?.querySelector<HTMLElement>('.modal-body :is(input, textarea, select, button):not([disabled])')
      ?? root?.querySelector<HTMLElement>('button:not([disabled])');
    first?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); } };
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); prev?.focus?.(); };
  }, []);
  // simple focus trap
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const f = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, a[href], [tabindex="0"]'));
    if (!f.length) return;
    const a = document.activeElement;
    if (e.shiftKey && a === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title} style={{ width }} onKeyDown={onKey}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        <div className="modal-body scroll-cue">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
