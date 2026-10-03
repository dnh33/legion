import { openSettings, useStore } from '../store';
import { Icon } from '../components/icons';
import { visibleNotices } from './copy';
import { lightLabel, runBlenderLaunch, useBlender } from './blenderStore';
import './blender.css';

/** The Blender status light in the Ops panel, in the Computer card's style. Hidden while the bridge is off unless the Sculptor is selected. */
export function BlenderCard() {
  const st = useBlender((s) => s.status);
  const busy = useBlender((s) => s.busy);
  const selAgent = useStore((s) => s.selectedAgentId);
  if (!st) return null;
  if (!st.enabled && selAgent !== 'sculptor') return null;
  const { label, tone } = lightLabel(st.light);
  const live = st.connected;
  const notices = visibleNotices(st);

  return (
    <section className="card computer blender-card" aria-label="Blender">
      <div className="card-head">
        <Icon name="cube" size={14} /><h4>Blender</h4>
        <span className={`pill pill-${tone === 'off' ? 'off' : tone}`} role="status"><i />{label}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => openSettings('blender')}>{st.enabled ? 'Settings' : 'Turn on'}</button>
      </div>
      {!st.enabled && (
        <div className="vm-note"><Icon name="cube" size={14} /><div><b>Off</b>The Sculptor builds in Blender through Legion's guarded bridge. Turn it on in Settings to let it.</div></div>
      )}
      {st.enabled && (
        <div className={`vm-note${tone === 'bad' ? ' bad' : tone === 'warn' ? ' warn' : ''}`}>
          <Icon name={tone === 'bad' ? 'x' : tone === 'warn' ? 'shield' : 'check'} size={14} />
          <div>
            {st.summary}
            {(st.light === 'needs-setup') && <button className="btn-ghost sm" onClick={() => openSettings('blender')}>Set up in Settings</button>}
            {(st.light === 'disconnected') && <button className="btn-ghost sm" onClick={() => void runBlenderLaunch()} disabled={busy !== null}>Launch Blender</button>}
          </div>
        </div>
      )}
      {st.enabled && notices.length > 0 && (
        <ul className="bl-notices" aria-label="Limits and warnings">{notices.map((n, i) => <li key={i}>{n}</li>)}</ul>
      )}
      {st.enabled && (
        <div className="bl-meta">
          <span>Local: {st.localReady ? 'ready' : 'not found'}</span>
          <span>Cloud VM: {st.sandbox === 'off' ? 'off' : st.sandboxReady ? 'ready' : 'not ready'}</span>
          <span>Live: {live ? `connected (${st.chosenBackend ?? ''} backend)` : 'not connected'}</span>
          {st.busy && <span>Running a script ({st.busy.mode === 'sandbox' ? 'cloud VM' : st.busy.mode})</span>}
          {(st.stats.approved + st.stats.denied + st.stats.blocked > 0) && <span>{st.stats.approved} ok {'·'} {st.stats.denied} denied {'·'} {st.stats.blocked} blocked</span>}
        </div>
      )}
    </section>
  );
}
