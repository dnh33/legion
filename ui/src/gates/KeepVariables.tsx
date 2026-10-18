import { useState } from 'react';
import { ENV_KEEP_LABEL } from '../../../src/shared/gates-registry';
import { Icon } from '../components/icons';
import { GatesNote } from './GatesPresets';
import { KEEP_EMPTY_LINE, KEEP_NOTE, checkKeepName, keepAddChange, keepRemoveChange } from './keepLogic';
import { KEYSTORE_LINE, type GatesView } from './presetsLogic';
import type { GatesChangeRequest, GatesNote as Note } from './useGatesView';

type Run = (c: GatesChangeRequest, done: string) => Promise<boolean>;

/**
 * The variables commands may keep: names (or NAME* prefixes) that the env-scrub gate lets through, in every project and outside projects. Adding one
 * loosens, so it goes through the same native confirmation as an approved site; removing one does not. The values are never read or shown here.
 */
export function KeepVariables({ view, busy, pending, note, run }: { view: GatesView; busy: boolean; pending: boolean; note: Note | null; run: Run }) {
  const kept = view.app.envKeep ?? [];
  const [text, setText] = useState('');
  const check = checkKeepName(text, kept);
  const canAdd = check.kind === 'ok' && !busy && view.canSign;
  const add = async () => {
    if (check.kind !== 'ok' || !canAdd) return;
    // the field is cleared only when the name was saved: a cancelled confirmation leaves it to try again or to change
    if (await run(keepAddChange(kept, check.name), `Now kept: ${check.name}.`)) setText('');
  };
  return (
    <div className="gates-sites gates-keep" aria-label={ENV_KEEP_LABEL}>
      <div className="gates-site-head"><b>{ENV_KEEP_LABEL}</b></div>
      <p className="muted-s">{KEEP_NOTE}</p>
      <div className="gates-keep-add">
        <input type="text" value={text} spellCheck={false} autoComplete="off" placeholder="NPM_TOKEN or MYAPP_*" aria-label="Variable name" disabled={busy}
          aria-invalid={check.kind === 'error'} aria-describedby={check.kind === 'error' ? 'gates-keep-error' : undefined}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
        <button type="button" className="btn sm" disabled={!canAdd} onClick={() => void add()}>Add</button>
      </div>
      {check.kind === 'error' && <p id="gates-keep-error" className="gates-keep-error" role="alert"><Icon name="x" size={12} /> <span>{check.message}</span></p>}
      {!view.canSign && <p className="muted-s">Add is off. {KEYSTORE_LINE}</p>}
      {kept.length === 0 ? <p className="muted-s">{KEEP_EMPTY_LINE}</p> : (
        <ul className="gates-hosts">
          {kept.map((n) => (
            <li key={n}>
              <code>{n}</code>
              <span className="muted-s">{n.endsWith('*') ? `Prefix: every name that starts with ${n.slice(0, -1)}` : ''}</span>
              <button type="button" className="btn-ghost sm" disabled={busy} aria-label={`Remove ${n}`} onClick={() => void run(keepRemoveChange(kept, n), `Removed ${n} from the list.`)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <GatesNote note={note} pending={pending} />
    </div>
  );
}
