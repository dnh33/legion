import { useEffect, useRef, useState } from 'react';
import { loadCatalog, setModelChoice, useStore } from '../store';
import { AUTO_INFO, groupModels, modelLabel } from '../models';
import { loadProviders, providerModelGroups, useProviders } from '../providers/providersStore';
import { Icon } from './icons';

/** Composer model pill + popover. Ctrl+M (or /model) opens it. */
export function ModelPicker({ model, agentName, onClose }: { model: string; agentName: string; onClose: () => void }) {
  const catalog = useStore((s) => s.catalog);
  const loading = useStore((s) => s.catalogLoading);
  const { current, more, fallback } = groupModels(catalog);
  const [showMore, setShowMore] = useState(() => more.some((m) => m.value === model));
  const provGroups = providerModelGroups(useProviders((x) => x.view));
  const provItems = provGroups.flatMap((g) => g.models.map((m) => ({ value: `${g.id}:${m}`, displayName: m, group: 'Other providers (not Claude)', description: `${g.label}, not Claude: Legion's tools and your MCP servers only` })));
  const claudeItems = [{ value: 'auto', displayName: 'Auto', description: AUTO_INFO, group: undefined as string | undefined }, ...current.map((m) => ({ ...m, group: 'Current models' })), ...(showMore ? more.map((m) => ({ ...m, group: 'More models' })) : [])];
  const items = [...claudeItems, ...provItems];
  const cur = Math.max(0, items.findIndex((m) => m.value === model));
  const [i, setI] = useState(cur);
  const [q, setQ] = useState('');
  const [edge, setEdge] = useState({ top: false, bottom: false });
  const syncEdge = () => { const el = box.current?.querySelector('.pop-list'); if (el) setEdge({ top: el.scrollTop > 2, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2 }); };
  const box = useRef<HTMLDivElement>(null);

  const ql = q.trim().toLowerCase();
  const list = items.filter((m) => !ql || m.displayName.toLowerCase().includes(ql) || m.value.toLowerCase().includes(ql));

  useEffect(() => { if (!catalog && !loading) void loadCatalog(); void loadProviders(); box.current?.querySelector<HTMLInputElement>('.mp-search')?.focus(); }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.model-pill')) onClose(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onClose]);
  useEffect(() => { box.current?.querySelector('.mp-item.hl')?.scrollIntoView({ block: 'nearest' }); syncEdge(); }, [i, showMore, catalog, q]);
  useEffect(() => { setI((n) => Math.min(n, Math.max(0, list.length - 1))); }, [list.length]);

  const pick = (v: string) => { setModelChoice(v); onClose(); };
  return (
    <div className="popover model-pop" ref={box} tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (list.length) setI((n) => (n + 1) % list.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (list.length) setI((n) => (n - 1 + list.length) % list.length); }
        else if (e.key === 'ArrowRight' && !ql && more.length && !showMore) { e.preventDefault(); setShowMore(true); }
        else if (e.key === 'ArrowLeft' && !ql && showMore) { e.preventDefault(); setShowMore(false); setI((n) => Math.min(n, current.length)); }
        else if (e.key === 'Home') { e.preventDefault(); setI(0); }
        else if (e.key === 'End') { e.preventDefault(); setI(Math.max(0, list.length - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (list[i]) pick(list[i].value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q) setQ(''); else onClose(); }
        else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
      }}>
      <div className="pop-head"><span>Model</span><span className="muted-s">for {agentName}</span></div>
      <div className="pop-search"><input className="mp-search" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') e.stopPropagation(); }} placeholder="Search models" aria-label="Search models" spellCheck={false} /></div>
      <div className={`pop-listwrap${edge.top ? ' sh-top' : ''}${edge.bottom ? ' sh-bot' : ''}`}>
      <div className="pop-list" role="listbox" aria-label="Model" aria-activedescendant={list[i] ? `mp-opt-${list[i].value}` : undefined} onScroll={syncEdge}>
        {list.map((m, n) => (
          <div key={m.value} style={{ display: 'contents' }}>
            {m.group && m.group !== list[n - 1]?.group && <div className="mp-group" role="presentation">{m.group}</div>}
            <button type="button" id={`mp-opt-${m.value}`} role="option" aria-selected={m.value === model} tabIndex={-1} className={`mp-item${n === i ? ' hl' : ''}${m.value === model ? ' cur' : ''}`}
              onMouseMove={() => setI(n)} onClick={() => pick(m.value)}>
              <span className="mp-text"><b>{m.displayName}</b><span>{m.description}</span></span>
              <span className="mp-check">{m.value === model && <Icon name="check" size={14} />}</span>
            </button>
          </div>
        ))}
        {ql && list.length === 0 && <div className="mp-empty" role="status">No models match “{q}”.</div>}
      </div>
      {!ql && more.length > 0 && <button type="button" className="mp-more" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
        {showMore ? 'Hide older models' : `More models (${more.length})`}<Icon name="chevron" size={12} />
      </button>}
      </div>
      <div className="pop-foot">
        {loading && !catalog ? <span>Loading models{'…'}</span>
          : fallback ? <><span>{catalog?.error ? 'Couldn’t load models from Claude Code.' : 'Showing default models.'}</span><button type="button" className="link-btn" onClick={() => void loadCatalog(true)}>Retry</button></>
          : <span>Saved for this agent. Current: {modelLabel(catalog, model)}</span>}
        <kbd>Ctrl M</kbd>
      </div>
    </div>
  );
}
