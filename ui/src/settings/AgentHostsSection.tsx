import { useEffect, useRef, useState } from 'react';
import type { AcpEntryView, AcpSwitches, AcpView } from '../../../src/shared/acp-view';
import { ACP_WATCHDOG_MAX_MINUTES, ACP_WATCHDOG_MIN_MINUTES } from '../../../src/shared/acp-view';
import { CONTAINED_NEEDS_HERMES, CONTAINED_SWITCH_HINT, CUSTOM_ENTRIES_NOTE, SWITCH_COPY, SWITCH_ORDER, loosenedSwitches } from '../../../src/shared/acp-copy';
import { PENDING_TEXT } from '../gates/useGatesView';
import { api } from '../api';
import { errText, loadSettings, runDoctor, saveSettings, toast, useStore } from '../store';
import { copyText } from '../util';
import { Icon } from '../components/icons';

/** What the last Contained check or set-up said, in the core's own words. */
export interface ContainedResult { kind: 'check' | 'setup'; ok: boolean; detail: string; signInCommand?: string }

export interface AgentHostsViewProps {
  acp: AcpView;
  /** The full check of Hermes is running (it starts Hermes once). */
  checking: boolean;
  contained: ContainedResult | null;
  containedBusy: boolean;
  onSwitch: (key: keyof AcpSwitches, on: boolean) => void;
  onWatchdog: (minutes: number) => void;
  onContained: (action: 'check' | 'setup') => void;
  /** Turns Hermes on or off (off: Hermes is not offered in the model list). */
  onToggle: (entryId: string, on: boolean) => void;
  /** The Contained switch of the Hermes entry. */
  onContainedSwitch?: (on: boolean) => void;
  onRecheck: () => void;
  /** A switch change is waiting for the native confirmation: the switches wait too. */
  switchPending?: boolean;
}

/** A web address (with or without https://) never breaks at its hyphens: it stays on one line, so it can be read and copied. */
const ADDRESS = /((?:https?:\/\/)?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*\.[A-Za-z]{2,}(?:\/[^\s,;]*[^\s,;.])?)/;
export function withLinks(text: string): React.ReactNode[] {
  return text.split(ADDRESS).map((part, i) => (i % 2 === 1 ? <span key={i} className="nb">{part}</span> : part));
}

/** One line for what Legion found: installed or not, which version, whether it starts. */
export function hostState(e: AcpEntryView, checking: boolean): { title: string; detail?: string } {
  const d = e.detection;
  const name = e.label;
  if (d.state === 'missing') return { title: `${name} is not installed`, ...(d.detail ? { detail: d.detail } : {}) };
  if (d.state === 'error') return { title: `${name} is installed but does not start`, ...(d.detail ? { detail: d.detail } : {}) };
  if (d.state === 'found' && d.checked) return { title: `${name} found${d.version ? `, version ${d.version}` : ''}` };
  if (d.state === 'found') return { title: checking ? `${name} found, checking it` : `${name} found, not checked yet` };
  return { title: checking ? `Checking ${name}` : `${name} has not been checked` };
}

