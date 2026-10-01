import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useMatch } from './CanvasPane';
import {
  clearPath, findPath, focusNode, openDialog, resolveTitles, runSearch, seedBsv, setHover, setPathEnd, setPathOpen, setSearch, setTab,
  showHitsOnGraph, startPick, swapPath, titleOf, loadLint, useG,
} from './graphStore';
import { GIcon } from './icons';
import { NODE_TYPES } from './palette';
import { ScopeTag, TypeDot, useAgentNames } from './shared';


/** Snippets come from raw Markdown bodies: drop the syntax characters for a one-line preview. */
const plain = (t: string) => t.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();

export function LeftColumn() {
  const tab = useG((s) => s.tab);
  const lint = useG((s) => s.lint);
  const stats = useG((s) => s.stats);
  const bsv = useG((s) => s.bsv);
  const bsvMsg = useG((s) => s.bsvMsg);
  const bsvLoaded = (stats?.byScope.bsv ?? 0) > 0;
  const lintCount = lint ? lint.orphans.length + lint.danglingEdges.length + lint.duplicateTitles.length + lint.stale.length + lint.contradictions.length + lint.untrustedWithoutReview.length : 0;
  return (
    <aside className="lt-left" aria-label="Lattice search and tools">
      <div className="lt-tabs" role="tablist" aria-label="Lattice panels">
        <button role="tab" aria-selected={tab === 'explore'} className={`lt-tab${tab === 'explore' ? ' on' : ''}`} onClick={() => setTab('explore')}>Explore</button>
        <button role="tab" aria-selected={tab === 'lint'} className={`lt-tab${tab === 'lint' ? ' on' : ''}`} onClick={() => setTab('lint')}>
          Lint{lint && lintCount > 0 && <b className="lt-count">{lintCount}</b>}
        </button>
        <span className="spacer" />
        {stats && <span className="lt-totals" title="Nodes and links in the whole graph">{stats.nodes.toLocaleString()} nodes {'·'} {stats.edges.toLocaleString()} links</span>}
      </div>
      {tab === 'explore' ? <Explore /> : <LintPane />}
      <div className="lt-foot">
        <button className="btn sm" onClick={() => openDialog({ kind: 'node', id: null })}><GIcon name="plus" size={13} /> New note</button>
        <button className="btn sm" onClick={() => openDialog({ kind: 'import' })}><GIcon name="import" size={13} /> Import</button>
        <button className="btn sm" onClick={() => openDialog({ kind: 'export' })}><GIcon name="export" size={13} /> Export</button>
        {!bsvLoaded && (
          <button className="btn sm lt-bsv" onClick={() => void seedBsv()} disabled={bsv === 'off'}
            title={bsv === 'off' ? bsvMsg || 'BSV mode is off: turn on the BSV Dev Kit toggle first.' : 'Load the bundled BSV Dev Kit lessons (needs BSV mode)'}>
            <GIcon name="shield" size={13} /> BSV pack
          </button>
        )}
      </div>
    </aside>
  );
}

