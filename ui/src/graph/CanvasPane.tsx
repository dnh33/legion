import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { GraphEngine, type EngineOptions } from './engine';
import {
  clearPath, expand, fitView, getG, MAX_VIEW_NODES, pickPath, select, setHover, startPick, toggleFrozen, useG, dismissNotice, titleOf,
} from './graphStore';
import { GIcon } from './icons';
import { NODE_TYPES, typeColor } from './palette';

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export function useMatch(): ((n: { scope: string; type: string; tags: string[] }) => boolean) | null {
  const scope = useG((s) => s.scope), type = useG((s) => s.type), tag = useG((s) => s.tag);
  return useMemo(() => {
    const t = tag.trim().replace(/^#/, '').toLowerCase();
    if (!scope && !type && !t) return null;
    return (n) => (!scope || n.scope === scope) && (!type || n.type === type) && (!t || n.tags.some((x) => x.toLowerCase().includes(t)));
  }, [scope, type, tag]);
}

export function CanvasPane({ insetRight, insetLeft, onToggleLeft, leftOpen }: { insetRight: number; insetLeft: number; onToggleLeft: () => void; leftOpen: boolean }) {
  const theme = useStore((s) => s.theme);
  const agents = useStore((s) => s.agents);
  const graph = useG((s) => s.graph);
  const selectedId = useG((s) => s.selectedId);
  const hoverId = useG((s) => s.hoverId);
  const path = useG((s) => s.path);
  const hits = useG((s) => s.hits);
  const cam = useG((s) => s.cam);
  const frozen = useG((s) => s.frozen);
  const stats = useG((s) => s.stats);
  const truncated = useG((s) => s.truncated);
  const evicted = useG((s) => s.evicted);
  const loading = useG((s) => s.graphLoading);
  const notice = useG((s) => s.notice);
  const match = useMatch();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const eng = useRef<GraphEngine | null>(null);
  /** The graph revision the engine was last given, so mounting feeds it once (the constructor effect and the [graph.rev] effect both run on mount). */
  const applied = useRef(-1);
  const [legendPref, setLegendPref] = useState<'auto' | 'open' | 'closed'>(() => { const v = lsGet('legion.lattice.legend'); return v === '1' ? 'open' : v === '0' ? 'closed' : 'auto'; });
  const [size, setSize] = useState({ w: 800, h: 700 });

  const freeW = size.w - insetLeft - insetRight;
  const legend = legendPref === 'open' || (legendPref === 'auto' && freeW >= 560 && size.h >= 640);
  const pathNodes = useMemo(() => new Set(path.result?.found ? path.result.nodes.map((n) => n.id) : []), [path.result]);
  const pathEdges = useMemo(() => new Set(path.result?.found ? path.result.edges.map((e) => e.id) : []), [path.result]);
  const hitIds = useMemo(() => new Set(hits?.map((h) => h.node.id) ?? []), [hits]);
  const badges = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.emoji || a.name.charAt(0).toUpperCase()])), [agents]);

  const opts = (): EngineOptions => ({
    theme, selectedId, hoverId, pathNodes, pathEdges, pathActive: pathNodes.size > 0, hitIds, match: match ? (n) => match(n) : null,
    pickMode: !!path.picking, frozen, insetLeft, insetRight, insetTop: 56, insetBottom: legend ? 128 : 40, badges,
  });

  useEffect(() => {
    const e = new GraphEngine(canvas.current!, { onSelect: select, onExpand: (id) => void expand(id), onHover: setHover, onPick: pickPath }, opts());
    eng.current = e;
    if (import.meta.env.DEV) (canvas.current as unknown as { __lattice?: GraphEngine }).__lattice = e;
    const g0 = getG().graph;
    applied.current = g0.rev;
    e.setData(g0.nodes, g0.edges);
    const ro = new ResizeObserver(() => { e.resize(); const r = wrap.current!.getBoundingClientRect(); setSize({ w: r.width, h: r.height }); });
    ro.observe(wrap.current!);
    const mo = new MutationObserver(() => { e.readColors(); e.invalidate(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { ro.disconnect(); mo.disconnect(); e.destroy(); eng.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { eng.current?.setOptions(opts()); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, selectedId, hoverId, pathNodes, pathEdges, hitIds, match, path.picking, frozen, insetLeft, insetRight, badges, legend]);
  useEffect(() => {
    const g = getG().graph; // the store's current graph, not this render's: the two can differ for a moment
    if (g.rev === applied.current) return;
    applied.current = g.rev;
    eng.current?.setData(g.nodes, g.edges);
  }, [graph.rev]);
  useEffect(() => {
    if (!cam.n) return;
    if (cam.kind === 'fit') eng.current?.fit(true);
    else if (cam.kind === 'focus' && cam.ids?.[0]) eng.current?.focusOn(cam.ids[0]);
    else if (cam.kind === 'fitIds' && cam.ids) eng.current?.fitIds(cam.ids);
  }, [cam.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // bring a selected node out from under the panel, but only after a possible double-click has finished
  useEffect(() => {
    if (!selectedId) return;
    const t = window.setTimeout(() => eng.current?.reveal(selectedId), 480);
    return () => window.clearTimeout(t);
  }, [selectedId, insetRight, insetLeft]);

  const present = useMemo(() => { const t = new Set(graph.nodes.map((n) => n.type)); return NODE_TYPES.filter((x) => t.has(x)); }, [graph.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasScope = useMemo(() => ({
    agent: graph.nodes.some((n) => n.scope.startsWith('agent:')), bsv: graph.nodes.some((n) => n.scope === 'bsv'),
    untrusted: graph.nodes.some((n) => n.sources?.some((x) => x.untrusted)),
  }), [graph.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: React.KeyboardEvent) => {
    const en = eng.current; if (!en) return;
    const step = e.shiftKey ? 220 : 80;
    switch (e.key) {
      case 'ArrowLeft': en.panBy(-step, 0); break;
      case 'ArrowRight': en.panBy(step, 0); break;
      case 'ArrowUp': en.panBy(0, -step); break;
      case 'ArrowDown': en.panBy(0, step); break;
      case '+': case '=': en.zoomBy(1.25); break;
      case '-': case '_': en.zoomBy(0.8); break;
      case '0': fitView(); break;
      case 'Escape': if (getG().path.picking) startPick(null); else select(null); break;
      case 'Enter': if (selectedId) void expand(selectedId); break;
      case ']': case '[': {
        const list = graph.nodes.slice().sort((a, b) => a.title.localeCompare(b.title));
        if (!list.length) break;
        const i = list.findIndex((n) => n.id === selectedId);
        const next = list[(i + (e.key === ']' ? 1 : -1) + list.length) % list.length]!;
        select(next.id); break;
      }
      default: return;
    }
    e.preventDefault();
  };

  const selLite = selectedId ? graph.nodes.find((n) => n.id === selectedId) : null;
  const degree = selLite ? graph.edges.filter((e) => e.from === selLite.id || e.to === selLite.id).length : 0;
  const total = stats?.nodes ?? 0;
  const pathFound = path.result?.found;

  return (
    <div className="lt-canvas-wrap" ref={wrap}>
      <canvas ref={canvas} className="lt-canvas" tabIndex={0} onKeyDown={onKey}
        aria-label={`Knowledge graph canvas, ${graph.nodes.length} nodes and ${graph.edges.length} links shown. Arrow keys pan, plus and minus zoom, 0 fits the view, bracket keys step through nodes, Enter expands the selected node. The results list in the left column lists the same nodes.`} />
      <div className="lt-sr" aria-live="polite">{selLite ? `Selected ${selLite.title}, ${selLite.type}, ${degree} links on canvas.` : ''}</div>

      <div className="lt-toolbar" role="toolbar" aria-label="Canvas controls" style={{ left: insetLeft + 10 }}>
        <button className={`lt-tool${leftOpen ? ' on' : ''}`} onClick={onToggleLeft} title="Show or hide the search panel" aria-label="Toggle search panel" aria-pressed={leftOpen}><GIcon name="panel" /></button>
        <button className="lt-tool" onClick={() => eng.current?.zoomBy(1.3)} title="Zoom in (+)" aria-label="Zoom in"><GIcon name="plus" /></button>
        <button className="lt-tool" onClick={() => eng.current?.zoomBy(1 / 1.3)} title="Zoom out (-)" aria-label="Zoom out"><GIcon name="minus" /></button>
        <button className="lt-tool" onClick={fitView} title="Fit to view (0)" aria-label="Fit to view"><GIcon name="fit" /></button>
        <button className="lt-tool" onClick={() => eng.current?.relayout()} title="Re-run the layout" aria-label="Re-run layout"><GIcon name="relayout" /></button>
        <button className={`lt-tool${frozen ? ' on' : ''}`} onClick={toggleFrozen} title={frozen ? 'Resume layout simulation' : 'Freeze layout'} aria-label={frozen ? 'Resume layout' : 'Freeze layout'} aria-pressed={frozen}><GIcon name={frozen ? 'play' : 'pause'} /></button>
      </div>

      {(path.picking || pathFound || path.result?.found === false) && (
        <div className="lt-banner" role="status" style={{ left: insetLeft + 10, maxWidth: Math.max(200, freeW - 20) }}>
          {path.picking ? <><GIcon name="path" /> <span>Click a node to set the <b>{path.picking === 'from' ? 'start' : 'end'}</b></span></>
            : pathFound ? <><GIcon name="path" />
              {freeW >= 520 ? <span><b>{titleOf(path.result!.nodes[0]!.id)}</b> <span aria-hidden="true">{'\u2192'}</span> <b>{titleOf(path.result!.nodes[path.result!.nodes.length - 1]!.id)}</b> </span> : <span>Path</span>}
                <span className="lt-faint lt-nowrap">{path.result!.edges.length} hop{path.result!.edges.length === 1 ? '' : 's'}</span></>
              : <><GIcon name="path" /> <span>No path found between those nodes</span></>}
          <button className="lt-x" onClick={() => (path.picking ? startPick(null) : clearPath())} aria-label={path.picking ? 'Cancel picking' : 'Clear path'}><GIcon name="x" size={13} /></button>
        </div>
      )}

      {loading && <div className="lt-busy" role="status"><i className="lt-spin" /> Loading</div>}

      <div className="lt-legend" style={{ left: insetLeft + 10, maxWidth: Math.max(180, Math.min(500, freeW - 20 - (legend ? 0 : 0))) }}>
        <button className="lt-legend-head" onClick={() => { setLegendPref(legend ? 'closed' : 'open'); lsSet('legion.lattice.legend', legend ? '0' : '1'); }} aria-expanded={legend}>
          <GIcon name="chevron" size={12} /> Legend
        </button>
        {legend && (
          <div className="lt-legend-body">
            <ul className="lt-legend-types">{present.map((t) => <li key={t}><i style={{ background: typeColor(theme, t) }} />{t}</li>)}</ul>
            <ul className="lt-legend-scopes">
              <li><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="currentColor" opacity=".55" /><circle cx="8" cy="8" r="5" fill="none" stroke="var(--line-strong)" /></svg>shared</li>
              {hasScope.agent && <li><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="3.6" fill="currentColor" opacity=".55" /><circle cx="8" cy="8" r="6.3" fill="none" stroke="var(--text-2)" strokeWidth="1.5" strokeDasharray="3 2.4" /></svg>private to a bot</li>}
              {hasScope.bsv && <li><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="3.6" fill="currentColor" opacity=".55" /><circle cx="8" cy="8" r="6.3" fill="none" stroke="var(--warn)" strokeWidth="2" /></svg>BSV pack</li>}
              {hasScope.untrusted && <li><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="currentColor" opacity=".55" /><circle cx="4.8" cy="4.8" r="2.4" fill="var(--warn)" /></svg>untrusted source</li>}
              <li className="lt-legend-note">badge = creator {'\u00b7'} arrow = link direction</li>
            </ul>
          </div>
        )}
      </div>

      {freeW >= 460 && <div className="lt-status" style={{ right: insetRight + 10 }} aria-live="off">
        <span title={total > graph.nodes.length ? `${total.toLocaleString()} nodes in the whole graph` : undefined}><b>{graph.nodes.length}</b>{total > graph.nodes.length ? <> / {total.toLocaleString()}</> : null} nodes {'\u00b7'} <b>{graph.edges.length}</b> links</span>
        {(truncated || evicted > 0 || graph.nodes.length >= MAX_VIEW_NODES) && <span className="lt-trunc" title={`The canvas shows at most ${MAX_VIEW_NODES} nodes at once. Search, or double-click a node, to bring in another part of the graph.`}>{graph.nodes.length >= MAX_VIEW_NODES ? `capped at ${MAX_VIEW_NODES}` : 'partial view'}</span>}
        <span className="lt-hint">Scroll zoom {'·'} drag pan {'·'} double-click expands</span>
      </div>}

      {notice && (
        <div className={`lt-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} style={{ left: `calc(50% + ${(insetLeft - insetRight) / 2}px)` }} key={notice.n}>
          <span>{notice.text}</span><button className="lt-x" onClick={dismissNotice} aria-label="Dismiss"><GIcon name="x" size={12} /></button>
        </div>
      )}
    </div>
  );
}
