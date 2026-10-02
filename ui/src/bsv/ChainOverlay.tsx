import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { formatCountdown, overlayModel, remainingMs } from '../../../src/shared/bsv-view';
import { BsvPanel } from './BsvPanel';
import { cancelConfirm, changePolicy, confirmEnable, loadPolicy, openBsvPanel, useBsv } from './bsvStore';
import './bsv.css';

/** Five short lines for the first-enable dialog (kept as data so the copy is easy to review). */
const CONFIRM_LINES = [
  'Turns on: the Assayer in the rail and the BSV knowledge pack.',
  'Testnet knowledge mode, shown by a calm cyan line along the title bar.',
  'The Assayer gets one read-only check that asks a wallet on this computer which network it claims. Legion has no spend tool: nothing signs, sends or holds funds. Never paste a seed phrase.',
  'Approvals and settings need this window. A bot that runs shell commands as you could still read your files or reach your wallet directly: a VM or a separate account is the real wall.',
  'Turn it off any time with the BSV switch in the title bar.',
];

function Confirm() {
  return (
    <Modal
      title="Turn on BSV mode?" width={520} onClose={cancelConfirm}
      footer={<>
        <span style={{ flex: 1 }} />
        <button className="btn-ghost" data-autofocus onClick={cancelConfirm}>Cancel</button>
        <button className="btn primary" onClick={confirmEnable}>Turn on BSV mode</button>
      </>}
    >
      <ul className="bsv-confirm">{CONFIRM_LINES.map((l) => <li key={l}>{l}</li>)}</ul>
    </Modal>
  );
}

type Ticker = { left: number; width: number; lines: string[] } | null;

/**
 * Where the ticker sits: centred in the free gap between the search box and the right-hand controls.
 * Measured, never laid out: the overlay is position:fixed and does not touch the header's own layout.
 * `tiers` are the candidate texts, longest first; the first that fits is shown.
 */
function useTickerSlot(active: boolean, tiers: string[][]): Ticker {
  const [slot, setSlot] = useState<Ticker>(null);
  const key = JSON.stringify(tiers);
  useLayoutEffect(() => {
    if (!active || !tiers.length) { setSlot(null); return; }
    const measure = () => {
      const search = document.querySelector('.tb-search')?.getBoundingClientRect();
      const right = document.querySelector('.tb-right')?.getBoundingClientRect();
      if (!search || !right) { setSlot(null); return; }
      const left = search.right + 14;
      const width = right.left - 14 - left;
      const CH = 6.2; // ~ advance of the 9.5px monospace face plus letter spacing
      const fits = (lines: string[]) => width >= Math.max(...lines.map((t) => t.length)) * CH;
      const lines = tiers.find(fits);
      setSlot(lines ? { left, width, lines } : null);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    const bar = document.querySelector('.titlebar');
    if (ro && bar) ro.observe(bar);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return slot;
}

/**
 * The armed countdown: the ONLY timer in the BSV UI besides the 60 s status poll. It ticks once a second, only while mainnet is armed
 * and the window is visible and focused, and only this small leaf re-renders. When it reaches zero it asks the core once; the core
 * has disarmed by itself by then.
 */
function Countdown({ until }: { until: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const asked = useRef(false);
  useEffect(() => {
    let id: number | undefined;
    const stop = () => { if (id !== undefined) { window.clearInterval(id); id = undefined; } };
    const run = () => {
      stop();
      setNow(Date.now());
      if (!document.hidden && document.hasFocus()) id = window.setInterval(() => setNow(Date.now()), 1000);
    };
    run();
    window.addEventListener('focus', run); window.addEventListener('blur', stop); document.addEventListener('visibilitychange', run);
    return () => { stop(); window.removeEventListener('focus', run); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', run); };
  }, [until]);
  const left = until === null ? 0 : Math.max(0, until - now);
  useEffect(() => { asked.current = false; }, [until]);
  useEffect(() => { if (until !== null && left <= 0 && !asked.current) { asked.current = true; void loadPolicy(); } }, [left, until]);
  return <time className="bsv-count" aria-label={`${formatCountdown(left)} left`}>{formatCountdown(left)}</time>;
}

/**
 * Chain-mode overlay. Everything here is STATIC: no animation, no gradient sweep, no breathing glow. A calm cyan hairline along the
 * bottom edge of the title bar on testnet; an amber frame around the window and an amber line while LIVE FUNDS is armed; a pill with
 * the Freeze chain button whenever armed or something is pending. It never intercepts the pointer except on the pill's own buttons.
 * Also hosts the first-enable confirmation dialog and the BSV panel.
 */
export function ChainOverlay() {
  const on = useBsv((s) => s.enabled);
  const confirm = useBsv((s) => s.confirmOpen);
  const panel = useBsv((s) => s.panelOpen);
  const nodes = useBsv((s) => s.knowledgeNodes);
  const loaded = useBsv((s) => s.knowledgeLoaded);
  const policy = useBsv((s) => s.policy);
  const wallet = useBsv((s) => s.wallet);
  const changing = useBsv((s) => s.changing);
  const model = useMemo(() => overlayModel({ enabled: on, policy, wallet, nodes, knowledgeLoaded: loaded, now: Date.now() }), [on, policy, wallet, nodes, loaded]);
  const slot = useTickerSlot(on, model.tiers);
  return (
    <>
      {on && (
        <div className="chain-overlay" data-chain={model.mode} data-warn={model.mainnetWarning ? '1' : undefined} aria-hidden="true">
          <i className="chain-line" />
          {slot && (
            <div className="chain-ticker" style={{ left: slot.left, width: slot.width }}>
              {slot.lines.map((l, i) => <span key={i}>{l}</span>)}
            </div>
          )}
        </div>
      )}
      {on && model.mode === 'armed' && <div className="live-border" aria-hidden="true" />}
      {on && model.pill && !panel && (
        <div className={`bsv-pill ${model.pill.kind}`} role={model.pill.kind === 'armed' ? 'alert' : 'status'} data-pill={model.pill.kind}>
          <span className="bsv-pill-text">{model.pill.kind === 'armed' ? <b>LIVE FUNDS</b> : null}{model.pill.kind === 'armed' ? ' armed' : model.pill.text}</span>
          {model.pill.kind === 'armed' && <Countdown until={policy?.armedUntil ?? null} />}
          {model.showFreeze && <button type="button" className="bsv-freeze" disabled={changing} onClick={() => void changePolicy({ kind: 'freeze' })}>Freeze chain</button>}
          {model.pill.kind === 'armed' && <button type="button" className="bsv-pill-btn" disabled={changing} onClick={() => void changePolicy({ kind: 'disarm' })}>Disarm</button>}
          <button type="button" className="bsv-pill-btn" onClick={openBsvPanel}>Details</button>
        </div>
      )}
      {panel && on && <BsvPanel />}
      {confirm && <Confirm />}
    </>
  );
}
