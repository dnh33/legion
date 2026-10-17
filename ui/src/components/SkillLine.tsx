import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SkillTurn } from '../../../src/shared/types';
import { MAX_LINES, lineText, overflowTurns, rowText } from '../../../src/shared/skill-line';
import { loadChatLine, useArmory } from '../armory/armoryStore';

/** Sources whose text the owner did not write: their rows show the id only. */
const OUTSIDE = new Set(['imported', 'claude-plugin']);
const GAP = 4;
const EDGE = 8;

/**
 * The quiet line under a reply that follows a skill-finder note: "Suggested: a, b · loaded: a". It shows only while the owner's
 * "Show suggestions in chat" is on. Each line is a button; it opens a small note with the ids, scores and matched words.
 */
export const SkillLines = memo(function SkillLines({ turns }: { turns: SkillTurn[] }) {
  const chatLine = useArmory((s) => s.chatLine);
  const skills = useArmory((s) => s.data?.skills);
  useEffect(() => { void loadChatLine(); }, []);
  const outside = useMemo(() => new Set((skills ?? []).filter((s) => OUTSIDE.has(s.source)).map((s) => s.id)), [skills]);
  if (!chatLine || !turns.length) return null;
  const shown = turns.slice(0, MAX_LINES);
  const extra = overflowTurns(turns);
  return (
    <div className="skl-lines">
      {shown.map((t, i) => <SkillLine key={`${t.at}-${i}`} turn={t} extra={i === shown.length - 1 ? extra : []} outside={outside} />)}
    </div>
  );
});

function SkillLine({ turn, extra, outside }: { turn: SkillTurn; extra: SkillTurn[]; outside: ReadonlySet<string> }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <>
      <button ref={btn} type="button" className="skl" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        title="Why these skills were suggested" onClick={() => setOpen((o) => !o)}>{lineText(turn)}</button>
      {open && <Why id={id} anchor={btn} turn={turn} extra={extra} outside={outside} onClose={(back) => { setOpen(false); if (back) btn.current?.focus(); }} />}
    </>
  );
}

/** The note. Fixed and in the page body, so the windowed message list never clips it. It sits below the line, or above when there is more room there, and stays inside the window. */
function Why({ id, anchor, turn, extra, outside, onClose }: { id: string; anchor: React.RefObject<HTMLButtonElement | null>; turn: SkillTurn; extra: SkillTurn[]; outside: ReadonlySet<string>; onClose: (refocus: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const place = useCallback(() => {
    const a = anchor.current, b = box.current; if (!a || !b) return;
    const r = a.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const roomBelow = vh - r.bottom - GAP - EDGE, roomAbove = r.top - GAP - EDGE;
    const h = b.scrollHeight + 2; // the border
    const below = h <= roomBelow || roomBelow >= roomAbove;
    const maxHeight = Math.max(80, below ? roomBelow : roomAbove);
    const shownH = Math.min(h, maxHeight);
    setPos({
      left: Math.max(EDGE, Math.min(r.left, vw - b.offsetWidth - EDGE)),
      top: below ? r.bottom + GAP : r.top - GAP - shownH,
      maxHeight,
    });
  }, [anchor]);
  useLayoutEffect(place, [place, turn, extra]);
  useEffect(() => { box.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const a = anchor.current;
    const down = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (box.current?.contains(t) || a?.contains(t)) return; // the line's own click toggles it
      onClose(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      onClose(true);
    };
    // the note follows its line; it closes only when the line has scrolled out of the window
    const scroll = (e: Event): void => {
      if (box.current?.contains(e.target as Node)) return;
      const r = a?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > document.documentElement.clientHeight) onClose(false); else place();
    };
    const resize = (): void => place();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [anchor, onClose, place]);

  const rows = turn.suggested.map((sid) => turn.why.find((w) => w.id === sid) ?? { id: sid, score: 0, matched: [] as string[] });
  return createPortal(
    <div ref={box} id={id} className="skl-pop" role="dialog" aria-label="Why these skills were suggested" tabIndex={-1}
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: 0, top: 0, opacity: 0 }}
      onBlur={(e) => { if (!document.hasFocus()) return; /* the window lost focus, not the note */ const n = e.relatedTarget as Node | null; if (!n || (!box.current?.contains(n) && !anchor.current?.contains(n))) onClose(false); }}>
      <p className="skl-pop-h">{turn.subagent ? `Why these were suggested to ${turn.subagent}` : 'Why these skills'}</p>
      <ul>
        {rows.map((w) => <li key={w.id}>{turn.why.some((x) => x.id === w.id) ? rowText(w, outside.has(w.id)) : w.id}</li>)}
      </ul>
      {extra.length > 0 && (
        <>
          <p className="skl-pop-h">+{extra.length} more</p>
          <ul>{extra.map((t, i) => <li key={`${t.at}-${i}`}>{lineText(t)}</li>)}</ul>
        </>
      )}
    </div>,
    document.body,
  );
}
