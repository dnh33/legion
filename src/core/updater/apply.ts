/**
 * The apply step: a journaled rename swap of the code-set entries inside the install folder, health check of the new build, rollback.
 *
 * This file is SELF-CONTAINED (node: imports only) on purpose: before a swap, main copies the compiled file to <install>/.update/run/apply.mjs
 * and runs it from there under the installed Electron binary in node mode, so it does not live in the folders it swaps. main also imports
 * `recoverInterrupted` from it at every start.
 *
 * What it touches: only the names in CODE_SET (or the names a full-package install passes) inside the install folder, and its own <install>/.update folder. Never the data
 * folder, shortcuts or uninstall.cmd; node_modules and runtime only when a full-package install passes them in `names`. No robocopy; no recursive delete outside .update (and there only after a containment and not-a-link check).
 * Every state change is journaled (temp file + fsync + rename) so a kill at any point is recoverable by `recoverInterrupted`.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only names an update may replace (directories and files at the top of the install folder). */
export const CODE_SET: readonly string[] = Object.freeze([
  'dist', 'dist-ui', 'assets', 'scripts', 'licenses',
  'package.json', 'package-lock.json', 'build-info.json', 'NOTICE', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md',
  'setup.cmd', 'setup-yes.cmd', 'start-legion.cmd',
]);
/**
 * The names a full-package install swaps: the code set plus the dependency tree and the Electron runtime.
 * Mirrors scripts/lib/package-lib.mjs `packageTopNames(CODE_SET)` (EXTRA_TOP). Used only when a signed manifest's
 * `fullAsset` is applied for a release that changes dependencies; the app package never carries these names.
 */
export const FULL_PACKAGE_SET: readonly string[] = Object.freeze([...CODE_SET, 'node_modules', 'runtime']);
export const UPDATE_DIR = '.update';

export type JournalState = 'swapping' | 'awaiting-health' | 'committed' | 'rolled-back';
export interface Journal { state: JournalState; from: string; to: string; entries: string[]; stagedDir: string; at: number; heartbeat: number }
export interface Outcome { at: string; from: string; to: string; result: 'ok' | 'rolled-back' | 'failed' | 're-exec'; reason?: string }

const upDir = (installDir: string): string => join(installDir, UPDATE_DIR);
const journalPath = (installDir: string): string => join(upDir(installDir), 'journal.json');
export const outcomePath = (installDir: string): string => join(upDir(installDir), 'outcome.json');
const prevDir = (installDir: string): string => join(upDir(installDir), 'prev');
const failedDir = (installDir: string): string => join(upDir(installDir), 'failed');
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** Deletes `target` only if it is INSIDE <install>/.update (not that folder itself) and is not a link. Anything else throws. */
export function removeOwned(installDir: string, target: string): void {
  const base = resolve(upDir(installDir));
  const abs = resolve(target);
  if (abs === base || !abs.startsWith(base + sep)) throw new Error('refusing to delete outside the update folder');
  let st; try { st = lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) throw new Error('refusing to delete a link');
  rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, JSON.stringify(value)); try { fsyncSync(fd); } catch { /* best effort */ } } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch { try { rmSync(file, { force: true }); } catch { /* ignore */ } renameSync(tmp, file); }
}
export function readJournal(installDir: string): Journal | null {
  try { const j = JSON.parse(readFileSync(journalPath(installDir), 'utf8')) as Journal; return j && Array.isArray(j.entries) ? j : null; } catch { return null; }
}
export function readOutcome(installDir: string): Outcome | null {
  try { return JSON.parse(readFileSync(outcomePath(installDir), 'utf8')) as Outcome; } catch { return null; }
}
const writeOutcome = (installDir: string, o: Omit<Outcome, 'at'>): void => writeJson(outcomePath(installDir), { at: new Date().toISOString(), ...o });
const saveJournal = (installDir: string, j: Journal): void => writeJson(journalPath(installDir), j);

