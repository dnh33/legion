import { useId, useRef, useState } from 'react';
import { openExternal } from '../api';
import { openEditor } from '../store';
import { openProject } from '../projects/projectsStore';
import { Icon } from '../components/icons';
import { Switch } from '../projects/page/SettingsTab';
import { FloatPanel } from '../ci/FloatPanel';
import { Glyph } from '../ci/CiPanel';
import { ago, formatDuration, runLook } from '../../../src/shared/ci-view';
import { normRepo } from '../../../src/shared/github-area';
import type { GithubAreaView, GithubRepoRow } from '../../../src/shared/github-area';
import { activityVerb, areaState, CREATE_DEFAULTS, createConfirmLine, createNameError, listRepos, rateLine, writesOffText } from './areaState';
import type { AreaState } from './areaState';
import {
  agentsOn, cancelRun, cancelSignIn, closeGithub, connectRead, connectWrite, createRepo, disconnectRead, disconnectWrite, GITHUB_NEW_REPO_URL, grantProject,
  loadArea, openGithubSettings, rerunFailed, setAgentsEnabled, setQuery, setTick, showMore, toggleRepo, useGithub, watchInCi,
} from './githubStore';
import type { CreateResult } from './githubStore';
import type { GithubAreaData, GithubProjectUse, GithubRepoDetail } from './types';
import './github.css';

const ext = (url: string) => () => openExternal(url);

/* ---------- connection ---------- */
function Connection({ view, state }: { view: GithubAreaData; state: AreaState }) {
  const busy = useGithub((s) => s.busy);
  const writeText = writesOffText(view);
  const signed = view.signedIn.read;
  const rate = rateLine(view);
  const agentsId = useId();
  if (!signed) return null;
  return (
    <section className="gh-conn" aria-label="Connection">
      <div className="gh-who">
        <span className="gh-login">Signed in as <b>{view.login ?? 'GitHub'}</b></span>
        <button type="button" className="btn-ghost sm" onClick={() => void disconnectRead()}>Sign out</button>
      </div>
      <dl className="gh-rows">
        <div className="gh-line"><dt>Reading</dt><dd><span className="gh-on">On</span></dd></div>
        <div className="gh-line">
          <dt>Writing</dt>
          <dd>
            {view.signedIn.write
              ? <><span className="gh-on">On</span><button type="button" className="btn-ghost sm" onClick={() => void disconnectWrite()}>Turn off</button></>
              : <><span className="gh-off">Off</span>{view.registered.write && <button type="button" className="btn sm" disabled={!!busy || state.disableGithubButtons} onClick={() => void connectWrite()}>{busy === 'write-app' ? 'Turning on' : 'Turn on writes'}</button>}</>}
          </dd>
        </div>
        <div className="gh-line">
          <dt id={agentsId}>Agents</dt>
          <dd><span className="gh-cap">{view.agentsEnabled ? 'May use the repos you turn on' : 'Cannot use GitHub'}</span><Switch id="gh-agents-switch" on={view.agentsEnabled} label="Let agents use GitHub" onChange={(v) => void setAgentsEnabled(v)} /></dd>
        </div>
      </dl>
      {writeText && <p className="gh-help">{writeText}</p>}
      {rate && <p className="gh-fine">{rate}</p>}
    </section>
  );
}

