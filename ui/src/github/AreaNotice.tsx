/** One plain line for an area state, with the way forward: Try again, or open Settings, GitHub. */
import type { AreaNotice } from './accessState';

export function AreaNoticeLine({ notice, onRetry, onSettings }: { notice: AreaNotice; onRetry?: () => void; onSettings: () => void }) {
  return (
    <span className="field-note gha-notice" role={notice.kind === 'loading' ? 'status' : 'alert'} data-kind={notice.kind}>
      {notice.text}
      {notice.retry && onRetry && <> <button type="button" className="gha-link" onClick={onRetry}>Try again</button></>}
      {notice.settings && <> <button type="button" className="gha-link" onClick={onSettings}>Open Settings, GitHub</button></>}
    </span>
  );
}
