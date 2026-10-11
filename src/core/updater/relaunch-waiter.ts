/**
 * The relaunch waiter: a detached helper that outlives the updater, waits until the old app is REALLY gone, and only then starts the new build.
 * It replaces the fire-and-forget `spawnApp` relaunch, which could start the new build while the old one was still exiting.
 *
 * Two halves in this one self-contained file (node: imports only):
 * - the parent side: `startWaiter` spawns THIS MODULE as a child process and completes a handshake (the waiter writes `readyFile`); the
 *   returned handle can cancel (kill) the waiter. All I/O goes through `WaiterDeps`.
 * - the waiter side: running this file as a script (`node relaunch-waiter.js '<job json>'`) writes the ready file, polls until the old pid is
 *   gone, and launches the new binary. It survives the updater's exit by design (detached + unref).
 *
 * The PID-reuse guard: a live pid only counts as "the old app still running" while its start time still matches the one recorded for the old
 * app. A live pid with a different start time is a recycled pid — the old app is effectively gone. This is what keeps the waiter from blocking
 * on a dead app's recycled pid, and from trusting a pid it cannot identify.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The waiter gives up (and does NOT relaunch) if the old app is still alive after this long. */
export const MAX_WAIT_MS = 900_000;
export const DEFAULT_HANDSHAKE_MS = 10_000;
const POLL_MS = 500;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type RelaunchVerdict = 'waiting' | 'ready' | 'pid-reused';

/**
 * The per-poll decision — pure, so the verdict logic is tested without spawning anything:
 * - 'waiting'    the old app is provably still running (same pid, same start time);
 * - 'ready'      it is genuinely gone (the pid is dead) or effectively gone (the pid was recycled: alive, different start time);
 * - 'pid-reused' the pid is alive but its start time cannot be read, so it is neither provably the old app nor provably a stranger: the waiter
 *                keeps waiting (usually transient — the process exited between the two probes — and the next poll resolves it).
 */
export function shouldRelaunch(oldPid: number, oldStartTimeMs: number, isAlive: (pid: number) => boolean, getStart: (pid: number) => number | null): RelaunchVerdict {
  if (!isAlive(oldPid)) return 'ready';
  const start = getStart(oldPid);
  if (start === null) return 'pid-reused';
  return start === oldStartTimeMs ? 'waiting' : 'ready';
}

// ------------------------------------------------------------------ the parent side

export interface WaiterDeps {
  spawnWaiter(script: string, args: string[]): { pid: number };
  killPid(pid: number): void;
  isPidAlive(pid: number): boolean;
  getPidStartTime(pid: number): number | null;
  fileExists(path: string): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}
export interface RelaunchHandle { waiterPid: number; cancel(): Promise<void> }
export interface WaiterOpts { oldPid: number; oldStartTimeMs: number; newCmd: string; newArgs: string[]; readyFile: string; handshakeTimeoutMs?: number }

/**
 * Spawns the waiter and confirms the handshake: the waiter must write `readyFile` within `handshakeTimeoutMs` (default 10 s) or it is
 * cancelled (killed) and the caller gets an error. After a successful handshake the caller may exit whenever it wants — the waiter
 * relaunches on its own once the old process is gone. `readyFile` should be unique per attempt (a stale one would confirm a dead waiter).
 */
export async function startWaiter(deps: WaiterDeps, opts: WaiterOpts): Promise<{ ok: true; handle: RelaunchHandle } | { ok: false; error: string }> {
  const timeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_MS;
  let spawned: { pid: number };
  try {
    // the whole job travels as one JSON argv: no shell quoting anywhere, and the newArgs array survives untouched
    const job = { oldPid: opts.oldPid, oldStartTimeMs: opts.oldStartTimeMs, newCmd: opts.newCmd, newArgs: opts.newArgs, readyFile: opts.readyFile };
    spawned = deps.spawnWaiter(fileURLToPath(import.meta.url), [JSON.stringify(job)]);
  } catch (e) {
    return { ok: false, error: `the relaunch waiter could not be started: ${errText(e)}` };
  }
  if (!Number.isInteger(spawned.pid) || spawned.pid <= 0) return { ok: false, error: 'the relaunch waiter did not report a pid' };
  const waiterPid = spawned.pid;
  const cancel = async (): Promise<void> => {
    deps.killPid(waiterPid);
    deps.log(`relaunch waiter ${waiterPid} cancelled`);
  };
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if (deps.fileExists(opts.readyFile)) {
      deps.log(`relaunch waiter ${waiterPid} is up; it starts the new build once pid ${opts.oldPid} is gone`);
      return { ok: true, handle: { waiterPid, cancel } };
    }
    if (deps.now() >= deadline) {
      await cancel();
      return { ok: false, error: `the relaunch waiter did not confirm within ${timeoutMs} ms` };
    }
    await deps.sleep(100);
  }
}

// ------------------------------------------------------------------ the waiter side

export interface WaiterRunDeps {
  writeReady(path: string): void;
  isPidAlive(pid: number): boolean;
  getPidStartTime(pid: number): number | null;
  launch(cmd: string, args: string[]): { pid?: number } | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}
