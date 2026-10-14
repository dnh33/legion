import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getState, useStore } from '../store';
import { useAnswers } from '../projects/page/answerStore';
import { autoStartTips, tipEnd, tipNext, tipsNeverAgain, useTips } from './tipsStore';
import { chooseTipLayout, isIdle, pickTip } from './tipsLogic';
import type { Box } from './tipsLogic';
import './whatsnew.css';

/**
 * "What's new" tips after an update. One small note beside the thing it explains. Not modal: nothing is dimmed or blocked,
 * focus stays where it is (Tab reaches the tip last, it is the final element on the page), and a tip never advances on its
 * own. It waits while something needs the user (an ask, a question, a hold countdown), and a tip whose page is not open waits
 * for that page. Escape ends the tour.
 */
export function WhatsNew() {
  const t = useTips();
  const loaded = useStore((s) => s.loaded);
  const version = useStore((s) => s.version);
  const approvals = useStore((s) => s.approvals.length);
  const questions = useStore((s) => s.questions.length);
  const answers = useAnswers();
  const holding = [...answers.values()].some((a) => a.kind === 'holding');
  const idle = isIdle({ approvals, questions, holding });

  useEffect(() => { if (loaded && version) autoStartTips(version, () => { const s = getState(); return s.tasks.length > 0 || s.projects.length > 0 || s.onboardingDismissed; }); }, [loaded, version]);

  const [cur, setCur] = useState<{ id: string; box: Box } | null>(null);
  const tourRef = useRef(t);
  tourRef.current = t;
  // Which pending tip has its anchor on screen right now, and where it is. Re-checked when the page changes or resizes.
  useEffect(() => {
    if (!t.tour || !idle) { setCur(null); return; }
    let raf = 0;
    const measure = (): void => {
      raf = 0;
      const cp = tourRef.current;
      if (!cp.tour) return;
      const found = new Map<string, Box>();
      for (const tip of cp.tips) {
        if (!cp.tour.pending.includes(tip.id)) continue;
        const el = document.querySelector(tip.anchor);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
        found.set(tip.id, { left: r.left, top: r.top, w: r.width, h: r.height });
      }
      const id = pickTip(cp.tour, new Set(found.keys()));
      const box = id ? found.get(id)! : null;
      setCur((prev) => {
        if (!id || !box) return prev === null ? prev : null;
        if (prev && prev.id === id && Math.abs(prev.box.left - box.left) < 1 && Math.abs(prev.box.top - box.top) < 1 && Math.abs(prev.box.w - box.w) < 1 && Math.abs(prev.box.h - box.h) < 1) return prev;
        return { id, box };
      });
    };
    const queue = (): void => { if (!raf) raf = requestAnimationFrame(measure); };
    queue();
    const mo = new MutationObserver(queue);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', queue);
    window.addEventListener('scroll', queue, true);
    return () => { mo.disconnect(); window.removeEventListener('resize', queue); window.removeEventListener('scroll', queue, true); if (raf) cancelAnimationFrame(raf); };
  }, [t.tour, t.tips, idle]);

  const shown = t.tour && idle ? cur : null;
  // Escape ends the tour (before the app's own Escape handlers). Not while typing or while a dialog is open.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('.scrim .modal')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      tipEnd();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown]);

  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 150 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - size.w) > 1 || Math.abs(r.height - size.h) > 1) setSize({ w: r.width, h: r.height });
  });

  // Floating or inline is decided once per tip and window size, from the rects of everything the tip could cover.
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = (): void => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const tip = shown ? t.tips.find((x) => x.id === shown.id) : undefined;
  const key = shown ? `${shown.id}|${vp.w}x${vp.h}` : '';
  const [mode, setMode] = useState<{ key: string; inline: boolean } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const inline = !!tip && mode?.key === key && mode.inline;
  // The inline callout's own spot: at the end of the anchor's row (a wrapping row, so it starts a line of its own under it), else right after the anchor. Removed before the next decision so the page is measured as it is.
  useLayoutEffect(() => {
    if (!inline || !tip) { setHost(null); return; }
    const anchor = document.querySelector(tip.anchor);
    if (!anchor) { setHost(null); return; }
    const el = document.createElement('div');
    el.className = 'wn-host';
    const row = anchor.closest('[data-tip-row]');
    if (row) row.appendChild(el); else anchor.insertAdjacentElement('afterend', el);
    setHost(el);
    return () => { el.remove(); };
  }, [inline, tip]);
  useLayoutEffect(() => {
    if (!shown || !tip || !ref.current || (mode && mode.key === key)) return;
    const tipEl = ref.current;
    const anchor = document.querySelector(tip.anchor);
    const win = { w: window.innerWidth, h: window.innerHeight };
    const obstacles: Box[] = [];
    const add = (el: Element): void => {
      const r = el.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.right > 0 && r.top < win.h && r.left < win.w) obstacles.push({ left: r.left, top: r.top, w: r.width, h: r.height });
    };
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"], [tabindex]')) {
      if (tipEl.contains(el) || (anchor && (anchor.contains(el) || el.contains(anchor)))) continue;
      add(el);
    }
    for (const el of (document.querySelector('main') ?? document).querySelectorAll('h1, h2')) { if (!tipEl.contains(el) && !(anchor && anchor.contains(el))) add(el); }
    const l = chooseTipLayout(shown.box, { w: tipEl.getBoundingClientRect().width, h: tipEl.getBoundingClientRect().height }, win, tip.placement, obstacles);
    setMode({ key, inline: l.mode === 'inline' });
  });

  if (!shown || !t.tour || !tip) return null;
  const floating = chooseTipLayout(shown.box, size, { w: vp.w, h: vp.h }, tip.placement, []);
  const pos = floating.mode === 'float' ? floating.placed : { left: 0, top: 0, placement: 'bottom' as const, caret: 18 };
  const first = t.moved === 0;
  const total = t.tips.length;
  const n = total - t.tour.pending.length + 1;
  const last = t.tour.pending.length === 1;
  const body = (
    <div ref={ref} className={inline ? 'wn-tip wn-inline' : 'wn-tip'} role="dialog" aria-label="What's new" aria-describedby="wn-text" data-placement={pos.placement} style={inline ? ({ '--wn-caret': '18px' } as CSSProperties) : ({ left: pos.left, top: pos.top, '--wn-caret': `${pos.caret}px` } as CSSProperties)}>
      <p className="wn-step">What's new, {n} of {total}</p>
      <p id="wn-text" className="wn-text">{tip.text}</p>
      <div className="wn-actions">
        <button type="button" className="btn primary sm" onClick={() => tipNext(tip.id)}>{last ? 'Done' : 'Next'}</button>
        <button type="button" className="btn-ghost sm" onClick={tipEnd}>End tour</button>
      </div>
      {first && <button type="button" className="wn-link" onClick={tipsNeverAgain}>Don't show tips after updates</button>}
    </div>
  );
  if (!inline) return body;
  return host ? createPortal(body, host) : null;
}
