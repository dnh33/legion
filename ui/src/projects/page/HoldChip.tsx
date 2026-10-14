/**
 * A hold outlives its row: leave the project page (another tab, view or project) and the Allow still goes out when its countdown ends.
 * So it is never invisible: while an answer is counting (or has just gone out) and its row is not on screen, this small chip in the app
 * frame says what is happening, with Undo and Send now. A reload or crash still sends nothing (the hold is in memory only).
 */
import { useEffect } from 'react';
import { dismissAnswer, sendNowAnswer, undoAnswer, useOffscreenAnswers } from './answerStore';

const LINGER_MS = 6000;

export function HoldChip() {
  const list = useOffscreenAnswers();
  // a finished answer whose row is gone leaves after a moment
  useEffect(() => {
    const id = window.setInterval(() => { const now = Date.now(); for (const a of list) if (a.kind !== 'holding' && a.doneAt && now - a.doneAt > LINGER_MS) dismissAnswer(a.key); }, 1000);
    return () => window.clearInterval(id);
  }, [list]);
  if (!list.length) return null;
  const first = list.find((a) => a.kind === 'holding') ?? list[0]!;
  const more = list.length - 1;
  const holding = first.kind === 'holding';
  const secs = Math.ceil((first.view?.leftMs ?? 0) / 1000);
  const label = `${first.row.agentName} ${first.row.what}`;
  return (
    <div className="pg-holdchip" data-testid="hold-chip" role="group" aria-label="Answer waiting to be sent">
      {holding ? (
        <>
          <span className="msg"><b>{first.row.ing} in <span className="num">{secs}</span> s</b><span className="who">{first.row.agentName}{first.view?.paused ? ', paused' : ''}</span></span>
          <button type="button" className="pg-btn strong sm" aria-label={`Undo: ${label}`} onClick={() => undoAnswer(first.key)}>Undo</button>
          <button type="button" className="pg-btn sm" aria-label={`Send now: ${label}`} onClick={() => sendNowAnswer(first.key)}>Send now</button>
        </>
      ) : (
        <>
          <span className="msg"><b>{first.text}</b></span>
          <button type="button" className="pg-btn ghost sm" aria-label="Dismiss" onClick={() => dismissAnswer(first.key)}>Dismiss</button>
        </>
      )}
      {more > 0 && <span className="pg-hold-note">+{more} more</span>}
    </div>
  );
}
