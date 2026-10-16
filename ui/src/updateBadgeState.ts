/**
 * Pure view-model of the title-bar update badge. Status in, what to show out: no React, no fetch, no clock, so
 * test/update-badge.test.ts runs it as it is. The component (components/UpdateBadge.tsx) owns the polling and the click.
 *
 * The badge is ambient: it says as little as it can while the update is only a background fact, and only grows louder
 * while the update is actually doing something the owner should know about (downloading, ready, installing).
 */

/** The slice of GET /api/update/status the badge reads. Extra fields on the real response are ignored. */
export interface UpdateBadgeStatus {
  phase?: string;
  available?: { version: string; requiresFullInstall?: boolean; canFullInstall?: boolean } | null;
  progress?: { bytes: number; total: number } | null;
  staged?: { version: string; kind?: 'code' | 'full' } | null;
  settings?: { autoInstallWhenIdle?: boolean } | null;
  /** Set once, right after an update landed and until it is dismissed (GET /api/update/status `updated`). */
  updated?: { version: string; id: string } | null;
  busy?: { idle?: boolean; reasons?: string[] } | null;
}

export type UpdateBadgeKind = 'none' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'approval' | 'updated';
export type UpdateBadgeTone = 'accent' | 'progress' | 'ready' | 'busy' | 'done';

/** Everything the badge renders from. `visible: false` means render nothing at all. */
export interface UpdateBadgeState {
  visible: boolean;
  kind: UpdateBadgeKind;
  /** The badge's own words. Empty when not visible. */
  label: string;
  /** Secondary text: the version, a download percent, or the install-timing hint. */
  detail: string;
  /** 0-100 while a download has a byte count, else null. */
  pct: number | null;
  tone: UpdateBadgeTone;
  /** Tooltip and accessible name. Empty when not visible. */
  title: string;
  /** What a click does. 'settings' opens Settings -> About, where the update panel lives. */
  action: 'settings' | 'none';
  /** For kind 'updated': the version and update id the notice is about (the component acknowledges the id when it is dismissed). */
  updated?: { version: string; id: string };
}

/** Percent of the download that has arrived, 0..100, or null before a byte count exists. */
export function downloadPct(p?: { bytes: number; total: number } | null): number | null {
  if (!p || !(p.total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((p.bytes / p.total) * 100)));
}

/** True when Legion installs the staged update by itself: auto-install is on and nothing is running. */
export function installsWhenIdle(s: UpdateBadgeStatus): boolean {
  return s.settings?.autoInstallWhenIdle === true && s.busy?.idle !== false;
}

const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

const NONE: UpdateBadgeState = { visible: false, kind: 'none', label: '', detail: '', pct: null, tone: 'accent', title: '', action: 'none' };

/**
 * One arm per phase of GET /api/update/status, in the order the arms must win:
 * installing (committing) outranks a download that is still finishing; a staged update outranks the available notice
 * it came from; anything else falls through to the available notice, and with no update at all the badge disappears.
 */
export function pureBadgeState(s: UpdateBadgeStatus): UpdateBadgeState {
  const phase = s.phase ?? 'idle';

  // Installing cannot be acted on and cannot be missed: it is the loudest state and it wins outright.
  if (phase === 'committing') {
    return {
      visible: true, kind: 'installing', label: 'Closing Legion', detail: '', pct: null, tone: 'busy',
      title: 'Legion is closing to install the update. A window shows each step until the new version is running.', action: 'settings',
    };
  }

  if (phase === 'downloading') {
    const pct = downloadPct(s.progress);
    // step 3: once every byte is in, the signature and hash checks run before the update counts as ready
    if (pct === 100) {
      return {
        visible: true, kind: 'verifying', label: 'Verifying the signature', detail: '', pct: 100, tone: 'progress',
        title: 'The update has downloaded. Legion is checking its signature before it offers to install. Click to open the update panel.', action: 'settings',
      };
    }
    const bytes = s.progress && s.progress.total > 0 ? ` (${fmtBytes(s.progress.bytes)} of ${fmtBytes(s.progress.total)})` : '';
    return {
      visible: true, kind: 'downloading', label: 'Downloading', detail: pct === null ? 'starting…' : `${pct}%`,
      pct, tone: 'progress',
      title: pct === null ? 'Downloading the update in the background.' : `Downloading the update: ${pct}%${bytes}. Click to open the update panel.`,
      action: 'settings',
    };
  }

  // staged (or phase 'staged') is the ready state; the hint says whether the owner must act or Legion will.
  if (s.staged || phase === 'staged') {
    const idle = installsWhenIdle(s);
    return {
      visible: true, kind: 'ready', label: 'Update ready', detail: idle ? 'installs when idle' : 'install now', pct: null, tone: 'ready',
      title: idle ? 'The update is ready. Legion installs it by itself once nothing has run for a minute.'
        : 'The update is ready to install. Click to open the update panel.',
      action: 'settings',
    };
  }

  if (phase === 'awaiting-approval') {
    return {
      visible: true, kind: 'approval', label: 'Update waiting', detail: 'your answer', pct: null, tone: 'accent',
      title: 'Legion is waiting for your answer on the update card. Click to open it.', action: 'settings',
    };
  }

  // step 10, seen from the new build: the update landed. Quiet, once, and below anything that is still under way.
  if (s.updated) {
    return {
      visible: true, kind: 'updated', label: `Updated to ${s.updated.version}`, detail: 'What\'s new', pct: null, tone: 'done',
      title: `Legion updated to ${s.updated.version}.`, action: 'none', updated: s.updated,
    };
  }

  const a = s.available;
  if (a && (phase === 'idle' || phase === 'checking')) {
    return {
      visible: true, kind: 'available', label: 'Update available', detail: `v${a.version}`, pct: null, tone: 'accent',
      title: `Version ${a.version} is available. Click to open Settings, About, and install it.`, action: 'settings',
    };
  }

  return NONE;
}
