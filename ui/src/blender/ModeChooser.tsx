import { CHOOSER_OPTIONS, CHOOSER_TEXT, CHOOSER_TITLE, chooserDefault } from './copy';
import { saveBlenderConfig, useBlender } from './blenderStore';

/**
 * One-time chooser at the top of the first Blender approval card. It never replaces Allow or Deny. The click goes through the normal settings
 * route (admin), is saved as the mode and ends the question; a model-supplied `mode` argument never reaches this path.
 */
export function ModeChooser() {
  const st = useBlender((x) => x.status);
  const busy = useBlender((x) => x.busy);
  if (!st || !st.enabled || st.modeAsked) return null;
  const pre = chooserDefault(st);
  return (
    <div className="bl-chooser" role="group" aria-label={CHOOSER_TITLE}>
      <b>{CHOOSER_TITLE}</b>
      <div className="bl-chooser-row">
        {CHOOSER_OPTIONS.map((o) => (
          <button key={o.mode} type="button" className={`btn sm${o.mode === pre ? ' suggested' : ''}`} title={o.mode === pre ? 'Suggested for this computer' : undefined} aria-label={o.mode === pre ? `${o.label} (suggested)` : undefined} disabled={busy !== null} onClick={() => void saveBlenderConfig({ mode: o.mode })}>{o.label}</button>
        ))}
      </div>
      <span className="muted-s">{CHOOSER_TEXT}</span>
    </div>
  );
}
