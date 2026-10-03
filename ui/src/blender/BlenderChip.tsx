import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { openSettings } from '../store';
import { requestEnableBlender, saveBlenderConfig, useBlender } from './blenderStore';
import { BLENDER_CHIP_TIP, chipModel, type ChipModel } from './chipModel';
import './blender.css';

/** The popover under the pill: what Blender is doing, one labelled switch, and the way to Settings. Exported for the tests. */
export function BlenderPopover({ m, onSettings }: { m: ChipModel; onSettings: () => void }) {
  return (
    <div className="bl-pop" role="group" aria-label="Blender">
      <div className="bl-pop-status"><i className={`bl-dot tone-${m.tone}`} aria-hidden="true" /><span>{m.label}</span></div>
      <button
        type="button" role="switch" aria-checked={m.enabled} disabled={m.switchDisabled} className={`bl-pop-switch${m.enabled ? ' on' : ''}`}
        onClick={() => { if (m.enabled) void saveBlenderConfig({ enabled: false }); else requestEnableBlender(); }}
      >
        <span className="bl-pop-switch-text">Turn on the Blender bridge</span>
        <i className="bl-track" aria-hidden="true" />
      </button>
      <p className="bl-pop-tip">{BLENDER_CHIP_TIP}</p>
      <button type="button" className="btn sm bl-pop-settings" onClick={onSettings}>{m.settingsText}</button>
    </div>
  );
}

/**
 * Title-bar entry for the Blender bridge: one quiet pill (cube, status dot, the word Blender) in the Doctor button's style. It opens a small
 * popover with the status, the enable switch and a link to Settings, Blender (it never starts a download). Turning ON goes through the same
 * "Turn on Blender?" dialog as Settings (requestEnableBlender); turning OFF is saveBlenderConfig({ enabled: false }), as in Settings.
 * Renders nothing when the core has no Blender module. Sits in .tb-right after the BSV chip.
 */
export function BlenderChip() {
  const status = useBlender((s) => s.status);
  const loaded = useBlender((s) => s.loaded);
  const failed = useBlender((s) => s.failed);
  const absent = useBlender((s) => s.absent);
  const busy = useBlender((s) => s.busy !== null);
  const m = chipModel({ status, loaded, failed, absent, busy });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  // say a state change out loud only when it matters: skip the first answer, "unknown" and a script starting
  const prev = useRef<string | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (m.tone === 'unknown') { prev.current = null; return; }
    if (prev.current !== null && prev.current !== m.label && m.announce) setSaid(m.label);
    prev.current = m.label;
  }, [m.label, m.tone, m.announce]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { const t = e.target as HTMLElement; if (!box.current?.contains(t) && !t.closest('.modal, .scrim')) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.scrim')) { setOpen(false); pill.current?.focus(); } };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  if (!m.visible) return null;
  return (
    <span className="tb-bl" ref={box}>
      <button
        ref={pill} type="button" className={`tb-bl-pill${open ? ' open' : ''}`} aria-haspopup="true" aria-expanded={open} aria-label={m.actionLabel} title={m.title}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="cube" size={14} />
        <i className={`bl-dot tone-${m.tone}`} aria-hidden="true" />
        <span className="tb-bl-word">Blender</span>
      </button>
      {open && <BlenderPopover m={m} onSettings={() => { setOpen(false); openSettings('blender'); }} />}
      <span className="sr-only" role="status" aria-live="polite">{said}</span>
    </span>
  );
}
