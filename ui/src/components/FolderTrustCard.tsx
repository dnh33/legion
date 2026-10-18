import { useEffect, useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { Icon } from './icons';
import { request } from '../api';
import { applyViaBridge } from '../gates/gatesAction';
import { TRUSTED_AFTER_LINE, TRUSTED_CHANGED_AFTER_LINE, TRUSTED_CHANGED_LEAD, TRUSTED_LEAD, cardLines, cardTrust, trustChange, trustHeading } from '../gates/trustLogic';
import type { CardTrust, TrustedRow } from '../gates/trustLogic';

type Held = NonNullable<ChatMessage['folderTrust']>['folders'][number];

/** The trusted folders as the core reads them now. Cards mounted together share one request; a failed read is "unknown" (the card then stays held back, as the message says). */
let inflight: Promise<TrustedRow[] | null> | null = null;
function trustedNow(): Promise<TrustedRow[] | null> {
  if (!inflight) {
    inflight = request<TrustedRow[]>('GET', '/api/gates/trusted-folders').then((r) => (Array.isArray(r) ? r : null)).catch(() => null);
    void inflight.then(() => setTimeout(() => { inflight = null; }, 1500));
  }
  return inflight;
}

/**
 * The notice a run leaves when it held back a folder's own settings: the folder, what could run (labelled lines, no variable value), and one button.
 * The button asks the app for the same native confirmation as the Gates page; the dialog there lists every command. Nothing runs until that is confirmed.
 * A thread opened later still shows the notice as it was written, so the card reads the trusted list: a folder trusted since says so and offers no Trust.
 */
function HeldFolder({ f, known, onTrusted }: { f: Held; known: CardTrust | 'checking'; onTrusted: (folder: string) => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [msg, setMsg] = useState('');
  const { shown, hidden } = cardLines(f.lines, f.more);
  const trusted = state === 'done' || known === 'trusted' || known === 'trusted-differs';
  const differs = state !== 'done' && known === 'trusted-differs';
  const trust = async () => {
    setState('busy'); setMsg('');
    const r = await applyViaBridge(window.legion?.gatesChange, trustChange(f.folder), async () => undefined);
    if (r.state === 'ok') { setState('done'); onTrusted(f.folder); return; }
    setState('idle');
    setMsg(r.state === 'cancelled' ? 'Cancelled. Nothing changed.' : r.message);
  };
  return (
    <div className="ft-folder">
      <code className="ft-path">{f.folder}</code>
      {trusted && <p className="ft-lead">{differs ? TRUSTED_CHANGED_LEAD : TRUSTED_LEAD}</p>}
      <ul className="ft-lines">
        {shown.map((l, i) => <li key={i}>{l}</li>)}
        {hidden > 0 && <li className="muted-s">and {hidden} more. The confirmation lists all of them.</li>}
      </ul>
      <div className="ft-actions">
        {!trusted && <button type="button" className="btn sm" disabled={state === 'busy' || known === 'checking'} onClick={() => void trust()}>{state === 'busy' ? 'Waiting for you to confirm in the window' : 'Trust this folder'}</button>}
        {trusted ? <span className="muted-s" role="status">{differs ? TRUSTED_CHANGED_AFTER_LINE : TRUSTED_AFTER_LINE}</span> : msg && <span className="ft-msg" role="status">{msg}</span>}
      </div>
    </div>
  );
}

export function FolderTrustCard({ text, folders }: { text: string; folders: Held[] }) {
  const [trusted, setTrusted] = useState<readonly string[]>([]);
  const [rows, setRows] = useState<TrustedRow[] | null | 'checking'>('checking');
  useEffect(() => {
    let alive = true;
    void trustedNow().then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, []);
  const known = (f: Held): CardTrust | 'checking' => (rows === 'checking' ? 'checking' : cardTrust(f, rows));
  const isTrusted = (f: Held): boolean => trusted.includes(f.folder) || known(f) === 'trusted' || known(f) === 'trusted-differs';
  const all = folders.length > 0 && folders.every(isTrusted);
  const count = folders.filter(isTrusted).length;
  return (
    <div className={`msg system ft-card${all ? ' trusted' : ''}`} role="group" aria-label={all ? 'Folder trusted' : 'Folder settings held back'}>
      <div className="ft-head"><Icon name={all ? 'check' : 'shield'} size={14} /><b>{trustHeading(folders.length, count)}</b></div>
      <p className="ft-why">{all ? 'This run used your user settings only.' : text.split('\n')[0]}</p>
      {folders.map((f) => <HeldFolder key={f.folder} f={f} known={known(f)} onTrusted={(p) => setTrusted((t) => (t.includes(p) ? t : [...t, p]))} />)}
    </div>
  );
}
