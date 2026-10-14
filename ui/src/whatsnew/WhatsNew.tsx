import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useAnswers } from '../projects/page/answerStore';
import { autoStartTips, tipEnd, tipNext, tipSkipTour, tipsNeverAgain, useTips } from './tipsStore';
import { isIdle, pickTip, placeTip } from './tipsLogic';
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
  const hasTasks = useStore((s) => s.tasks.length > 0);
  const approvals = useStore((s) => s.approvals.length);
  const questions = useStore((s) => s.questions.length);
  const answers = useAnswers();
  const holding = [...answers.values()].some((a) => a.kind === 'holding');
  const idle = isIdle({ approvals, questions, holding });

  useEffect(() => { if (loaded && version) autoStartTips(version, hasTasks); }, [loaded, version, hasTasks]);

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

  if (!shown || !t.tour) return null;
  const tip = t.tips.find((x) => x.id === shown.id);
  if (!tip) return null;
  const pos = placeTip(shown.box, size, { w: window.innerWidth, h: window.innerHeight }, tip.placement);
  const first = t.moved === 0;
  const total = t.tips.length;
  const n = total - t.tour.pending.length + 1;
  const last = t.tour.pending.length === 1;
  return (
    <div ref={ref} className="wn-tip" role="dialog" aria-label="What's new" aria-describedby="wn-text" data-placement={pos.placement} style={{ left: pos.left, top: pos.top }}>
      <p className="wn-step">What's new, {n} of {total}</p>
      <p id="wn-text" className="wn-text">{tip.text}</p>
      <div className="wn-actions">
        <button type="button" className="btn primary sm" onClick={() => tipNext(tip.id)}>{last ? 'Done' : 'Next'}</button>
        {!last && <button type="button" className="btn sm" onClick={() => tipNext(tip.id)}>Skip</button>}
        {first && <button type="button" className="btn-ghost sm" onClick={tipSkipTour}>Skip tour</button>}
        {first && <button type="button" className="btn-ghost sm" onClick={tipEnd}>End tour</button>}
      </div>
      {first && <button type="button" className="wn-link" onClick={tipsNeverAgain}>Don't show tips after updates</button>}
    </div>
  );
}
