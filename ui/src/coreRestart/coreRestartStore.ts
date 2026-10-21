/**
 * Small external store for the core-restart notice and the stopped banner. The state lives in the desktop (main.ts): a restart reloads this
 * window, and the new page reads it once on load; when the core is left stopped there is no reload, so main also says so with an event.
 * In a plain browser (no desktop) there is nothing to read and nothing shows.
 */
import { useSyncExternalStore } from 'react';
import type { StoppedWhy } from './coreRestartText';
import { nextOption } from './coreRestartText';

export interface CoreRestartUi { restarted: boolean; stopped: StoppedWhy | null; dismissed: boolean; busy: boolean; error: string | null }

let st: CoreRestartUi = { restarted: false, stopped: null, dismissed: false, busy: false, error: null };
const subs = new Set<() => void>();
const set = (p: Partial<CoreRestartUi>): void => { st = { ...st, ...p }; subs.forEach((f) => f()); };
export const getCoreRestart = (): CoreRestartUi => st;
export function useCoreRestart<T>(pick: (s: CoreRestartUi) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => pick(st), () => pick(st));
}

const validWhy = (v: unknown): StoppedWhy | null => (v === 'limit' || v === 'failed' || v === 'starting' ? v : null);

/** Reads what happened from the desktop. The restart notice is handed out once, so a new one starts un-dismissed. */
export async function refreshCoreRestart(): Promise<void> {
  try {
    const r = await window.legion?.coreRestartState?.();
    if (!r) return;
    const restarted = r.restarted === true;
    set({ restarted: restarted || st.restarted, stopped: validWhy(r.stopped), ...(restarted ? { dismissed: false } : {}) });
  } catch { /* the desktop is gone: nothing to show */ }
}

let started = false;
/** Once, from the app shell. */
export function startCoreRestart(): void {
  if (started) return;
  started = true;
  void refreshCoreRestart();
  window.legion?.onCoreRestartChanged?.(() => void refreshCoreRestart());
}

export function dismissCoreNotice(): void { set({ dismissed: true }); }

/** The banner's Restart core button: the same restart as the tray. The window reloads when it works. */
export async function restartCoreFromBanner(): Promise<void> {
  if (st.busy) return;
  set({ busy: true, error: null });
  try {
    const r = await window.legion?.restartCoreNow?.();
    if (!r) set({ busy: false, error: 'Legion could not ask the desktop to restart it.' });
    else set({ busy: false, error: r.ok ? null : (r.error ?? 'The restart failed.') });
  } catch { set({ busy: false, error: 'The restart failed.' }); }
}

/** Settings: read the switch, or set it. Main answers with the truth. */
export async function coreRestartOption(on?: boolean): Promise<boolean> {
  try { return nextOption(await window.legion?.coreRestartOption?.(on)); } catch { return true; }
}