export function AgentHostsView(p: AgentHostsViewProps) {
  const hermes = p.acp.entries.find((e) => e.id === 'hermes');
  const others = p.acp.entries.filter((e) => e.id !== 'hermes');
  const [mins, setMins] = useState(String(p.acp.watchdogMinutes));
  useEffect(() => { setMins(String(p.acp.watchdogMinutes)); }, [p.acp.watchdogMinutes]);
  const minsOk = /^\d+$/.test(mins) && Number(mins) >= ACP_WATCHDOG_MIN_MINUTES && Number(mins) <= ACP_WATCHDOG_MAX_MINUTES;
  const state = hermes ? hostState(hermes, p.checking) : undefined;
  // Hermes is not found on PATH: Contained has nothing to set up or check, and an old result would contradict the row above it.
  const missing = hermes?.detection.state === 'missing';
  const dot = !hermes ? 'idle' : hermes.detection.state === 'found' && hermes.detection.checked ? 'ok' : hermes.detection.state === 'error' ? 'bad' : 'idle';
  return (
    <div className="set-section hosts">
      <header className="set-head"><h3>Agent hosts</h3><p>Other agents Legion can run for you. Hermes is optional: Claude works without it.</p></header>
      {hermes && state && (
        <div className="set-card" aria-label="Hermes">
          <div className="host-row">
            <span className={`host-dot ${dot}`} aria-hidden="true" />
            <div className="host-main">
              <b>Hermes</b>
              <span className="set-hint" role="status">{withLinks(state.detail?.startsWith(state.title) ? state.detail : `${state.title}.${state.detail ? ` ${state.detail}` : ''}`)}</span>
            </div>
            <button type="button" className="btn sm" onClick={p.onRecheck} disabled={p.checking}>{p.checking ? 'Checking…' : 'Check again'}</button>
          </div>
          <label className="set-check"><input type="checkbox" checked={hermes.enabled} onChange={(e) => p.onToggle(hermes.id, e.target.checked)} />
            <span><b>Offer Hermes in the model list</b><em>When Hermes is found, you can pick it for an agent.</em></span></label>
          <label className="set-check"><input type="checkbox" checked={hermes.contained === true} disabled={missing} onChange={(e) => p.onContainedSwitch?.(e.target.checked)} />
            <span><b>Contained</b><em>{missing ? CONTAINED_NEEDS_HERMES : CONTAINED_SWITCH_HINT}</em></span></label>
          {hermes.contained === true && !missing && (
            <div className="host-contained">
              <div className="host-actions">
                <button type="button" className="btn sm" onClick={() => p.onContained('setup')} disabled={p.containedBusy}>Set up</button>
                <button type="button" className="btn-ghost sm" onClick={() => p.onContained('check')} disabled={p.containedBusy}>Check</button>
                {p.containedBusy && <span className="set-hint" role="status">Working{'…'}</span>}
              </div>
              {p.contained && <p className="set-hint" role="status">{p.contained.detail}</p>}
              {p.contained?.signInCommand && (
                <div className="cmd fix"><code>{p.contained.signInCommand}</code><button type="button" className="btn-ghost sm" onClick={() => void copyText(p.contained!.signInCommand!)}><Icon name="copy" size={12} /> Copy</button></div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="set-card">
        <div className="host-head"><h4>In between</h4>
          <p className="set-hint">Hermes asks you its own questions and Legion passes them on as Hermes wrote them. These four change that, and every one is off until you turn it on.</p></div>
        {SWITCH_ORDER.map((k) => (
          <label key={k} className="set-check"><input type="checkbox" checked={p.acp.switches[k]} disabled={p.switchPending === true} onChange={(e) => p.onSwitch(k, e.target.checked)} />
            <span><b>{SWITCH_COPY[k].label}</b><em>{SWITCH_COPY[k].hint}</em></span></label>
        ))}
        {p.switchPending === true && <p className="set-hint" role="status">{PENDING_TEXT}</p>}
        <div className="set-field"><label className="set-label" htmlFor="hosts-watchdog">Watchdog minutes</label>
          <input id="hosts-watchdog" className="narrow" inputMode="numeric" value={mins} spellCheck={false} aria-invalid={!minsOk}
            onChange={(e) => setMins(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={() => { if (!minsOk) setMins(String(p.acp.watchdogMinutes)); else if (Number(mins) !== p.acp.watchdogMinutes) p.onWatchdog(Number(mins)); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <span className="set-hint">Legion stops a Hermes task that has been quiet this long. {ACP_WATCHDOG_MIN_MINUTES} to {ACP_WATCHDOG_MAX_MINUTES}.</span></div>
      </div>
      <div className="set-card">
        <div className="host-head"><h4>Other agent hosts</h4></div>
        {others.length === 0 ? <p className="set-hint">None added.</p> : (
          <ul className="host-list">{others.map((e) => <li key={e.id}><b>{e.label}</b> <code>{[e.command, ...e.args].join(' ')}</code> <span className="chip-pill">{e.enabled ? 'On' : 'Off'}</span></li>)}</ul>
        )}
        <p className="set-hint">{CUSTOM_ENTRIES_NOTE} Edit the config file (Doctor shows where it is), then restart Legion.</p>
      </div>
    </div>
  );
}

/** The Settings page: the full check of Hermes runs when it opens (it starts Hermes once, and only here, in the Doctor and when a run starts). */
export function AgentHostsSection() {
  const settings = useStore((s) => s.settings);
  const [checking, setChecking] = useState(true);
  const [contained, setContained] = useState<ContainedResult | null>(null);
  const [containedBusy, setContainedBusy] = useState(false);
  const [switchPending, setSwitchPending] = useState(false);
  const alive = useRef(true);
  const check = async (): Promise<void> => {
    setChecking(true);
    try { await runDoctor(true); await loadSettings(); } finally { if (alive.current) setChecking(false); }
  };
  useEffect(() => { alive.current = true; void check(); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!settings) return <div className="set-section"><p className="set-hint" role="status">Loading{'…'}</p></div>;
  const save = async (patch: Parameters<typeof saveSettings>[0]): Promise<void> => { try { await saveSettings(patch, true); } catch (e) { toast(errText(e), 'error'); } };
  // R63: a switch that lets Hermes ask less goes through the app's native confirmation; one that keeps or tightens saves directly. Without the app (a plain browser) a loosening is refused here and by the core.
  const saveSwitch = async (k: keyof AcpSwitches, on: boolean): Promise<void> => {
    const patch = { [k]: on } as Partial<AcpSwitches>;
    const bridge = window.legion?.acpSwitchChange;
    if (!bridge) {
      if (loosenedSwitches(settings.acp.switches, patch).length > 0) { toast('This change needs the Legion app window, which asks you to confirm it.', 'error'); return; }
      await save({ acp: { switches: patch } });
      return;
    }
    setSwitchPending(loosenedSwitches(settings.acp.switches, patch).length > 0);
    try {
      const r = await bridge({ switches: patch });
      if (r.ok) await loadSettings();
      else toast(r.cancelled ? 'Not changed. You cancelled it.' : (r.error ?? 'The change failed.'), r.cancelled ? 'info' : 'error');
    } catch (e) { toast(errText(e), 'error'); } finally { if (alive.current) setSwitchPending(false); }
  };
  const runContained = async (action: 'check' | 'setup'): Promise<void> => {
    setContainedBusy(true);
    try {
      const r = await api.acpContained(action);
      const ok = action === 'setup' ? r.ok === true : r.exists === true && r.policyOk === true;
      setContained({ kind: action, ok, detail: r.detail ?? '', ...(r.signInCommand ? { signInCommand: r.signInCommand } : {}) });
    } catch (e) { setContained({ kind: action, ok: false, detail: errText(e) }); } finally { setContainedBusy(false); }
  };
  return (
    <AgentHostsView acp={settings.acp} checking={checking} contained={contained} containedBusy={containedBusy}
      switchPending={switchPending} onSwitch={(k, on) => void saveSwitch(k, on)}
      onWatchdog={(n) => void save({ acp: { watchdogMinutes: n } })}
      onToggle={(id, on) => void save({ acp: { entries: [{ id, enabled: on }] } })}
      onContainedSwitch={(on) => void save({ acp: { entries: [{ id: 'hermes', contained: on }] } })}
      onContained={(a) => void runContained(a)} onRecheck={() => void check()} />
  );
}
