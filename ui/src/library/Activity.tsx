import { useEffect, useMemo } from 'react';
import type { KgActivityRow } from '../../../src/shared/kg';
import { activityVerb, humanizeIds, idsIn, undoState } from '../../../src/shared/kg-library';
import { GIcon } from '../graph/icons';
import { focusNode, resolveTitles, titleOf, useG } from '../graph/graphStore';
import { fmtDate } from '../graph/palette';
import { Creator, TypeDot, useAgentNames } from '../graph/shared';
import { relTime } from '../util';
import { TaintBadge, TrustBadge } from './Badges';
import { loadActivity, setActAgent, setSub, undoEntry, useL } from './libraryStore';

export function Activity() {
  const rows = useL((s) => s.activity);
  const state = useL((s) => s.activityState);
  const error = useL((s) => s.activityError);
  const agent = useL((s) => s.actAgent);
  const names = useAgentNames();
  const who = useMemo(() => [...new Set((rows ?? []).map((r) => r.who))].sort(), [rows]);
  const visible = (rows ?? []).filter((r) => !agent || r.who === agent);
  const filterGone = agent && !who.includes(agent);

  if (rows === null && state !== 'error') return <div className="lib-pane" role="status" aria-busy="true"><div className="lib-skels"><i /><i /><i /></div></div>;
  if (rows === null) {
    return (
      <div className="lib-pane"><div className="lib-empty" role="alert">
        <span className="lib-empty-ic bad"><GIcon name="alert" size={22} /></span>
        <b>Activity did not load</b><span>{error}</span>
        <button className="btn primary" onClick={() => void loadActivity()}>Try again</button>
      </div></div>
    );
  }
  return (
    <div className="lib-pane">
      <div className="lib-head">
      <div className="lib-tools" role="toolbar" aria-label="Activity filters">
        <label className="lib-sel">
          <span className="lt-sr">Filter by bot</span>
          <select value={filterGone ? '' : agent} onChange={(e) => setActAgent(e.target.value)} aria-label="Filter by bot">
            <option value="">All bots</option>
            {who.map((w) => <option key={w} value={w}>{w === 'system' ? 'System' : names(w) ?? w}</option>)}
          </select>
        </label>
        <span className="lib-faint lib-tools-note">Bot and system writes of the last 7 days. Your own edits are not listed.</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => void loadActivity()}><GIcon name="relayout" size={13} /> Refresh</button>
      </div>
      {state === 'error' && error && <div className="lib-flash error" role="alert"><div><b>Could not refresh.</b> {error}</div><button className="btn sm" onClick={() => void loadActivity()}>Retry</button></div>}
      </div>
      {visible.length === 0 ? (
        <div className="lib-empty"><b>No bot writes in the last 7 days</b><span>When a bot saves, edits or links something, it shows up here with an Undo.</span></div>
      ) : (
        <ul className="lib-list act" aria-label="Recent writes">
          {visible.map((r) => <li key={r.id}><ActRow row={r} /></li>)}
        </ul>
      )}
    </div>
  );
}

function ActRow({ row }: { row: KgActivityRow }) {
  const busy = useL((s) => s.busy.has(row.id));
  const err = useL((s) => s.rowErr[row.id]);
  const u = undoState(row);
  useG((s) => s.kv);
  const raw = row.title || row.nodeId || '';
  const ids = idsIn(raw);
  const idKey = ids.join(',');
  useEffect(() => { if (ids.length) void resolveTitles(ids); }, [idKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = humanizeIds(raw, (id) => titleOf(id));
  const isEdge = row.kind === 'link' || row.kind === 'unlink';
  const open = () => { if (row.nodeId) { setSub('lattice'); void focusNode(row.nodeId); } };
  return (
    <div className={`lib-act${row.undone ? ' undone' : ''}`}>
      <span className="lib-act-when" title={fmtDate(row.at)}>{relTime(row.at)}{relTime(row.at) !== 'now' && <small>ago</small>}</span>
      <Creator id={row.who} size={20} label={false} />
      <div className="lib-act-main">
        <div className="lib-act-line">
          <b>{row.who === 'system' ? 'System' : <WhoName id={row.who} />}</b> <span className="lib-act-verb">{activityVerb(row.kind)}</span>
          {row.nodeType && <TypeDot type={row.nodeType} size={9} />}
          {row.nodeId && !isEdge ? <button className="lib-act-title" onClick={open} title="Open in the Lattice">{shown}</button>
            : <span className={`lib-act-title static${isEdge ? ' mono' : ''}`}>{shown}</span>}
        </div>
        <div className="lib-act-badges">
          {row.trust && <TrustBadge trust={row.trust} />}
          {row.tainted && <TaintBadge />}
          {row.undone && <span className="lib-badge status-archived">Undone</span>}
        </div>
        {err && <p className="lib-rowerr" role="alert"><GIcon name="alert" size={13} /> {err}</p>}
      </div>
      <div className="lib-act-undo">
        <button className="btn sm" disabled={!u.can || busy} onClick={() => void undoEntry(row)} aria-describedby={u.can ? undefined : `why-${row.id}`}>
          {busy ? 'Undoing' : 'Undo'}
        </button>
        {!u.can && !row.undone && <span className="lib-why" id={`why-${row.id}`}>{u.reason}</span>}
      </div>
    </div>
  );
}

function WhoName({ id }: { id: string }) {
  const names = useAgentNames();
  return <>{names(id) ?? id}</>;
}
