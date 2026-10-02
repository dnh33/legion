import { memo, useEffect, useRef, useState } from 'react';
import { isImeKey } from '../chat/ime';
import { clearQueue, editQueued, removeQueued, resumeQueue, sendQueuedNow, useThreadQueue } from '../chat/queueStore';
import { Icon } from './icons';

/** One line for the list: whitespace collapsed, clipped (a queued message can be 50 000 characters; the DOM gets at most 160). */
const oneLine = (t: string): string => { const s = t.slice(0, 400).replace(/\s+/g, ' ').trim(); return s.length > 160 ? s.slice(0, 159).trimEnd() + '…' : s; };

/**
 * The messages waiting to be sent, above the composer. Subscribes to its own thread's queue only, and is memoised on two strings, so typing in
 * the composer (which re-renders its parent per keystroke) never re-renders it.
 */
export const QueueStrip = memo(function QueueStrip({ qkey, waiting }: { qkey: string; waiting: string }) {
  const q = useThreadQueue(qkey);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const skipSave = useRef(false);
  useEffect(() => { if (editing) { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } }, [editing]);
  // leave edit mode when the item is gone (sent, removed, cleared)
  useEffect(() => { if (editing && !q?.items.some((i) => i.id === editing)) setEditing(null); }, [q, editing]);
  if (!q || q.items.length === 0) return null;

  const n = q.items.length;
  const held = q.hold !== null;
  const sendingNow = q.sending !== null;
  const state = held ? 'Paused' : sendingNow ? 'Sending…' : waiting || 'Waiting';
  const save = (id: string) => { if (skipSave.current) { skipSave.current = false; return; } const ok = editQueued(qkey, id, draft); if (ok) setEditing(null); };

  return (
    <div className={`qstrip${held ? ' held' : ''}`} role="region" aria-label="Queued messages" data-testid="queue-strip">
      <div className="q-head" aria-live="polite">
        <span className="q-badge" data-testid="queue-count">{n}</span>
        <b>{n === 1 ? 'message queued' : 'messages queued'}</b>
        <span className="q-state" data-testid="queue-state">{state}</span>
        <span className="q-hint"><kbd>Enter</kbd> queues, <kbd>Ctrl+Enter</kbd> interrupts</span>
      </div>
      {held && (
        <div className="q-hold" role="status" data-testid="queue-hold">
          <Icon name="shield" size={13} />
          <span>
            {q.hold === 'cancelled' && <>Queue paused: you stopped the run, so nothing is sent on its own.</>}
            {q.hold === 'error' && <>Queue paused: {q.error ? q.error : 'the run failed'}.</>}
            {q.hold === 'restored' && <>Restored after reload. Nothing is sent until you resume.</>}
          </span>
          <button type="button" className="btn-ghost sm q-resume" onClick={() => resumeQueue(qkey)}>Resume</button>
          <button type="button" className="btn-ghost sm danger" onClick={() => clearQueue(qkey)}>Clear</button>
        </div>
      )}
      <ol className="q-list">
        {q.items.map((it, i) => {
          const inFlight = q.sending === it.id;
          return (
            <li key={it.id} className={`q-item${inFlight ? ' sending' : ''}`} data-testid="queue-item">
              <span className="q-n" aria-hidden="true">{i + 1}</span>
              {editing === it.id ? (
                <textarea ref={ta} className="q-edit" rows={Math.min(5, Math.max(2, draft.split('\n').length))} value={draft} aria-label={`Edit queued message ${i + 1}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => save(it.id)}
                  onKeyDown={(e) => {
                    if (isImeKey(e.nativeEvent)) return;
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skipSave.current = true; setEditing(null); }
                    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(it.id); }
                  }} />
              ) : (
                <button type="button" className="q-text" disabled={inFlight} title={`${it.text.slice(0, 600)}${it.text.length > 600 ? '…' : ''}\n\nClick to edit`}
                  aria-label={`Queued message ${i + 1}: ${oneLine(it.text)}. Edit`}
                  onClick={() => { skipSave.current = false; setDraft(it.text); setEditing(it.id); }}>{oneLine(it.text)}</button>
              )}
              {inFlight ? <span className="q-tag live">Sending</span> : i === 0 && !held ? <span className="q-tag">Next</span> : null}
              <button type="button" className="q-act" disabled={inFlight} aria-label={`Send queued message ${i + 1} now (interrupts the run)`} title="Send now: interrupts the current run"
                onMouseDown={(e) => e.preventDefault()} onClick={() => void sendQueuedNow(qkey, it.id)}><Icon name="send" size={12} /></button>
              <button type="button" className="q-act" disabled={inFlight} aria-label={`Remove queued message ${i + 1}`} title="Remove from the queue"
                onMouseDown={(e) => e.preventDefault()} onClick={() => removeQueued(qkey, it.id)}><Icon name="x" size={12} /></button>
            </li>
          );
        })}
      </ol>
    </div>
  );
});
