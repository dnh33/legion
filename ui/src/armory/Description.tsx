/** One line of a skill's description with a Show more toggle; shared by the Armory and Doctrine rows. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CUT_NOTE, descriptionCut } from '../../../src/shared/armory-view';
import './armory.css';

/** One line of the description, and the whole of it one keyboard-reachable toggle away. The text is never cut in the data. */
export function Description({ text, name, cutNote = CUT_NOTE }: { text: string; name: string; cutNote?: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const el = useRef<HTMLParagraphElement>(null);
  const measure = (): void => {
    const p = el.current;
    // Measured only while clamped: once open, the toggle stays so the owner can close it again.
    if (p && !expanded) setLong(p.scrollHeight > p.clientHeight + 1);
  };
  // Measured before the first paint, so "Show more" is in the row from the start and nothing below it jumps when it would have appeared later.
  // Only the rows of an open group exist, so this is at most one group's worth of reads.
  useLayoutEffect(() => { measure(); }, [text, expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const p = el.current;
    if (!p || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(p);
    return () => ro.disconnect();
  }, [expanded, text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <p id={id} ref={el} className={`arm-desc${expanded ? '' : ' clamp'}`}>{text}</p>
      {long || expanded ? (
        <button type="button" className="link-btn arm-desc-toggle" aria-expanded={expanded} aria-controls={id}
          aria-label={`${expanded ? 'Show less' : 'Show more'}: ${name}`} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      {expanded && descriptionCut(text) ? <p className="set-hint arm-cutnote">{cutNote}</p> : null}
    </>
  );
}
