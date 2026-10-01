import { useLayoutEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { cancelConfirm, confirmEnable, useBsv } from './bsvStore';
import './bsv.css';

/** Four short lines for the first-enable dialog (kept as data so the copy is easy to review). */
const CONFIRM_LINES = [
  'Turns on: the Assayer in the rail and the BSV knowledge pack.',
  'Testnet only, shown by a calm cyan line along the title bar.',
  'No wallet: no keys, no signing, no funds. Never paste a seed phrase.',
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
 */
function useTickerSlot(active: boolean, nodes: number, loaded: boolean): Ticker {
  const [slot, setSlot] = useState<Ticker>(null);
  useLayoutEffect(() => {
    if (!active) { setSlot(null); return; }
    const measure = () => {
      const search = document.querySelector('.tb-search')?.getBoundingClientRect();
      const right = document.querySelector('.tb-right')?.getBoundingClientRect();
      if (!search || !right) { setSlot(null); return; }
      const left = search.right + 14;
      const width = right.left - 14 - left;
      const count = loaded ? `${nodes} bsv node${nodes === 1 ? '' : 's'}` : '';
      const CH = 6.2; // ~ advance of the 9.5px monospace face plus letter spacing
      const fits = (lines: string[]) => width >= Math.max(...lines.map((t) => t.length)) * CH;
      const tiers = [
        ['TESTNET · knowledge mode', ...(count ? [count] : [])],
        ['TESTNET', ...(count ? [count] : [])],
        ['TESTNET'],
      ];
      const lines = tiers.find(fits);
      setSlot(lines ? { left, width, lines } : null);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    const bar = document.querySelector('.titlebar');
    if (ro && bar) ro.observe(bar);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [active, nodes, loaded]);
  return slot;
}

/**
 * Chain-mode overlay (testnet): a calm cyan hairline pulse along the bottom edge of the title bar and a tiny
 * status readout. Overlay only: pointer-events none, confined to the 40px title bar, never over the rail or the stage.
 * Also hosts the first-enable confirmation dialog.
 */
export function ChainOverlay() {
  const on = useBsv((s) => s.enabled);
  const confirm = useBsv((s) => s.confirmOpen);
  const nodes = useBsv((s) => s.knowledgeNodes);
  const loaded = useBsv((s) => s.knowledgeLoaded);
  const slot = useTickerSlot(on, nodes, loaded);
  return (
    <>
      {on && (
        <div className="chain-overlay" data-chain="testnet" aria-hidden="true">
          <i className="chain-glow" />
          <i className="chain-line" />
          {slot && (
            <div className="chain-ticker" style={{ left: slot.left, width: slot.width }}>
              {slot.lines.map((l, i) => <span key={i}>{l}</span>)}
            </div>
          )}
        </div>
      )}
      {confirm && <Confirm />}
    </>
  );
}
