import { useEffect, useMemo, useRef, useState } from 'react';
import { api, openExternal } from '../api';
import { openEditor, openSettings, refreshBoatHealth, toast, useStore, vmAction } from '../store';
import { clip, vmIsLive, vmLabel, vmTone } from '../util';
import { RATES_TTL_MS, usageLine, vmUsage } from '../../../src/shared/vm-usage';
import { Icon } from './icons';

/** Re-render every 30 s while `on` so the "up for" line moves. A timer, not an animation. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => { setNow(Date.now()); refreshBoatHealth(RATES_TTL_MS / 2); }, 30_000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

export function ComputerCard() {
  const agentId = useStore((s) => s.selectedAgentId);
  const agent = useStore((s) => s.agents.find((a) => a.id === s.selectedAgentId));
  const vm = useStore((s) => s.vms[s.selectedAgentId]);
  const boat = useStore((s) => s.boatConfigured);
  const health = useStore((s) => s.boatHealth);
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
  const now = useNow(enabled && boat);

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

  // Memoised: the card re-renders often, the numbers only change with the record, the 30 s tick or the prices. The prices come from a
  // cached copy (health): past the TTL they are not used, the cost shows as unknown until a fresh copy arrives.
  const ratesAsOf = health ? Date.parse(health.asOf) : undefined;
  const usage = useMemo(() => (vm ? vmUsage(vm, now, health?.rates, health?.currency ?? '', Number.isNaN(ratesAsOf) ? undefined : ratesAsOf) : null), [vm, now, health?.rates, health?.currency, ratesAsOf]);
  if (!agent) return null;
  const blocked = !enabled ? null : !boat ? 'boat' : null;
  const showUsage = enabled && boat && usage && (usage.running || usage.todaySeconds > 0);
  const refused = health?.forbidden ?? [];
  const claudeOff = health?.claude.state === 'not_configured';

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
          <div><b>boat.dev key missing</b>Add your boat.dev API key to let agents start VMs.
            <button className="btn-ghost sm" onClick={() => openSettings('boat')}>Add key in Settings</button></div>
        </div>
      )}
      {enabled && boat && vm?.notice && state !== 'error' && (
        <div className="vm-note warn"><Icon name="shield" size={14} /><div><b>{vm.requestedSize ? `Running at ${vm.size} size` : 'Note'}</b>{vm.notice}</div></div>
      )}
      {enabled && boat && refused.length > 0 && (
        <div className="vm-note warn">
          <Icon name="shield" size={14} />
          <div><b>This boat.dev key is limited</b>It cannot {refused.map((f) => f.action).join(', ')}. Create a full-access key in boat.dev and paste it in Settings.
            <button className="btn-ghost sm" onClick={() => openSettings('boat')}>Open boat.dev settings</button></div>
        </div>
      )}
      {enabled && boat && claudeOff && (
        <div className="vm-note">
          <Icon name="monitor" size={14} />
          <div><b>Claude is not configured on boat.dev</b>Open the Agents page in your boat.dev dashboard to connect it. Until then the vm_claude tool is off.
            <button className="btn-ghost sm" onClick={() => openExternal('https://boat.dev/')}>Open boat.dev</button></div>
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

      {showUsage && usage && (
        <div className="vm-usage" title="Measured by Legion from ready to stop. boat.dev's own billing may differ.">
          <span>{usageLine(usage)}</span>{usage.estimate && <em>estimate</em>}{usage.estimateNote && <em title={usage.estimateNote}>cost unknown</em>}
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
