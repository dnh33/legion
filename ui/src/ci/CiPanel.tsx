import { useRef, useState } from 'react';
import { openExternal } from '../api';
import type { CiJob, CiLogView, CiRun } from '../../../src/shared/ci';
import { ago, formatDuration, problemText, runLook } from '../../../src/shared/ci-view';
import type { Tone } from '../../../src/shared/ci-view';
import { FloatPanel } from './FloatPanel';
import { pickReturnFocus } from './focusReturn';
import { cancelRun, closeCi, connectGithub, describeCounts, refreshCi, rerunFailed, saveRepo, toggleLog, toggleRun, useCi } from './ciStore';
import './ci.css';

function Glyph({ tone }: { tone: Tone }) {
  const p = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
  if (tone === 'ok') return <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M5.2 8.2l2 2 3.6-4" /></svg>;
  if (tone === 'bad') return <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></svg>;
  if (tone === 'run') return <svg {...p}><circle cx="8" cy="8" r="6" strokeDasharray="3 2.4" /><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" /></svg>;
  return <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M5.5 8h5" /></svg>;
}

/* ---------- log ---------- */
function LogBox({ jobId, log, url }: { jobId: number; log: CiLogView | 'loading' | undefined; url: string }) {
  if (!log || log === 'loading') return <p className="ci-note" role="status">Loading the log&hellip;</p>;
  if (!log.available) {
    if (log.reason === 'logs-unavailable') return <p className="ci-note">Logs are not available yet.{url && <> <button type="button" className="ci-link" onClick={() => openExternal(url)}>Open on GitHub</button></>}</p>;
    if (log.reason === 'expired') return <p className="ci-note">GitHub no longer has this log.{url && <> <button type="button" className="ci-link" onClick={() => openExternal(url)}>Open on GitHub</button></>}</p>;
    return <p className="ci-note">{log.problem ? problemText(log.problem) : 'The log could not be loaded.'}</p>;
  }
  return (
    <div className="ci-log-wrap">
      {/* plain text node: never HTML */}
      <pre className="ci-log" tabIndex={0} role="region" aria-label={`Log for job ${jobId}`}>{log.text}</pre>
      {(log.truncated || log.masked) && <p className="ci-fine">{log.truncated ? 'Showing the end of the log. ' : ''}{log.masked ? 'Secret-looking values are hidden.' : ''}</p>}
    </div>
  );
}

/* ---------- jobs ---------- */
function JobRow({ job }: { job: CiJob }) {
  const look = runLook(job.status, job.conclusion);
  const failed = look.tone === 'bad';
  const open = useCi((s) => !!s.openLogs[job.id]);
  const log = useCi((s) => s.logs[job.id]);
  const body = (
    <>
      <span className={`ci-st tone-${look.tone}`}><Glyph tone={look.tone} /><span className="ci-st-word">{look.word}</span></span>
      <span className="ci-job-name" title={job.name}>{job.name}</span>
      {job.os && <span className="ci-tag">{job.os === 'macos' ? 'macOS' : job.os === 'windows' ? 'Windows' : 'Linux'}</span>}
      <span className="ci-dur">{formatDuration(job.durationMs)}</span>
    </>
  );
  return (
    <li className="ci-job">
      {failed
        ? <button type="button" className="ci-job-row ci-job-btn" aria-expanded={open} aria-controls={`ci-log-${job.id}`} onClick={() => void toggleLog(job.id)}>{body}</button>
        : <div className="ci-job-row">{body}</div>}
      {failed && open && <div id={`ci-log-${job.id}`}><LogBox jobId={job.id} log={log} url={job.url} /></div>}
    </li>
  );
}

/* ---------- run ---------- */
function RunActions({ run, canWrite }: { run: CiRun; canWrite: 'yes' | 'no' | 'unknown' }) {
  const busy = useCi((s) => s.busy);
  const look = runLook(run.status, run.conclusion);
  return (
    <div className="ci-actions">
      {canWrite === 'yes' ? (
        <>
          {look.tone === 'bad' && <button type="button" className="btn sm" disabled={!!busy} onClick={() => void rerunFailed(run.id)}>{busy === `rerun-failed:${run.id}` ? 'Starting…' : 'Re-run failed jobs'}</button>}
          {look.tone === 'run' && <button type="button" className="btn sm" disabled={!!busy} onClick={() => void cancelRun(run.id)}>{busy === `cancel:${run.id}` ? 'Cancelling…' : 'Cancel run'}</button>}
        </>
      ) : (
        <button type="button" className="btn sm" onClick={connectGithub}>Connect with write access</button>
      )}
      {run.url && <button type="button" className="btn-ghost sm ci-ext" onClick={() => openExternal(run.url)}>Open on GitHub</button>}
    </div>
  );
}

