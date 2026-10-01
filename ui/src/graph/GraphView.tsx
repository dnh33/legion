/** The Lattice: knowledge graph view. Left: search / filters / lint. Centre: canvas. Right: node details. */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { CanvasPane } from './CanvasPane';
import { DetailPanel } from './DetailPanel';
import { DialogHost } from './Dialogs';
import { LeftColumn } from './LeftColumn';
import * as store from './graphStore';
import { boot, openDialog, resetOffline, seedBsv, select, startLive, useG } from './graphStore';
import { GIcon } from './icons';
import './graph.css';

// dev only: lets tests drive the store from the console (stripped from production builds)
if (import.meta.env.DEV) (window as unknown as { __latticeStore?: typeof store }).__latticeStore = store;

const NARROW = 760;   // below this the left column is a drawer over the canvas
const MEDIUM = 1080;  // below this the detail panel is a little narrower
const LEFT_W = 276;

export function GraphView() {
  const bootState = useG((s) => s.boot);
  const bootError = useG((s) => s.bootError);
  const stats = useG((s) => s.stats);
  const selectedId = useG((s) => s.selectedId);
  const offline = useG((s) => s.offline);
  const noSeeds = useG((s) => s.noSeeds);
  const nodeCount = useG((s) => s.graph.nodes.length);
  const loading = useG((s) => s.graphLoading);
  const conn = useStore((s) => s.conn);
  const root = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);
  const [leftOpen, setLeftOpen] = useState(true);

  useEffect(() => { void boot(); return startLive(); }, []);
  useEffect(() => { if (conn === 'online' && (bootState === 'error' || offline)) { resetOffline(); void boot(); } }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ro = new ResizeObserver((es) => setW(es[0]?.contentRect.width ?? 1000));
    ro.observe(root.current!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (document.querySelector('.scrim')) return;
      select(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const narrow = w < NARROW;
  const compact = w < MEDIUM;
  const empty = bootState === 'ready' && stats !== null && stats.nodes === 0;
  const detailOpen = !!selectedId;
  const leftShown = !empty && bootState === 'ready' && leftOpen && !(narrow && detailOpen);
  const detailW = narrow ? Math.max(260, Math.min(340, w - 60)) : compact ? 340 : 372;
  const toggleLeft = () => { if (narrow && detailOpen) { select(null); setLeftOpen(true); } else setLeftOpen((v) => !v); };

  let content: React.ReactNode;
  if (bootState === 'loading' && !stats) content = <LoadingState />;
  else if (bootState === 'error' && !stats) content = <ErrorState message={bootError} offline={conn === 'offline' || bootError === 'Cannot reach Legion core'} />;
  else if (empty) content = <EmptyState />;
  else content = (
    <>
      {leftShown && <div className={`lt-left-slot${narrow ? ' overlay' : ''}`} style={{ width: LEFT_W }}><LeftColumn /></div>}
      <div className="lt-stage">
        <CanvasPane insetLeft={narrow && leftShown ? LEFT_W : 0} insetRight={detailOpen ? detailW : 0} leftOpen={leftShown} onToggleLeft={toggleLeft} />
        {(conn === 'offline' || offline) && (
          <div className="lt-offline" role="alert" style={{ right: detailOpen ? detailW + 10 : 10, left: (narrow && leftShown ? LEFT_W : 0) + 190 }}>
            <GIcon name="alert" size={14} /> Cannot reach Legion core. Showing what was loaded; it will refresh when the connection returns.
          </div>
        )}
        {nodeCount === 0 && !loading && (
          <div className="lt-hollow">
            <b>{noSeeds ? 'Nothing to start from yet' : 'The canvas is empty'}</b>
            <span>{stats?.nodes.toLocaleString()} notes are in the Lattice. Search for a word from a title, tag or body to load that part of the graph.</span>
          </div>
        )}
        {detailOpen && <DetailPanel width={detailW} />}
      </div>
    </>
  );
  return (
    <section className={`lt${narrow ? ' narrow' : ''}`} ref={root} aria-label="Lattice, the knowledge graph">
      {content}
      <DialogHost />
    </section>
  );
}

function LoadingState() {
  return (
    <div className="lt-state" role="status" aria-busy="true">
      <div className="lt-state-card"><i className="lt-spin big" /><b>Reading the Lattice</b><span>Fetching the graph from Legion core.</span></div>
    </div>
  );
}

function ErrorState({ message, offline }: { message: string | null; offline: boolean }) {
  return (
    <div className="lt-state" role="alert">
      <div className="lt-state-card">
        <span className="lt-state-ic bad"><GIcon name="alert" size={22} /></span>
        <b>{offline ? 'Legion core is not reachable' : 'The Lattice did not load'}</b>
        <span>{offline ? 'The knowledge graph lives in the core process. This view retries on its own when the connection returns.' : message}</span>
        <button className="btn primary" onClick={() => void boot()}>Try again</button>
      </div>
    </div>
  );
}

function EmptyState() {
  const bsv = useG((s) => s.bsv);
  const bsvMsg = useG((s) => s.bsvMsg);
  return (
    <div className="lt-state">
      <div className="lt-state-card wide">
        <svg className="lt-constellation" viewBox="0 0 220 120" aria-hidden="true">
          <g stroke="var(--line-strong)" strokeWidth="1.4" fill="none">
            <path d="M30 78 L74 40 L128 62 L176 30" /><path d="M74 40 L96 98 L128 62" /><path d="M128 62 L186 92" /><path d="M96 98 L30 78" />
          </g>
          <g strokeWidth="1.4">
            <circle cx="30" cy="78" r="6" fill="var(--surface-3)" stroke="var(--line-strong)" />
            <circle cx="74" cy="40" r="9" fill="#B79CFF" opacity=".9" />
            <circle cx="128" cy="62" r="11" fill="#4FD1C5" opacity=".9" />
            <circle cx="176" cy="30" r="7" fill="#F2D16B" opacity=".9" />
            <circle cx="96" cy="98" r="7" fill="#FF9F6B" opacity=".9" />
            <circle cx="186" cy="92" r="6" fill="#6BB6FF" opacity=".9" />
            <circle cx="128" cy="62" r="16" fill="none" stroke="var(--accent)" opacity=".7" />
          </g>
        </svg>
        <h2>The Lattice is empty</h2>
        <p>The Lattice is the shared knowledge graph your bots read and write: durable facts, decisions and lessons, each linked to what it relates to. Bots look here before they ask you for context, and add what they learn with a source.</p>
        <p className="lt-state-sub">Everything in it is data, never instructions. Import notes you already keep, or write the first one yourself.</p>
        <div className="lt-state-actions">
          <button className="btn primary" onClick={() => openDialog({ kind: 'import' })}><GIcon name="import" size={14} /> Import a vault</button>
          <button className="btn" onClick={() => openDialog({ kind: 'node', id: null })}><GIcon name="plus" size={14} /> Write the first note</button>
          <button className="btn" onClick={() => void seedBsv()} disabled={bsv === 'off'} title={bsv === 'off' ? bsvMsg || 'BSV mode is off.' : 'Load the bundled BSV Dev Kit lessons (needs BSV mode)'}><GIcon name="shield" size={14} /> Load BSV knowledge pack</button>
        </div>
        <p className="lt-state-foot">A vault is any folder of Markdown files, such as an Obsidian vault. Legion only reads it.</p>
      </div>
    </div>
  );
}