/* ---------- state banner ---------- */
function Banner({ state, view }: { state: AreaState; view: GithubAreaData | null }) {
  const flow = useGithub((s) => s.flow);
  const busy = useGithub((s) => s.busy);
  const firstUrl = view?.repos[0]?.installationSettingsUrl ?? 'https://github.com/settings/installations';
  const run = (id: NonNullable<AreaState['action']>['id']): void => {
    if (id === 'connect' || id === 'sign-in') void connectRead();
    else if (id === 'retry') void loadArea(true);
    else openExternal(firstUrl);
  };
  if (state.id === 'signing-in') {
    return (
      <div className="gh-note gh-signin" role="status" aria-label="Sign-in waiting">
        <p>On github.com/login/device, enter this code:</p>
        <p className="gh-code" aria-label="Your code">{flow?.userCode ?? '...'}</p>
        <div className="gh-actions">
          <button type="button" className="btn sm primary" onClick={() => openExternal(flow?.verificationUri ?? 'https://github.com/login/device')}>Open GitHub</button>
          <button type="button" className="btn-ghost sm" onClick={cancelSignIn}>Cancel</button>
        </div>
        <p className="gh-fine">Legion checks every two seconds. The code works for a few minutes.</p>
      </div>
    );
  }
  if (state.id === 'ready' || state.id === 'loading') return null;
  return (
    <div className={`gh-note tone-${state.tone}`} role={state.tone === 'warn' ? 'alert' : 'status'}>
      <p>{state.text}</p>
      {state.action && <button type="button" className="btn sm" disabled={!!busy || (state.disableGithubButtons && state.action.id !== 'retry')} onClick={() => run(state.action!.id)}>{state.action.label}</button>}
    </div>
  );
}

/* ---------- create ---------- */
function CreateForm({ view, blocked }: { view: GithubAreaData; blocked: boolean }) {
  const busy = useGithub((s) => s.busy === 'create');
  const login = view.login ?? 'you';
  const orgs = view.orgs ?? [];
  const [owner, setOwner] = useState(login);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [priv, setPriv] = useState<boolean>(CREATE_DEFAULTS.private);
  const [readme, setReadme] = useState<boolean>(CREATE_DEFAULTS.readme);
  const [tick, setTick] = useState<boolean>(CREATE_DEFAULTS.tick);
  const [touched, setTouched] = useState(false);
  const [fail, setFail] = useState<CreateResult | null>(null);
  const nameErr = createNameError(name);
  const id = useId();
  const writeReady = view.registered.write && view.signedIn.write;
  const submit = async () => {
    setTouched(true);
    if (nameErr || busy || blocked) return;
    const r = await createRepo({ ...(owner !== login ? { owner } : {}), name, ...(desc.trim() ? { description: desc.trim() } : {}), private: priv, readme, tick });
    if (r.ok) { setName(''); setDesc(''); setFail(null); } else setFail(r);
  };
  return (
    <form className="gh-create" aria-label="Create a repo" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="gh-field">
        <label htmlFor={`${id}-owner`}>Owner</label>
        <select id={`${id}-owner`} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value={login}>{login} (your account)</option>
          {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
      <div className="gh-field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} value={name} onChange={(e) => { setName(e.target.value); setFail(null); }} onBlur={() => setTouched(true)} spellCheck={false} autoComplete="off" placeholder="my-new-repo" aria-invalid={touched && !!nameErr} aria-describedby={`${id}-name-msg`} />
        <p id={`${id}-name-msg`} className="gh-err" role={touched && nameErr ? 'alert' : undefined}>{touched && nameErr ? nameErr : ''}</p>
      </div>
      <div className="gh-field">
        <label htmlFor={`${id}-desc`}>Description <span className="gh-opt">(optional)</span></label>
        <input id={`${id}-desc`} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={350} autoComplete="off" />
      </div>
      <div className="gh-checks">
        <label><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private</label>
        <label><input type="checkbox" checked={readme} onChange={(e) => setReadme(e.target.checked)} /> Add a README</label>
        <label><input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} /> Turn it on in Legion</label>
      </div>
      {!view.registered.write ? (
        <div className="gh-actions"><p className="gh-help">Creating repos from Legion is not available in this build yet.</p><button type="button" className="btn sm" onClick={ext(GITHUB_NEW_REPO_URL)}>Create on GitHub</button></div>
      ) : !writeReady ? (
        <div className="gh-need">
          <p className="gh-help">Creating a repo uses Legion (write), the app that can change things on GitHub. Connect it first. Agents still cannot write anywhere until you allow it, and every write asks you first.</p>
          <button type="button" className="btn sm primary" disabled={blocked} onClick={() => void connectWrite()}>Connect Legion (write)</button>
        </div>
      ) : (
        <>
          <p className="gh-confirm" aria-live="polite">{name && !nameErr ? createConfirmLine(owner, name, priv) : 'Pick a name to see what will be created.'}</p>
          {fail && !fail.ok && <p className="gh-err" role="alert">{fail.text}</p>}
          <div className="gh-actions">
            <button type="submit" className="btn sm primary" aria-disabled={busy || blocked || undefined} disabled={blocked}>{busy ? 'Creating' : 'Create'}</button>
            {blocked && <span className="gh-fine">GitHub is asking you to wait.</span>}
          </div>
        </>
      )}
    </form>
  );
}

