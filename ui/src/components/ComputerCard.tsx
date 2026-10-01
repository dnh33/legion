import { useEffect, useRef, useState } from 'react';
import { api, openExternal } from '../api';
import { openDoctor, openEditor, toast, useStore, vmAction } from '../store';
import { clip, vmIsLive, vmLabel, vmTone } from '../util';
import { Icon } from './icons';

export function ComputerCard() {
  const agentId = useStore((s) => s.selectedAgentId);
  const agent = useStore((s) => s.agents.find((a) => a.id === s.selectedAgentId));
  const vm = useStore((s) => s.vms[s.selectedAgentId]);
  const boat = useStore((s) => s.boatConfigured);
  const state = vm?.state ?? 'none';
  const live = vmIsLive(state);
  const transition = state === 'provisioning' || state === 'archiving';
  const enabled = !!agent?.vm.enabled;
  const [shot, setShot] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [out, setOut] = useState<{ code: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const agentRef = useRef(agentId);
  agentRef.current = agentId;

  // live preview: poll every 2.5s while the VM is up and the window is visible
  useEffect(() => {
    setShot(null); setOut(null);
    if (!live) return;
    let stop = false; let t: number | undefined;
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) {
        try {
          const r = await api.screenshot(agentId);
          if (!stop && agentRef.current === agentId) setShot(`data:image/${r.format};base64,${r.data}`);
        } catch { /* 409 while booting etc. */ }
      }
      t = window.setTimeout(tick, 2500);
    };
    void tick();
    const vis = () => { if (!document.hidden) { clearTimeout(t); void tick(); } };
    document.addEventListener('visibilitychange', vis);
    return () => { stop = true; clearTimeout(t); document.removeEventListener('visibilitychange', vis); };
  }, [agentId, live]);

  const run = async () => {
    if (!cmd.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.exec(agentId, cmd);
      setOut({ code: r.exitCode, text: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trimEnd() });
    } catch (e) { setOut({ code: -1, text: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };
  const desktop = async () => {
    try { const r = await api.desktop(agentId); openExternal(r.url); } catch (e) { toast(e instanceof Error ? e.message : 'Could not open desktop', 'error'); }
  };

  if (!agent) return null;
  const blocked = !enabled ? null : !boat ? 'boat' : null;

  return (
    <section className="card computer">
      <div className="card-head">
        <Icon name="monitor" size={14} /><h4>Computer</h4>
        {enabled && boat && <span className={`pill pill-${vmTone(state)}`}><i />{vmLabel[state]}</span>}
        <span className="spacer" />
        {enabled && live && <button className="icon-btn sm" onClick={() => void desktop()} aria-label="Open desktop in boat.dev" title="Open desktop in boat.dev"><Icon name="ext" size={13} /></button>}
        {enabled && (live
          ? <button className="btn sm" onClick={() => void vmAction(agentId, 'stop')}>Stop</button>
          : <button className="btn sm primary" onClick={() => void vmAction(agentId, 'start')} disabled={!!blocked || transition}
              title={blocked ? 'Add a boat.dev API key first' : 'Start this agent\u2019s VM'}>{state === 'error' ? 'Retry' : 'Start'}</button>)}
      </div>

      {!enabled && (
        <div className="vm-note">
          <Icon name="monitor" size={14} />
          <div><b>{clip(agent.name, 28)} has no VM</b>Turn it on in the agent settings to give it a computer.
            <button className="btn-ghost sm" onClick={() => openEditor(agentId)}>Open agent settings</button></div>
        </div>
      )}
      {enabled && !boat && (
        <div className="vm-note warn">
          <Icon name="shield" size={14} />
          <div><b>boat.dev key missing</b>Add <code>boat.apiKey</code> to the config to let agents start VMs.
            <button className="btn-ghost sm" onClick={openDoctor}>Open Doctor</button></div>
        </div>
      )}
      {enabled && boat && state === 'provisioning' && (
        <div className="vm-note"><span className="spin" /><div>Booting the VM. Usually under a minute.</div></div>
      )}
      {enabled && boat && state === 'archiving' && (
        <div className="vm-note"><span className="spin" /><div>Saving a snapshot, then stopping.</div></div>
      )}
      {enabled && boat && state === 'error' && (
        <div className="vm-note bad"><Icon name="x" size={14} /><div><b>VM failed to start</b>{vm?.error ?? 'Something went wrong. Try again.'}</div></div>
      )}
      {enabled && boat && (state === 'none' || state === 'archived') && (
        <div className="vm-note">
          <Icon name="monitor" size={14} />
          <div>{state === 'none' ? `No VM yet. It starts when ${clip(agent.name, 28)} needs a computer, or press Start.` : 'Stopped. Snapshot kept, billing paused.'}</div>
        </div>
      )}

      {enabled && boat && live && (
        <>
          <div className={`screen${shot ? ' has' : ''} live`}>
            {shot ? <img src={shot} alt="Live view of the agent's VM desktop" draggable={false} /> : (
              <div className="screen-empty"><Icon name="monitor" size={20} /><span>Waiting for first frame{'\u2026'}</span></div>
            )}
            {shot && <span className="live-tag"><i />Live</span>}
          </div>
          <div className="exec">
            <span className="prompt">$</span>
            <input value={cmd} placeholder="run a command in the VM" spellCheck={false}
              onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} aria-label="VM command" />
            {busy && <span className="spin" />}
          </div>
          {out && <pre className={`exec-out${out.code ? ' fail' : ''}`}><span className="exit">exit {out.code}</span>{out.text || '(no output)'}</pre>}
          <div className="computer-meta"><span>Size {vm?.size}</span><span>Stops after {agent.vm.idleStopMinutes} min idle</span></div>
        </>
      )}
    </section>
  );
}
