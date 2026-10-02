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
  const provItems = provGroups.flatMap((g) => g.models.map((m) => ({ value: `${g.id}:${m}`, displayName: m, description: `${g.label}, not Claude: Legion's tools and your MCP servers only` })));
  const claudeItems = [{ value: 'auto', displayName: 'Auto', description: AUTO_INFO }, ...current, ...(showMore ? more : [])];
  const items = [...claudeItems, ...provItems];
  const cur = Math.max(0, items.findIndex((m) => m.value === model));
  const [i, setI] = useState(cur);
  const [edge, setEdge] = useState({ top: false, bottom: false });
  const syncEdge = () => { const el = box.current?.querySelector('.pop-list'); if (el) setEdge({ top: el.scrollTop > 2, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2 }); };
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!catalog && !loading) void loadCatalog(); void loadProviders(); box.current?.focus(); }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.model-pill')) onClose(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onClose]);
  useEffect(() => { box.current?.querySelector('.mp-item.hl')?.scrollIntoView({ block: 'nearest' }); syncEdge(); }, [i, showMore, catalog]);

  const pick = (v: string) => { setModelChoice(v); onClose(); };
  return (
    <div className="popover model-pop" ref={box} tabIndex={-1} role="listbox" aria-label="Model"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => (n + 1) % items.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => (n - 1 + items.length) % items.length); }
        else if (e.key === 'ArrowRight' && more.length && !showMore) { e.preventDefault(); setShowMore(true); }
        else if (e.key === 'ArrowLeft' && showMore) { e.preventDefault(); setShowMore(false); setI((n) => Math.min(n, current.length)); }
        else if (e.key === 'Home') { e.preventDefault(); setI(0); }
        else if (e.key === 'End') { e.preventDefault(); setI(items.length - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(items[i].value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
      }}>
      <div className="pop-head"><span>Model</span><span className="muted-s">for {agentName}</span></div>
      <div className={`pop-listwrap${edge.top ? ' sh-top' : ''}${edge.bottom ? ' sh-bot' : ''}`}>
      <div className="pop-list" onScroll={syncEdge}>
        {items.map((m, n) => (
          <div key={m.value} style={{ display: 'contents' }}>
            {n === 1 && <div className="mp-group">Current models</div>}
            {showMore && n === 1 + current.length && <div className="mp-group">More models</div>}
            {provItems.length > 0 && n === claudeItems.length && <div className="mp-group">Other providers (not Claude)</div>}
            <button type="button" role="option" aria-selected={m.value === model} className={`mp-item${n === i ? ' hl' : ''}${m.value === model ? ' cur' : ''}`}
              onMouseMove={() => setI(n)} onClick={() => pick(m.value)}>
              <span className="mp-text"><b>{m.displayName}</b><span>{m.description}</span></span>
              <span className="mp-check">{m.value === model && <Icon name="check" size={14} />}</span>
            </button>
          </div>
        ))}
        {more.length > 0 && <button type="button" className="mp-more" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
          {showMore ? 'Hide older models' : `More models (${more.length})`}<Icon name="chevron" size={12} />
        </button>}
      </div>
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
