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
