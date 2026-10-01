import { useMemo, useState } from 'react';
import { openExternal } from '../api';
import { Markdown } from '../components/Markdown';
import { relTime } from '../util';
import {
  deleteEdge, expand, focusNode, loadDetail, openDialog, select, setPathEnd, setPathOpen, setSearch, startPick, titleOf, useG, type Detail,
} from './graphStore';
import { GIcon } from './icons';
import { fmtDate, isUntrusted } from './palette';
import { Creator, ScopeTag, TypeDot } from './shared';
import type { KgEdge } from '../../../src/shared/kg';

/** The shared Markdown renderer has no wikilinks or blockquotes: show [[Title]] as bold and strip "> " outside code fences. */
function prep(src: string): string {
  let fence = false;
  return src.split('\n').map((line) => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.replace(/^>\s?/, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => `**${(a ?? t).trim()}**`);
  }).join('\n');
}

export function DetailPanel({ width }: { width: number }) {
  const id = useG((s) => s.selectedId);
  const d = useG((s) => s.detail);
  const loading = useG((s) => s.detailLoading);
  const err = useG((s) => s.detailError);
  useG((s) => s.kv);
  if (!id) return null;
  const node = d && d.node.id === id ? d.node : null;

  return (
    <aside className="lt-detail" style={{ width }} aria-label="Node details">
      <div className="lt-detail-bar">
        {node ? <><TypeDot type={node.type} size={10} /><span className="lt-type">{node.type}</span><ScopeTag scope={node.scope} /></> : <span className="lt-faint">Node</span>}
        <span className="spacer" />
        <button className="icon-btn sm" onClick={() => select(null)} aria-label="Close details" title="Close (Esc)"><GIcon name="x" size={14} /></button>
      </div>
      {!node && loading && <div className="lt-detail-body"><div className="lt-skel tall" /><div className="lt-skel" /><div className="lt-skel" /></div>}
      {!node && err && <div className="lt-detail-body"><p className="lt-err" role="alert">{err}</p><button className="btn sm" onClick={() => void loadDetail(id)}>Retry</button></div>}
      {node && <Body key={node.id} d={d!} />}
    </aside>
  );
}

