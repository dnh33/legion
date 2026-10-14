import './settings.css';
import { soundEvent } from '../../sound/soundService';
import { switchEvent } from '../../sound/soundLogic';

/** `silent` is for a switch that plays its own cue. `expanded` is for a switch that opens a question before it changes anything: aria-checked stays what is true (off), aria-expanded says the question is open. */
export function Switch({ on, label, disabled, onChange, id, expanded, silent }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void; id: string; expanded?: boolean; silent?: boolean }) {
  return <button type="button" role="switch" id={id} className={'pg-sw' + (expanded ? ' asking' : '')} aria-checked={on} {...(expanded !== undefined ? { 'aria-expanded': expanded } : {})} aria-label={label} disabled={disabled} onClick={(e) => { const ev = switchEvent(!on, { trusted: e.isTrusted, expanded, silent }); if (ev) soundEvent(ev); onChange(!on); }} />;
}
