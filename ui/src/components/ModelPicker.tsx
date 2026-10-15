import { useEffect, useRef, useState } from 'react';
import { loadCatalog, setModelChoice, useStore } from '../store';
import { AUTO_INFO, groupModels, modelLabel, providerCreatorGroups } from '../models';
import { loadProviders, refreshStaleModels, useProviders } from '../providers/providersStore';
import { Icon } from './icons';

/** One row the arrow keys can reach: a model, or a collapsible group head ("Older models (n)", a creator group). */
type Nav =
  | { kind: 'item'; id: string; value: string; displayName: string; description: string; section?: string }
  | { kind: 'head'; id: string; label: string; count: number; open: boolean; toggle: () => void };

/** Composer model pill + popover. Ctrl+M (or /model) opens it. */
export function ModelPicker({ model, agentName, onClose }: { model: string; agentName: string; onClose: () => void }) {
  const catalog = useStore((s) => s.catalog);
  const loading = useStore((s) => s.catalogLoading);
  const view = useProviders((x) => x.view);
  const { current, older, fallback } = groupModels(catalog);
  const providers = (view?.providers ?? []).filter((p) => p.enabled && p.models.length > 0);
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const creators = providerCreatorGroups(providers.map((p) => ({ id: p.id, label: p.label, models: p.models })));
  const configured = new Set(providers.flatMap((p) => p.configuredModels.map((m) => `${p.id}:${m}`)));
  const [showOlder, setShowOlder] = useState(() => older.some((m) => m.value === model));
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [edge, setEdge] = useState({ top: false, bottom: false });
  const box = useRef<HTMLDivElement>(null);

  const ql = q.trim().toLowerCase();
  const hit = (...xs: string[]) => !ql || xs.some((x) => x.toLowerCase().includes(ql));

  // Built from what is visible: a collapsed group contributes its head only, so the arrow keys never land inside it.
  const nav: Nav[] = [{ kind: 'item', id: 'auto', value: 'auto', displayName: 'Auto', description: AUTO_INFO }];
  for (const m of current) if (hit(m.displayName, m.value)) nav.push({ kind: 'item', id: m.value, value: m.value, displayName: m.displayName, description: m.description, section: 'Current models' });
  if (older.some((m) => hit(m.displayName, m.value))) {
    const open = ql ? true : showOlder;
    nav.push({ kind: 'head', id: 'older', label: `Older models (${older.length})`, count: older.length, open, toggle: () => setShowOlder((v) => !v) });
    if (open) for (const m of older) if (hit(m.displayName, m.value)) nav.push({ kind: 'item', id: m.value, value: m.value, displayName: m.displayName, description: m.description, section: 'Older models' });
  }
  for (const g of creators) {
    const groupHit = hit(g.label);
    const models = g.models.filter((m) => groupHit || hit(m));
    if (!models.length) continue;
    const key = `group-${g.id}`;
    const defaultOpen = g.models.some((m) => configured.has(`${g.providerId}:${m}`) || `${g.providerId}:${m}` === model);
    const open = ql ? true : (openGroups[key] ?? defaultOpen);
    nav.push({ kind: 'head', id: key, label: g.label, count: g.models.length, open, toggle: () => setOpenGroups((s) => ({ ...s, [key]: !open })) });
    if (open) {
      const pname = providerById.get(g.providerId)?.label ?? g.providerId;
      for (const m of models) nav.push({ kind: 'item', id: `${g.providerId}:${m}`, value: `${g.providerId}:${m}`, displayName: m, description: `${pname}, not Claude: Legion's tools and your MCP servers only` });
    }
  }

  const [i, setI] = useState(() => Math.max(0, nav.findIndex((n) => n.kind === 'item' && n.value === model)));
  const hl = nav[i];
  const syncEdge = () => { const el = box.current?.querySelector('.pop-list'); if (el) setEdge({ top: el.scrollTop > 2, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2 }); };

  useEffect(() => {
    if (!catalog && !loading) void loadCatalog();
    // the picker's first open fetches the model lists of switched-on providers that are missing or a day old
    void Promise.resolve(loadProviders()).then(() => refreshStaleModels());
    box.current?.querySelector<HTMLInputElement>('.mp-search')?.focus();
  }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.model-pill')) onClose(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onClose]);
  useEffect(() => { box.current?.querySelector('.mp-item.hl, .mp-head.hl')?.scrollIntoView({ block: 'nearest' }); syncEdge(); }, [i, showOlder, openGroups, catalog, q, view]);
  useEffect(() => { setI((n) => Math.min(n, Math.max(0, nav.length - 1))); }, [nav.length]);

  const pick = (v: string) => { setModelChoice(v); onClose(); };
  const failed = providers.find((p) => p.modelsError);
  return (
    <div className="popover model-pop" ref={box} tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => (n + 1) % nav.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => (n - 1 + nav.length) % nav.length); }
        else if (e.key === 'ArrowRight' && hl?.kind === 'head' && !hl.open) { e.preventDefault(); hl.toggle(); }
        else if (e.key === 'ArrowLeft' && hl?.kind === 'head' && hl.open) { e.preventDefault(); hl.toggle(); }
        else if (e.key === 'Home') { e.preventDefault(); setI(0); }
        else if (e.key === 'End') { e.preventDefault(); setI(Math.max(0, nav.length - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (hl?.kind === 'head') hl.toggle(); else if (hl) pick(hl.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q) setQ(''); else onClose(); }
        else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
      }}>
      <div className="pop-head"><span>Model</span><span className="muted-s">for {agentName}</span></div>
      <div className="pop-search"><input className="mp-search" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') e.stopPropagation(); }} placeholder="Search models" aria-label="Search models" spellCheck={false} /></div>
      <div className={`pop-listwrap${edge.top ? ' sh-top' : ''}${edge.bottom ? ' sh-bot' : ''}`}>
      <div className="pop-list" role="listbox" aria-label="Model" aria-activedescendant={hl ? `mp-opt-${hl.id}` : undefined} onScroll={syncEdge}>
        {nav.map((n, k) => (
          <div key={`${n.kind}-${n.id}`} style={{ display: 'contents' }}>
            {n.kind === 'item' && n.section && (() => { const p = nav[k - 1]; return p?.kind === 'item' && p.section !== n.section ? <div className="mp-group" role="presentation">{n.section}</div> : null; })()}
            {n.kind === 'head' ? (
              <button type="button" id={`mp-opt-${n.id}`} role="option" aria-selected={false} aria-expanded={n.open} tabIndex={-1} className={`mp-group mp-head${k === i ? ' hl' : ''}`}
                onMouseMove={() => setI(k)} onClick={n.toggle}>
                <span className="mp-head-label">{n.label}</span>{!ql && <span className="mp-count">{n.count}</span>}<Icon name="chevron" size={12} />
              </button>
            ) : (
              <button type="button" id={`mp-opt-${n.id}`} role="option" aria-selected={n.value === model} tabIndex={-1} className={`mp-item${k === i ? ' hl' : ''}${n.value === model ? ' cur' : ''}`}
                onMouseMove={() => setI(k)} onClick={() => pick(n.value)}>
                <span className="mp-text"><b>{n.displayName}</b><span>{n.description}</span></span>
                <span className="mp-check">{n.value === model && <Icon name="check" size={14} />}</span>
              </button>
            )}
          </div>
        ))}
        {ql && nav.length <= 1 && <div className="mp-empty" role="status">No models match “{q}”.</div>}
      </div>
      </div>
      <div className="pop-foot">
        {loading && !catalog ? <span>Loading models{'…'}</span>
          : fallback ? <><span>{catalog?.error ? 'Couldn’t load models from Claude Code.' : 'Showing default models.'}</span><button type="button" className="link-btn" onClick={() => void loadCatalog(true)}>Retry</button></>
          : <span>Saved for this agent. Current: {modelLabel(catalog, model)}</span>}
        {failed && <span className="mp-quiet" role="status">Couldn’t refresh {failed.label} models. Showing saved ones.</span>}
        <kbd>Ctrl M</kbd>
      </div>
    </div>
  );
}
