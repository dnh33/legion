import { Icon } from '../components/icons';
import { BSV_TIP, openBsvPanel, requestToggle, useBsv } from './bsvStore';
import './bsv.css';

/** Title-bar switch for BSV mode, plus (while on) a small Panel button. Sits in .tb-right, left of the Doctor button. */
export function BsvChip() {
  const on = useBsv((s) => s.enabled);
  const busy = useBsv((s) => s.busy);
  const live = useBsv((s) => !!s.policy && s.policy.armed && !s.policy.frozen);
  return (
    <span className="tb-bsv-slot">
      {on && <button type="button" className="tb-bsv-panel" data-live={live ? '1' : undefined} title="Wallet status, live funds, freeze and activity" aria-label="Open the BSV panel" onClick={openBsvPanel}>PANEL</button>}
      <button
        type="button" role="switch" aria-checked={on} aria-label="BSV Dev Kit"
        className={`tb-bsv${on ? ' on' : ''}`} title={BSV_TIP} disabled={busy} onClick={requestToggle}
      >
        <Icon name="bitcoin" size={14} />
        <span className="tb-bsv-label">BSV</span>
        <i className="tb-bsv-track" aria-hidden="true" />
      </button>
    </span>
  );
}
