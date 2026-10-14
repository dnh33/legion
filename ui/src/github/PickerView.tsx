/** "Choose repos": which repos Legion (read) and Legion (write) are installed on, ticked here instead of on github.com. */
import { useId, useState } from 'react';
import { PAGE } from './areaState';
import { closePicker, openAtGithub, pickerKey, setPickerQuery, setPickerRepo, useGithub } from './githubStore';
import type { PickerState } from './githubStore';
import type { GithubApp, GithubPickerRow, GithubPickerView } from '../../../src/shared/github-area';
import type { GithubAreaData } from './types';

const APP_NAME: Record<GithubApp, string> = { read: 'Legion (read)', write: 'Legion (write)' };
const FALLBACK_SETTINGS = 'https://github.com/settings/installations';

type Ready = Extract<GithubPickerView, { phase: 'ready' }>;
const ready = (v: GithubPickerView | undefined): Ready | undefined => (v?.phase === 'ready' ? v : undefined);

function Box({ app, row, p, locked }: { app: GithubApp; row: GithubPickerRow; p: PickerState; locked: boolean }) {
  const busy = p.sending[app] === row.id;
  const waiting = p.sending[app] !== undefined && !busy;
  return (
    <span className={`gh-pk-cell${busy ? ' busy' : ''}`}>
      <input type="checkbox" checked={row.installed} disabled={locked || !row.admin || busy || waiting} aria-busy={busy || undefined}
        aria-label={`${APP_NAME[app]} on ${row.fullName}`} onChange={(e) => void setPickerRepo(app, row.id, e.target.checked)} />
      {busy && <span className="gh-pk-spin" aria-hidden="true" />}
    </span>
  );
}

function PickerRow({ row, p, apps, locked }: { row: GithubPickerRow; p: PickerState; apps: GithubApp[]; locked: Record<GithubApp, boolean> }) {
  const [owner, name] = row.fullName.split('/');
  const errs = apps.map((a) => p.errors[pickerKey(a, row.id)]).filter((x): x is string => !!x);
  return (
    <li className="gh-pk-row">
      <div className="gh-pk-name">
        <span className="gh-repo-name" title={row.fullName}><span className="gh-owner">{owner}/</span>{name}</span>
        <span className="ci-tag">{row.private ? 'Private' : 'Public'}</span>
      </div>
      {apps.map((a) => {
        const r = (p.data[a] as Ready | undefined)?.rows.find((x) => x.id === row.id);
        return r ? <Box key={a} app={a} row={r} p={p} locked={locked[a]} /> : <span key={a} />;
      })}
      {!row.admin && <p className="gh-pk-why">You are not an admin of this repo, so you cannot change it here.</p>}
      {[...new Set(errs)].map((m) => <p key={m} className="gh-err gh-pk-err" role="alert">{m}</p>)}
    </li>
  );
}

export function PickerView({ view }: { view: GithubAreaData }) {
  const p = useGithub((s) => s.picker);
  const [shown, setShown] = useState(PAGE);
  const searchId = useId();
  if (!p) return null;
  const read = ready(p.data.read);
  const write = ready(p.data.write);
  const apps: GithubApp[] = write ? ['read', 'write'] : ['read'];
  // one list: the repos GitHub shows for either App, in the order GitHub gave them
  const rows: GithubPickerRow[] = [...(read?.rows ?? [])];
  for (const w of write?.rows ?? []) if (!rows.some((r) => r.id === w.id)) rows.push(w);
  const settingsUrl = view.repos[0]?.installationSettingsUrl ?? FALLBACK_SETTINGS;
  const locked: Record<GithubApp, boolean> = { read: read?.selection === 'all', write: write?.selection === 'all' };
  const sees = (read ?? write)?.seesUninstalled;
  const addUrl = (read ?? write)?.installUrl ?? settingsUrl;
  return (
    <section className="gh-picker" aria-label="Choose repos">
      <div className="gh-head">
        <h3>Choose repos</h3>
        <span className="gh-count">{read ? `Legion (read) is on ${read.rows.filter((r) => r.installed).length} of ${read.rows.length}` : ''}</span>
        <button type="button" className="btn sm primary" onClick={closePicker}>Done</button>
      </div>
      <p className="gh-help">Tick a repo to let Legion reach it. Each tick is saved at once.</p>
      <div className="gh-search">
        <label className="sr-only" htmlFor={searchId}>Search your repos</label>
        <input id={searchId} type="search" value={p.query} onChange={(e) => { setShown(PAGE); setPickerQuery(e.target.value); }} placeholder="Search repos" autoComplete="off" spellCheck={false} />
      </div>
      {p.loadError && <p className="gh-err" role="alert">{p.loadError}</p>}
      {!view.signedIn.write && <p className="gh-fine">Turn on writes to choose repos for writing.</p>}
      {(['read', 'write'] as const).map((a) => {
        const d = p.data[a];
        if (d?.phase === 'not-installed') return (
          <div key={a} className="gh-note"><p>{APP_NAME[a]} is not installed on your account yet.</p><button type="button" className="btn sm" onClick={() => { openAtGithub(d.installUrl); }}>Install at GitHub</button></div>
        );
        if (d?.phase === 'ready' && d.selection === 'all') return (
          <div key={a} className="gh-note"><p>{APP_NAME[a]} can reach every repo on GitHub. To choose here, set it to Only select repositories at GitHub.</p><button type="button" className="btn sm" onClick={() => { openAtGithub(settingsUrl); }}>Open at GitHub</button></div>
        );
        return null;
      })}
      {p.loading && !read && !write && !p.loadError && <div className="gh-skel" role="status" aria-label="Loading your repos">{[0, 1, 2, 3].map((i) => <i key={i} />)}</div>}
      {(read || write) && (
        <>
          <div className={`gh-pk-cols${apps.length === 2 ? ' two' : ''}`} aria-hidden="true"><span /> {apps.map((a) => <span key={a}>{a === 'read' ? 'Read' : 'Write'}</span>)}</div>
          {rows.length === 0
            ? <p className="gh-help">{p.query ? `No repo matches “${p.query}”.` : 'GitHub shows no repos for this account.'}</p>
            : <ul className={`gh-list gh-pk-list${apps.length === 2 ? ' two' : ''}`} aria-label="Repos you can choose" aria-busy={p.loading || undefined}>{rows.slice(0, shown).map((r) => <PickerRow key={r.id} row={r} p={p} apps={apps} locked={locked} />)}</ul>}
          {rows.length > shown && <button type="button" className="btn-ghost sm gh-more" onClick={() => setShown(shown + PAGE)}>Show more ({rows.length - shown} left)</button>}
          {(read?.truncated || write?.truncated) && <p className="gh-fine">GitHub has more repos than Legion lists. Search to narrow it down.</p>}
          {sees === false && (
            <div className="gh-note">
              <p>GitHub only shows Legion the repos it can already reach. To add another, choose it at GitHub.</p>
              <button type="button" className="btn sm" onClick={() => { openAtGithub(addUrl); }}>Add repos at GitHub</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
