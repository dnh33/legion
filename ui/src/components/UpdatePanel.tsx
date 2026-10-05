import { useCallback, useEffect, useState } from 'react';
import { request } from '../api';
import { errText } from '../store';
import '../styles/update.css';

/** GET /api/update/status (admin only). Mirrors src/core/updater/index.ts UpdateStatus. */
interface UpdateStatus {
  mode: 'apply' | 'checkout' | 'unwritable' | 'unsupported'; keyConfigured: boolean; installed: { version: string };
  settings: { checkEnabled: boolean; autoInstallWhenIdle: boolean; intervalHours: number };
  check: { lastCheckedAt?: string; lastResult?: string; nextAllowedAt?: string };
  available?: { version: string; size: number; notes: string; publishedAt: string; requiresFullInstall: boolean };
  phase: 'idle' | 'checking' | 'awaiting-approval' | 'downloading' | 'staged' | 'committing';
  progress?: { bytes: number; total: number }; error?: string; staged?: { version: string }; consent: boolean; readyToApply: boolean;
  busy: { idle: boolean; reasons: string[] };
  outcome?: { from: string; to: string; result: 'ok' | 'rolled-back' | 'failed'; reason?: string };
  stopped?: { tasks: Array<{ id: string; agentId: string }> };
  /** Versions held back after a rolled-back first start, and when each may be retried. */
  blocked?: Array<{ version: string; at?: string; retryAfter?: string }>;
}
type Bridge = { updateRestartNow?: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }> };
const bridge = (): Bridge => (window as unknown as { legion?: Bridge }).legion ?? {};

export const AUTO_INSTALL_TEXT = 'Install updates automatically when idle. Legion will download a new release without asking again and restart itself when no task or approval is running. Off by default.';
const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;

/**
 * Phases where offering the Update button is correct. Every other phase is work already under way, and a second
 * click is a second request against that work: `committing` re-POSTs /api/update/install while an install is already
 * committing. Named rather than inlined so the rule is one thing to read and one thing to extend.
 */
const IDLE_FOR_INSTALL: ReadonlyArray<UpdateStatus['phase']> = ['idle', 'checking'];

