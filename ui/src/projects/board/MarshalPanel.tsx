import { useEffect, useState } from 'react';
import type { BoardMarshalStatus, MarshalConfig } from '../../../../src/shared/board';
import {
  CHECK_MAX, STALL_BOUNDS, WAVE_BOUNDS, checksError, draftErrors, draftOf, draftToConfig, parseChecks, runLine,
} from './marshalLogic';
import type { MarshalDraft } from './marshalLogic';
import './board.css';

/**
 * The Marshal's own view: what runs and why that bot, what is blocked and why, what is next — plus the
 * switch that starts it and the two bounds it works to. Presentational: the store loads the status and the
 * panel hands a whole config back through `onSave`, so this component decides nothing and fetches nothing.
 */
export function MarshalPanel({ view, busy, readOnly, onSave }: {
  view?: BoardMarshalStatus;
  busy: boolean;
  readOnly: boolean;
  onSave: (cfg: MarshalConfig) => void;
}) {
  const cfg = view?.marshal;
  const [draft, setDraft] = useState<MarshalDraft>(() => draftOf(cfg));
  // re-seed from what the CORE says whenever the stored config changes (a save, or another window) — never while typing
  const stored = `${cfg?.enabled}|${cfg?.waveSize}|${cfg?.stallMinutes}`;
  useEffect(() => { setDraft(draftOf(cfg)); }, [stored]); // eslint-disable-line react-hooks/exhaustive-deps
  const errors = draftErrors(draft);
  const s = view?.status;
  const set = (p: Partial<MarshalDraft>): void => setDraft((d) => ({ ...d, ...p }));
  const save = (): void => { if (!errors.length && !readOnly) onSave(draftToConfig(draft)); };

  return (
    <section className="bd-marshal" aria-labelledby="bd-marshal-h">
      <div className="bd-marshal-head">
        <h4 id="bd-marshal-h">The Marshal</h4>
        <span className={`bd-marshal-state${cfg?.enabled ? ' on' : ''}`}>{cfg ? (cfg.enabled ? 'On' : 'Off') : 'Loading…'}</span>
      </div>
      <p className="field-note">
        {cfg?.enabled
          ? 'Every pass settles the runs that ended or stalled, then starts a wave of work on the best bot it can find. Each run starts on that bot’s own model, and its access tier still decides what asks you first.'
          : 'Off. Nothing is matched and no bot is started until you switch this on.'}
      </p>

      <form className="bd-filters bd-marshal-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="bd-marshal-on">
          <input type="checkbox" checked={draft.enabled} disabled={readOnly || busy} onChange={(e) => set({ enabled: e.target.checked })} />
          Let the Marshal work this board
        </label>
        <label>Wave size
          <input type="number" inputMode="numeric" min={WAVE_BOUNDS[0]} max={WAVE_BOUNDS[1]} value={draft.waveSize} disabled={readOnly || busy}
            aria-label={`Wave size: items one pass may start, ${WAVE_BOUNDS[0]} to ${WAVE_BOUNDS[1]}`} onChange={(e) => set({ waveSize: e.target.value })} />
        </label>
        <label>Stop a silent run after (minutes)
          <input type="number" inputMode="numeric" min={STALL_BOUNDS[0]} max={STALL_BOUNDS[1]} value={draft.stallMinutes} disabled={readOnly || busy}
            aria-label={`Stop a silent run after ${STALL_BOUNDS[0]} to ${STALL_BOUNDS[1]} minutes`} onChange={(e) => set({ stallMinutes: e.target.value })} />
        </label>
        <button type="submit" className="btn primary" disabled={readOnly || busy || errors.length > 0} aria-describedby={errors.length ? 'bd-marshal-errors' : undefined}>Save</button>
      </form>
      <p className="field-note">
        Wave size is how many items one pass starts (1&ndash;10). A run that reports nothing for the stop-after
        time is cancelled and its item tried again on another bot; a second stall hands the item back to you (1&ndash;240 minutes).
      </p>
      {errors.length > 0 && (
        <ul className="bd-marshal-errors" id="bd-marshal-errors">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      {readOnly && <p className="proj-note" role="note">This project is archived: the Marshal&rsquo;s settings are read-only until you unarchive it.</p>}

      <div className="bd-marshal-cols">
        <section aria-labelledby="bd-ms-run">
          <h5 id="bd-ms-run">Running <span className="bd-count">{s?.running.length ?? 0}</span></h5>
          {!s || s.running.length === 0 ? <p className="muted-s">Nothing is running.</p> : (
            <ul className="bd-marshal-list">
              {s.running.map((r) => (
                <li key={r.taskId}>
                  <p className="bd-marshal-line">{runLine(r)}</p>
                  <p className="field-note">
                    Why this bot: {r.why}
                    {r.irreversible.length > 0 && `. Irreversible: ${r.irreversible.join(', ')}${r.gated ? '; the approval card will gate it' : ''}`}
                  </p>
                  <p className="muted-s">{r.rankWhy}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="bd-ms-block">
          <h5 id="bd-ms-block">Blocked <span className="bd-count">{s?.blocked.length ?? 0}</span></h5>
          {!s || s.blocked.length === 0 ? <p className="muted-s">Nothing is blocked.</p> : (
            <ul className="bd-marshal-list">
              {s.blocked.map((b) => (
                <li key={b.itemId}>
                  <p className="bd-marshal-line">{b.title}</p>
                  <p className="field-note">{b.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="bd-ms-next">
          <h5 id="bd-ms-next">Next <span className="bd-count">{s?.next.length ?? 0}</span></h5>
          {!s || s.next.length === 0 ? <p className="muted-s">Nothing is queued.</p> : (
            <ul className="bd-marshal-list">
              {s.next.map((n) => (
                <li key={n.itemId}>
                  <p className="bd-marshal-line">{n.title} <span className="muted-s">(score {n.score})</span></p>
                  <p className="field-note">{n.why}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <details className="bd-marshal-plain">
        <summary>Plain-text status</summary>
        <pre>{view?.statusText ?? ''}</pre>
      </details>
    </section>
  );
}

/**
 * One item's done-when checks, as the owner writes them: one check per line, saved beside the item and read
 * back from the core (never assumed), because the Marshal dispatches nothing until they exist.
 */
export function DoneWhen({ value, onChange, onSave, saved, disabled, busy }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  /** True once the core has confirmed the last save (the owner sees the write landed). */
  saved?: boolean;
  disabled: boolean;
  busy: boolean;
}) {
  const err = checksError(value);
  const count = parseChecks(value).length;
  return (
    <div className="bd-checks">
      <h4 className="bd-h4">Done when</h4>
      <p className="field-note">
        One check per line, up to {CHECK_MAX}. The Marshal dispatches this item only once they are written, and
        the run is judged against exactly these lines.
      </p>
      <textarea rows={4} value={value} disabled={disabled} aria-label="Done when: one check per line" aria-describedby="bd-checks-note" onChange={(e) => onChange(e.target.value)} />
      <span id="bd-checks-note" className={`field-note${err ? ' proj-over' : ''}`}>
        {err ?? (count === 0 ? 'No checks yet: nothing dispatches this item until you write them.' : `${count} of ${CHECK_MAX} checks.`)}
      </span>
      <div className="bd-actions">
        <button type="button" className="btn" disabled={disabled || busy || !!err} onClick={onSave}>Save checks</button>
        {saved && <span className="field-note" role="status">Saved. The Marshal will dispatch on exactly these.</span>}
      </div>
    </div>
  );
}
