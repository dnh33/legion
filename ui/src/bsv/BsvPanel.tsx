import { useState } from 'react';
import { Modal } from '../components/Modal';
import { request } from '../api';
import { auditLine, formatCountdown, heightText, remainingMs, safeLine, spendModel, walletHeadline } from '../../../src/shared/bsv-view';
import type { PolicyView } from '../../../src/shared/bsv-view';
import { toast } from '../store';
import { canChangePolicy, changePolicy, checkWallet, closeBsvPanel, connectWallet, disconnectWallet, loadAudit, useBsv } from './bsvStore';
import './bsv.css';

const sats = (n: number) => `${n.toLocaleString('en-US')} sat`;

function WalletSection() {
  const enabled = useBsv((s) => s.enabled);
  const w = useBsv((s) => s.wallet);
  const changing = useBsv((s) => s.changing);
  const [addr, setAddr] = useState('');
  const bridge = canChangePolicy();
  const warn = w?.condition === 'mainnet-warning';
  const connected = !!w?.connected;
  return (
    <section className="bsv-sec" aria-labelledby="bsv-h-wallet">
      <h3 id="bsv-h-wallet">Wallet</h3>
      <p className={`bsv-line${warn ? ' warn' : ''}`} data-wallet={w?.condition ?? 'none'}>{walletHeadline(w, enabled)}</p>
      <dl className="bsv-kv">
        <dt>Looked at</dt><dd>{w?.url ? safeLine(w.url, 60) : 'nothing yet: no address is set'}</dd>
        <dt>Network it claims</dt><dd>{w?.probed && w.reachable ? (w.network === 'main' ? 'mainnet' : w.network === 'test' ? 'testnet' : 'not stated') : 'none'}</dd>
        {w?.probed && w.reachable && heightText(w.height) ? <><dt>Block height</dt><dd>{heightText(w.height)}</dd></> : null}
        {w?.probed && w.checkedAt ? <><dt>Checked</dt><dd>{safeLine(w.checkedAt, 30)}</dd></> : null}
      </dl>
      {!bridge && <p className="bsv-fine">This window has no app bridge (a browser tab?). Open the Legion app to connect a wallet.</p>}
      <div className="bsv-row">
        <input className="bsv-input" type="text" inputMode="url" spellCheck={false} autoComplete="off" aria-label="Wallet address on this computer" placeholder="http://127.0.0.1:<port>" value={addr} onChange={(e) => setAddr(e.target.value)} disabled={!bridge || connected} />
        {connected
          ? <button type="button" className="btn-ghost" disabled={!bridge || changing} onClick={() => void disconnectWallet()}>Disconnect</button>
          : <button type="button" className="btn" disabled={!bridge || changing || !addr.trim()} onClick={() => void connectWallet(addr)}>Connect&hellip;</button>}
        <button type="button" className="btn-ghost" disabled={!connected} onClick={() => void checkWallet()}>Check now</button>
      </div>
      <p className="bsv-fine">Legion does not guess an address and does not look for a wallet by itself. Connect opens a native confirmation that names the address, and only after you confirm does Legion ask four read-only questions: version, network, whether it is logged in, and block height. It does not ask for balances, outputs, keys or addresses. The connection lasts until you disconnect, freeze, turn BSV mode off or restart. The answer is the wallet&apos;s own claim; any program on this computer could give it.</p>
    </section>
  );
}

