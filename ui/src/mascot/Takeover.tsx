import { useEffect, useRef, useState } from 'react';
import { CANVAS_H, CANVAS_W, FULL, frameAt, loopTicks, progressBar, stillFrame, type Frame } from '../../../src/shared/takeover-art';
import { toast, useStore } from '../store';
import './takeover.css';

/** The window event that plays the takeover (three clicks on the title-bar glyph, or "Deus vult" in the command palette). */
export const TAKEOVER_EVENT = 'legion:takeover';
const COOLDOWN_MS = 30_000;
const SC = 7;

/** Three clicks within 1.5 s: returns the click handler for the title-bar glyph. */
export function useTripleClick(): () => void {
  const clicks = useRef<number[]>([]);
  return () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 1500), now];
    if (clicks.current.length >= 3) { clicks.current = []; window.dispatchEvent(new Event(TAKEOVER_EVENT)); }
  };
}

/**
 * The title-bar easter egg: the critter is converted into the Legion helm (src/shared/takeover-art.ts, the approved prototype),
 * beside the terminal panel, once, under the title bar, then it fades. Decorative only: no pointer events, hidden from screen
 * readers, a 30 s cooldown, skipped while the window is in the background, a 2 s still under reduced motion.
 */
export function Takeover() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [leaving, setLeaving] = useState(false);
  const sworn = useStore((s) => s.agents.length);
  const last = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const clear = () => { for (const id of timers.current) { clearInterval(id); clearTimeout(id); } timers.current = []; };
    const end = (afterMs: number) => {
      timers.current.push(window.setTimeout(() => setLeaving(true), afterMs));
      timers.current.push(window.setTimeout(() => { setFrame(null); setLeaving(false); }, afterMs + 400));
    };
    const play = () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible') return;
      if (now - last.current < COOLDOWN_MS) { toast('The Legion already holds Claude. Try again in a moment.'); return; }
      last.current = now;
      clear();
      setLeaving(false);
      try {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setFrame(stillFrame()); end(2000); return; }
        let t = 0;
        setFrame(frameAt(FULL, t));
        const id = window.setInterval(() => {
          t++;
          if (t >= loopTicks(FULL)) { clearInterval(id); return; }
          setFrame(frameAt(FULL, t));
        }, FULL.tickMs);
        timers.current.push(id);
        end(loopTicks(FULL) * FULL.tickMs);
      } catch { clear(); setFrame(null); } // an egg never breaks the title bar
    };
    window.addEventListener(TAKEOVER_EVENT, play);
    return () => { window.removeEventListener(TAKEOVER_EVENT, play); clear(); };
  }, []);

  if (!frame) return null;
  const bar = progressBar(frame);
  return (
    <div className={`takeover${leaving ? ' leaving' : ''}`} aria-hidden="true">
      <div className="takeover-stage">
        <svg width={CANVAS_W * SC} height={CANVAS_H * SC} shapeRendering="crispEdges">
          {frame.pixels.map((p, i) => <rect key={i} x={p.x * SC} y={p.y * SC} width={SC} height={SC} fill={p.color} opacity={p.opacity} />)}
        </svg>
      </div>
      <div className="takeover-term">
        <div><span className="tk-mark">{'Ŧ'}</span> <span className="tk-name">LEGION</span> <span className="tk-dim">// cogitator online</span></div>
        <div className="tk-headline" style={{ color: frame.headlineColor }}>{frame.headline}</div>
        <div className="tk-dim tk-bar">{bar || ' '}</div>
        <div>The Order has the terminal.{sworn > 0 ? <> {sworn} sworn &middot; 1 leads.</> : null}</div>
        <div><span className="tk-dim">&gt;</span> <span className="tk-caret">_</span></div>
      </div>
    </div>
  );
}