/* ---------------- explore ---------------- */
function Explore() {
  const q = useG((s) => s.q), scope = useG((s) => s.scope), type = useG((s) => s.type), tag = useG((s) => s.tag);
  const hits = useG((s) => s.hits), searching = useG((s) => s.searching), err = useG((s) => s.searchError);
  const graph = useG((s) => s.graph);
  const selectedId = useG((s) => s.selectedId);
  const picking = useG((s) => s.path.picking);
  const agents = useStore((s) => s.agents);
  const match = useMatch();
  const agentName = useAgentNames();

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph.edges) { d.set(e.from, (d.get(e.from) ?? 0) + 1); d.set(e.to, (d.get(e.to) ?? 0) + 1); }
    return d;
  }, [graph.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagOptions = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of graph.nodes) for (const t of n.tags) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
  }, [graph.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (hits) return hits.map((h) => ({ id: h.node.id, title: h.node.title, type: h.node.type, scope: h.node.scope, tags: h.node.tags, snippet: h.node.snippet }));
    return graph.nodes.filter((n) => !match || match(n))
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.title.localeCompare(b.title))
      .slice(0, 250).map((n) => ({ id: n.id, title: n.title, type: n.type, scope: n.scope, tags: n.tags, snippet: '' }));
  }, [hits, graph.rev, match, degree]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = !!(scope || type || tag.trim());

  return (
    <div className="lt-explore">
      <div className="lt-search">
        <GIcon name="search" size={14} />
        <input type="search" value={q} placeholder="Search the Lattice" aria-label="Search the knowledge graph"
          onChange={(e) => setSearch({ q: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); if (e.key === 'Escape' && q) { setSearch({ q: '' }); e.stopPropagation(); } }} />
        {searching && <i className="lt-spin" aria-label="Searching" />}
        {q && !searching && <button className="lt-x" onClick={() => setSearch({ q: '' })} aria-label="Clear search"><GIcon name="x" size={13} /></button>}
      </div>
      <div className="lt-filters">
        <select value={scope} onChange={(e) => setSearch({ scope: e.target.value })} aria-label="Filter by scope">
          <option value="">Any scope</option><option value="shared">Shared</option><option value="bsv">BSV pack</option>
          {agents.map((a) => <option key={a.id} value={`agent:${a.id}`}>Private {'·'} {a.name}</option>)}
        </select>
        <select value={type} onChange={(e) => setSearch({ type: e.target.value })} aria-label="Filter by type">
          <option value="">Any type</option>{NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input list="lt-tags" className="lt-tag-in" value={tag} placeholder="Tag" aria-label="Filter by tag" onChange={(e) => setSearch({ tag: e.target.value })} />
        <datalist id="lt-tags">{tagOptions.map((t) => <option key={t} value={t} />)}</datalist>
      </div>

      <div className="lt-list-head">
        <span id="lt-list-label">{hits ? `Results · ${hits.length}${hits.length === 30 ? '+' : ''}` : `On canvas · ${rows.length}${filtered ? ' matching' : ''}`}</span>
        {filtered && <button className="lt-link" onClick={() => setSearch({ scope: '', type: '', tag: '' })}>Clear filters</button>}
        {hits && hits.length > 0 && <button className="lt-link" onClick={showHitsOnGraph} title="Replace the canvas with these results and their neighbours">Show on graph</button>}
      </div>
      {err && <p className="lt-err" role="alert">{err} <button className="lt-link" onClick={() => void runSearch()}>Retry</button></p>}
      <ul className="lt-list scroll-cue" aria-labelledby="lt-list-label">
        {rows.map((r) => (
          <li key={r.id}>
            <button className={`lt-row${r.id === selectedId ? ' sel' : ''}`} aria-current={r.id === selectedId ? 'true' : undefined}
              onClick={() => void focusNode(r.id)} onMouseEnter={() => setHover(r.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(r.id)} onBlur={() => setHover(null)}
              title={picking ? `Set as ${picking === 'from' ? 'start' : 'end'} of the path` : undefined}>
              <TypeDot type={r.type} />
              <span className="lt-row-main">
                <span className="lt-row-title">{r.title}</span>
                <span className="lt-row-meta">{r.type}{' · '}{r.scope === 'shared' ? 'shared' : r.scope === 'bsv' ? 'bsv' : `private ${agentName(r.scope.replace('agent:', '')) ?? ''}`}{r.tags.length > 0 && <> {'·'} {r.tags.slice(0, 3).map((t) => `#${t}`).join(' ')}</>}</span>
                {r.snippet && <span className="lt-row-snip">{plain(r.snippet)}</span>}
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && !searching && !err && (
          <li className="lt-list-empty">
            {hits ? <>No matches for {'“'}{q}{'”'}.<br /><span className="lt-faint">Search matches words in titles, tags and bodies. Try fewer or simpler words.</span></>
              : filtered ? 'Nothing on the canvas matches these filters. Search to look beyond what is loaded.' : 'The canvas is empty. Search to load part of the graph.'}
          </li>
        )}
      </ul>
      <PathFinder />
    </div>
  );
}

/* ---------------- path finder ---------------- */
function PathFinder() {
  const p = useG((s) => s.path);
  const selectedId = useG((s) => s.selectedId);
  const slot = (which: 'from' | 'to') => {
    const id = p[which];
    return (
      <div className={`lt-slot${p.picking === which ? ' picking' : ''}`}>
        <span className="lt-slot-k">{which === 'from' ? 'From' : 'To'}</span>
        <span className="lt-slot-v">{id ? titleOf(id) : <span className="lt-faint">{p.picking === which ? 'click a node…' : 'not set'}</span>}</span>
        {selectedId && selectedId !== id && <button className="lt-link" onClick={() => setPathEnd(which, selectedId)} title="Use the selected node">use selected</button>}
        <button className={`lt-mini${p.picking === which ? ' on' : ''}`} onClick={() => startPick(p.picking === which ? null : which)} aria-pressed={p.picking === which} aria-label={`Pick ${which === 'from' ? 'start' : 'end'} node on the canvas or list`} title="Pick from canvas or list"><GIcon name="expand" size={13} /></button>
        {id && <button className="lt-mini" onClick={() => setPathEnd(which, null)} aria-label={`Clear ${which}`}><GIcon name="x" size={12} /></button>}
      </div>
    );
  };
  const r = p.result;
  return (
    <section className={`lt-path${p.open ? ' open' : ''}`}>
      <button className="lt-sec-head" onClick={() => setPathOpen(!p.open)} aria-expanded={p.open}>
        <GIcon name="chevron" size={12} /> <GIcon name="path" size={13} /> Path finder
        {!p.open && r?.found && <span className="lt-faint">{r.edges.length} hops</span>}
      </button>
      {p.open && (
        <div className="lt-path-body">
          {slot('from')}
          <div className="lt-swap"><button className="lt-mini" onClick={swapPath} aria-label="Swap start and end" title="Swap"><GIcon name="swap" size={13} /></button></div>
          {slot('to')}
          <div className="lt-path-actions">
            <button className="btn sm primary" disabled={!p.from || !p.to || p.loading} onClick={() => void findPath()}>{p.loading ? 'Searching' : 'Find path'}</button>
            {(p.from || p.to || r) && <button className="btn-ghost sm" onClick={clearPath}>Clear</button>}
          </div>
          {p.error && <p className="lt-err" role="alert">{p.error}</p>}
          {r && !r.found && <p className="lt-muted">No path within 6 hops. These nodes are not connected closely, if at all.</p>}
          {r?.found && (
            <ol className="lt-steps" aria-label="Path steps">
              {r.nodes.map((n, i) => (
                <li key={n.id + i}>
                  <button className="lt-link-row" onClick={() => void focusNode(n.id)}><TypeDot type={n.type} size={8} /> <span>{n.title}</span></button>
                  {r.edges[i] && <span className="lt-step-rel">{r.edges[i]!.rel.replace(/_/g, ' ')} {r.edges[i]!.from === n.id ? '↓' : '↑'}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- lint ---------------- */
function Row({ id, extra }: { id: string; extra?: string }) {
  const known = useG((s) => s.known.get(id));
  return (
    <button className="lt-lint-row" onClick={() => void focusNode(id)} title={`Jump to ${known?.title ?? id}`}>
      {known ? <TypeDot type={known.type} /> : <i className="lt-dot lt-dot-off" />}
      <span className="lt-row-title">{known?.title ?? id}</span>
      {extra && <span className="lt-faint lt-nowrap">{extra}</span>}
    </button>
  );
}
function Section({ title, hint, count, children, tone }: { title: string; hint: string; count: number; children: React.ReactNode; tone?: 'warn' | 'danger' }) {
  const [open, setOpen] = useState(true);
  if (!count) return null;
  return (
    <section className="lt-lint-sec">
      <button className="lt-sec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <GIcon name="chevron" size={12} /> {title} <b className={`lt-count${tone ? ' ' + tone : ''}`}>{count}</b>
      </button>
      {open && <><p className="lt-lint-hint">{hint}</p><div className="lt-lint-items">{children}</div></>}
    </section>
  );
}
function Capped<T>({ items, render, max = 40 }: { items: T[]; render: (t: T, i: number) => React.ReactNode; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, max);
  return <>{shown.map(render)}{items.length > max && !all && <button className="lt-link" onClick={() => { setAll(true); void resolveTitles((items as unknown as Array<string | { id: string }>).map((x) => (typeof x === 'string' ? x : x.id))); }}>Show all {items.length}</button>}</>;
}

function LintPane() {
  const lint = useG((s) => s.lint), loading = useG((s) => s.lintLoading), err = useG((s) => s.lintError);
  useG((s) => s.kv);
  if (!lint && loading) return <div className="lt-explore"><div className="lt-skel" /><div className="lt-skel" /><div className="lt-skel" /></div>;
  if (!lint) return <div className="lt-explore"><p className="lt-err" role="alert">{err ?? 'Lint has not run yet.'} <button className="lt-link" onClick={() => void loadLint()}>Retry</button></p></div>;
  const total = lint.orphans.length + lint.danglingEdges.length + lint.duplicateTitles.length + lint.stale.length + lint.contradictions.length + lint.untrustedWithoutReview.length;
  return (
    <div className="lt-explore lt-lint">
      <div className="lt-lint-head">
        <span>{lint.counts.nodes.toLocaleString()} nodes {'·'} {lint.counts.edges.toLocaleString()} links</span>
        <button className="btn-ghost sm" onClick={() => void loadLint()} disabled={loading}><GIcon name="relayout" size={12} /> {loading ? 'Checking' : 'Re-check'}</button>
      </div>
      {err && <p className="lt-err" role="alert">{err}</p>}
      <div className="lt-lint-scroll scroll-cue">
        {total === 0 && <div className="lt-allclear"><GIcon name="check" size={20} /><b>All clear</b><span className="lt-faint">No orphans, dangling links, duplicates, stale notes or contradictions.</span></div>}
        <Section title="Contradictions" tone="danger" count={lint.contradictions.length} hint="Two notes joined by a contradicts link. Decide which one holds, then supersede or fix the other.">
          <Capped items={lint.contradictions} render={(c, i) => (
            <div className="lt-pair" key={i}><Row id={c.a} /><span className="lt-vs"><GIcon name="bolt" size={12} /></span><Row id={c.b} /></div>)} />
        </Section>
        <Section title="Untrusted, not reviewed" tone="warn" count={lint.untrustedWithoutReview.length} hint="Content from the web, email or chain data. Read it, then open Edit and tick reviewed. It stays data, never instructions.">
          <Capped items={lint.untrustedWithoutReview} render={(id) => <Row key={id} id={id} />} />
        </Section>
        <Section title="Dangling links" tone="danger" count={lint.danglingEdges.length} hint="Links whose endpoint no longer exists. They are listed by link id; the core can drop them on compaction.">
          <Capped items={lint.danglingEdges} render={(id) => <div className="lt-lint-row static" key={id}><i className="lt-dot lt-dot-off" /><code className="lt-code">{id}</code></div>} />
        </Section>
        <Section title="Duplicate titles" count={lint.duplicateTitles.length} hint="Several notes share one title. Merge them or rename.">
          <Capped items={lint.duplicateTitles} render={(d) => (
            <div className="lt-dupe" key={d.title}><div className="lt-dupe-t">{d.title}</div>{d.ids.map((id) => <Row key={id} id={id} />)}</div>)} />
        </Section>
        <Section title="Orphans" count={lint.orphans.length} hint="No links in or out. Link them to what they belong to, or delete them.">
          <Capped items={lint.orphans} render={(id) => <Row key={id} id={id} />} />
        </Section>
        <Section title="Stale" count={lint.stale.length} hint="Not touched for over 90 days. Check they still hold.">
          <Capped items={lint.stale} render={(s) => <Row key={s.id} id={s.id} extra={`${s.daysOld} d`} />} />
        </Section>
      </div>
    </div>
  );
}
