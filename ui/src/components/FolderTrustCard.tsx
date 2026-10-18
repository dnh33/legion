import { useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { Icon } from './icons';
import { applyViaBridge } from '../gates/gatesAction';
import { cardLines, trustChange, trustHeading } from '../gates/trustLogic';

type Held = NonNullable<ChatMessage['folderTrust']>['folders'][number];

/**
 * The notice a run leaves when it held back a folder's own settings: the folder, what could run (labelled lines, no variable value), and one button.
 * The button asks the app for the same native confirmation as the Gates page; the dialog there lists every command. Nothing runs until that is confirmed.
 */
function HeldFolder({ f, onTrusted }: { f: Held; onTrusted: (folder: string) => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [msg, setMsg] = useState('');
  const { shown, hidden } = cardLines(f.lines, f.more);
  const trust = async () => {
    setState('busy'); setMsg('');
    const r = await applyViaBridge(window.legion?.gatesChange, trustChange(f.folder), async () => undefined);
    if (r.state === 'ok') { setState('done'); setMsg('Trusted. It applies from the next run.'); onTrusted(f.folder); return; }
    setState('idle');
    setMsg(r.state === 'cancelled' ? 'Cancelled. Nothing changed.' : r.message);
  };
  return (
    <div className="ft-folder">
      <code className="ft-path">{f.folder}</code>
      <ul className="ft-lines">
        {shown.map((l, i) => <li key={i}>{l}</li>)}
        {hidden > 0 && <li className="muted-s">and {hidden} more. The confirmation lists all of them.</li>}
      </ul>
      <div className="ft-actions">
        {state !== 'done' && <button type="button" className="btn sm" disabled={state === 'busy'} onClick={() => void trust()}>{state === 'busy' ? 'Waiting for you to confirm in the window' : 'Trust this folder'}</button>}
        {msg && <span className={state === 'done' ? 'muted-s' : 'ft-msg'} role="status">{msg}</span>}
      </div>
    </div>
  );
}

export function FolderTrustCard({ text, folders }: { text: string; folders: Held[] }) {
  const [trusted, setTrusted] = useState<readonly string[]>([]);
  const all = folders.length > 0 && folders.every((f) => trusted.includes(f.folder));
  return (
    <div className={`msg system ft-card${all ? ' trusted' : ''}`} role="group" aria-label={all ? 'Folder trusted' : 'Folder settings held back'}>
      <div className="ft-head"><Icon name={all ? 'check' : 'shield'} size={14} /><b>{trustHeading(folders.length, trusted.length)}</b></div>
      <p className="ft-why">{all ? 'This run used your user settings only.' : text.split('\n')[0]}</p>
      {folders.map((f) => <HeldFolder key={f.folder} f={f} onTrusted={(p) => setTrusted((t) => (t.includes(p) ? t : [...t, p]))} />)}
    </div>
  );
}
