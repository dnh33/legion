/**
 * Legion Core restarts itself once when it stops unexpectedly. Pure pieces only (no electron import), so every branch is tested:
 * the crash tracker, the decision, what the window is told, and the switch. The wiring is in main.ts.
 *
 * The limit follows the crash tracker of an editor's extension host: record the crash, then restart only while fewer than 3 are
 * recorded in the last 5 minutes. So the first and second stop restart the core, and the third shows the banner instead.
 */

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 5 * 60 * 1000;
/** Wait before restarting, so a whole-app kill (taskkill of the app tree) can finish and show up as quitting first. */
export const RESTART_DELAY_MS = 1000;

export class CrashTracker {
  private crashes: number[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  private prune(): void {
    const oldest = this.now() - CRASH_WINDOW_MS;
    while (this.crashes.length > 0 && this.crashes[0]! < oldest) this.crashes.shift();
  }
  /** Records a crash now. Returns how many are in the window, this one included. */
  register(): number {
    this.prune();
    this.crashes.push(this.now());
    return this.crashes.length;
  }
  count(): number {
    this.prune();
    return this.crashes.length;
  }
  reset(): void { this.crashes = []; }
}

export interface RestartFacts {
  /** Someone in main asked for this stop (the tray Restart, a settings restart, the updater, quit). */
  intended: boolean;
  quitting: boolean;
  /** An update is being applied, or a swap is in progress. */
  updating: boolean;
  /** The computer is logging off or shutting down. */
  sessionEnding: boolean;
  /** The Settings switch. */
  enabled: boolean;
  /** Crashes in the window, this one included. */
  count: number;
}

export type RestartDecision = { action: 'restart' | 'stop-at-limit' | 'ignore'; log: string };

export function decideRestart(f: RestartFacts): RestartDecision {
  if (f.intended) return { action: 'ignore', log: 'not restarting: intended stop' };
  if (f.quitting) return { action: 'ignore', log: 'not restarting: quitting' };
  if (f.sessionEnding) return { action: 'ignore', log: 'not restarting: session ending' };
  if (f.updating) return { action: 'ignore', log: 'not restarting: update in progress' };
  if (!f.enabled) return { action: 'ignore', log: 'not restarting: switched off in Settings' };
  if (f.count >= CRASH_LIMIT) return { action: 'stop-at-limit', log: `not restarting: limit reached (${f.count} in the last 5 minutes)` };
  return { action: 'restart', log: `restarting (crash ${f.count} of ${CRASH_LIMIT} in 5 minutes)` };
}

export function exitLine(code: number | null, signal: string | null, count: number): string {
  return `Legion Core exited unexpectedly: code ${code ?? 'none'}, signal ${signal ?? 'none'}, ${count} in the last 5 minutes`;
}

/** `stopped`: why the core is left stopped: the crash limit, or a restart that did not come up. */
export type StoppedWhy = 'limit' | 'failed';
export interface CoreRestartView { restarted: boolean; stopped: StoppedWhy | null }

/** What the window is told. The restart notice is handed out once; the stopped state stays until the person restarts the core. */
export class CoreRestartState {
  private restarted = false;
  private stopped: StoppedWhy | null = null;
  noteRestarted(): void { this.restarted = true; }
  noteStopped(why: StoppedWhy): void { this.stopped = why; this.restarted = false; }
  clearStopped(): void { this.stopped = null; }
  take(): CoreRestartView {
    const v = { restarted: this.restarted, stopped: this.stopped };
    this.restarted = false;
    return v;
  }
}

/** The Settings switch, from the text of app-settings.json. On unless it says a real false. */
export function restartEnabled(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    const j = JSON.parse(raw) as { restartCoreOnCrash?: unknown } | null;
    return !(j && typeof j === 'object' && j.restartCoreOnCrash === false);
  } catch { return true; }
}

/** The text of app-settings.json with the switch set, every other key kept. A file that does not parse is replaced. */
export function withRestartEnabled(raw: string | null, on: boolean): string {
  let base: Record<string, unknown> = {};
  try {
    const j = raw === null ? null : JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) base = j as Record<string, unknown>;
  } catch { /* start a fresh file */ }
  return JSON.stringify({ ...base, restartCoreOnCrash: on }, null, 2) + '\n';
}