function ArmSection({ p }: { p: PolicyView }) {
  const [minutes, setMinutes] = useState(15);
  const changing = useBsv((s) => s.changing);
  const bridge = canChangePolicy();
  const left = remainingMs(p, Date.now());
  const armed = p.armed && left > 0 && !p.frozen;
  const choices = p.armChoicesMinutes.length ? p.armChoicesMinutes : [5, 15, 30, 60];
  return (
    <section className="bsv-sec" aria-labelledby="bsv-h-live">
      <h3 id="bsv-h-live">Live funds</h3>
      <p className={`bsv-line${armed ? ' live' : ''}`} data-armed={armed ? '1' : '0'}>
        {p.frozen ? `Frozen: ${safeLine(p.frozen.reason, 160) || 'no reason recorded'}.` : armed ? `Armed, ${formatCountdown(left)} left. Disarms by itself at zero and when Legion restarts.` : 'Disarmed. Testnet knowledge mode.'}
      </p>
      {!p.nativeAvailable && <p className="bsv-fine">This core was not started by the Legion app, so policy changes are locked. Restart Legion from the tray menu.</p>}
      {!bridge && <p className="bsv-fine">This window has no app bridge (a browser tab?). Open the Legion app to arm, disarm or freeze.</p>}
      <div className="bsv-row" role="group" aria-label="Arm for how long">
        {choices.map((m) => <button key={m} type="button" className={`bsv-chip${m === minutes ? ' on' : ''}`} aria-pressed={m === minutes} onClick={() => setMinutes(m)}>{m} min</button>)}
      </div>
      <div className="bsv-row">
        <button type="button" className="btn bsv-arm" disabled={!bridge || !p.nativeAvailable || changing || !!p.frozen} onClick={() => void changePolicy({ kind: 'arm', minutes })}>Arm LIVE FUNDS&hellip;</button>
        <button type="button" className="btn-ghost" disabled={!bridge || changing || !p.armed} onClick={() => void changePolicy({ kind: 'disarm' })}>Disarm</button>
        {p.frozen
          ? <button type="button" className="btn" disabled={!bridge || !p.nativeAvailable || changing} onClick={() => void changePolicy({ kind: 'unfreeze' })}>Unfreeze&hellip;</button>
          : <button type="button" className="btn-ghost bsv-freeze-btn" disabled={!bridge || changing} onClick={() => void changePolicy({ kind: 'freeze' })}>Freeze chain</button>}
      </div>
      <p className="bsv-fine">Arming and unfreezing open a native confirmation from the app, which this window cannot answer for you. Freeze and Disarm act at once. Arming changes Legion&apos;s policy state only. <b>Testnet spends do not need Arm</b>, and the spend tool refuses a mainnet request in this version.</p>
    </section>
  );
}

function SpendSection({ p }: { p: PolicyView }) {
  const changing = useBsv((s) => s.changing);
  const bridge = canChangePolicy();
  const m = spendModel(p);
  return (
    <section className="bsv-sec" aria-labelledby="bsv-h-spend">
      <h3 id="bsv-h-spend">Requests from the Assayer (testnet)</h3>
      <p className="bsv-line" data-spend={p.spendTools ? 'on' : 'off'}>{m.headline}</p>
      {m.pending.length === 0 && m.unknown.length === 0 && <p className="bsv-fine">Nothing is waiting for your answer.</p>}
      {m.pending.map((r) => (
        <div className="bsv-row" key={r.requestId} data-spend-pending={r.requestId}>
          <span className="bsv-line">{r.label}</span>
          <button type="button" className="btn" disabled={!bridge || changing} onClick={() => void changePolicy({ kind: 'spend-review', requestId: r.requestId })}>Review&hellip;</button>
          <button type="button" className="btn-ghost" disabled={!bridge || changing} onClick={() => void changePolicy({ kind: 'spend-deny', requestId: r.requestId })}>Deny</button>
        </div>
      ))}
      {m.unknown.map((r) => (
        <div className="bsv-row" key={r.requestId} data-spend-unknown={r.requestId}>
          <span className="bsv-line warn">{r.label}</span>
          <button type="button" className="btn" disabled={!bridge || changing} onClick={() => void changePolicy({ kind: 'spend-resolve', requestId: r.requestId })}>Resolve&hellip;</button>
        </div>
      ))}
      <p className="bsv-fine">The amount, the full recipient address, the network and the fee are shown only in a native dialog that the app words from what the core reports; this window cannot answer it for you. A request nobody answers expires by itself. An unknown outcome blocks every spend until you resolve it.</p>
    </section>
  );
}

function LimitsSection({ p }: { p: PolicyView }) {
  return (
    <section className="bsv-sec" aria-labelledby="bsv-h-limits">
      <h3 id="bsv-h-limits">Limits</h3>
      <dl className="bsv-kv">
        <dt>Per transaction</dt><dd>{sats(p.caps.perTxSats)}</dd>
        <dt>Per session</dt><dd>{sats(p.caps.perSessionSats)} <span className="bsv-dim">(used {sats(p.usage.sessionSats)})</span></dd>
        <dt>Per rolling 24 hours</dt><dd>{sats(p.caps.per24hSats)} <span className="bsv-dim">(used {sats(p.usage.last24hSats)})</span></dd>
        <dt>Max outputs</dt><dd>{p.caps.maxOutputs}</dd>
        <dt>Fee ceiling</dt><dd>{sats(p.caps.maxFeeSats)}</dd>
        <dt>Recipient allowlist</dt><dd>{p.allowlist.length ? `${p.allowlist.length} address${p.allowlist.length === 1 ? '' : 'es'}` : 'empty: no recipient is allowed'}</dd>
      </dl>
      <p className="bsv-fine">Defaults are tiny and hard ceilings are written in code. The limits are enforced by a tested policy engine that the testnet spend tool consults for every request. Changing them is possible only from the app after a native confirmation; the form for it is not built yet.</p>
    </section>
  );
}

