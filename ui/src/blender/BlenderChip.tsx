import { useEffect, useRef, useState } from 'react';
import { openSettings } from '../store';
import { requestEnableBlender, saveBlenderConfig, useBlender } from './blenderStore';
import { BLENDER_CHIP_TIP, chipModel } from './chipModel';
import './blender.css';

/**
 * Title-bar chip for the Blender bridge: a status button (opens Settings, Blender; "Get Blender" only opens Settings, it never downloads)
 * and the enable switch. Turning ON calls requestEnableBlender (the "Turn on Blender?" dialog, shared with Settings; the write is saveBlenderConfig after Confirm); turning OFF calls saveBlenderConfig directly, as Settings does.
 * Renders nothing when the core has no Blender module. Sits in .tb-right next to the BSV chip.
 */
export function BlenderChip() {
  const status = useBlender((s) => s.status);
  const loaded = useBlender((s) => s.loaded);
  const failed = useBlender((s) => s.failed);
  const absent = useBlender((s) => s.absent);
  const busy = useBlender((s) => s.busy !== null);
  const error = useBlender((s) => s.error);
  const m = chipModel({ status, loaded, failed, absent, busy });
  // say a state change out loud only when it matters: skip the first answer, "unknown" and a script starting
  const prev = useRef<string | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (m.tone === 'unknown') { prev.current = null; return; }
    if (prev.current !== null && prev.current !== m.label && m.announce) setSaid(m.label);
    prev.current = m.label;
  }, [m.label, m.tone, m.announce]);
  if (!m.visible) return null;
  return (
    <span className="tb-bl-slot" role="group" aria-label="Blender">
      <button type="button" className={`tb-bl-status tone-${m.tone}`} title={m.title} aria-label={m.actionLabel} onClick={() => openSettings('blender')}>
        <i className="tb-bl-dot" aria-hidden="true" />
        <span className="tb-bl-text">{m.text}</span>
      </button>
      <button
        type="button" role="switch" aria-checked={m.enabled} aria-label="Blender bridge"
        className={`tb-bl-switch${m.enabled ? ' on' : ''}`} title={BLENDER_CHIP_TIP} disabled={m.switchDisabled} data-error={error ? '1' : undefined}
        onClick={() => { if (m.enabled) void saveBlenderConfig({ enabled: false }); else requestEnableBlender(); }}
      >
        <span className="tb-bl-label">Blender</span>
        <i className="tb-bl-track" aria-hidden="true" />
      </button>
      <span className="sr-only" role="status" aria-live="polite">{said}</span>
    </span>
  );
}
