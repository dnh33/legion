import { useEffect, useRef, useState } from 'react';
import { loadCatalog, setModelChoice, useStore } from '../store';
import { AUTO_INFO, groupModels, modelLabel, providerCreatorGroups } from '../models';
import { loadProviders, refreshStaleModels, useProviders } from '../providers/providersStore';
import { buildPickerLayout, resolveHighlight, type PickerHead, type PickerItem } from '../../../src/shared/model-picker-rows';
import { Icon } from './icons';

/** A DOM id for a row: option ids must be unique and free of spaces, slashes and colons. */
const optionId = (id: string) => `mp-opt-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/**
 * Composer model pill + popover. Ctrl+M (or /model) opens it.
 * Keys: arrows move the highlight, Enter picks it (or opens and closes a group head), Escape clears the search or closes, Tab closes.
 * A search puts the highlight on the first real match. The Older models head is pinned under the list, so it stays in view.
 */
export function ModelPicker({ model, agentName, onClose }: { model: string; agentName: string; onClose: () => void }) {
  const catalog = useStore((s) => s.catalog);
  const loading = useStore((s) => s.catalogLoading);
  const view = useProviders((x) => x.view);
  const { current, older, fallback } = groupModels(catalog);
  const providers = (view?.providers ?? []).filter((p) => p.enabled && p.models.length > 0);
  const groups = providerCreatorGroups(providers.map((p) => ({ id: p.id, label: p.label, models: p.models })));
  const configured = providers.flatMap((p) => p.configuredModels.map((m) => `${p.id}:${m}`));
  const [olderOpen, setOlderOpen] = useState(() => older.some((m) => m.value === model));
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  /** The row the owner moved to. Cleared by every change of the search, so a query always lands on its first match. */
  const [hlId, setHlId] = useState<string | undefined>(undefined);
  const [edge, setEdge] = useState({ top: false, bottom: false });
  const box = useRef<HTMLDivElement>(null);

  const layout = buildPickerLayout({ query: q, selected: model, autoDescription: AUTO_INFO, current, older, groups, configured, olderOpen, groupOpen });
  const { nav } = layout;
  const hl = resolveHighlight(nav, hlId, q, model);
  const cur = hl >= 0 ? nav[hl] : undefined;
  const failed = providers.find((p) => p.modelsError);

  const syncEdge = () => { const el = box.current?.querySelector('.pop-list'); if (el) setEdge({ top: el.scrollTop > 2, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2 }); };
  /** A search opens every head and shows only matches, so a head cannot be closed while one is searched. */
  const toggleHead = (h: PickerHead) => {
    if (q.trim()) return;
    if (h.id === 'older') setOlderOpen((v) => !v);
    else setGroupOpen((s) => ({ ...s, [h.id]: !h.open }));
  };
  const move = (d: 1 | -1) => { if (nav.length) setHlId(nav[(hl + d + nav.length) % nav.length]!.id); };
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
  useEffect(() => { box.current?.querySelector('.mp-item.hl, .mp-head.hl')?.scrollIntoView({ block: 'nearest' }); syncEdge(); }, [cur?.id, olderOpen, groupOpen, catalog, q, view]);

  const itemRow = (n: PickerItem) => (
    <button key={n.id} type="button" id={optionId(n.id)} role="option" aria-selected={n.value === model} tabIndex={-1}
      className={`mp-item${cur?.id === n.id ? ' hl' : ''}${n.value === model ? ' cur' : ''}`}
      onMouseMove={() => setHlId(n.id)} onClick={() => pick(n.value)}>
      <span className="mp-text"><b>{n.displayName}</b>{n.description && <span>{n.description}</span>}</span>
      <span className="mp-check">{n.value === model && <Icon name="check" size={14} />}</span>
    </button>
  );
  const headRow = (h: PickerHead) => (
    <button key={h.id} type="button" id={optionId(h.id)} role="option" aria-selected={false} tabIndex={-1}
      aria-label={`${h.label}, ${h.count} ${h.count === 1 ? 'model' : 'models'}, ${h.open ? 'open' : 'closed'}`}
      title="Enter opens or closes this group"
      className={`mp-group mp-head${h.open ? ' is-open' : ''}${cur?.id === h.id ? ' hl' : ''}`}
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
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q) { setQ(''); setHlId(undefined); } else onClose(); }
        else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
      }}>
      <div className="pop-head"><span>Model</span><span className="muted-s">for {agentName}</span></div>
      <div className="pop-search">
        <input className="mp-search" value={q} onChange={(e) => { setQ(e.target.value); setHlId(undefined); }}
          placeholder="Search models" aria-label="Search models" aria-controls="mp-listbox" spellCheck={false} />
      </div>
      <div className="pop-body" role="listbox" id="mp-listbox" aria-label="Model" aria-activedescendant={cur ? optionId(cur.id) : undefined}>
        <div className={`pop-listwrap${edge.top ? ' sh-top' : ''}${edge.bottom ? ' sh-bot' : ''}`}>
          <div className="pop-list" onScroll={syncEdge}>
            {layout.rows.map((r, k) => r.kind === 'label'
              ? <div key={`label-${k}`} className="mp-group mp-label" role="presentation">{r.text}</div>
              : r.kind === 'head' ? headRow(r) : itemRow(r))}
          </div>
        </div>
        {layout.older && (
          <div className="mp-older">
            {headRow(layout.older.head)}
            {layout.older.rows.length > 0 && <div className="mp-older-rows">{layout.older.rows.map(itemRow)}</div>}
          </div>
        )}
      </div>
      <div className="pop-foot">
        {nav.length === 0 && q.trim() ? <span role="status">No models match “{q.trim()}”.</span>
          : loading && !catalog ? <span>Loading models{'…'}</span>
          : fallback ? <><span>{catalog?.error ? 'Couldn’t load models from Claude Code.' : 'Showing default models.'}</span><button type="button" className="link-btn" onClick={() => void loadCatalog(true)}>Retry</button></>
          : <span>Saved for this agent. Current: {modelLabel(catalog, model)}</span>}
        {failed && <span className="mp-quiet" role="status">Couldn’t refresh {failed.label} models. Showing saved ones.</span>}
        <kbd>Ctrl M</kbd>
      </div>
    </div>
  );
}
