import { BSV_TIP, requestToggle, useBsv } from './bsvStore';
import './bsv.css';

/** Title-bar switch for BSV mode. Sits in .tb-right, left of the Doctor button. */
export function BsvChip() {
  const on = useBsv((s) => s.enabled);
  const busy = useBsv((s) => s.busy);
  return (
    <span className="tb-bsv-slot">
      <button
        type="button" role="switch" aria-checked={on} aria-label="BSV Dev Kit"
        className={`tb-bsv${on ? ' on' : ''}`} title={BSV_TIP} disabled={busy} onClick={requestToggle}
      >
        <span className="tb-bsv-label">BSV</span>
        <i className="tb-bsv-track" aria-hidden="true" />
      </button>
    </span>
  );
}
