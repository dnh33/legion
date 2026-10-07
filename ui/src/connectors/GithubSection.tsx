import { useCallback, useEffect, useState } from 'react';
import { openExternal, request } from '../api';
import { errText } from '../store';
import { storageLine } from '../../../src/shared/connectors-view';
import type { GithubConnectionView, GithubStatusView } from '../../../src/shared/connectors-view';

type Native = { connectorConnect?: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }> };

/** Settings, Connectors, GitHub. Everything from the core is shown as plain text. The sign-in is started by the app's main process (src/electron/connector-ipc.ts). */
export function GithubSection() {
  const [st, setSt] = useState<GithubStatusView | null>(null);
  const [conn, setConn] = useState<GithubConnectionView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const load = useCallback(async () => {
    try {
      const s = await request<GithubStatusView>('GET', '/api/connectors/github');
      setSt(s);
      if (s.signedIn) {
        setRemoved(false);
        try { setConn(await request<GithubConnectionView>('GET', '/api/connectors/github/connection')); } catch { setConn(null); }
      } else setConn(null);
    } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // while a sign-in is waiting for the owner on GitHub, look again every two seconds
  const pending = st?.flow.phase === 'pending';
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [pending, load]);

  const connect = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const fn = (window as unknown as { legion?: Native }).legion?.connectorConnect;
      if (!fn) throw new Error('Connecting needs the Legion app window (it shows a confirmation dialog). Open Legion from its shortcut.');
      const r = await fn();
      if (r.cancelled) setNote('Cancelled. Nothing changed.'); else if (!r.ok) throw new Error(r.error ?? 'The connect failed.');
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); void load(); }
  };
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); setNote(null); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); void load(); } };

  if (!st) return <div className="set-section">{err ? <p className="set-error" role="alert">{err}</p> : <div className="set-loading"><span className="spin" /> Loading{'…'}</div>}</div>;
  const f = st.flow;
  return (
    <div className="set-section" aria-label="GitHub">
      <div className="set-head"><h3>GitHub</h3><p>Let agents read your repositories, issues, pull requests and CI runs. Read only.</p></div>
      <p className="set-note">An agent can use GitHub only after you turn it on for that agent (agent editor, Connectors). Everything GitHub returns is text other people wrote, so a run that reads it is marked as having read outside content. Runs started from Claude Code, Cowork or another MCP client cannot use connectors.</p>
      {err && <p className="set-error" role="alert">{err}</p>}
      {note && <p className="set-note" role="status">{note}</p>}
      {!st.available && !st.signedIn && (
        <p className="set-note" role="status"><b>Not available yet.</b> The Legion GitHub App is not registered in this build, so signing in is switched off. Anonymous reads of public repositories still work.</p>
      )}
      {st.signedIn ? (
        <div role="status" aria-label="Connected">
          <p><b>Connected</b>{conn?.login ? <> as <code>{conn.login}</code></> : null}. {storageLine(st.storage)}</p>
          {conn
            ? <ul className="set-list">
              <li>Permissions: {conn.permissions && Object.keys(conn.permissions).length ? Object.entries(conn.permissions).map(([k, v]) => `${k} (${v})`).join(', ') : 'not reported'}</li>
              <li>Rate limit: {conn.rate.remaining} of {conn.rate.limit} requests left{conn.rate.limit ? `, resets ${conn.rate.resetAt.replace('T', ' ').slice(0, 16)} UTC` : ''}</li>
            </ul>
            : <p className="set-note">Could not read the connection from GitHub right now.</p>}
          <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void act(async () => { await request('POST', '/api/connectors/github/disconnect'); setRemoved(true); })}>Disconnect</button>
        </div>
      ) : f.phase === 'pending' ? (
        <div role="status" aria-label="Sign-in waiting">
          <p>On GitHub, enter this code:</p>
          <p aria-label="Your code"><code style={{ fontSize: '1.6em', letterSpacing: '0.12em' }}>{f.userCode}</code></p>
          <button type="button" className="btn sm" onClick={() => openExternal(f.verificationUri)}>Open GitHub</button>{' '}
          <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void act(() => request('POST', '/api/connectors/github/cancel'))}>Cancel</button>
          <p className="set-note">Legion is waiting for you to approve it on GitHub. The code works for a few minutes.</p>
        </div>
      ) : (
        <div>
          {f.phase === 'failed' && <p className="set-error" role="alert">{f.message}</p>}
          {st.storage === 'sign-in-again' && <p className="set-note" role="status">{storageLine('sign-in-again')}</p>}
          <button type="button" className="btn sm" disabled={busy || !st.available} title={st.available ? '' : 'Not available yet'} onClick={() => void connect()}>Connect GitHub</button>
          {st.key === 'missing' && st.available && <p className="set-note">The first connect restarts Legion Core once, to store the sign-in encrypted. Legion asks first.</p>}
        </div>
      )}
      {removed && !st.signedIn && (
        <p className="set-note" role="status">Removed here. To revoke the grant at GitHub, open <button type="button" className="btn-ghost sm" onClick={() => openExternal(st.revokeUrl)}>github.com/settings/applications</button>.</p>
      )}
    </div>
  );
}