async function saveLog() {
  try {
    const j = await request<{ entries: unknown[] }>('GET', '/api/bsv/audit?limit=500');
    const blob = new Blob([[...j.entries].reverse().map((e) => JSON.stringify(e)).join('\n') + '\n'], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'legion-bsv-audit.jsonl';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { toast(`Could not save the log: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
}

function ActivitySection({ verifiedEntries, policyOk, policyReason }: { verifiedEntries: number; policyOk: boolean; policyReason?: string }) {
  const a = useBsv((s) => s.audit);
  const ok = a ? a.ok : policyOk;
  return (
    <section className="bsv-sec" aria-labelledby="bsv-h-activity">
      <h3 id="bsv-h-activity">Activity</h3>
      <p className={`bsv-line${ok ? '' : ' warn'}`} data-audit={ok ? 'ok' : 'broken'}>
        {ok ? `Log verified: ${a?.total ?? verifiedEntries} entr${(a?.total ?? verifiedEntries) === 1 ? 'y' : 'ies'}, each sealed to the one before.` : `The log did NOT verify (${safeLine(a?.reason ?? policyReason, 120) || 'unknown'}). The evidence was kept and a new log started; the chain is frozen.`}
      </p>
      <div className="bsv-row">
        <button type="button" className="btn-ghost" onClick={() => void loadAudit(true)}>Refresh</button>
        <button type="button" className="btn-ghost" onClick={() => void saveLog()}>Save log as file</button>
      </div>
      {a?.error && <p className="bsv-line warn">Could not read the log: {safeLine(a.error, 160)}</p>}
      <ol className="bsv-log" aria-label="Recent BSV activity, newest first">
        {(a?.entries ?? []).map((e) => {
          const l = auditLine(e);
          return (
            <li key={e.seq} data-decision={safeLine(e.decision, 30)}>
              <span className="bsv-log-when">{l.when}</span>
              <span className="bsv-log-who">{l.who}</span>
              <span className="bsv-log-what">{l.what}</span>
              {l.why && <span className="bsv-log-why">{l.why}</span>}
            </li>
          );
        })}
        {a && !a.loading && a.entries.length === 0 && <li className="bsv-log-empty">Nothing recorded yet.</li>}
      </ol>
      {a?.more && <div className="bsv-row"><button type="button" className="btn-ghost" disabled={a.loading} onClick={() => void loadAudit(false)}>Older</button></div>}
      <p className="bsv-fine">The log records who asked for what and what was decided. It never holds keys, seed phrases or wallet answers. It is tamper-evident, not tamper-proof: a program running as you could rewrite it, and the check would show that.</p>
    </section>
  );
}

/** The BSV panel: wallet status, live-funds arming and freeze, limits and the activity log. Static: nothing animates, nothing polls. */
export function BsvPanel() {
  const p = useBsv((s) => s.policy);
  return (
    <Modal title="BSV mode" width={640} onClose={closeBsvPanel} footer={<><span style={{ flex: 1 }} /><button type="button" className="btn-ghost" data-autofocus onClick={closeBsvPanel}>Close</button></>}>
      <div className="bsv-panel">
        <p className="bsv-lead">Testnet mode. The Assayer can explain, draft and review, can ask whether a wallet is there, and can ask for one testnet payment. <b>{'Legion\'s own code holds no keys: a payment needs your confirmation in a native dialog and then your wallet\'s own prompt.'}</b> An agent&apos;s ordinary tools (a shell, a web fetch) are outside that statement: they are limited by their own approval cards, not by anything on this panel.</p>
        <WalletSection />
        {p && <SpendSection p={p} />}
        {p ? <ArmSection p={p} /> : <section className="bsv-sec"><h3>Live funds</h3><p className="bsv-line">Loading policy&hellip;</p></section>}
        <ActivitySection verifiedEntries={p?.audit.entries ?? 0} policyOk={p?.audit.ok ?? true} policyReason={p?.audit.reason} />
        {p && <LimitsSection p={p} />}
      </div>
    </Modal>
  );
}
