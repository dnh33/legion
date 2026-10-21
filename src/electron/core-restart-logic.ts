/**
 * Legion Core restarts itself once when it stops unexpectedly. Pure pieces only (no electron import), so every branch is tested:
 * the crash tracker, the decision, what the window is told, and the switch. The wiring is in main.ts.
 *
 * The limit follows the crash tracker of an editor's extension host: record the crash, then restart only while fewer than 3 are
 * recorded in the last 5 minutes. So the first and second stop restart the core, and the third shows the banner instead.
 */

import { join } from 'node:path';
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

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
  /** Legion is still starting (the splash is up): a core that dies now is the start's failure, not a crash to restart. */
  booting?: boolean;
  /** The switch file could not be read (the error code). Then `enabled` is false, and the log says why. */
  switchError?: string;
  /** Crashes in the window, this one included. */
  count: number;
}

export type RestartDecision = { action: 'restart' | 'stop-at-limit' | 'stopped-starting' | 'ignore'; log: string };

export function decideRestart(f: RestartFacts): RestartDecision {
  if (f.intended) return { action: 'ignore', log: 'not restarting: intended stop' };
  if (f.quitting) return { action: 'ignore', log: 'not restarting: quitting' };
  if (f.sessionEnding) return { action: 'ignore', log: 'not restarting: session ending' };
  if (f.updating) return { action: 'ignore', log: 'not restarting: update in progress' };
  if (f.booting) return { action: 'stopped-starting', log: 'not restarting: Legion is still starting' };
  if (!f.enabled) return { action: 'ignore', log: f.switchError ? `not restarting: could not read the switch file (${f.switchError})` : 'not restarting: switched off in Settings' };
  if (f.count >= CRASH_LIMIT) return { action: 'stop-at-limit', log: `not restarting: limit reached (${f.count} in the last 5 minutes)` };
  return { action: 'restart', log: `restarting (crash ${f.count} of ${CRASH_LIMIT} in 5 minutes)` };
}

export function exitLine(code: number | null, signal: string | null, count: number): string {
  return `Legion Core exited unexpectedly: code ${code ?? 'none'}, signal ${signal ?? 'none'}, ${count} in the last 5 minutes`;
}

/** `stopped`: why the core is left stopped: the crash limit, or a restart that did not come up. */
export type StoppedWhy = 'limit' | 'failed' | 'starting';
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

/** The file work behind the switch. Real fs by default; tests pass their own. */
export interface SwitchFs {
  read(path: string): string;
  write(path: string, text: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}
const realFs: SwitchFs = {
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, t) => writeFileSync(p, t, { flag: 'wx' }), // exclusive: never follows a planted link
  rename: (a, b) => renameSync(a, b),
  remove: (p) => { try { unlinkSync(p); } catch { /* already gone */ } },
};
const isMissing = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'ENOENT';

/**
 * The switch as main reads it when the core has just died. No file yet: on. A file that cannot be read right now (an antivirus scan holds it,
 * a permission error) is unknown, and unknown means do not restart: the person's "off" must never flip to "on" for a crash.
 */
export function readRestartSwitch(path: string, fs: Pick<SwitchFs, 'read'> = realFs): boolean {
  return restartSwitchStatus(path, fs).on;
}

/** Like readRestartSwitch, and when the file could not be read it also says why (the error code), for the log. */
export function restartSwitchStatus(path: string, fs: Pick<SwitchFs, 'read'> = realFs): { on: boolean; error?: string } {
  let raw: string | null = null;
  try { raw = fs.read(path); } catch (e) {
    if (!isMissing(e)) return { on: false, error: (e as { code?: string } | null)?.code ?? 'unreadable' };
  }
  return { on: restartEnabled(raw) };
}

/**
 * Saves the switch: the new text goes to a temp file next to the real one and is renamed over it, so a crash or a power cut in the middle
 * leaves the old file whole. A file that exists but cannot be read is not overwritten (that would drop its other keys): the error is thrown.
 */
export function writeRestartSwitch(path: string, on: boolean, fs: SwitchFs = realFs): void {
  let raw: string | null = null;
  try { raw = fs.read(path); } catch (e) { if (!isMissing(e)) throw e; }
  const tmp = `${path}.${process.pid}.tmp`;
  const text = withRestartEnabled(raw, on);
  try {
    try { fs.write(tmp, text); } catch (e) {
      // the temp name is taken (a leftover, or something planted there): remove it, never write through it, and try once more
      if ((e as { code?: string } | null)?.code !== 'EEXIST') throw e;
      fs.remove(tmp);
      fs.write(tmp, text);
    }
    fs.rename(tmp, path);
  } catch (e) {
    fs.remove(tmp);
    throw e;
  }
}

/** At startup: removes the temp files an interrupted save left next to app-settings.json. Returns how many. */
export function sweepSwitchTemps(dir: string, fs: { list(dir: string): string[]; remove(p: string): void } = { list: (d) => readdirSync(d), remove: realFs.remove }): number {
  let names: string[] = [];
  try { names = fs.list(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (/^app-settings\.json\.\d+\.tmp$/.test(name)) { fs.remove(join(dir, name)); n++; }
  }
  return n;
}

/** One async job at a time. A caller that arrives while it runs shares that run's answer instead of starting a second one. */
export class SingleFlight<T> {
  private pending: Promise<T> | null = null;
  get busy(): boolean { return this.pending !== null; }
  run(job: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending;
    const p = job().finally(() => { if (this.pending === p) this.pending = null; });
    this.pending = p;
    return p;
  }
}
