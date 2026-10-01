import { useEffect, useMemo, useRef, useState } from 'react';
import { platform, request } from '../api';
import { Modal } from '../components/Modal';
import { useStore } from '../store';
import type { KgNodeType, KgSearchHit, KgSource } from '../../../src/shared/kg';
import { KG_LIMITS, KG_RELS } from '../../../src/shared/kg';
import {
  addLink, closeDialog, deleteNode, exportVault, importVault, saveNode, titleOf, useG,
  type ExportReport, type ImportReport,
} from './graphStore';
import { GIcon } from './icons';
import { NODE_TYPES } from './palette';
import { TypeDot } from './shared';

export function DialogHost() {
  const d = useG((s) => s.dialog);
  useEffect(() => {
    if (!d) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [d]);
  if (!d) return null;
  switch (d.kind) {
    case 'node': return <NodeDialog key={d.id ?? 'new'} id={d.id} />;
    case 'link': return <LinkDialog from={d.from} />;
    case 'delete': return <DeleteDialog id={d.id} />;
    case 'import': return <ImportDialog />;
    case 'export': return <ExportDialog />;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dirHint = platform === 'win32' ? 'C:\\Users\\you\\Documents\\Vault' : '/home/you/Documents/Vault';

/* ---------- create / edit a note ---------- */
function NodeDialog({ id }: { id: string | null }) {
  const agents = useStore((s) => s.agents);
  const existing = useG((s) => (id ? (s.detail?.node.id === id ? s.detail.node : s.graph.nodes.find((n) => n.id === id)) ?? null : null));
  const [title, setTitle] = useState(existing?.title ?? '');
  const [type, setType] = useState<KgNodeType>(existing?.type ?? 'note');
  const [scope, setScope] = useState<string>(existing?.scope ?? 'shared');
  const [tags, setTags] = useState((existing?.tags ?? []).join(', '));
  const [body, setBody] = useState(existing?.body ?? '');
  const [sources, setSources] = useState<KgSource[]>(existing?.sources?.map((x) => ({ ...x })) ?? []);
  const [conf, setConf] = useState<number | undefined>(existing?.confidence);
  const [reviewed, setReviewed] = useState(existing?.props?.reviewed === true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const anyUntrusted = sources.some((x) => x.untrusted);
  const scopes = useMemo(() => {
    const o = [{ v: 'shared', l: 'Shared (every bot can read it)' }, ...agents.map((a) => ({ v: `agent:${a.id}`, l: `Private to ${a.name}` }))];
    if (existing?.scope === 'bsv') o.push({ v: 'bsv', l: 'BSV pack' });
    return o;
  }, [agents, existing]);

  const submit = async () => {
    if (!title.trim()) { setErr('A note needs a title.'); return; }
    setBusy(true); setErr('');
    try {
      await saveNode({
        id: id ?? undefined, title, type, body, scope, sources, confidence: conf, reviewed: anyUntrusted && reviewed,
        tags: [...new Set(tags.split(/[,\n]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean))],
      });
      closeDialog();
    } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  const upd = (i: number, p: Partial<KgSource>) => setSources((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Modal title={id ? 'Edit note' : 'New note'} width={620} onClose={closeDialog}
      footer={<>
        {err && <span className="err-s lt-foot-err" role="alert" style={{ margin: 0 }}>{err}</span>}
        <span className="spacer" />
        <button className="btn" onClick={closeDialog}>Cancel</button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy || !title.trim()}>{busy ? 'Saving' : id ? 'Save' : 'Create note'}</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>Title<input data-autofocus value={title} maxLength={KG_LIMITS.titleChars} onChange={(e) => setTitle(e.target.value)} placeholder="A short, findable name" /></label>
        <div className="row">
          <label className="grow">Type<select value={type} onChange={(e) => setType(e.target.value as KgNodeType)}>{NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          <label className="grow">Scope<select value={scope} onChange={(e) => setScope(e.target.value)}>{scopes.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></label>
        </div>
        <label>Tags<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated" /></label>
        <label>Body (Markdown)
          <textarea rows={9} value={body} maxLength={KG_LIMITS.bodyChars} onChange={(e) => setBody(e.target.value)} placeholder={'Durable facts, decisions and lessons. Use [[Other title]] to mention another note.'} />
          <span className="field-note">{body.length.toLocaleString()} / {KG_LIMITS.bodyChars.toLocaleString()}</span>
        </label>
        <fieldset>
          <legend>Sources</legend>
          {sources.length === 0 && <span className="field-note">Add a source for anything taken from the web or a file.</span>}
          {sources.map((s, i) => (
            <div className="lt-src-edit" key={i}>
              <input value={s.ref} onChange={(e) => upd(i, { ref: e.target.value })} placeholder="URL, path or free text" aria-label={`Source ${i + 1}`} />
              <input value={s.licence ?? ''} onChange={(e) => upd(i, { licence: e.target.value })} placeholder="Licence" aria-label={`Licence ${i + 1}`} className="lic" />
              <label className="check-row"><input type="checkbox" checked={!!s.untrusted} onChange={(e) => upd(i, { untrusted: e.target.checked })} /> untrusted</label>
              <button type="button" className="icon-btn sm" onClick={() => setSources((xs) => xs.filter((_, j) => j !== i))} aria-label={`Remove source ${i + 1}`}><GIcon name="x" size={13} /></button>
            </div>
          ))}
          <div><button type="button" className="btn sm" onClick={() => setSources((xs) => [...xs, { ref: '' }])}><GIcon name="plus" size={12} /> Add source</button></div>
          {anyUntrusted && <label className="check-row"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I have read this and it is safe to keep (clears the lint warning)</label>}
        </fieldset>
        <label className="check-row lt-conf-edit">
          <input type="checkbox" checked={conf !== undefined} onChange={(e) => setConf(e.target.checked ? 0.7 : undefined)} /> Confidence
          <input type="range" min={0} max={1} step={0.05} disabled={conf === undefined} value={conf ?? 0.7} onChange={(e) => setConf(Number(e.target.value))} aria-label="Confidence" />
          <span className="lt-faint">{conf === undefined ? 'not stated' : `${Math.round(conf * 100)}%`}</span>
        </label>
      </form>
    </Modal>
  );
}

/* ---------- add link ---------- */
function LinkDialog({ from }: { from: string }) {
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [rel, setRel] = useState('relates');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<KgSearchHit[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    const my = ++seq.current;
    const t = window.setTimeout(() => {
      request<KgSearchHit[]>('GET', `/api/kg/search?q=${encodeURIComponent(q.trim())}&limit=8`).then((h) => { if (my === seq.current) setHits(h.filter((x) => x.node.id !== from)); }).catch(() => {});
    }, 180);
    return () => window.clearTimeout(t);
  }, [q, from]);

  const submit = async () => {
    if (!target) return;
    setBusy(true); setErr('');
    try { await addLink(dir === 'out' ? from : target, dir === 'out' ? target : from, rel, note); closeDialog(); }
    catch (e) { setErr(errText(e)); setBusy(false); }
  };
  const a = <b className="lt-end">{titleOf(from)}</b>;
  const b = target ? <b className="lt-end">{titleOf(target)}</b> : <span className="lt-faint">pick a note below</span>;
  return (
    <Modal title="Add link" width={520} onClose={closeDialog}
      footer={<>
        {err && <span className="err-s" role="alert" style={{ margin: 0 }}>{err}</span>}
        <span className="spacer" />
        <button className="btn" onClick={closeDialog}>Cancel</button>
        <button className="btn primary" onClick={() => void submit()} disabled={!target || !rel.trim() || busy}>{busy ? 'Linking' : 'Add link'}</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="lt-sentence">{dir === 'out' ? <>{a} <i>{rel || '\u2026'}</i> {b}</> : <>{b} <i>{rel || '\u2026'}</i> {a}</>}</p>
        <div className="row">
          <label className="grow">Relation
            <input list="lt-rels" value={rel} onChange={(e) => setRel(e.target.value)} placeholder="relates" />
            <datalist id="lt-rels">{KG_RELS.map((r) => <option key={r} value={r} />)}</datalist>
          </label>
          <label className="grow">Direction
            <select value={dir} onChange={(e) => setDir(e.target.value as 'out' | 'in')}><option value="out">This note {'\u2192'} other</option><option value="in">Other {'\u2192'} this note</option></select>
          </label>
        </div>
        <label>Find the other note<input data-autofocus type="search" value={q} onChange={(e) => { setQ(e.target.value); setTarget(null); }} placeholder="Search by title, tag or text" /></label>
        {hits.length > 0 && (
          <ul className="lt-pick" role="listbox" aria-label="Matching notes">
            {hits.map((h) => (
              <li key={h.node.id}><button type="button" role="option" aria-selected={target === h.node.id} className={`lt-row${target === h.node.id ? ' sel' : ''}`} onClick={() => setTarget(h.node.id)}>
                <TypeDot type={h.node.type} /><span className="lt-row-main"><span className="lt-row-title">{h.node.title}</span><span className="lt-row-meta">{h.node.type} {'\u00b7'} {h.node.scope}</span></span>
              </button></li>
            ))}
          </ul>
        )}
        {q.trim() && hits.length === 0 && <span className="field-note">No matching notes.</span>}
        <label>Note (optional)<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Why these are linked" /></label>
      </form>
    </Modal>
  );
}

/* ---------- delete ---------- */
function DeleteDialog({ id }: { id: string }) {
  const node = useG((s) => (s.detail?.node.id === id ? s.detail.node : s.graph.nodes.find((n) => n.id === id)) ?? null);
  const links = useG((s) => (s.detail && s.detail.node.id === id ? s.detail.out.length + s.detail.in.length : null));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await deleteNode(id); closeDialog(); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <Modal title="Delete this note?" width={460} onClose={closeDialog}
      footer={<>
        {err && <span className="err-s" role="alert" style={{ margin: 0 }}>{err}</span>}
        <span className="spacer" />
        <button className="btn" data-autofocus onClick={closeDialog}>Keep it</button>
        <button className="btn danger" onClick={() => void go()} disabled={busy}>{busy ? 'Deleting' : 'Delete note'}</button>
      </>}>
      <p className="lt-confirm-text"><b>{node?.title ?? id}</b> will be removed{links ? <> together with its {links} link{links === 1 ? '' : 's'}</> : null}. Agents will no longer find it. This cannot be undone.</p>
    </Modal>
  );
}

/* ---------- import / export vault ---------- */
function ImportDialog() {
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rep, setRep] = useState<ImportReport | null>(null);
  const go = async () => {
    setBusy(true); setErr(''); setRep(null);
    try { setRep(await importVault(dir)); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <Modal title="Import a vault" width={560} onClose={closeDialog}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={closeDialog}>{rep ? 'Done' : 'Cancel'}</button>
        {!rep && <button className="btn primary" onClick={() => void go()} disabled={!dir.trim() || busy}>{busy ? 'Importing' : 'Import'}</button>}
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (!rep) void go(); }}>
        <label>Vault folder<input data-autofocus value={dir} onChange={(e) => setDir(e.target.value)} placeholder={dirHint} spellCheck={false} disabled={busy} /></label>
        <p className="field-note">An Obsidian or plain Markdown folder on the machine where Legion runs. Legion reads it and never changes it. Each <code>.md</code> file becomes a note, <code>[[wikilinks]]</code> become links, and a file imported twice is updated, not duplicated.</p>
        {err && <p className="err-s" role="alert">{err}</p>}
        {rep && (
          <div className="lt-report" role="status">
            <b>Imported {rep.files} file{rep.files === 1 ? '' : 's'}</b>
            <ul><li>{rep.created} created</li><li>{rep.updated} updated</li><li>{rep.unchanged} unchanged</li><li>{rep.edges} links</li>{rep.stubs > 0 && <li>{rep.stubs} stubs for unresolved titles</li>}</ul>
            {rep.skipped.length > 0 && <details><summary>{rep.skipped.length} skipped</summary><ul className="lt-skipped">{rep.skipped.slice(0, 50).map((s, i) => <li key={i}><code>{s.path}</code> {s.reason}</li>)}</ul></details>}
          </div>
        )}
      </form>
    </Modal>
  );
}

function ExportDialog() {
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rep, setRep] = useState<ExportReport | null>(null);
  const go = async () => {
    setBusy(true); setErr(''); setRep(null);
    try { setRep(await exportVault(dir)); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <Modal title="Export as a vault" width={560} onClose={closeDialog}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={closeDialog}>{rep ? 'Done' : 'Cancel'}</button>
        <button className="btn primary" onClick={() => void go()} disabled={!dir.trim() || busy}>{busy ? 'Exporting' : rep ? 'Export again' : 'Export'}</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label>Target folder<input data-autofocus value={dir} onChange={(e) => setDir(e.target.value)} placeholder={dirHint} spellCheck={false} disabled={busy} /></label>
        <p className="field-note">Legion writes one Markdown file per note on the machine where it runs, with frontmatter and a Links section, ready to open in Obsidian. Exporting again to the same folder updates the files in place.</p>
        {err && <p className="err-s" role="alert">{err}</p>}
        {rep && <div className="lt-report" role="status"><b>Wrote {rep.written} file{rep.written === 1 ? '' : 's'}</b><ul>{rep.removedStale > 0 && <li>{rep.removedStale} renamed note file{rep.removedStale === 1 ? '' : 's'} cleaned up</li>}<li><code>{rep.dir}</code></li></ul></div>}
      </form>
    </Modal>
  );
}