async function renameRetry(from: string, to: string, retryMs: number): Promise<void> {
  const end = Date.now() + retryMs;
  for (;;) {
    try { renameSync(from, to); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code ?? '') || Date.now() >= end) throw e;
      await sleepMs(500);
    }
  }
}

export interface SwapOptions { installDir: string; stagedDir: string; from: string; to: string; retryMs?: number; /** The names to swap; default CODE_SET. A full-package install passes the code set plus node_modules and runtime. Each must be one plain folder or file name. */ names?: readonly string[]; /** Test hook: throws to simulate a kill at that step. */ step?: (label: string) => void }

/** Moves the live code-set entries into .update/prev and the staged ones into place. Throws on failure after rolling back (or leaves the journal for recovery if the process dies). */
export async function swapIn(o: SwapOptions): Promise<void> {
  const { installDir, stagedDir } = o;
  const retryMs = o.retryMs ?? 15_000;
  const step = o.step ?? (() => undefined);
  for (const n of o.names ?? []) if (!n || n === '.' || n === '..' || /[\\/:]/.test(n) || n === UPDATE_DIR) throw new Error(`refusing to swap "${n}"`);
  const names = (o.names ?? CODE_SET).filter((n) => existsSync(join(stagedDir, n)));
  if (!names.includes('package.json') || !names.includes('dist')) throw new Error('the staged tree is incomplete');
  for (const n of names) if (isLink(join(stagedDir, n))) throw new Error('a staged entry is a link');
  mkdirSync(upDir(installDir), { recursive: true });
  removeOwned(installDir, prevDir(installDir)); // exactly one previous version is kept: the older one goes
  removeOwned(installDir, failedDir(installDir));
  mkdirSync(prevDir(installDir), { recursive: true });
  const j: Journal = { state: 'swapping', from: o.from, to: o.to, entries: names, stagedDir, at: Date.now(), heartbeat: Date.now() };
  saveJournal(installDir, j);
  step('journaled');
  try {
    for (const n of names) {
      const live = join(installDir, n);
      step(`before-move:${n}`);
      if (existsSync(live)) await renameRetry(live, join(prevDir(installDir), n), retryMs);
      step(`before-install:${n}`);
      await renameRetry(join(stagedDir, n), live, retryMs);
      step(`after-install:${n}`);
    }
  } catch (e) {
    if ((e as { kill?: boolean }).kill) throw e; // test hook: simulates the process dying here, so nothing may clean up
    await rollback(installDir, 'failed: ' + (e instanceof Error ? e.message : String(e)));
    throw e;
  }
  j.state = 'awaiting-health'; j.heartbeat = Date.now();
  saveJournal(installDir, j);
}

/**
 * Puts the previous build back, working from what is on disk (not only from the journal), so it is correct whichever step was interrupted:
 * staged copy still there = untouched; previous copy there = old one was moved out. Idempotent.
 */
export async function rollback(installDir: string, reason: string, retryMs = 15_000): Promise<void> {
  const j = readJournal(installDir);
  if (!j) return;
  mkdirSync(failedDir(installDir), { recursive: true });
  for (const n of [...j.entries].reverse()) {
    const live = join(installDir, n);
    const prev = join(prevDir(installDir), n);
    const stagedHere = existsSync(join(j.stagedDir, n));
    if (stagedHere && !existsSync(prev)) continue; // never touched
    if (existsSync(live) && !stagedHere) await renameRetry(live, join(failedDir(installDir), n), retryMs); // the new copy goes aside
    if (existsSync(prev)) await renameRetry(prev, live, retryMs);
  }
  saveJournal(installDir, { ...j, state: 'rolled-back', heartbeat: Date.now() });
  writeOutcome(installDir, { from: j.from, to: j.to, result: 'rolled-back', reason });
  try { removeOwned(installDir, failedDir(installDir)); } catch { /* leftovers are harmless */ }
}