function RunRow({ run, canWrite }: { run: CiRun; canWrite: 'yes' | 'no' | 'unknown' }) {
  const open = useCi((s) => s.expanded === run.id);
  const jobs = useCi((s) => s.jobs[run.id]);
  const look = runLook(run.status, run.conclusion);
  const dur = run.durationMs !== null ? formatDuration(run.durationMs) : look.tone === 'run' ? `since ${ago(run.startedAt)}`.replace('since just now', 'just started') : '';
  return (
    <li className={`ci-run tone-${look.tone}`}>
      <button type="button" className="ci-run-row" aria-expanded={open} aria-controls={`ci-run-${run.id}`} onClick={() => toggleRun(run.id)}>
        <span className={`ci-st tone-${look.tone}`}><Glyph tone={look.tone} /><span className="ci-st-word">{look.word}</span></span>
        <span className="ci-run-main">
          <span className="ci-run-title" title={run.title}>{run.title || run.workflow}</span>
          <span className="ci-run-meta"><span className="ci-wf">{run.workflow}</span><span className="ci-br" title={run.branch}>{run.branch}</span>{run.attempt > 1 && <span className="ci-tag">attempt {run.attempt}</span>}</span>
        </span>
        <span className="ci-dur">{dur}</span>
        <svg className="ci-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 6l3 3 3-3" /></svg>
      </button>
      {open && (
        <div id={`ci-run-${run.id}`} className="ci-run-body">
          {!jobs ? <p className="ci-note" role="status">Loading the jobs&hellip;</p>
            : jobs.problem && !jobs.jobs.length ? <p className="ci-note">{problemText(jobs.problem)}</p>
            : jobs.jobs.length === 0 ? <p className="ci-note">No jobs yet.</p>
            : <ul className="ci-jobs">{jobs.jobs.map((j) => <JobRow key={j.id} job={j} />)}</ul>}
          <RunActions run={run} canWrite={canWrite} />
        </div>
      )}
    </li>
  );
}

/* ---------- body ---------- */
function RepoForm({ first }: { first?: boolean }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="ci-repo" onSubmit={(e) => { e.preventDefault(); setBusy(true); void saveRepo(text).then((m) => { setErr(m); setBusy(false); }); }}>
      <label className={first ? 'ci-fine' : 'sr-only'} htmlFor="ci-repo-in">{first ? 'Type the GitHub repository to watch' : 'Watch another repository'}</label>
      <div className="ci-repo-row">
        <input id="ci-repo-in" className="ci-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="owner/name" spellCheck={false} autoComplete="off" aria-invalid={!!err} aria-describedby={err ? 'ci-repo-err' : undefined} />
        <button type="submit" className="btn sm" disabled={busy || !text.trim()}>Watch</button>
      </div>
      {err && <p id="ci-repo-err" className="ci-err" role="alert">{err}</p>}
    </form>
  );
}

function PanelBody() {
  const state = useCi((s) => s.state);
  const runs = useCi((s) => s.runs);
  const offline = useCi((s) => s.offline);
  const loaded = useCi((s) => s.loaded);
  if (!loaded) return <p className="ci-note" role="status">Loading&hellip;</p>;
  if (!state) return <p className="ci-note">{offline ? 'Cannot reach Legion. Trying again.' : 'CI is not available in this build.'}</p>;
  if (!state.available) return <p className="ci-note">GitHub support arrives with Connectors.</p>;
  if (!state.repo) {
    return (
      <div className="ci-empty">
        <p className="ci-note">No repository yet. Legion reads it from your project folder&apos;s git remote. This folder has none on GitHub.</p>
        <RepoForm first />
      </div>
    );
  }
  const anon = state.connection?.auth === 'anonymous';
  const problem = runs?.problem ?? state.problem;
  const privateRepo = problem?.kind === 'not-connected';
  const list = runs?.runs ?? [];
  return (
    <>
      {offline && <p className="ci-banner warn" role="status">Cannot reach Legion. Trying again.</p>}
      {problem && <div className={`ci-banner ${privateRepo ? '' : 'warn'}`} role="status"><span>{problemText(problem)}</span>{(privateRepo || problem.kind === 'auth-expired') && <button type="button" className="btn sm" onClick={connectGithub}>Connect GitHub</button>}</div>}
      {anon && !problem && <p className="ci-banner" role="status"><span>Connect GitHub for live updates. Without it, runs refresh when you open this panel, return to the window or press Refresh.</span><button type="button" className="btn sm" onClick={connectGithub}>Connect GitHub</button></p>}
      {!problem && list.length === 0 && <p className="ci-note">No runs yet for {state.branch ? `${state.branch} or ` : ''}main.</p>}
      {list.length > 0 && <ul className="ci-runs" aria-label="Workflow runs">{list.map((r) => <RunRow key={r.id} run={r} canWrite={state.canWrite} />)}</ul>}
      {list.length === 0 && problem && !privateRepo && null}
      <details className="ci-more"><summary>Watch another repository</summary><RepoForm /></details>
    </>
  );
}

/** The CI panel: floats or docks. Opened by the title-bar chip (CiChip) or the command palette. */
export function CiPanel() {
  const open = useCi((s) => s.panelOpen);
  const state = useCi((s) => s.state);
  const summary = useCi((s) => s.summary);
  const refreshing = useCi((s) => s.refreshing);
  const say = useCi((s) => s.say);
  const returnFocus = useRef(() => pickReturnFocus((sel) => document.querySelector<HTMLElement>(sel)) as HTMLElement | null);
  const repo = state?.repo ? `${state.repo.owner}/${state.repo.name}` : null;
  const sub = repo ? <><span className="ci-repo-name">{repo}</span>{state?.branch && <span className="ci-br">{state.branch}</span>}</> : undefined;
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">{say}</div>
      <FloatPanel
        id="ci" title="CI" subtitle={sub} open={open} onClose={closeCi} returnFocus={returnFocus.current} label={`CI runs${repo ? ` for ${repo}` : ''}${summary ? `: ${describeCounts(summary.counts)}` : ''}`}
        defaults={{ w: 480, h: 600, dockW: 400 }}
        actions={state?.available && state.repo ? (
          <button type="button" className="fp-btn" onClick={() => void refreshCi('manual')} disabled={refreshing} aria-label="Refresh" title="Refresh">
            <svg className={refreshing ? 'ci-spin' : undefined} width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3" /><path d="M13.4 2.6v3h-3" /></svg>
          </button>
        ) : undefined}
      >
        <PanelBody />
      </FloatPanel>
    </>
  );
}