/* ---------- repo detail ---------- */
function CiBlock({ repo, d, canWrite, blocked }: { repo: string; d: GithubRepoDetail; canWrite: boolean; blocked: boolean }) {
  const { runs, failed, source } = d.ci;
  if (source === 'watch-needed') return <div className="gh-sec"><h4>CI</h4><p className="gh-help">The CI panel is watching another repo.</p><button type="button" className="btn sm" onClick={() => void watchInCi(repo)}>Watch this repo in CI</button></div>;
  if (runs.length === 0) return <div className="gh-sec"><h4>CI</h4><p className="gh-help">No CI runs yet.</p></div>;
  return (
    <div className="gh-sec">
      <h4>CI</h4>
      <ul className="gh-runs" aria-label={`Latest CI runs for ${repo}`}>
        {runs.slice(0, 3).map((r) => {
          const look = runLook(r.status, r.conclusion);
          const names = failed[r.id] ?? [];
          return (
            <li key={r.id} className={`gh-run tone-${look.tone}`}>
              <div className="gh-run-top">
                <span className={`ci-st tone-${look.tone}`}><Glyph tone={look.tone} /><span className="ci-st-word">{look.word}</span></span>
                <span className="gh-run-title" title={r.title}>{r.title || r.workflow}</span>
                <span className="gh-run-when">{r.durationMs !== null ? formatDuration(r.durationMs) : ago(r.startedAt)}</span>
              </div>
              <div className="gh-run-meta"><span className="ci-br" title={r.branch}>{r.branch}</span><span>{ago(r.updatedAt)}</span>{r.attempt > 1 && <span className="ci-tag">attempt {r.attempt}</span>}</div>
              {look.tone === 'bad' && names.length > 0 && <p className="gh-failed"><span>Failed:</span> {names.join(', ')}</p>}
              <div className="gh-actions">
                {look.tone === 'bad' && (canWrite
                  ? <button type="button" className="btn sm" disabled={blocked} onClick={() => void rerunFailed(repo, r.id)}>Re-run failed</button>
                  : <button type="button" className="btn sm" disabled={blocked} onClick={() => void connectWrite()} title="Re-running needs Legion (write)">Turn on writes to re-run</button>)}
                {look.tone === 'run' && (canWrite
                  ? <button type="button" className="btn sm" disabled={blocked} onClick={() => void cancelRun(repo, r.id)}>Cancel</button>
                  : <button type="button" className="btn sm" disabled={blocked} onClick={() => void connectWrite()} title="Cancelling needs Legion (write)">Turn on writes to cancel</button>)}
                <button type="button" className="btn-ghost sm" disabled={blocked} onClick={ext(r.url)}>Open on GitHub</button>
              </div>
            </li>
          );
        })}
      </ul>
      {canWrite && <p className="gh-fine">Re-run and Cancel ask you first.</p>}
    </div>
  );
}

function projectLevel(repo: string, p: GithubProjectUse): 'none' | 'read' | 'write' {
  const g = agentsOn(repo);
  const w = new Set(g.write.map((a) => a.id));
  const r = new Set(g.read.map((a) => a.id));
  if (p.agentIds.length === 0) return 'none';
  if (p.agentIds.every((id) => w.has(id))) return 'write';
  if (p.agentIds.every((id) => w.has(id) || r.has(id))) return 'read';
  return 'none';
}