export interface WaiterJob { oldPid: number; oldStartTimeMs: number; newCmd: string; newArgs: string[]; readyFile: string; maxWaitMs?: number; pollMs?: number }
export type WaiterOutcome = 'relaunched' | 'gave-up' | 'launch-failed';

/**
 * The waiter loop: announce (ready file), poll `shouldRelaunch` until the old app is gone, then launch the new build. If the old app is
 * still alive after `maxWaitMs` (default 900 s), nothing is launched — starting the new build on top of a running old one is exactly the
 * race this waiter exists to prevent; the swap is already on disk, so the next manual start runs the new version.
 */
export async function runWaiter(job: WaiterJob, d: WaiterRunDeps): Promise<WaiterOutcome> {
  try {
    d.writeReady(job.readyFile);
  } catch (e) {
    d.log(`relaunch waiter: the ready file could not be written: ${errText(e)}`);
  }
  const deadline = d.now() + (job.maxWaitMs ?? MAX_WAIT_MS);
  for (;;) {
    const verdict = shouldRelaunch(job.oldPid, job.oldStartTimeMs, d.isPidAlive, d.getPidStartTime);
    if (verdict === 'ready') break;
    if (verdict === 'pid-reused') d.log(`relaunch waiter: pid ${job.oldPid} is alive but its start time cannot be read: waiting`);
    if (d.now() >= deadline) {
      d.log(`relaunch waiter: pid ${job.oldPid} did not go away within ${Math.round((job.maxWaitMs ?? MAX_WAIT_MS) / 1000)} s: giving up without a relaunch`);
      return 'gave-up';
    }
    await d.sleep(job.pollMs ?? POLL_MS);
  }
  d.log(`relaunch waiter: the old app (pid ${job.oldPid}) is gone; starting ${job.newCmd}`);
  try {
    if (!d.launch(job.newCmd, job.newArgs)) return 'launch-failed';
    return 'relaunched';
  } catch (e) {
    d.log(`relaunch waiter: the new build could not be started: ${errText(e)}`);
    return 'launch-failed';
  }
}

// ------------------------------------------------------------------ real I/O (used by the entry point and by the orchestrator's wiring)

/**
 * A stable fingerprint of when a process started (epoch ms). Both sides use this same function, so identity only needs equality:
 * the parent records `getPidStartTime(process.pid)` as `oldStartTimeMs` and the waiter compares it against the live pid's value.
 */
export function realGetPidStartTime(pid: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [long]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
      const n = Number(out.trim().split(/\s+/).pop());
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
    }
    // linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot at 100 Hz) plus /proc/stat btime
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + ticks * 10 : null;
  } catch {
    return null; // unknown platform or unreadable: shouldRelaunch then reports pid-reused and never assumes the old app is gone
  }
}

export function realWaiterRunDeps(optsEnv?: Record<string, string | undefined>): WaiterRunDeps {
  return {
    writeReady: (p) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, String(process.pid)); },
    isPidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    getPidStartTime: realGetPidStartTime,
    launch: (cmd, args) => {
      try {
        // the waiter runs as plain node (ELECTRON_RUN_AS_NODE=1 when spawned from the electron helper); the app it starts must not inherit it
        const env: Record<string, string | undefined> = { ...(optsEnv ?? {}) };
        delete env.ELECTRON_RUN_AS_NODE;
        const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
        c.on('error', () => undefined);
        c.unref();
        return { ...(c.pid ? { pid: c.pid } : {}) };
      } catch { return null; }
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => { try { console.error(`[legion-relaunch] ${line}`); } catch { /* ignore */ } },
  };
}

/** Parent-side real deps; `log` is the orchestrator's (e.g. appending to .update/apply.log). */
export function realWaiterDeps(optsEnv?: Record<string, string | undefined>, log: (line: string) => void = (l) => { try { console.error(`[legion-relaunch] ${l}`); } catch { /* ignore */ } }): WaiterDeps {
  return {
    spawnWaiter: (script, args) => {
      // the waiter is plain node code: force ELECTRON_RUN_AS_NODE=1 so electron.exe runs it as node under the helper
      const c = spawn(process.execPath, [script, ...args], { detached: true, stdio: 'ignore', windowsHide: false, env: { ...(optsEnv ?? {}), ELECTRON_RUN_AS_NODE: '1' } });
      c.on('error', () => undefined);
      c.unref();
      if (!c.pid) throw new Error('the waiter process did not start');
      return { pid: c.pid };
    },
    killPid: (pid) => {
      if (process.platform === 'win32') { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined); return; }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    },
    isPidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    getPidStartTime: realGetPidStartTime,
    fileExists: existsSync,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  };
}

// Entry point: `node relaunch-waiter.js '<job json>'` (or electron.exe with ELECTRON_RUN_AS_NODE=1). Not run when this file is imported.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let job: WaiterJob | null = null;
  try { job = JSON.parse(process.argv[2] ?? '') as WaiterJob; } catch { /* no job: nothing to do */ }
  if (job && typeof job.oldPid === 'number' && typeof job.newCmd === 'string') {
    void runWaiter(job, realWaiterRunDeps()).then((r) => process.exit(r === 'relaunched' ? 0 : 1)).catch(() => process.exit(2));
  }
}
