/**
 * Title-bar update badge: a global, always-mounted indicator for an available update. It polls the existing
 * GET /api/update/status roughly every 30 s while the window is visible, renders nothing when there is no update,
 * and in every other state is one click into Settings -> About (where the existing UpdatePanel lives).
 *
 * The state machine is pure and lives in ../updateBadgeState.ts (test/update-badge.test.ts runs it). This file owns
 * only the polling and the markup. It does not touch the update panel, the api helper, or the store: it imports them.
 */
import { useEffect, useState } from 'react';
import { request } from '../api';
import { openSettings } from '../store';
import { pureBadgeState, type UpdateBadgeStatus } from '../updateBadgeState';
import '../styles/update-badge.css';

/** The badge is ambient; 30 s is fast enough to notice a download, slow enough to be invisible. */
const POLL_MS = 30_000;

/**
 * Polls GET /api/update/status every 30 s while the window is visible, and stops while it is hidden (no requests when
 * nobody is looking; it polls once on the way back). A failed poll is silent: the badge keeps its last known state
 * rather than flashing an error into the title bar. Exported so a caller could reuse the poll.
 */
export function useUpdateStatus(): UpdateBadgeStatus | null {
  const [status, setStatus] = useState<UpdateBadgeStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const s = await request<UpdateBadgeStatus>('GET', '/api/update/status');
        if (alive) setStatus(s);
      } catch { /* ambient: keep the last state */ }
    };
    const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
    const start = () => { stop(); void load(); timer = window.setInterval(() => { if (!document.hidden) void load(); }, POLL_MS); };
    const onVisible = () => { if (document.hidden) stop(); else start(); };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; stop(); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return status;
}

/**
 * The badge itself. Renders nothing when there is no update; otherwise a small pill in the title bar that opens the
 * update panel on click. Sits in .tb-right beside the other status chips.
 */
export function UpdateBadge() {
  const status = useUpdateStatus();
  const b = pureBadgeState(status ?? {});
  if (!b.visible) return null;
  return (
    <button
      type="button"
      className={`upd-badge upd-badge-${b.kind} tone-${b.tone}`}
      onClick={() => openSettings('about')}
      title={b.title}
      aria-label={b.title}
    >
      <i className="upd-badge-dot" aria-hidden="true" />
      <span className="upd-badge-label">{b.label}</span>
      {b.detail && <span className="upd-badge-detail">{b.detail}</span>}
    </button>
  );
}
