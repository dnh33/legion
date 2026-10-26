import { useState } from 'react';
import type { SettingsView, TaintConfig } from '../../../src/shared/types';
import { errText, saveSettings } from '../store';
import { OUTSIDE_TEXT_COPY } from './outsideTextLogic';

/**
 * Settings, Gates: what marks a run as having read outside text. Two controls and a one-time notice. Saves at once, like the rest of the page.
 * The notice tells an updated install that the default changed, with a way back in one click.
 */
export function OutsideText({ s }: { s: SettingsView }) {
  const t: TaintConfig = s.taint ?? { shell: 'local', outsideFiles: true, noticeSeen: false };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<TaintConfig>) => {
    setBusy(true); setError(null);
    try { await saveSettings({ taint: patch }); } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const C = OUTSIDE_TEXT_COPY;
  return (
    <div className="gates-outside" aria-label={C.title}>
      <h3 className="gates-trust-h">{C.title}</h3>
      <p className="muted-s">{C.lead}</p>
      {!t.noticeSeen && (
        <div className="gates-outside-notice" role="note">
          <p>{C.notice}</p>
          <div className="gates-outside-btns">
            <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void save({ noticeSeen: true })}>{C.keep}</button>
            <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void save({ noticeSeen: true, shell: 'strict' })}>{C.useStrict}</button>
          </div>
        </div>
      )}
      <div role="radiogroup" aria-label={C.shellLabel} className="gates-outside-opts">
        {(['local', 'strict'] as const).map((v) => (
          <label key={v} className="gates-outside-opt">
            <input type="radio" name="taint-shell" checked={t.shell === v} disabled={busy} onChange={() => void save({ shell: v })} />
            <span><b>{C.shell[v].name}</b><span className="muted-s">{C.shell[v].help}</span></span>
          </label>
        ))}
      </div>
      <div className="gates-outside-row">
        <div><b>{C.filesName}</b><span className="muted-s">{C.filesHelp}</span></div>
        <label className="set-check"><input type="checkbox" checked={t.outsideFiles} disabled={busy} aria-label={C.filesName} onChange={(e) => void save({ outsideFiles: e.target.checked })} /><span>On</span></label>
      </div>
      <p className="muted-s">{C.limits}</p>
      {error && <p className="gates-err" role="alert">{error}</p>}
    </div>
  );
}