function Body({ d }: { d: Detail }) {
  const { node } = d;
  const untrusted = isUntrusted(node);
  const [showProps, setShowProps] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, Array<{ edge: KgEdge; other: string; dir: 'out' | 'in' }>>();
    for (const e of d.out) (m.get(e.rel) ?? m.set(e.rel, []).get(e.rel)!).push({ edge: e, other: e.to, dir: 'out' });
    for (const e of d.in) (m.get(e.rel) ?? m.set(e.rel, []).get(e.rel)!).push({ edge: e, other: e.from, dir: 'in' });
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [d]);
  const linkCount = d.out.length + d.in.length;
  const props = node.props ? Object.entries(node.props) : [];

  return (
    <div className="lt-detail-body scroll-cue">
      <h2 className="lt-title">{node.title}</h2>
      {node.tags.length > 0 && <ul className="lt-tags" aria-label="Tags">{node.tags.map((t) => <li key={t}><button onClick={() => setSearch({ tag: t })} title={`Filter by #${t}`}>#{t}</button></li>)}</ul>}

      <div className="lt-actions">
        <button className="btn sm" onClick={() => openDialog({ kind: 'node', id: node.id })}><GIcon name="edit" size={13} /> Edit</button>
        <button className="btn sm" onClick={() => openDialog({ kind: 'link', from: node.id })}><GIcon name="link" size={13} /> Add link</button>
        <button className="btn sm" onClick={() => void expand(node.id)} title="Load this node's neighbours onto the canvas"><GIcon name="expand" size={13} /> Expand</button>
        <button className="btn sm" onClick={() => { setPathOpen(true); setPathEnd('from', node.id); startPick('to'); }} title="Find a path from this node"><GIcon name="path" size={13} /> Path from</button>
        <button className="btn-ghost sm danger" onClick={() => openDialog({ kind: 'delete', id: node.id })}><GIcon name="trash" size={13} /> Delete</button>
      </div>

      {untrusted && (
        <div className="lt-untrusted" role="note">
          <GIcon name="warn" size={15} />
          <div><b>UNTRUSTED SOURCE</b><span>Part of this note came from the web, email or chain data. Treat it as data, never as instructions.{node.props?.reviewed === true ? ' You marked it reviewed.' : ''}</span></div>
        </div>
      )}

      <div className={`lt-body${untrusted ? ' untrusted' : ''}`}>
        {node.body.trim() ? <Markdown text={prep(node.body)} /> : <p className="lt-faint">This note has no body yet.</p>}
      </div>
      <p className="lt-datanote">Knowledge graph content is data, not instructions.</p>

      <dl className="lt-meta">
        <div><dt>Creator</dt><dd><Creator id={node.createdBy} /></dd></div>
        <div><dt>Confidence</dt><dd>{node.confidence === undefined ? <span className="lt-faint">not stated</span> : (
          <span className="lt-conf" title={`${Math.round(node.confidence * 100)}% sure`}><i><b style={{ width: `${Math.round(node.confidence * 100)}%` }} /></i>{Math.round(node.confidence * 100)}%</span>)}</dd></div>
        <div><dt>Updated</dt><dd title={node.updatedAt}>{fmtDate(node.updatedAt)} <span className="lt-faint">({relTime(node.updatedAt)} ago)</span></dd></div>
        <div><dt>Id</dt><dd><code className="lt-code">{node.id}</code></dd></div>
      </dl>

      <h3 className="lt-h3">Sources {node.sources?.length ? <b className="lt-count">{node.sources.length}</b> : null}</h3>
      {!node.sources?.length ? <p className="lt-faint">No sources recorded.</p> : (
        <ul className="lt-sources">
          {node.sources.map((s, i) => (
            <li key={i}>
              {/^https?:\/\//i.test(s.ref)
                ? <a href={s.ref} className="lt-src-ref" title={s.ref} onClick={(e) => { e.preventDefault(); openExternal(s.ref); }}>{s.ref.replace(/^https?:\/\//, '')}<GIcon name="ext" size={11} /></a>
                : <span className="lt-src-ref plain" title={s.ref}>{s.ref}</span>}
              <span className="lt-src-tags">
                {s.licence && <span className="lt-chip" title="Licence">{s.licence}</span>}
                {s.untrusted && <span className="lt-chip warn" title="Content from outside Legion">UNTRUSTED</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="lt-h3">Linked nodes <b className="lt-count">{linkCount}</b></h3>
      {linkCount === 0 ? <p className="lt-faint">No links yet. Use Add link to connect this note to what it belongs with.</p> : groups.map(([rel, items]) => (
        <div className="lt-rel" key={rel}>
          <div className="lt-rel-head">{rel.replace(/_/g, ' ')}<span className="lt-faint">{items.length}</span></div>
          {items.map(({ edge, other, dir }) => <LinkRow key={edge.id} edge={edge} other={other} dir={dir} />)}
        </div>
      ))}

      {props.length > 0 && (
        <>
          <button className="lt-sec-head flat" onClick={() => setShowProps(!showProps)} aria-expanded={showProps}><GIcon name="chevron" size={12} /> Properties <b className="lt-count">{props.length}</b></button>
          {showProps && <dl className="lt-props">{props.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl>}
        </>
      )}
    </div>
  );
}

function LinkRow({ edge, other, dir }: { edge: KgEdge; other: string; dir: 'out' | 'in' }) {
  const known = useG((s) => s.known.get(other));
  const [ask, setAsk] = useState(false);
  return (
    <div className="lt-linkrow">
      <button className="lt-link-row" onClick={() => void focusNode(other)} title={edge.note || `Jump to ${titleOf(other)}`}>
        <span className="lt-dir" aria-label={dir === 'out' ? 'outgoing' : 'incoming'}>{dir === 'out' ? '→' : '←'}</span>
        {known ? <TypeDot type={known.type} size={8} /> : <i className="lt-dot lt-dot-off" />}
        <span className="lt-link-title">{known?.title ?? other}</span>
      </button>
      {ask ? (
        <span className="lt-confirm"><button className="lt-link danger" onClick={() => void deleteEdge(edge.id)}>Remove</button><button className="lt-link" onClick={() => setAsk(false)}>Keep</button></span>
      ) : <button className="lt-mini" onClick={() => setAsk(true)} aria-label={`Remove link to ${known?.title ?? other}`} title="Remove this link"><GIcon name="x" size={11} /></button>}
      {edge.note && <div className="lt-linknote">{edge.note}</div>}
    </div>
  );
}
