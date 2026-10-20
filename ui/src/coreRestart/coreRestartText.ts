/**
 * The words and the pure rules of the core-restart notice, the stopped banner and the Settings line. No React, no fetch: test/core-restart-ui.test.ts
 * runs it as it is. The state comes from the desktop (main.ts) and the store in coreRestartStore.ts holds it.
 */

export const CORE_RESTARTED_TEXT = 'Legion Core stopped unexpectedly and was restarted. Running tasks were stopped.';
const WHERE = 'Details are in core.log in your data folder (Settings, About).';
export const CORE_STOPPED_LIMIT_TEXT = `Legion Core stopped 3 times in 5 minutes, so Legion did not restart it again. ${WHERE}`;
export const CORE_STOPPED_FAILED_TEXT = `Legion Core stopped unexpectedly and could not be restarted. ${WHERE}`;
export const CORE_OPTION_LABEL = 'Restart Legion Core when it stops unexpectedly';
export const CORE_OPTION_HINT = 'If Legion Core stops on its own, Legion starts it again. Running tasks are stopped when that happens. After 3 stops in 5 minutes it stops trying and tells you. Off: the core stays stopped until you restart it from the tray.';

export type StoppedWhy = 'limit' | 'failed';
export interface BannerInput {
  restarted: boolean;
  stopped: StoppedWhy | null;
  /** The person closed the restart notice. */
  dismissed: boolean;
  /** The Restart core button is working. */
  busy: boolean;
  /** What the last button press said went wrong. */
  error: string | null;
}
export interface BannerModel {
  tone: 'info' | 'stop';
  role: 'status' | 'alert';
  text: string;
  action: 'dismiss' | 'restart';
  actionLabel: string;
  actionDisabled: boolean;
}

/** What the banner shows, or null for nothing. A stop outranks the notice and cannot be dismissed: only a restart ends it. */
export function bannerModel(s: BannerInput): BannerModel | null {
  if (s.stopped) {
    const base = s.stopped === 'limit' ? CORE_STOPPED_LIMIT_TEXT : CORE_STOPPED_FAILED_TEXT;
    return {
      tone: 'stop', role: 'alert', text: s.error ? `${base} Restart failed: ${s.error}` : base,
      action: 'restart', actionLabel: s.busy ? 'Restarting\u2026' : 'Restart core', actionDisabled: s.busy,
    };
  }
  if (s.restarted && !s.dismissed) return { tone: 'info', role: 'status', text: CORE_RESTARTED_TEXT, action: 'dismiss', actionLabel: 'Dismiss', actionDisabled: false };
  return null;
}

/** The switch as main reports it (main is the truth, even after a failed save). Anything unreadable counts as on, the default. */
export function nextOption(reply: unknown): boolean {
  const e = reply && typeof reply === 'object' ? (reply as { enabled?: unknown }).enabled : undefined;
  return typeof e === 'boolean' ? e : true;
}
