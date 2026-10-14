import { useCallback, useEffect, useState } from 'react';
import { request } from '../api';
import { errText } from '../store';
import { notificationsLine, quietProblem } from './awayLogic';
import type { QuietView } from './awayLogic';
import './away.css';

interface AppAway { quiet: QuietView; notify: { enabled: boolean; returnSummary: boolean } }

/** Settings, Notifications: popups for what needs you, and quiet hours. Stored by the core (/api/away), read by the desktop shell. */
export function NotificationsSection() {
  const [app, setApp] = useState<AppAway | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [quiet, setQuiet] = useState<QuietView | null>(null);
  const load = useCallback(async () => {
    try { const v = await request<{ app: AppAway }>('GET', '/api/away'); setApp(v.app); setQuiet(v.app.quiet); setErr(null); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const patch = async (body: Record<string, unknown>): Promise<void> => {
    try { const v = await request<AppAway>('PATCH', '/api/away/app', body); setApp(v); setQuiet(v.quiet); setErr(null); } catch (e) { setErr(errText(e)); void load(); }
  };
  const problem = quiet ? quietProblem(quiet) : null;
  const changeQuiet = (next: QuietView): void => {
    setQuiet(next);
    if (!quietProblem(next)) void patch({ quiet: next });
  };

  return (
    <div className="set-section away-section">
      <header className="set-head" data-tip="settings-notifications"><h3>Notifications</h3><p>Legion puts a mark on its taskbar button and shows a pop-up when something needs you. A pop-up never shows what an agent wrote or the command it wants to run.</p></header>
      {err && <p className="set-error" role="alert">{err}</p>}
      {!app && !err && <div className="set-loading"><span className="spin" /> Loading{'…'}</div>}
      {app && quiet && (
        <>
          <label className="set-check">
            <input type="checkbox" checked={app.notify.enabled} onChange={(e) => void patch({ notify: { enabled: e.target.checked } })} />
            <span><b>Pop-ups when something needs you</b><em>An approval, a question, a run that failed, a run waiting for you, or a budget reached. The mark on the Legion button stays on either way. Each project can ask for fewer or more in its own settings.</em></span>
          </label>
          <label className="set-check">
            <input type="checkbox" checked={app.notify.returnSummary} onChange={(e) => void patch({ notify: { returnSummary: e.target.checked } })} />
            <span><b>Summary when you come back</b><em>After 30 minutes or more away from Legion, one line: what needs you, what failed, what was spent.</em></span>
          </label>
          <fieldset className="away-quiet">
            <legend>Quiet hours</legend>
            <label className="set-check">
              <input type="checkbox" checked={quiet.enabled} onChange={(e) => changeQuiet({ ...quiet, enabled: e.target.checked })} />
              <span><b>Keep pop-ups quiet at night</b><em>No pop-ups in this window. Asks keep waiting, and their wait clock pauses.</em></span>
            </label>
            <div className="away-times">
              <label>From <input type="time" value={quiet.from} disabled={!quiet.enabled} onChange={(e) => changeQuiet({ ...quiet, from: e.target.value })} aria-describedby="away-quiet-line" /></label>
              <label>To <input type="time" value={quiet.to} disabled={!quiet.enabled} onChange={(e) => changeQuiet({ ...quiet, to: e.target.value })} aria-describedby="away-quiet-line" /></label>
            </div>
            <p id="away-quiet-line" className={problem ? 'set-error' : 'set-hint'} role={problem ? 'alert' : undefined}>{problem ?? notificationsLine(quiet)}</p>
          </fieldset>
        </>
      )}
    </div>
  );
}
