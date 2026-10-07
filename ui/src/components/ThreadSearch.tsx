import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from './icons';

interface Hit { index: number; id: string; role: string; snippet: string }

/**
 * Search inside one conversation. The search runs on the core over the WHOLE thread (not just the loaded part); a hit opens the page around it.
 * Hits come newest first. Enter or the arrows step through them; Esc closes.
 */
export function ThreadSearch({ taskId, onJump, onClose }: { taskId: string; onJump: (index: number, id: string) => void | Promise<void>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [at, setAt] = useState(0);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const seq = useRef(0);
  const id = useId();

  useEffect(() => {
    const text = q.trim();
    if (!text) { seq.current++; setHits([]); setState('idle'); return; }
    const t = window.setTimeout(async () => {
      const me = ++seq.current;
      setState('busy');
      try {
        const r = await api.searchMessages(taskId, text);
        if (me !== seq.current) return;
        setHits(r.hits); setAt(0); setState('done');
        if (r.hits[0]) void onJump(r.hits[0].index, r.hits[0].id);
      } catch { if (me === seq.current) setState('error'); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (to: number) => { if (!hits.length) return; const i = (to + hits.length) % hits.length; setAt(i); void onJump(hits[i]!.index, hits[i]!.id); };
  const status = state === 'busy' ? 'Searching…' : state === 'error' ? 'Search failed.' : state === 'done' ? (hits.length ? `${at + 1} of ${hits.length}${hits.length >= 100 ? '+' : ''}` : 'No matches.') : '';

  return (
    <div className="thread-search" role="search">
      <label htmlFor={id} className="sr-only">Search this conversation</label>
      <input id={id} type="search" value={q} autoFocus autoComplete="off" spellCheck={false} placeholder="Search this conversation" onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(at + (e.shiftKey ? -1 : 1)); } else if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
      <span className="ts-status" role="status" aria-live="polite">{status}</span>
      <button type="button" className="icon-btn" aria-label="Older match" title="Older match (Enter)" disabled={hits.length < 2} onClick={() => go(at + 1)}><span className="flip"><Icon name="down" size={13} /></span></button>
      <button type="button" className="icon-btn" aria-label="Newer match" title="Newer match (Shift+Enter)" disabled={hits.length < 2} onClick={() => go(at - 1)}><Icon name="down" size={13} /></button>
      <button type="button" className="icon-btn" aria-label="Close search" title="Close (Esc)" onClick={onClose}><Icon name="x" size={13} /></button>
    </div>
  );
}
