/**
 * The desktop app must be exactly one process.
 *
 * Electron hands the first process a single-instance lock; a second launch (a pinned shortcut, a double-click on
 * Legion.exe, or the updater's own relaunch after an in-place update) receives `false` from
 * `app.requestSingleInstanceLock()`. That second process must quit BEFORE it creates a window, a tray or a core:
 * two processes over one core is exactly the stacking that left two Legion windows on screen.
 *
 * Kept pure and free of electron so the rule is tested without booting a window.
 */
export interface SingleInstanceDecision {
  /** This is the first process: take the lock, build the window, start the core. */
  primary: boolean;
  /** This is a later process: quit before doing anything visible. */
  quit: boolean;
}

/** The single-instance rule as data, so the branch that quits is tested rather than read. */
export function decideSingleInstance(hasLock: boolean): SingleInstanceDecision {
  return hasLock ? { primary: true, quit: false } : { primary: false, quit: true };
}

/**
 * The single-instance lock for a start. The updater's relaunch (LEGION_UPDATE_HANDOFF) can arrive while a third launch still holds the lock for
 * a few milliseconds on its way out, so a handoff retries for up to maxMs before it gives up; any other second launch asks once and quits.
 * (H2, the updating window, replaces this hand-over: until then this retry is the guard against the race.)
 */
export async function acquireStartLock(o: { request: () => boolean; handoff: boolean; sleep: (ms: number) => Promise<void>; now: () => number; maxMs?: number; stepMs?: number }): Promise<boolean> {
  if (o.request()) return true;
  if (!o.handoff) return false;
  const end = o.now() + (o.maxMs ?? 5000);
  const step = o.stepMs ?? 100;
  while (o.now() < end) {
    await o.sleep(step);
    if (o.request()) return true;
  }
  return false;
}
