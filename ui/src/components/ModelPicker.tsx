import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadCatalog, setModelChoice, useStore } from '../store';
import { AUTO_INFO, groupModels, modelLabel, providerCreatorGroups } from '../models';
import { loadProviders, refreshStaleModels, useProviders } from '../providers/providersStore';
import { buildPickerLayout, nextHighlightId, resolveHighlight, type PickerHead, type PickerItem } from '../../../src/shared/model-picker-rows';
import { Icon } from './icons';

/** A DOM id for a row: option ids must be unique and free of spaces, slashes and colons. */
const optionId = (id: string) => `mp-opt-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/**
 * Composer model pill + popover. Ctrl+M (or /model) opens it.
 * Keys: arrows move the highlight, Enter picks it (or opens and closes a group head), Escape clears the search or closes, Tab closes.
 * A search puts the highlight on the first real match, and the arrows and hover move it from there. The list is one scroller: the
 * Older models head is its last row, pinned to the bottom edge, and its rows follow the head when it is open.
 */
export function ModelPicker({ model, agentName, onClose }: { model: string; agentName: string; onClose: () => void }) {
  const catalog = useStore((s) => s.catalog);
  const loading = useStore((s) => s.catalogLoading);
  const view = useProviders((x) => x.view);
  const loadingProviders = useProviders((x) => !x.loaded || x.refreshing);
  const { current, older, fallback } = groupModels(catalog);
  const providers = (view?.providers ?? []).filter((p) => p.enabled && p.models.length > 0);
  const groups = providerCreatorGroups(providers.map((p) => ({ id: p.id, label: p.label, models: p.models })));
  const configured = providers.flatMap((p) => p.configuredModels.map((m) => `${p.id}:${m}`));
  const [olderOpen, setOlderOpen] = useState(() => older.some((m) => m.value === model));
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  /** Heads the owner opened or closed while a query is typed. Cleared by every change of the search. */
  const [queryOpen, setQueryOpen] = useState<Record<string, boolean>>({});
  /** The row the owner moved to. Cleared by every change of the search, so a query starts on its first match. */
  const [hlId, setHlId] = useState<string | undefined>(undefined);
  const [edge, setEdge] = useState({ top: false, bottom: false });
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The list's scroll position when the owner opened Older models; closing returns to it. */
  const olderTop = useRef(0);
  /** What the next Older toggle asks of the list: the head to the top (opening), or the saved position (closing). */
  const olderMove = useRef<'top' | 'restore' | null>(null);
  /** Set by the Older toggle: the highlight must not scroll the list again in that same render, or it undoes the move. */
  const keepScroll = useRef(false);

  const layout = buildPickerLayout({ query: q, selected: model, autoDescription: AUTO_INFO, current, older, groups, configured, olderOpen, groupOpen, queryOpen });
  const { nav } = layout;
  const hl = resolveHighlight(nav, hlId, q, model);
  const cur = hl >= 0 ? nav[hl] : undefined;
  const failed = providers.find((p) => p.modelsError);
  const noMatch = nav.length === 0 && q.trim() !== '';

  const syncEdge = () => { const el = list.current; if (el) setEdge({ top: el.scrollTop > 2, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2 }); };
  /** Enter on a head flips what the head shows. A search opens every head by default, and the owner can close one while it is searched. */
  const toggleHead = (h: PickerHead) => {
    if (q.trim()) setQueryOpen((s) => ({ ...s, [h.id]: !h.open }));
    else if (h.id === 'older') {
      if (olderOpen) olderMove.current = 'restore';
      else { olderTop.current = list.current?.scrollTop ?? 0; olderMove.current = 'top'; }
      setOlderOpen((v) => !v);
    }
    else setGroupOpen((s) => ({ ...s, [h.id]: !h.open }));
  };
  /** Every change of the search clears the moved highlight and the heads opened under the old query. */
  const changeQuery = (v: string) => { setQ(v); setHlId(undefined); setQueryOpen({}); };
  const move = (d: 1 | -1) => { const id = nextHighlightId(nav, hlId, q, model, d); if (id !== undefined) setHlId(id); };
  const pick = (v: string) => { setModelChoice(v); onClose(); };

  useEffect(() => {
    if (!catalog && !loading) void loadCatalog();
    // the picker's first open fetches the model lists of switched-on providers that are missing or a day old, in the background
    void loadProviders().then(() => refreshStaleModels());
    box.current?.querySelector<HTMLInputElement>('.mp-search')?.focus();
  }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.model-pill')) onClose(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onClose]);
  // Opening Older models puts its head at the top of the list, so its rows fill the space under it; closing restores the position.
  useLayoutEffect(() => {
    const move = olderMove.current;
    olderMove.current = null;
    const el = list.current;
    if (!move || !el) return;
    keepScroll.current = true;
    if (move === 'restore') { el.scrollTop = olderTop.current; return; }
    // the head's natural place is the bottom of the row before it (a pinned head is drawn lower, so it is not measured)
    const prev = el.querySelector('.mp-older-head')?.previousElementSibling;
    el.scrollTop = prev ? el.scrollTop + prev.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 0;
  }, [olderOpen]);
  useEffect(() => {
    if (keepScroll.current) keepScroll.current = false;
    else box.current?.querySelector('.mp-item.hl, .mp-head.hl')?.scrollIntoView({ block: 'nearest' });
    syncEdge();
  }, [cur?.id, olderOpen, groupOpen, catalog, q, view, loadingProviders]);

  const itemRow = (n: PickerItem) => (
    <button key={n.id} type="button" id={optionId(n.id)} role="option" aria-selected={n.value === model} tabIndex={-1}
      className={`mp-item${cur?.id === n.id ? ' hl' : ''}${n.value === model ? ' cur' : ''}`} title={n.title}
      onMouseMove={() => setHlId(n.id)} onClick={() => pick(n.value)}>
      <span className="mp-text"><b>{n.displayName}</b>{n.description && <span>{n.description}</span>}</span>
      <span className="mp-check">{n.value === model && <Icon name="check" size={14} />}</span>
    </button>
  );
  const headRow = (h: PickerHead) => (
    <button key={h.id} type="button" id={optionId(h.id)} role="option" aria-selected={false} tabIndex={-1}
      aria-label={`${h.label}, ${h.count} ${h.count === 1 ? 'model' : 'models'}, ${h.open ? 'open' : 'closed'}`}
      title="Enter opens or closes this group"
      className={`mp-group mp-head${h.id === 'older' ? ' mp-older-head' : ''}${h.open ? ' is-open' : ''}${cur?.id === h.id ? ' hl' : ''}`}
      onMouseMove={() => setHlId(h.id)} onClick={() => toggleHead(h)}>
      <span className="mp-head-label">{h.label}</span><span className="mp-count">{h.count}</span><Icon name="chevron" size={12} />
    </button>
  );

  return (
    <div className="popover model-pop" ref={box} tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); if (cur?.kind === 'head') toggleHead(cur); else if (cur?.kind === 'item') pick(cur.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q) changeQuery(''); else onClose(); }
        else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
      }}>
      <div className="pop-head"><span>Model</span><span className="muted-s">for {agentName}</span></div>
      <div className="pop-search">
        <input className="mp-search" value={q} onChange={(e) => changeQuery(e.target.value)}
          placeholder="Search models" aria-label="Search models" aria-controls="mp-listbox" spellCheck={false} />
      </div>
      <div className="pop-body" role="listbox" id="mp-listbox" aria-label="Model" aria-activedescendant={cur ? optionId(cur.id) : undefined}>
        {(layout.rows.length > 0 || layout.older || noMatch) && (
          // four rows or more get a floor, so the list never shrinks to a sliver; a shorter list is just its own height
          <div className={`pop-listwrap${layout.rows.length >= 4 ? ' is-tall' : ''}${edge.top ? ' sh-top' : ''}${edge.bottom ? ' sh-bot' : ''}`}>
            <div className="pop-list" ref={list} onScroll={syncEdge}>
              {layout.rows.map((r, k) => r.kind === 'label'
                ? <div key={`label-${k}`} className="mp-group mp-label" role="presentation">{r.text}</div>
                : r.kind === 'head' ? headRow(r) : itemRow(r))}
              {layout.older && <>{headRow(layout.older.head)}{layout.older.rows.map(itemRow)}</>}
              {noMatch && <div className="mp-empty" role="status">No models match “{q.trim()}”.</div>}
            </div>
          </div>
        )}
      </div>
      <div className="pop-foot">
        {loading && !catalog ? <span>Loading models{'…'}</span>
          : fallback ? <><span>{catalog?.error ? 'Couldn’t load models from Claude Code.' : 'Showing default models.'}</span><button type="button" className="link-btn" onClick={() => void loadCatalog(true)}>Retry</button></>
          : <span>Saved for this agent. Current: {modelLabel(catalog, model)}</span>}
        <kbd>Ctrl M</kbd>
        {failed && <span className="mp-quiet" role="status">Couldn’t refresh {failed.label} models. Showing saved ones.</span>}
        {!failed && loadingProviders && <span className="mp-quiet" role="status">Loading provider models{'…'}</span>}
      </div>
    </div>
  );
}
