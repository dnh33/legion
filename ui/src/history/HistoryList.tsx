import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { adoptTask, openHistoryTask, openTaskMenu, tapEvents } from '../store';
import { statusDot } from '../../../src/shared/continue';
import { cleanTitle } from '../util';
import { PAGE, ROW_H, SEARCH_DEBOUNCE_MS, applyLiveEvent, emptyHistory, historyStatus, mergePage, needsMore, scrollToRow, windowRange, type HistoryState } from './historyLogic';

const VIEW_H = 240;

/**
 * One agent's whole task history, in a popover: a search box, then rows paged from GET /api/tasks and only the visible ones drawn.
 * The rows keep the old "+N more" menu's semantics (role="menu", menuitems, Enter or click opens, right click opens the task menu);
 * aria-setsize / aria-posinset say where a drawn row sits among the loaded ones, since most are not in the DOM.
 */
export function HistoryList({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [st, setSt] = useState<HistoryState>(emptyHistory);
  const [scroll, setScroll] = useState(0);
  const [active, setActive] = useState(0);
  const seq = useRef(0);          // a late answer for an older query is dropped
  const stRef = useRef(st); stRef.current = st;
  const box = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<Map<number, HTMLButtonElement>>(new Map());
  const focusNext = useRef(false);
  const inputId = useId();

  // debounce the query: the list searches 200 ms after the last keystroke
  useEffect(() => { const t = window.setTimeout(() => setQ(input.trim()), SEARCH_DEBOUNCE_MS); return () => clearTimeout(t); }, [input]);

  const load = useCallback(async (reset: boolean) => {
    const me = ++seq.current;
    const cursor = reset ? null : stRef.current.nextCursor;
    setSt((s) => ({ ...(reset ? emptyHistory() : s), loading: true, error: null }));
    try {
      const page = await api.tasksPage({ agentId, q, cursor, limit: PAGE, archived: true });
      if (me !== seq.current) return;
      setSt((s) => mergePage(reset ? emptyHistory() : s, page, reset));
    } catch (e) {
      if (me !== seq.current) return;
      setSt((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [agentId, q]);

  // a new agent or query starts over from the top
  useEffect(() => { setActive(0); setScroll(0); if (box.current) box.current.scrollTop = 0; void load(true); return () => { seq.current++; }; }, [load]);
  // live changes (a run finishing, a rename, a close) reach rows already loaded
  useEffect(() => tapEvents((e) => setSt((s) => applyLiveEvent(s, e, true))), []);

  const { start, end } = windowRange(scroll, VIEW_H, st.rows.length);
  useEffect(() => { if (needsMore(st, end)) void load(false); }, [st, end, load]);
  useEffect(() => { if (focusNext.current) { focusNext.current = false; rowsRef.current.get(active)?.focus(); } });

  const move = (to: number) => {
    const i = Math.max(0, Math.min(st.rows.length - 1, to));
    setActive(i); focusNext.current = true;
    const top = scrollToRow(i, scroll, VIEW_H);
    if (box.current && top !== scroll) box.current.scrollTop = top;
    setScroll(top);
  };
  const open = (i: number) => { const t = st.rows[i]; if (t) { openHistoryTask(t); onClose(); } };

  return (
    <div className="more-pop history-pop">
      <label htmlFor={inputId} className="sr-only">Search task history</label>
      <input id={inputId} className="history-q" type="search" value={input} placeholder="Search tasks" autoFocus autoComplete="off" spellCheck={false}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'ArrowDown' && st.rows.length) { e.preventDefault(); move(0); } else if (e.key === 'Escape') onClose(); }} />
      <p className="history-status" role="status" aria-live="polite">{historyStatus(st, q)}{st.error && <> <button type="button" className="btn-ghost sm" onClick={() => void load(st.rows.length === 0)}>Retry</button></>}</p>
      <div className="history-scroll" ref={box} style={{ height: Math.min(VIEW_H, Math.max(ROW_H, st.rows.length * ROW_H)) }} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        role="menu" aria-label="Task history" aria-busy={st.loading || undefined}>
        <div style={{ height: st.rows.length * ROW_H, position: 'relative' }}>
          {st.rows.slice(start, end).map((t, k) => {
            const i = start + k;
            return (
              <button key={t.id} type="button" role="menuitem" className={`more-item history-row${t.archived ? ' closed' : ''}`} style={{ position: 'absolute', top: i * ROW_H, height: ROW_H }}
                tabIndex={i === active ? 0 : -1} aria-setsize={st.rows.length} aria-posinset={i + 1} ref={(el) => { if (el) rowsRef.current.set(i, el); else rowsRef.current.delete(i); }}
                onClick={() => open(i)} onFocus={() => setActive(i)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); move(i + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) document.getElementById(inputId)?.focus(); else move(i - 1); }
                  else if (e.key === 'Home') { e.preventDefault(); move(0); } else if (e.key === 'End') { e.preventDefault(); move(st.rows.length - 1); }
                  else if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
                }}
                onContextMenu={(e) => { e.preventDefault(); adoptTask(t); openTaskMenu(e.clientX, e.clientY, t.id); }}>
                <i className={`st st-${statusDot(t)}`} /><span>{cleanTitle(t.title)}</span>
                {t.archived && <em className="from-chip closed-chip">closed</em>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
