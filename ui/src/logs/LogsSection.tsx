import { useCallback, useEffect, useState } from 'react';
import { request } from '../api';
import { errText, toast } from '../store';
import { copyText } from '../util';
import { LOGS_DESCRIPTION } from '../../../src/shared/logs';
import type { LogsErrorsView, LogsView } from '../../../src/shared/logs';
import './logs.css';

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Settings, Logs. A neutral local record: what Legion did, in a folder the person owns. Nothing here is sent anywhere. */
export function LogsSection() {
  const [view, setView] = useState<LogsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const load = useCallback(async () => {
    try { setView(await request<LogsView>('GET', '/api/logs')); setErr(null); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const copyErrors = async () => {
    setBusy(true);
    try {
      const r = await request<LogsErrorsView>('GET', '/api/logs/errors');
      if (!r.text.trim()) { toast('No errors recorded'); return; }
      toast((await copyText(r.text)) ? 'Copied errors.log' : 'Could not copy');
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setConfirming(false);
    try { setView(await request<LogsView>('POST', '/api/logs/clear')); setErr(null); toast('Logs cleared'); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="set-section logs-section">
      <header className="set-head"><h3>Logs</h3><p>{LOGS_DESCRIPTION}</p></header>
      {err && <p className="set-error" role="alert">{err}</p>}
      {!view && !err && <div className="set-loading"><span className="spin" /> Loading{'…'}</div>}
      {view && (
        <>
          <dl className="set-about">
            <div><dt>Folder</dt><dd><code>{view.dir}</code><button type="button" className="btn-ghost sm" onClick={() => void copyText(view.dir).then((ok) => ok && toast('Copied'))}>Copy path</button></dd></div>
          </dl>
          <ul className="logs-files" aria-label="Log files">
            {view.files.length === 0 && <li className="set-hint">Nothing recorded yet.</li>}
            {view.files.map((f) => <li key={f.name}><code>{f.name}</code><span>{size(f.bytes)}</span></li>)}
          </ul>
          <div className="logs-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void copyErrors()}>Copy errors</button>
            {!confirming && <button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirming(true)}>Clear logs</button>}
            {confirming && (
              <span className="logs-confirm" role="group" aria-label="Confirm clearing the logs" onKeyDown={(e) => { if (e.key === 'Escape') setConfirming(false); }}>
                <span>Delete every log file? This cannot be undone.</span>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void clear()} autoFocus>Delete logs</button>
                <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>Keep them</button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