export function markCommitted(installDir: string): void {
  const j = readJournal(installDir);
  if (!j || j.state === 'committed') return;
  saveJournal(installDir, { ...j, state: 'committed', heartbeat: Date.now() });
  writeOutcome(installDir, { from: j.from, to: j.to, result: 'ok' });
  try { removeOwned(installDir, join(upDir(installDir), 'staging')); } catch { /* ignore */ }
}

/**
 * Called by main at every start, BEFORE the core is spawned. `swapping` = the helper died mid-swap: roll back. `awaiting-health` with the
 * running build not being the new one and a stale heartbeat: roll back. Running build == new one: leave it (main confirms it with markCommitted).
 */
export async function recoverInterrupted(installDir: string, ctx: { runningVersion: string; nowMs?: number; staleMs?: number }): Promise<'none' | 'rolled-back' | 'awaiting-confirm'> {
  const j = readJournal(installDir);
  if (!j) return 'none';
  const now = ctx.nowMs ?? Date.now();
  if (j.state === 'swapping') { await rollback(installDir, 'interrupted: the update was cut off during the swap'); return 'rolled-back'; }
  if (j.state === 'awaiting-health') {
    if (ctx.runningVersion === j.to) return 'awaiting-confirm';
    if (now - j.heartbeat > (ctx.staleMs ?? 120_000)) { await rollback(installDir, 'interrupted: the new build was never confirmed healthy'); return 'rolled-back'; }
  }
  return 'none';
}

// ------------------------------------------------------------------ the helper process

export interface Relaunch { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }
export interface ApplyJob {
  installDir: string; stagedDir: string; parentPid: number; port: number; from: string; to: string; relaunch: Relaunch;
  healthTimeoutMs?: number; parentWaitMs?: number; portFreeMs?: number; swapRetryMs?: number;
  /** The names to swap; omitted = CODE_SET (code-only), FULL_PACKAGE_SET = code set + node_modules + runtime. Validated by main-logic commitMatches before it is written here. */
  names?: readonly string[];
}
export interface ApplyDeps {
  isAlive(pid: number): boolean;
  health(port: number): Promise<{ ok: boolean; version?: string } | null>;
  spawnApp(r: Relaunch): { pid?: number } | null;
  killTree(pid: number): Promise<void>;
  /** Full-package swaps on Windows: re-run this helper from a runtime outside the install, returning to nothing. */
  reExec?(jobFile: string): boolean;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  step?: (label: string) => void;
}