function RepoDetail({ row, view, state }: { row: GithubRepoRow; view: GithubAreaData; state: AreaState }) {
  const d = useGithub((s) => s.detail[row.fullName]);
  const agentsVersion = useGithub((s) => s.view); // re-render when access changes
  void agentsVersion;
  const g = agentsOn(row.fullName);
  const did = view.activity.filter((a) => normRepo(a.repo) === normRepo(row.fullName)).slice(0, 5);
  const blocked = state.disableGithubButtons;
  return (
    <div className="gh-detail" id={`gh-detail-${row.fullName.replace('/', '--')}`}>
      <div className="gh-actions gh-links">
        <button type="button" className="btn-ghost sm" disabled={blocked} onClick={ext(row.htmlUrl)}><Icon name="ext" size={12} /> Open on GitHub</button>
        <button type="button" className="btn-ghost sm" disabled={blocked} onClick={ext(row.installationSettingsUrl)}>Change repos at GitHub</button>
      </div>
      {!row.ticked && <p className="gh-help">This repo is off in Legion. Agents cannot see it. Turn it on to let them.</p>}
      {!d ? <p className="gh-help" role="status">Loading.</p> : <CiBlock repo={row.fullName} d={d} canWrite={view.signedIn.write} blocked={blocked} />}
      <div className="gh-sec">
        <h4>Agents</h4>
        {g.read.length + g.write.length === 0 ? <p className="gh-help">No agent has GitHub on this repo.</p> : (
          <ul className="gh-agents">
            {g.write.map((a) => <li key={a.id}><button type="button" className="gh-chip" onClick={() => openEditor(a.id)} aria-label={`${a.name}, can read and write. Open this agent`}>{a.name}<em>Read and write</em></button></li>)}
            {g.read.map((a) => <li key={a.id}><button type="button" className="gh-chip" onClick={() => openEditor(a.id)} aria-label={`${a.name}, can read. Open this agent`}>{a.name}<em>Read</em></button></li>)}
          </ul>
        )}
      </div>
      {d && d.projects.length > 0 && (
        <div className="gh-sec">
          <h4>Projects using it</h4>
          <ul className="gh-projects">
            {d.projects.map((p) => {
              const lvl = projectLevel(row.fullName, p);
              return (
                <li key={p.id}>
                  <button type="button" className="ci-link" onClick={() => { closeGithub(); openProject(p.id); }}>{p.name}</button>
                  <span className="gh-seg" role="group" aria-label={`Let the agents in ${p.name} use ${row.fullName}`}>
                    <button type="button" className="btn sm" aria-pressed={lvl === 'read' || lvl === 'write'} disabled={!row.ticked || !view.agentsEnabled} onClick={() => void grantProject(row.fullName, p.id, 'read')}>Let agents read it</button>
                    <button type="button" className="btn sm" aria-pressed={lvl === 'write'} disabled={!row.ticked || !view.agentsEnabled || !view.signedIn.write} title={view.signedIn.write ? '' : 'Turn on writes first'} onClick={() => void grantProject(row.fullName, p.id, 'write')}>Let agents write</button>
                  </span>
                </li>
              );
            })}
          </ul>
          {!row.ticked && <p className="gh-fine">Turn the repo on first.</p>}
        </div>
      )}
      <div className="gh-sec">
        <h4>What agents did here</h4>
        {did.length === 0 ? <p className="gh-help">Nothing yet. Comments, issues, pull requests and re-runs by agents will show here.</p> : (
          <ul className="gh-did">
            {did.map((a) => (
              <li key={a.id}>
                <span><b>{a.agent}</b> {activityVerb(a.kind)} <button type="button" className="ci-link" disabled={blocked} onClick={ext(a.url)}>{a.title}</button></span>
                <time dateTime={a.at}>{ago(a.at)}</time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ---------- repos ---------- */
function RepoRow({ row, view, state }: { row: GithubRepoRow; view: GithubAreaData; state: AreaState }) {
  const open = useGithub((s) => s.expanded === row.fullName);
  const [owner, name] = row.fullName.split('/');
  const detailId = `gh-detail-${row.fullName.replace('/', '--')}`;
  return (
    <li className={`gh-repo${open ? ' open' : ''}${row.ticked ? ' on' : ''}`}>
      <div className="gh-repo-row">
        <button type="button" className="gh-repo-main" aria-expanded={open} aria-controls={detailId} onClick={() => toggleRepo(row.fullName)}>
          <svg className="ci-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 6l3 3 3-3" /></svg>
          <span className="gh-repo-name" title={row.fullName}><span className="gh-owner">{owner}/</span>{name}</span>
          <span className="gh-tags">
            <span className="ci-tag">{row.private ? 'Private' : 'Public'}</span>
            {row.installedRead && <span className="ci-tag" title="Legion (read) can see it">Read</span>}
            {row.installedWrite && <span className="ci-tag" title="Legion (write) can change it">Write</span>}
          </span>
        </button>
        <Switch id={`gh-tick-${row.fullName}`} on={row.ticked} label={`Turn on ${row.fullName} in Legion`} onChange={(v) => void setTick(row.fullName, v)} />
      </div>
      {open && <RepoDetail row={row} view={view} state={state} />}
    </li>
  );
}

function Repos({ view, state }: { view: GithubAreaData; state: AreaState }) {
  const query = useGithub((s) => s.query);
  const shown = useGithub((s) => s.shown);
  const [create, setCreate] = useState(false);
  const { rows, more, total } = listRepos(view.repos, query, shown);
  const ticked = view.repos.filter((r) => r.ticked).length;
  return (
    <section className="gh-repos" aria-label="Repos">
      <div className="gh-head">
        <h3>Repos</h3>
        <span className="gh-count">{ticked} of {view.repos.length} on in Legion</span>
        <button type="button" className="btn sm" aria-expanded={create} aria-controls="gh-create-box" onClick={() => setCreate(!create)}>New repo</button>
      </div>
      {create && <div id="gh-create-box"><CreateForm view={view} blocked={state.disableGithubButtons} /></div>}
      {view.repos.length > 6 && (
        <div className="gh-search"><label className="sr-only" htmlFor="gh-search-in">Search your repos</label><input id="gh-search-in" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repos" autoComplete="off" spellCheck={false} /></div>
      )}
      {view.repos.length > 0 && rows.length === 0 && <p className="gh-help">No repo matches &ldquo;{query}&rdquo;.</p>}
      {rows.length > 0 && <ul className="gh-list" aria-label="Your repos">{rows.map((r) => <RepoRow key={r.fullName} row={r} view={view} state={state} />)}</ul>}
      {more > 0 && <button type="button" className="btn-ghost sm gh-more" onClick={showMore}>Show {Math.min(more, 100)} more ({total - rows.length} left)</button>}
      {view.truncated && <p className="gh-fine">GitHub has more repos than Legion lists. Search to narrow it down.</p>}
    </section>
  );
}

function Skeleton() {
  return <div className="gh-skel" role="status" aria-label="Loading your repos">{[0, 1, 2, 3].map((i) => <i key={i} />)}</div>;
}

/* ---------- the panel ---------- */
export function GithubArea() {
  const open = useGithub((s) => s.open);
  const view = useGithub((s) => s.view);
  const loading = useGithub((s) => s.loading);
  const signingIn = useGithub((s) => s.signingIn);
  const returnFocus = useRef(() => (document.querySelector('.tb-gh') ?? document.querySelector('.tb-search')) as HTMLElement | null);
  const state = areaState(view as GithubAreaView | null, { signingIn, loading: !view });
  const showList = !!view && view.signedIn.read && state.id !== 'auth-ended' && state.id !== 'nothing-installed' && state.id !== 'signing-in' && state.id !== 'loading';
  void loading;
  return (
    <FloatPanel
      id="github" title="GitHub" subtitle={view?.login ? <span className="ci-repo-name">{view.login}</span> : undefined} open={open} onClose={closeGithub} returnFocus={returnFocus.current}
      label="GitHub: repos, CI and agents" defaults={{ w: 480, h: 640, dockW: 440 }}
      actions={<button type="button" className="fp-btn" onClick={openGithubSettings} aria-label="GitHub settings" title="GitHub settings"><Icon name="gear" size={15} /></button>}
    >
      <div className="gh-body">
        {state.id === 'loading' ? <Skeleton /> : (
          <>
            <Banner state={state} view={view} />
            {view && <Connection view={view} state={state} />}
            {showList && view && <Repos view={view} state={state} />}
          </>
        )}
      </div>
    </FloatPanel>
  );
}
