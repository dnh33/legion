import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { clampGeometry, PANEL_TOP as TOP } from '../../../src/shared/ci-view';
import type { PanelGeometry } from '../../../src/shared/ci-view';
import './ci.css';

/**
 * A reusable panel container: floats above the app (drag by the title, resize from the corner) or docks to the right edge under the title
 * bar. Position, size and mode are remembered per window (localStorage, per `id`). Not modal: no focus trap, no scrim.
 *
 * Keyboard: Escape closes and gives focus back to `returnFocus`. On the title handle, arrow keys move a floating panel by 16 px (Shift: resize)
 * and resize a docked one. Everything a pointer can do has a button or key equivalent.
 * Docked, it sets `--dock-w` and `data-dock` on <html>; app.css-side rules in ci.css make the app grid leave room for it.
 */
const STEP = 16;
const DEFAULT: PanelGeometry = { mode: 'float', x: 0, y: 0, w: 460, h: 560, dockW: 380 };

const key = (id: string) => `legion.float.${id}`;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function load(id: string, defaults: Partial<PanelGeometry>): PanelGeometry {
  const base = { ...DEFAULT, ...defaults };
  try {
    const raw = JSON.parse(localStorage.getItem(key(id)) ?? 'null') as Partial<PanelGeometry> | null;
    if (raw && typeof raw === 'object') return { mode: raw.mode === 'dock' ? 'dock' : 'float', x: num(raw.x, base.x), y: num(raw.y, base.y), w: num(raw.w, base.w), h: num(raw.h, base.h), dockW: num(raw.dockW, base.dockW) };
  } catch { /* private mode or damaged: use the defaults */ }
  return base;
}
function save(id: string, g: PanelGeometry): void { try { localStorage.setItem(key(id), JSON.stringify(g)); } catch { /* not remembered */ } }