export async function runApply(job: ApplyJob, d: ApplyDeps): Promise<Outcome['result']> {
  const { installDir } = job;
  const waitUntil = async (cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    for (;;) { if (await cond()) return true; if (Date.now() >= end) return false; await d.sleep(250); }
  };
  // On Windows this helper runs from <install>/node_modules (electron.exe as node). A full-package swap must
  // rename the very directory the helper is loaded from, which Windows refuses with EPERM no matter how often
  // it is retried (the running image does not share delete). Unload first: re-run the helper from a copy of the
  // runtime in the system temp dir (env-guarded against loops), and let that fresh process own the swap and
  // every outcome after it. The parent and port waits run again in the fresh process.
  if (process.platform === 'win32' && job.names?.includes('node_modules') && process.env.LEGION_APPLY_REEXEC !== '1') {
    d.log('full package: re-running the swap helper from a runtime outside the install (node_modules must move)');
    if (d.reExec?.(process.argv[2] ?? '')) return 're-exec';
  }
  d.log(`apply ${job.from} -> ${job.to}`);
  if (!(await waitUntil(() => !d.isAlive(job.parentPid), job.parentWaitMs ?? 30_000))) { d.log('the app is still running: nothing was changed'); writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: 'the app did not exit in time; nothing was changed' }); return 'failed'; }
  // a core that still answers means files are in use: never swap under it
  if (!(await waitUntil(async () => (await d.health(job.port)) === null, job.portFreeMs ?? 10_000))) { d.log('a core still answers on the port: nothing was changed'); writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: 'a Legion core is still running; nothing was changed' }); d.spawnApp(job.relaunch); return 'failed'; }
  try {
    await swapIn({ installDir, stagedDir: job.stagedDir, from: job.from, to: job.to, retryMs: job.swapRetryMs ?? 15_000, ...(job.names ? { names: job.names } : {}), ...(d.step ? { step: d.step } : {}) });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    d.log(`swap failed: ${reason}`);
    const code = (e as NodeJS.ErrnoException).code;
    writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: ['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '') ? 'files in use: close other Legion windows or tools started in the Legion folder, then try again' : reason });
    d.spawnApp(job.relaunch);
    return 'failed';
  }
  d.log('swapped; starting the new build');
  const child = d.spawnApp(job.relaunch);
  const pid = child?.pid;
  const healthy = await waitUntil(async () => {
    const j = readJournal(installDir);
    if (j) saveJournal(installDir, { ...j, heartbeat: Date.now() });
    const h = await d.health(job.port);
    return !!h && h.ok && h.version === job.to;
  }, job.healthTimeoutMs ?? 60_000);
  if (healthy) { markCommitted(installDir); d.log('the new build is healthy'); return 'ok'; }
  d.log('the new build did not become healthy: rolling back');
  if (pid) await d.killTree(pid); // by PID, never by name
  await waitUntil(async () => (await d.health(job.port)) === null, job.portFreeMs ?? 10_000);
  await rollback(installDir, `the new build did not report healthy on 127.0.0.1:${job.port} within ${Math.round((job.healthTimeoutMs ?? 60_000) / 1000)} s`, job.swapRetryMs ?? 15_000);
  d.spawnApp(job.relaunch);
  return 'rolled-back';
}

export function realDeps(installDir: string): ApplyDeps {
  return {
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    health: async (port) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return null;
        const j = (await r.json().catch(() => ({}))) as { version?: string };
        return { ok: true, ...(typeof j.version === 'string' ? { version: j.version } : {}) };
      } catch { return null; }
    },
    spawnApp: (r) => {
      try {
        // this helper runs with ELECTRON_RUN_AS_NODE=1; the app it starts must not inherit it (it would run as plain node)
        const env: Record<string, string | undefined> = { ...process.env, ...(r.env ?? {}) };
        delete env.ELECTRON_RUN_AS_NODE;
        const c = spawn(r.cmd, r.args, { cwd: r.cwd, detached: true, stdio: 'ignore', windowsHide: false, env });
        c.on('error', () => undefined);
        c.unref();
        return { ...(c.pid ? { pid: c.pid } : {}) };
      } catch { return null; }
    },
    killTree: (pid) => new Promise((done) => {
                if (process.platform === 'win32') { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done()); return; }
                try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
                done();
            }),
            reExec: (jobFile) => {
                const src = process.execPath; // electron.exe under <install>/node_modules — the thing locking the swap
                const dst = join(tmpdir(), `legion-apply-${process.pid}.exe`);
                const env: Record<string, string | undefined> = { ...process.env, LEGION_APPLY_REEXEC: '1' };
                try { copyFileSync(src, dst); } catch { return false; }
                try {
                    const c = spawn(dst, [process.argv[1] ?? '', jobFile], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: false, env });
                    c.on('error', () => undefined);
                    c.unref();
                    return true;
                } catch { return false; }
            },
    sleep: sleepMs,
    log: (line) => { try { appendFileSync(join(upDir(installDir), 'apply.log'), `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ } },
  };
}

// Entry point: `electron.exe .update/run/apply.mjs <job.json>` (ELECTRON_RUN_AS_NODE=1). Not run when this file is imported.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const jobFile = process.argv[2] ?? '';
  let job: ApplyJob | null = null;
  try { job = JSON.parse(readFileSync(jobFile, 'utf8')) as ApplyJob; } catch { /* no job: nothing to do */ }
  if (job) void runApply(job, realDeps(job.installDir)).then((r) => process.exit(r === 'ok' ? 0 : 1)).catch(() => process.exit(2));
}
