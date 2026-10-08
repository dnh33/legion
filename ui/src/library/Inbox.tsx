import { useEffect, useMemo, useRef, useState } from 'react';
import type { KgInboxRow } from '../../../src/shared/kg';
import { KG_LIMITS } from '../../../src/shared/kg';
import { agentCounts, inboxKindLabel, parseTags, planBulk, previewText, skipNote } from '../../../src/shared/kg-library';
import { GIcon } from '../graph/icons';
import { resolveTitles, titleOf, useG } from '../graph/graphStore';
import { fmtDate, scopeLabel } from '../graph/palette';
import { Creator, TypeDot, useAgentNames } from '../graph/shared';
import { ago } from '../util';
import { NodeTrustBadge, StatusBadge, TaintBadge } from './Badges';
import { EditDiff } from './Diff';
import {
  acceptOne, acceptSelected, dismissFlash, loadInbox, rejectOne, setAgent, setIncludeUntrusted, setSel, toggleSel, useL,
} from './libraryStore';

export function Inbox() {
  const rows = useL((s) => s.inbox);
  const state = useL((s) => s.inboxState);
  const error = useL((s) => s.inboxError);
  const agent = useL((s) => s.agent);
  const sel = useL((s) => s.sel);
  const include = useL((s) => s.includeUntrusted);
  const bulkBusy = useL((s) => s.bulkBusy);
  const flash = useL((s) => s.flash);
  const names = useAgentNames();

  const visible = useMemo(() => (rows ?? []).filter((r) => !agent || r.agentId === agent), [rows, agent]);
  const plan = useMemo(() => planBulk(rows ?? [], sel, include), [rows, sel, include]);
  const agents = useMemo(() => agentCounts(rows ?? []), [rows]);
  const allSelected = visible.length > 0 && visible.every((r) => sel.has(r.id));
  const someSelected = !allSelected && visible.some((r) => sel.has(r.id));
  const allBox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (allBox.current) allBox.current.indeterminate = someSelected; }, [someSelected, rows === null]);

  if (rows === null && state !== 'error') return <div className="lib-pane" role="status" aria-busy="true"><div className="lib-skels"><i /><i /><i /></div></div>;
  if (rows === null) {
    return (
      <div className="lib-pane"><div className="lib-empty" role="alert">
        <span className="lib-empty-ic bad"><GIcon name="alert" size={22} /></span>
        <b>The inbox did not load</b><span>{error}</span>
        <button className="btn primary" onClick={() => void loadInbox()}>Try again</button>
      </div></div>
    );
  }

  return (
    <div className="lib-pane">
      <div className="lib-head">
      {rows.length > 0 && (
        <div className="lib-tools" role="toolbar" aria-label="Inbox actions">
          <label className="lib-check all">
            <input ref={allBox} type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? [] : visible.map((r) => r.id))} aria-label="Select all shown" />
            <span>{sel.size ? `${sel.size} selected` : 'Select all'}</span>
          </label>
          <label className="lib-sel">
            <span className="lt-sr">Filter by bot</span>
            <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Filter by bot">
              <option value="">All bots ({rows.length})</option>
              {agents.map((a) => <option key={a.agentId} value={a.agentId}>{names(a.agentId) ?? a.agentId} ({a.count})</option>)}
            </select>
          </label>
          <span className="spacer" />
          {plan.untrusted > 0 && (
            <label className="lib-check warn" title="Notes with an untrusted source may carry text a web page wrote. Read them first.">
              <input type="checkbox" checked={include} onChange={(e) => setIncludeUntrusted(e.target.checked)} />
              <span>Include {plan.untrusted} untrusted</span>
            </label>
          )}
          <button className="btn sm primary" disabled={bulkBusy || plan.accept.length === 0} onClick={() => void acceptSelected()}
            title={sel.size === 0 ? 'Tick rows to accept several at once' : plan.skip.length ? 'Rows with an untrusted source are skipped unless you tick "Include untrusted". Trigger notes, edits of your own notes and rows from a bot another bot woke are always reviewed one by one.' : undefined}>
            {bulkBusy ? 'Accepting' : `Accept ${plan.accept.length || ''}`.trim()}
          </button>
          {plan.skip.length > 0 && <span className="lib-skipnote" role="status">{skipNote(plan.skip)}</span>}
        </div>
      )}

      {flash && (
        <div className={`lib-flash ${flash.kind}`} role={flash.kind === 'error' ? 'alert' : 'status'}>
          <div>
            <b>{flash.text}</b>
            {flash.detail && flash.detail.length > 0 && <ul>{flash.detail.slice(0, 6).map((d, i) => <li key={i}>{d}</li>)}{flash.detail.length > 6 && <li>and {flash.detail.length - 6} more</li>}</ul>}
          </div>
          <button className="lt-x" onClick={dismissFlash} aria-label="Dismiss message"><GIcon name="x" size={13} /></button>
        </div>
      )}
      {state === 'error' && error && (
        <div className="lib-flash error" role="alert"><div><b>Could not refresh the inbox.</b> {error} The list below may be out of date.</div><button className="btn sm" onClick={() => void loadInbox()}>Retry</button></div>
      )}
      </div>

      {rows.length === 0 ? (
        <div className="lib-empty">
          <span className="lib-empty-ic"><GIcon name="check" size={22} /></span>
          <b>Nothing waiting</b>
          <span>Bots save straight to the Library. Only what a bot picked up from the web, a shell or an outside tool, or an edit to one of your own notes, stops here for you.</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="lib-empty"><b>Nothing from this bot</b><button className="btn sm" onClick={() => setAgent('')}>Show all bots</button></div>
      ) : (
        <ul className="lib-list" aria-label="Notes waiting for review">
          {visible.map((r) => <li key={r.id}><Row row={r} /></li>)}
        </ul>
      )}
    </div>
  );
}