export function FloatPanel({ id, title, subtitle, open, onClose, returnFocus, actions, children, label, defaults }: {
  id: string;
  title: string;
  subtitle?: ReactNode;
  open: boolean;
  onClose: () => void;
  /** Element to focus after closing (the control that opened the panel). */
  returnFocus?: () => HTMLElement | null;
  /** Extra header buttons, placed before Dock and Close. */
  actions?: ReactNode;
  children: ReactNode;
  label?: string;
  defaults?: Partial<PanelGeometry>;
}) {
  const [g, setG] = useState<PanelGeometry>(() => load(id, defaults ?? {}));
  const root = useRef<HTMLElement>(null);
  const gRef = useRef(g);
  gRef.current = g;
  const drag = useRef<{ kind: 'move' | 'size' | 'dock'; px: number; py: number; g: PanelGeometry } | null>(null);
  const [say, setSay] = useState('');

  const commit = useCallback((next: PanelGeometry, remember = true) => {
    const c = clampGeometry(next, window.innerWidth, window.innerHeight);
    gRef.current = c; setG(c);
    if (remember) save(id, c);
  }, [id]);

  // first placement: top-right under the title bar when nothing was remembered
  useLayoutEffect(() => {
    if (!open) return;
    let first: PanelGeometry | null = null;
    try { first = localStorage.getItem(key(id)) === null ? gRef.current : null; } catch { first = gRef.current; }
    if (first && first.x === 0 && first.y === 0) commit({ ...first, x: window.innerWidth - first.w - 16, y: TOP + 12 }, false);
    else commit(gRef.current, false);
  }, [open, id, commit]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => commit(gRef.current, false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, commit]);

  // docked: leave room in the app grid; undone on close and on switching to float
  useEffect(() => {
    if (!open || g.mode !== 'dock') return undefined;
    const el = document.documentElement;
    el.style.setProperty('--dock-w', `${g.dockW}px`);
    el.dataset.dock = id;
    return () => { el.style.removeProperty('--dock-w'); if (el.dataset.dock === id) delete el.dataset.dock; };
  }, [open, g.mode, g.dockW, id]);

  // focus lands in the panel when it opens
  useEffect(() => { if (open) root.current?.focus({ preventScroll: true }); }, [open]);

  const close = useCallback(() => {
    onClose();
    // after the panel has unmounted
    window.setTimeout(() => returnFocus?.()?.focus(), 0);
  }, [onClose, returnFocus]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !(e.target as HTMLElement).closest?.('input, textarea, select')) { e.preventDefault(); e.stopPropagation(); close(); }
  };

  const down = (kind: 'move' | 'size' | 'dock') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (kind === 'move' && (gRef.current.mode === 'dock' || (e.target as HTMLElement).closest('button'))) return;
    drag.current = { kind, px: e.clientX, py: e.clientY, g: gRef.current };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (d.kind === 'move') commit({ ...d.g, x: d.g.x + dx, y: d.g.y + dy }, false);
    else if (d.kind === 'size') commit({ ...d.g, w: d.g.w + dx, h: d.g.h + dy }, false);
    else commit({ ...d.g, dockW: d.g.dockW - dx }, false);
  };
  const up = () => { if (drag.current) { drag.current = null; save(id, gRef.current); } };

  const keyMove = (e: ReactKeyboardEvent) => {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) return;
    e.preventDefault();
    const cur = gRef.current;
    const dx = k === 'ArrowLeft' ? -STEP : k === 'ArrowRight' ? STEP : 0;
    const dy = k === 'ArrowUp' ? -STEP : k === 'ArrowDown' ? STEP : 0;
    if (cur.mode === 'dock') { if (dx) commit({ ...cur, dockW: cur.dockW - dx }); }
    else if (e.shiftKey) commit({ ...cur, w: cur.w + dx, h: cur.h + dy });
    else commit({ ...cur, x: cur.x + dx, y: cur.y + dy });
  };

  const toggleMode = () => {
    const next = gRef.current.mode === 'float' ? 'dock' : 'float';
    commit({ ...gRef.current, mode: next });
    setSay(next === 'dock' ? `${title} docked to the right edge` : `${title} is floating`);
    root.current?.focus({ preventScroll: true });
  };

  if (!open) return null;
  const docked = g.mode === 'dock';
  const style = docked ? { width: g.dockW } : { left: g.x, top: g.y, width: g.w, height: g.h };
  return (
    <section
      ref={root} className={`fp ${docked ? 'fp-dock' : 'fp-float'}`} style={style} role="dialog" aria-modal="false" aria-label={label ?? title} tabIndex={-1} onKeyDown={onKeyDown}
      data-mode={g.mode}
    >
      {docked && <div className="fp-edge" onPointerDown={down('dock')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-hidden="true" />}
      <header className="fp-head" onPointerDown={down('move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <button
          type="button" className="fp-grip" onKeyDown={keyMove}
          aria-label={docked ? `Resize ${title}: left and right arrow keys` : `Move ${title}: arrow keys. Resize: Shift and arrow keys`}
          title={docked ? 'Drag the edge, or use arrow keys here, to resize' : 'Drag to move. Arrow keys move, Shift and arrow keys resize'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.1" /><circle cx="9" cy="3" r="1.1" /><circle cx="3" cy="9" r="1.1" /><circle cx="9" cy="9" r="1.1" /><circle cx="3" cy="6" r="1.1" /><circle cx="9" cy="6" r="1.1" /></svg>
        </button>
        <div className="fp-titles"><h2 className="fp-title">{title}</h2>{subtitle && <div className="fp-sub">{subtitle}</div>}</div>
        <div className="fp-actions">
          {actions}
          <button type="button" className="fp-btn" onClick={toggleMode} aria-label={docked ? 'Float the panel' : 'Dock the panel to the right edge'} title={docked ? 'Float' : 'Dock to the right'}>
            {docked
              ? <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" /><rect x="5" y="5.5" width="6" height="5" rx="1" /></svg>
              : <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></svg>}
          </button>
          <button type="button" className="fp-btn" onClick={close} aria-label={`Close ${title}`} title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </header>
      <div className="fp-body">{children}</div>
      {!docked && <div className="fp-resize" onPointerDown={down('size')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-hidden="true" />}
      <div className="sr-only" role="status" aria-live="polite">{say}</div>
    </section>
  );
}
