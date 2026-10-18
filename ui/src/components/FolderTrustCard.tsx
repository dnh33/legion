import { useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { Icon } from './icons';
import { applyViaBridge } from '../gates/gatesAction';
import { cardLines, trustChange } from '../gates/trustLogic';

type Held = NonNullable<ChatMessage['folderTrust']>['folders'][number];

/**
 * The notice a run leaves when it held back a folder's own settings: the folder, what could run (labelled lines, no variable value), and one button.
 * The button asks the app for the same native confirmation as the Gates page; the dialog there lists every command. Nothing runs until that is confirmed.
 */
function HeldFolder({ f }: { f: Held }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [msg, setMsg] = useState('');
  const { shown, hidden } = cardLines(f.lines, f.more);
  const trust = async () => {
    setState('busy'); setMsg('');
    const r = await applyViaBridge(window.legion?.gatesChange, trustChange(f.folder), async () => undefined);
    if (r.state === 'ok') { setState('done'); setMsg('Trusted. It applies from the next run.'); return; }
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
  return (
    <div className="msg system ft-card" role="group" aria-label="Folder settings held back">
      <div className="ft-head"><Icon name="shield" size={14} /><b>This folder's settings were held back</b></div>
      <p className="ft-why">{text.split('\n')[0]}</p>
      {folders.map((f) => <HeldFolder key={f.folder} f={f} />)}
    </div>
  );
}