function Row({ row }: { row: KgInboxRow }) {
  const { node } = row;
  const selected = useL((s) => s.sel.has(row.id));
  const busy = useL((s) => s.busy.has(row.id));
  const err = useL((s) => s.rowErr[row.id]);
  const names = useAgentNames();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const isProposal = row.kind === 'supersede' || row.kind === 'sweep' || row.kind === 'merge';
  useG((s) => s.kv);

  const ids = isProposal ? [node.props?.oldId, node.props?.newId, node.props?.keep, ...String(node.props?.drop ?? '').split(','), ...String(node.props?.oldIds ?? '').split(','), ...String(node.props?.newIds ?? '').split(',')].filter((x): x is string => typeof x === 'string' && !!x) : [];
  const idKey = ids.join(',');
  useEffect(() => { if (ids.length) void resolveTitles(ids); }, [idKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = (id: unknown) => `“${titleOf(String(id))}”`;
  const headline = row.kind === 'supersede' ? `Replace ${q(node.props?.oldId)} with ${q(node.props?.newId)}`
    : row.kind === 'sweep' ? `Retire ${plural(String(node.props?.oldIds ?? '').split(',').filter(Boolean).length, 'note')}`
    : row.kind === 'merge' ? `Merge ${plural(String(node.props?.drop ?? '').split(',').filter(Boolean).length, 'note')} into ${q(node.props?.keep)}`
    : node.title;
  const body = node.body;
  const long = body.length > 260 || body.split('\n').length > 4;
  const via = node.origin?.via;

  return (
    <article className={`lib-row${row.untrusted ? ' untrusted' : ''}${selected ? ' sel' : ''}${busy ? ' busy' : ''}`} aria-busy={busy} aria-label={`${inboxKindLabel(row.kind)}: ${headline}`}>
      <label className="lib-row-check"><input type="checkbox" checked={selected} onChange={() => toggleSel(row.id)} disabled={busy} aria-label={`Select ${headline}`} /></label>
      <div className="lib-row-main">
        <header className="lib-row-head">
          <TypeDot type={node.type} size={10} />
          <h3 className="lib-row-title">{headline}</h3>
          <span className="lib-row-badges">
            <StatusBadge status="pending" />
            <span className="lib-badge kind">{inboxKindLabel(row.kind)}</span>
            <NodeTrustBadge node={node} />
            {row.tainted && <TaintBadge />}
            {row.untrusted && !row.tainted && <span className="lib-badge srcwarn" title="A source of this note is marked untrusted. Bulk accept skips it.">Untrusted source</span>}
          </span>
        </header>
        <div className="lib-row-meta">
          <Creator id={row.agentId} size={18} />
          <span>{node.type}</span>
          <span>{scopeLabel(node.scope, names)}</span>
          {node.origin?.taskId && <span title={`Task ${node.origin.taskId}`}>task <code>{node.origin.taskId.slice(-8)}</code></span>}
          {via && <span>woken by {names(via) ?? via}</span>}
          <span title={fmtDate(row.createdAt)}>{ago(row.createdAt)}</span>
        </div>

        {editing ? (
          <EditForm row={row} onDone={() => setEditing(false)} />
        ) : (
          <>
            {row.kind === 'edit' && row.target ? <EditDiff before={row.target} after={node} /> : (
              body.trim() ? (
                <div className="lib-body-wrap">
                  <p className={`lib-body${open ? ' open' : ''}`}>{open ? body : previewText(body, 260)}</p>
                  {long && <button className="lt-link" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show all'}</button>}
                </div>
              ) : <p className="lib-faint">No body.</p>
            )}
            {node.tags.length > 0 && row.kind !== 'edit' && <ul className="lt-tags lib-tags" aria-label="Tags">{node.tags.map((t) => <li key={t}><span>#{t}</span></li>)}</ul>}
            {node.sources && node.sources.length > 0 && (
              <ul className="lib-sources" aria-label="Sources">
                {node.sources.map((s, i) => (
                  <li key={i}><span className="lib-src" title={s.ref}>{s.ref}</span>{s.untrusted && <span className="lib-badge srcwarn">Untrusted</span>}</li>
                ))}
              </ul>
            )}
            {err && <p className="lib-rowerr" role="alert"><GIcon name="alert" size={13} /> {err}</p>}
            <div className="lib-actions">
              <button className="btn sm primary" disabled={busy} onClick={() => void acceptOne(row)}>Accept</button>
              {!isProposal && <button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>Edit then accept</button>}
              <button className="btn sm danger-o" disabled={busy} onClick={() => void rejectOne(row)}>Reject</button>
              {busy && <span className="lt-spin" role="status" aria-label="Working" />}
              <span className="lib-hint">{acceptHint(row)}</span>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function acceptHint(row: KgInboxRow): string {
  if (row.kind === 'supersede') return 'Accepting retires the old note and keeps it, marked superseded.';
  if (row.kind === 'sweep') return 'Accepting retires every note in the batch and keeps them, marked superseded.';
  if (row.kind === 'merge') return 'Accepting archives the duplicates and moves their links.';
  if (row.kind === 'edit') return 'Accepting replaces the note it edits; the old text stays, marked superseded.';
  if (row.tainted) return 'Accept keeps it at agent trust. Edit then accept makes it yours.';
  return 'Accepting makes it a note you stand behind.';
}

function EditForm({ row, onDone }: { row: KgInboxRow; onDone: () => void }) {
  const { node } = row;
  const busy = useL((s) => s.busy.has(row.id));
  const err = useL((s) => s.rowErr[row.id]);
  const [title, setTitle] = useState(node.title);
  const [body, setBody] = useState(node.body);
  const [tags, setTags] = useState(node.tags.join(', '));
  const submit = async () => { if (title.trim() && (await acceptOne(row, { title, body, tags: parseTags(tags) }))) onDone(); };
  return (
    <form className="lib-edit" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label>Title<input data-autofocus value={title} maxLength={KG_LIMITS.titleChars} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Tags<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated" /></label>
      <label>Body
        <textarea rows={8} value={body} maxLength={KG_LIMITS.bodyChars} onChange={(e) => setBody(e.target.value)} />
        <span className="lib-faint">{body.length.toLocaleString()} / {KG_LIMITS.bodyChars.toLocaleString()}</span>
      </label>
      {err && <p className="lib-rowerr" role="alert"><GIcon name="alert" size={13} /> {err}</p>}
      <div className="lib-actions">
        <button className="btn sm primary" type="submit" disabled={busy || !title.trim()}>{busy ? 'Accepting' : 'Accept with my edits'}</button>
        <button className="btn sm" type="button" disabled={busy} onClick={onDone}>Cancel</button>
        <span className="lib-hint">Editing marks the note as written by you (human trust){row.tainted ? ' and clears the taint' : ''}. Change nothing and it stays a plain accept.</span>
      </div>
    </form>
  );
}