/** Settings, About: the update notice, the Update button, the "ready, will install when idle" state and the three switches. All text from the release is shown as plain text. */
export function UpdatePanel() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setSt(await request<UpdateStatus>('GET', '/api/update/status')); } catch (e) { setErr(errText(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const fast = st?.phase === 'downloading' || st?.phase === 'awaiting-approval' || st?.phase === 'committing';
  useEffect(() => { const t = setInterval(() => void load(), fast ? 2000 : 30000); return () => clearInterval(t); }, [load, fast]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); void load(); } };
  if (!st) return <div className="upd">{err ? <p className="upd-err" role="alert">{err}</p> : <p className="upd-muted">Checking update state{'…'}</p>}</div>;
  const a = st.available;
  const notifyOnly = !!a && (st.mode !== 'apply' || a.requiresFullInstall);
  const patch = (p: Partial<UpdateStatus['settings']>) => act(() => request('PATCH', '/api/update/settings', p));
  return (
    <div className="upd" aria-label="Updates">
      <h4>Updates</h4>
      {!st.keyConfigured && <p className="upd-muted">Updates are off in this build: it has no update key built in.</p>}
      {!st.keyConfigured && <p className="upd-muted">You are on v{st.installed.version}.</p>}
      {st.keyConfigured && (
        <p className="upd-muted">You are on v{st.installed.version}. {st.check.lastResult ? `Last check: ${st.check.lastResult}.` : 'Not checked yet.'}</p>
      )}
      {st.outcome && st.outcome.result !== 'ok' && (
        <p className="upd-warn" role="status">Update {st.outcome.to} {st.outcome.result === 'rolled-back' ? 'did not start correctly and Legion went back to the previous version' : 'was not installed'}{st.outcome.reason ? `: ${st.outcome.reason}` : ''}. <button type="button" className="btn-ghost sm" onClick={() => void act(() => request('POST', '/api/update/ack'))}>Dismiss</button></p>
      )}
      {st.outcome?.result === 'ok' && st.stopped && st.stopped.tasks.length > 0 && (
        <p className="upd-warn" role="status">Updated to {st.outcome.to}. These tasks were stopped for the restart and were not resumed: {st.stopped.tasks.map((t) => t.id).join(', ')}. Run them again from the task list. <button type="button" className="btn-ghost sm" onClick={() => void act(() => request('POST', '/api/update/ack'))}>Dismiss</button></p>
      )}
      {st.outcome?.result === 'ok' && !(st.stopped && st.stopped.tasks.length) && (
        <p className="upd-muted">Updated to {st.outcome.to}. <button type="button" className="btn-ghost sm" onClick={() => void act(() => request('POST', '/api/update/ack'))}>Dismiss</button></p>
      )}
      {a && (
        <div className="upd-card">
          <b>Version {a.version} is available</b> <span className="upd-muted">({mb(a.size)}, published {a.publishedAt.slice(0, 10)})</span>{' '}
          <a className="upd-muted" href={`https://github.com/dnh33/legion/releases/tag/v${a.version}`} target="_blank" rel="noreferrer noopener">Release notes</a>
          {a.notes && <pre className="upd-notes">{a.notes}</pre>}
          {notifyOnly && st.mode === 'checkout' && <p className="upd-muted">This is a git checkout. Update it yourself: <code>git pull</code>, <code>npm ci</code>, <code>npm run build</code>. Legion does not run these for you.</p>}
          {notifyOnly && st.mode !== 'checkout' && (a.requiresFullInstall
            ? <p className="upd-muted">This release changes dependencies, so it cannot be installed from inside Legion. Download the source of the release and run setup.cmd, as for a first install.</p>
            : <p className="upd-muted">This install cannot be updated from inside Legion ({st.mode === 'unwritable' ? 'the folder is not writable' : 'unsupported system'}).</p>)}
          {!notifyOnly && !st.staged && IDLE_FOR_INSTALL.includes(st.phase) && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act(() => request('POST', '/api/update/install'))}>Update</button>
          )}
          {st.phase === 'awaiting-approval' && <p className="upd-muted">Waiting for your answer on the update card.</p>}
          {st.phase === 'committing' && <p className="upd-muted" role="status">Installing. Legion restarts when this finishes{'…'}</p>}
          {st.phase === 'downloading' && <p className="upd-muted">Downloading and checking{st.progress ? ` (${Math.round((st.progress.bytes / st.progress.total) * 100)}%)` : ''}{'…'}</p>}
          {st.staged && (
            <div>
              <p><b>Update ready.</b> {st.readyToApply ? 'Installing now.' : 'Will install when Legion is idle, or now if you use the button below.'}</p>
              {st.busy.reasons.length > 0 && <ul className="upd-reasons">{st.busy.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              <div className="upd-actions">
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act(() => request('POST', '/api/update/install'))}>Update and install now</button>
                <button type="button" className="btn-ghost" disabled={busy || !bridge().updateRestartNow} title="Shows what will stop and asks first" onClick={() => void act(async () => { const r = await bridge().updateRestartNow!(); if (!r.ok && !r.cancelled) throw new Error(r.error ?? 'The restart did not start.'); })}>Restart now{'…'}</button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act(() => request('POST', '/api/update/cancel'))}>Cancel update</button>
              </div>
            </div>
          )}
        </div>
      )}
      {st.blocked && st.blocked.length > 0 && (
        <div className="upd-card">
          {st.blocked.map((b) => (
            <p key={b.version}>
              <b>Version {b.version} is being held back.</b>{' '}
              {b.at ? `It failed its first start on ${b.at.slice(0, 10)} and Legion went back to the previous version. ` : ''}
              {b.retryAfter
                ? `You can try it again from ${b.retryAfter.slice(0, 10)} without this button.`
                : 'Legion does not know when it will clear, so it will not clear on its own. Use the button to try it whenever you have fixed whatever stopped it.'}
            </p>
          ))}
          <div className="upd-actions">
            {st.blocked.map((b) => (
              <button key={b.version} type="button" className="btn-ghost" disabled={busy} onClick={() => void act(() => request('POST', '/api/update/retry', { version: b.version }))}>
                Try {b.version} again
              </button>
            ))}
          </div>
        </div>
      )}
      {st.error && <p className="upd-err" role="alert">{st.error}</p>}
      {err && <p className="upd-err" role="alert">{err}</p>}
      <div className="upd-actions">
        <button type="button" className="btn-ghost" disabled={busy || !st.keyConfigured} onClick={() => void act(() => request('POST', '/api/update/check'))}>Check now</button>
      </div>
      <label className="set-check"><input type="checkbox" checked={st.settings.checkEnabled} disabled={busy} onChange={(e) => void patch({ checkEnabled: e.target.checked })} /> <span>Check for updates on launch and every {st.settings.intervalHours} hours (one request to github.com; nothing else is sent)</span></label>
      <label className="set-check"><input type="checkbox" checked={st.settings.autoInstallWhenIdle} disabled={busy || st.mode !== 'apply'} onChange={(e) => { if (!e.target.checked || window.confirm(AUTO_INSTALL_TEXT)) void patch({ autoInstallWhenIdle: e.target.checked }); }} /> <span>{AUTO_INSTALL_TEXT}</span></label>
    </div>
  );
}
