import { useEffect, useState } from 'react';
import { TRUSTED_FOLDERS_LABEL } from '../../../src/shared/gates-registry';
import { request } from '../api';
import { GatesNote } from './GatesPresets';
import { KEYSTORE_LINE, type GatesView } from './presetsLogic';
import { TRUST_CHANGED_LINE, TRUST_EMPTY_LINE, TRUST_NOTE, trustSummary, untrustChange, type TrustedRow } from './trustLogic';
import type { GatesChangeRequest, GatesNote as Note } from './useGatesView';

type Run = (c: GatesChangeRequest, done: string) => Promise<boolean>;

/**
 * The folders you trust (Settings, Gates, everything): each with what it carries today and Remove. Trusting happens from the card in a thread, where the
 * held-back commands are; this list is for looking and for taking trust away. Remove needs no confirmation: it only makes Legion ask again.
 */
export function TrustedFolders({ view, busy, pending, note, run }: { view: GatesView; busy: boolean; pending: boolean; note: Note | null; run: Run }) {
  const records = view.app.trustedFolders ?? [];
  const [rows, setRows] = useState<TrustedRow[] | null>(null);
  const key = JSON.stringify(records);
  useEffect(() => {
    let alive = true;
    if (records.length === 0) { setRows([]); return; }
    request<TrustedRow[]>('GET', '/api/gates/trusted-folders').then((r) => { if (alive) setRows(Array.isArray(r) ? r : []); }).catch(() => { if (alive) setRows(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const list: TrustedRow[] = rows ?? records.map((r) => ({ folder: r.folder, current: true, summary: [], more: 0 }));
  return (
    <div className="gates-sites gates-trust" aria-label={TRUSTED_FOLDERS_LABEL}>
      <h3 className="gates-trust-h">{TRUSTED_FOLDERS_LABEL}</h3>
      <p className="muted-s">{TRUST_NOTE}</p>
      {!view.canSign && <p className="muted-s">Trusting a folder is off. {KEYSTORE_LINE}</p>}
      {list.length === 0 ? <p className="muted-s">{TRUST_EMPTY_LINE}</p> : (
        <ul className="gates-hosts gates-trust-list">
          {list.map((r) => (
            <li key={r.folder}>
              <div className="gates-trust-main">
                <code>{r.folder}</code>
                <span className="muted-s">{rows ? (r.current ? trustSummary(r) : TRUST_CHANGED_LINE) : ''}</span>
              </div>
              <button type="button" className="btn-ghost sm" disabled={busy} aria-label={`Remove ${r.folder}`} onClick={() => void run(untrustChange(r.folder), 'Removed. Legion asks again before that folder runs its own commands.')}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <GatesNote note={note} pending={pending} />
    </div>
  );
}
