import { useEffect, useState } from 'react';
import { LIMIT_GATE_IDS, type GateValue } from '../../../src/shared/gates-registry';
import { loadDocsHosts } from '../../../src/shared/docs-hosts';
import { Icon } from '../components/icons';
import { EVERYTHING, GatesNote } from './GatesPresets';
import { STALE_DAYS, overridesWith, permissionRows, siteGroups, staleHosts, lastUsedByHost, type GateRow, type GatesView } from './presetsLogic';
import { loadActivity, loadWebHosts, type GatesChangeRequest, type GatesNote as Note } from './useGatesView';

type Run = (c: GatesChangeRequest, done: string) => Promise<boolean>;

const isOn = (v: GateValue): boolean => v === true || (typeof v === 'object' && v.on);
const limitOf = (v: GateValue): number | undefined => (typeof v === 'object' ? v.limit : undefined);
const valueText = (v: GateValue): string => (typeof v === 'object' ? `On, limit ${v.limit}` : v ? 'On' : 'Off');

/** One permission gate: what it protects, a switch (or a number), what the preset alone would give, and Reset when it was changed. */
function GateRowView({ row, projectId, view, busy, run }: { row: GateRow; projectId: string | undefined; view: GatesView; busy: boolean; run: Run }) {
  const editable = projectId !== undefined;
  const limit = limitOf(row.value);
  const [draft, setDraft] = useState(String(limit ?? ''));
  useEffect(() => { setDraft(String(limit ?? '')); }, [limit, projectId]);
  const set = (value: GateValue | undefined, done: string) => {
    if (projectId === undefined) return;
    void run({ kind: 'project', id: projectId, patch: { overrides: overridesWith(view, projectId, row.id, value) } }, done);
  };
  const on = isOn(row.value);
  const hasLimit = LIMIT_GATE_IDS.includes(row.id);
  const defLimit = limitOf(row.presetDefault);
  const draftNum = Number(draft);
  const draftOk = Number.isInteger(draftNum) && draftNum >= 1 && draftNum <= 100;
  return (
    <div className="gates-row gates-gate">
      <div className="gates-gate-main">
        <b>{row.label}</b>
        <span className="field-note">{row.protects}</span>
        <span className="field-note">Preset default: {valueText(row.presetDefault)}{row.overridden ? `. Changed here: ${valueText(row.value)}.` : ''}</span>
        {!on && <span className="field-note gates-ifoff">With this off: {row.ifOff}</span>}
      </div>
      <div className="gates-gate-ctl">
        {editable ? (
          <label className="gates-switch">
            <input type="checkbox" role="switch" checked={on} disabled={busy}
              onChange={(e) => set(e.target.checked ? (hasLimit ? { on: true, limit: defLimit ?? 1 } : true) : false, `${row.label}: ${e.target.checked ? 'on' : 'off'}.`)} />
            <span>{on ? 'On' : 'Off'}</span>
          </label>
        ) : <span className="gates-value">{valueText(row.value)}</span>}
        {editable && hasLimit && on && (
          <span className="gates-limit">
            <label>Limit <input type="number" min={1} max={100} value={draft} disabled={busy} aria-label={`${row.label}: limit`} onChange={(e) => setDraft(e.target.value)} /></label>
            <button type="button" className="btn-ghost sm" disabled={busy || !draftOk || draftNum === limit} onClick={() => set({ on: true, limit: draftNum }, `${row.label}: limit ${draftNum}.`)}>Set limit</button>
          </span>
        )}
        {row.overridden && editable && <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => set(undefined, `${row.label}: back to the preset.`)}>Reset</button>}
      </div>
    </div>
  );
}

/** The sites agents may read: built in, the ones you allowed (with when each was last read), and the ones a goal trusts. */
function WebSites({ view, busy, run }: { view: GatesView; busy: boolean; run: Run }) {
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<Array<{ at: string; kind: string; text: string }>>([]);
  const allowed = view.app.allowedHosts ?? [];
  useEffect(() => {
    let live = true;
    void loadWebHosts().then((m) => { if (live) setSaved(m); });
    void loadActivity({ kinds: ['web-call'], limit: 1000 }).then((l) => { if (live) setLines(l); }, () => { /* the dates are advisory */ });
    return () => { live = false; };
  }, [allowed.join('|')]);
  const last = lastUsedByHost(lines, saved);
  const groups = siteGroups({ builtIn: [...loadDocsHosts()], allowed, goal: [] }, last);
  const stale = staleHosts(allowed, last, Date.now());
  const remove = (hosts: string[], done: string) => run({ kind: 'app', patch: { allowedHosts: allowed.filter((h) => !hosts.includes(h)) } }, done);
  return (
    <div className="gates-sites" aria-label="Websites agents can read">
      {groups.map((g) => (
        <div key={g.id} className="gates-site-group">
          {g.id === 'built-in' ? (
            <details>
              <summary><b>{g.label}</b> <span className="muted-s">{g.hosts.length} documentation sites. Agents read these without asking.</span></summary>
              <ul className="gates-hosts">{g.hosts.map((h) => <li key={h.host}><code>{h.host}</code><span className="muted-s">Last used: {h.lastUsed}</span></li>)}</ul>
            </details>
          ) : (
            <>
              <div className="gates-site-head">
                <b>{g.label}</b>
                {g.id === 'allowed' && stale.length > 0 && (
                  <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void remove(stale, `Removed ${stale.length} ${stale.length === 1 ? 'site' : 'sites'} not used for ${STALE_DAYS} days.`)}>Tidy up</button>
                )}
              </div>
              {g.hosts.length === 0 ? <p className="muted-s">None yet</p> : (
                <ul className="gates-hosts">
                  {g.hosts.map((h) => (
                    <li key={h.host}>
                      <code>{h.host}</code>
                      <span className="muted-s">Last used: {h.lastUsed}{g.id === 'allowed' && stale.includes(h.host) ? `. Not used for ${STALE_DAYS} days.` : ''}</span>
                      {g.removable && <button type="button" className="btn-ghost sm" disabled={busy} aria-label={`Remove ${h.host}`} onClick={() => void remove([h.host], `Removed ${h.host}.`)}>Remove</button>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Fine tuning: every permission gate for the chosen scope, collapsed until the owner opens it. A gate is set per project; the app default shows what the preset gives. */
export function PermissionGates({ view, scope, busy, note, run }: { view: GatesView; scope: string; busy: boolean; note: Note | null; run: Run }) {
  const projectId = scope === EVERYTHING ? undefined : scope;
  const rows = permissionRows(view, projectId);
  return (
    <details className="set-card gates-fine">
      <summary><Icon name="chevron" size={14} /><span className="gates-fine-title"><h3>Fine tuning</h3><span className="muted-s">{rows.length} permission gates. Each follows the preset until you change it.</span></span></summary>
      {projectId === undefined && (
        <p className="gates-warn"><Icon name="shield" size={13} /> <span>These are the values the app default gives. Choose a project above to change a single gate for it.</span></p>
      )}
      <ul className="gates-gates">
        {rows.map((r) => (
          <li key={r.id} className="gates-gate-wrap">
            <GateRowView row={r} projectId={projectId} view={view} busy={busy} run={run} />
            {r.id === 'web-reads' && <WebSites view={view} busy={busy} run={run} />}
          </li>
        ))}
      </ul>
      <GatesNote note={note} pending={busy} />
    </details>
  );
}
