/**
 * Settings → House context: what is in the layer, and the one place a file becomes a rule.
 *
 * The trust column is the whole point of this screen. A file the app shipped is trusted already. A file the owner wrote
 * is NOT, and never becomes so by itself: it needs one click here, and one click again after every edit, because the
 * approval is a hash of specific bytes (ADR 0010). That is deliberate. A standing "trust this path forever" grant would
 * be the hole the module exists to avoid -- an agent runs as the same OS user and could edit the file after the click.
 *
 * So the button says what it does, and says what happens next: approving THESE bytes, and an edit undoes it.
 */
import { useEffect } from 'react';
import { Icon } from '../components/icons';
import { loadHouse, setHouseTrust, useHouse } from './houseStore';
import type { HouseFileView } from './houseStore';
import './house.css';

const LABEL: Record<HouseFileView['trust'], string> = {
  shipped: 'From Legion',
  adopted: 'Your rules',
  untrusted: 'Not approved',
};
const BLURB: Record<HouseFileView['trust'], string> = {
  shipped: 'Ships with Legion, unchanged. Your agents read it as the app\u2019s own rules.',
  adopted: 'You approved these exact words. Your agents read them as your rules.',
  untrusted: 'Your agents read this as material to consider, never as instructions.',
};

export function HouseSection() {
  const st = useHouse((s) => s.status);
  const loaded = useHouse((s) => s.loaded);
  const busyPath = useHouse((s) => s.busyPath);
  const error = useHouse((s) => s.error);
  const failed = useHouse((s) => s.failed);
  const absent = useHouse((s) => s.absent);

  // Re-read on entry: the owner may have edited files in this folder since it was last open.
  useEffect(() => { void loadHouse(); }, []);

  if (absent) {
    return (
      <div className="set-section">
        <header className="set-head"><h3>House context</h3><p>This version of Legion has no house context layer. Update to get it.</p></header>
      </div>
    );
  }
  if (failed && !loaded) {
    return (
      <div className="set-section">
        <header className="set-head"><h3>House context</h3><p>Loading</p></header>
        {error ? <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div>
          : <div className="set-loading"><span className="spin" /> Reading the context layer{'\u2026'}</div>}
      </div>
    );
  }

  const files = st?.files ?? [];
  const mine = files.filter((f) => f.trust !== 'shipped');
  const shipped = files.filter((f) => f.trust === 'shipped');

  return (
    <div className="set-section">
      <header className="set-head">
        <h3>House context</h3>
        <p>
          The project&rsquo;s own documentation, which every agent can read before it asks you something.
          Files Legion ships are trusted as they are. A file you write yourself needs your approval &mdash; and
          needs it again after any edit, because approval is for those exact words, not for the file name.
        </p>
      </header>

      {error ? <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div> : null}

      {(st?.missing.length ?? 0) > 0 ? (
        <div className="set-error" role="alert">
          <Icon name="x" size={13} />
          <span>
            {st!.missing.length} expected file(s) are not in the layer, so it is incomplete: {st!.missing.join(', ')}.
            {' '}This usually means a partial install.
          </span>
        </div>
      ) : null}

      {!loaded ? <div className="set-loading"><span className="spin" /> Reading the context layer{'\u2026'}</div> : null}

      {loaded && !files.length ? (
        <p className="set-hint">
          The layer is empty. Put a markdown file in <code>{st?.root}</code> and it will appear here, unapproved,
          ready for you to make it a rule.
        </p>
      ) : null}

      {mine.length ? (
        <>
          <h4 className="house-h">Your files</h4>
          <p className="set-hint">{BLURB.untrusted}</p>
          <ul className="house-list">
            {mine.map((f) => <Row key={f.path} f={f} busy={busyPath === f.path} disabled={busyPath !== null && busyPath !== f.path} onAdopt={() => void setHouseTrust(f.path, true)} onUnadopt={() => void setHouseTrust(f.path, false)} />)}
          </ul>
        </>
      ) : null}

      {shipped.length ? (
        <>
          <h4 className="house-h">From Legion</h4>
          <ul className="house-list">
            {shipped.map((f) => <Row key={f.path} f={f} busy={false} disabled={false} />)}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Row({ f, busy, disabled, onAdopt, onUnadopt }: {
  f: HouseFileView; busy: boolean; disabled: boolean;
  onAdopt?: () => void; onUnadopt?: () => void;
}) {
  return (
    <li className={`house-row t-${f.trust}`}>
      <div className="house-main">
        <span className="house-path" title={f.path}>{f.path}</span>
        <span className="house-meta">
          <span className={`house-tag t-${f.trust}`}>{LABEL[f.trust]}</span>
          <span className="house-bytes">{f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} KB`}</span>
        </span>
      </div>
      {onAdopt || onUnadopt ? (
        <div className="set-actions">
          {busy ? <span className="house-busy"><span className="spin" /> Saving</span> : f.trust === 'adopted' ? (
            <button type="button" className="btn" disabled={disabled} onClick={onUnadopt}
              title="Withdraw your approval. The file stays readable, but agents will treat it as material again.">
              Withdraw approval
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={disabled} onClick={onAdopt}
              title="Approve these exact words as your rules. If you or an agent edits the file later, you will need to approve it again.">
              Approve as my rules
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}