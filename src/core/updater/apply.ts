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
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, writeSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// C21: this helper is copied alone to <install>/.update/run/apply.mjs and run standalone during the swap,
// so it imports node: builtins ONLY. The types and the pure recovery judge are inlined here (no sibling
// imports); every impure behavior (preflight, marker, teardown, waiter, metrics, progress) arrives through
// ApplyDeps, exactly like health/spawnApp/reExec already do.
export interface PreflightResult { ok: boolean; backedUp: string[]; error?: string }
export interface MarkerInfo { fromVersion: string; toVersion: string }
export interface BeginResult { ok: boolean; reason?: 'in-progress' | 'error'; message?: string }
export interface RecoveryVerdict { action: 'swap-back' | 'complete' | 'clean'; reason: string }
export interface UpdateAttemptRec { at: number; from: string; to: string; result: 'ok' | 'rolled-back' | 'failed' | 're-exec'; durationMs: number; reason?: string }
export interface ProgressEventRec { stage: string; message: string; percent: number | null }
export type ProgressSink = (e: ProgressEventRec) => void;

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
/** Written in apply.log by every swap, so a log shows which generation of the helper did it (0.2.7 and older write no stamp). */
export const APPLY_HELPER_STAMP = 'helper:stepping-stone-1';
/** The prepared runtime the helper can start from (see runtime-copy.ts). Lives in .update, which the swap never renames. */
export const RUNTIME_COPY_DIR = 'runtime-copy';
/** The cross-process update marker (update-marker.ts reads the same file at every start). */
export const MARKER_FILE_NAME = 'update-in-progress.json';
/** The marker is a lease: live while its owner beats within this window, whatever process the owner is now. */
export const MARKER_LEASE_MS = 120_000;
/** Hard cap: a marker older than this never blocks anything, beating or not. */
export const MARKER_MAX_MS = 20 * 60_000;

export type JournalState = 'swapping' | 'awaiting-health' | 'committed' | 'rolled-back';
export interface Journal { state: JournalState; from: string; to: string; entries: string[]; /** The entries whose live copy was moved to .update/prev. A rollback restores exactly these. Absent in journals from older helpers. */ hadPrev?: string[]; stagedDir: string; at: number; heartbeat: number }
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

export function markerLeaseState(m: { startedAt: number; heartbeat?: number }, nowMs: number): 'capped' | 'leased' | 'lapsed' {
  if (nowMs - m.startedAt > MARKER_MAX_MS) return 'capped';
  return m.heartbeat !== undefined && nowMs - m.heartbeat <= MARKER_LEASE_MS ? 'leased' : 'lapsed';
}

interface MarkerFile { pid: number; startTimeMs: number; fromVersion: string; toVersion: string; startedAt: number; heartbeat: number }
/**
 * The helper's own update marker, written to <install>/.update/update-in-progress.json for update-marker.ts to read at the next start.
 * Self-contained on purpose (this file cannot import update-marker.ts). The first helper begins it; the process the re-exec starts
 * adopts it (same file, new pid); both beat it, so the lease stays fresh across the hand-over and a dead owner's marker lapses.
 */
export function fileMarker(installDir: string, o: { now?: () => number; isAlive?: (pid: number) => boolean } = {}): NonNullable<ApplyDeps['marker']> {
  const now = o.now ?? Date.now;
  const alive = o.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } });
  const file = join(upDir(installDir), MARKER_FILE_NAME);
  const read = (): MarkerFile | null => {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<MarkerFile>;
      return v && Number.isInteger(v.pid) && typeof v.startedAt === 'number' && typeof v.toVersion === 'string' && typeof v.fromVersion === 'string'
        ? { pid: v.pid as number, startTimeMs: typeof v.startTimeMs === 'number' ? v.startTimeMs : v.startedAt, fromVersion: v.fromVersion, toVersion: v.toVersion, startedAt: v.startedAt, heartbeat: typeof v.heartbeat === 'number' ? v.heartbeat : 0 }
        : null;
    } catch { return null; }
  };
  const live = (m: MarkerFile): boolean => {
    const s = markerLeaseState(m, now());
    return s === 'leased' || (s === 'lapsed' && alive(m.pid));
  };
  const write = (m: MarkerFile): void => writeJson(file, m);
  const fresh = (i: MarkerInfo, startedAt = now()): MarkerFile => ({ pid: process.pid, startTimeMs: startedAt, fromVersion: i.fromVersion, toVersion: i.toVersion, startedAt, heartbeat: now() });
  const refuse = (m: MarkerFile): BeginResult => ({ ok: false, reason: 'in-progress', message: `an update is already in progress (pid ${m.pid}, ${m.fromVersion} -> ${m.toVersion})` });
  return {
    begin(info) {
      const cur = read();
      if (cur && live(cur)) return refuse(cur);
      try { write(fresh(info)); return { ok: true }; } catch (e) { return { ok: false, reason: 'error', message: `could not create the update marker: ${e instanceof Error ? e.message : String(e)}` }; }
    },
    adopt(info) {
      const cur = read();
      if (cur && live(cur) && cur.toVersion !== info.toVersion) return refuse(cur);
      try { write(fresh(info, cur && cur.toVersion === info.toVersion ? cur.startedAt : now())); return { ok: true }; } catch (e) { return { ok: false, reason: 'error', message: `could not take over the update marker: ${e instanceof Error ? e.message : String(e)}` }; }
    },
    touch() { const cur = read(); if (cur && cur.pid === process.pid) { try { write({ ...cur, heartbeat: now() }); } catch { /* the next beat tries again */ } } },
    end() { try { rmSync(file, { force: true }); } catch { /* a lapsed lease expires it */ } },
    isInProgress() { const cur = read(); return !!cur && live(cur); },
  };
}

async function renameRetry(from: string, to: string, retryMs: number, beat?: () => void): Promise<void> {
  const end = Date.now() + retryMs;
  for (;;) {
    try { renameSync(from, to); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code ?? '') || Date.now() >= end) throw e;
      beat?.();
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
  // A full-package swap replaces the dependency tree and the runtime, so a staged folder that lost any of them (an antivirus
  // scanner, a cleanup) must be refused BEFORE anything moves, not swapped in with the missing part silently skipped.
  if ((o.names ?? []).includes('node_modules')) {
    for (const must of ['dist-ui', 'node_modules', 'runtime']) if (!names.includes(must)) throw new Error(`the staged update is incomplete: ${must} is missing, so nothing was changed`);
  }
  for (const n of names) if (isLink(join(stagedDir, n))) throw new Error('a staged entry is a link');
  mkdirSync(upDir(installDir), { recursive: true });
  // exactly one previous version is kept: the older one goes. But the folder may be the ONLY way back from a build that was never
  // confirmed (its swap or health check is still open in the journal). Put that build back first, so what is kept is a copy that was good.
  const open = readJournal(installDir);
  if (open && (open.state === 'swapping' || open.state === 'awaiting-health')) await rollback(installDir, 'a newer update started before this build was confirmed', o.retryMs ?? 15_000);
  removeOwned(installDir, prevDir(installDir));
  removeOwned(installDir, failedDir(installDir));
  mkdirSync(prevDir(installDir), { recursive: true });
  const j: Journal = { state: 'swapping', from: o.from, to: o.to, entries: names, hadPrev: names.filter((n) => existsSync(join(installDir, n))), stagedDir, at: Date.now(), heartbeat: Date.now() };
  saveJournal(installDir, j);
  step('journaled');
  // The heartbeat of a live swap: a start that finds this journal must see a helper that is still working (recoverInterrupted defers
  // while it is fresh), so beat between entries and while a rename waits for a lock.
  const beat = (): void => { touchHeartbeat(installDir); };
  try {
    for (const n of names) {
      const live = join(installDir, n);
      step(`before-move:${n}`);
      beat();
      if (existsSync(live)) await renameRetry(live, join(prevDir(installDir), n), retryMs, beat);
      step(`before-install:${n}`);
      await renameRetry(join(stagedDir, n), live, retryMs, beat);
      step(`after-install:${n}`);
      beat();
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
  // A build that was confirmed healthy is the install now. Whoever asks late (a helper whose window ended while the new build
  // was still starting) must not undo it.
  if (j.state === 'committed') return;
  mkdirSync(failedDir(installDir), { recursive: true });
  const lost: string[] = [];
  for (const n of [...j.entries].reverse()) {
    const live = join(installDir, n);
    const prev = join(prevDir(installDir), n);
    const stagedHere = existsSync(join(j.stagedDir, n));
    if (stagedHere && !existsSync(prev)) continue; // never touched
    if (!existsSync(prev)) {
      // The previous copy is gone. If the old install HAD this entry, the live one is all that is left: never move it aside
      // (that would restore nothing and delete the install). If the old install did not have it, the new one simply goes.
      if (j.hadPrev?.includes(n) || !j.hadPrev) { if (existsSync(live)) lost.push(n); continue; }
    }
    if (existsSync(live) && !stagedHere) await renameRetry(live, join(failedDir(installDir), n), retryMs); // the new copy goes aside
    if (existsSync(prev)) await renameRetry(prev, live, retryMs);
  }
  saveJournal(installDir, { ...j, state: 'rolled-back', heartbeat: Date.now() });
  writeOutcome(installDir, { from: j.from, to: j.to, result: 'rolled-back', reason: lost.length ? `${reason}. The previous copy of ${lost.join(', ')} was already gone, so the new files were left in place.` : reason });
  try { removeOwned(installDir, failedDir(installDir)); } catch { /* leftovers are harmless */ }
}

/**
 * Heartbeat of an unconfirmed swap. Re-reads right before writing and never touches a journal that was committed or rolled back meanwhile (the new build confirms itself from its own process).
 * Known, accepted window: the read and the write are two separate steps with no file lock, so a commit from another process in between is still overwritten by this
 * beat. The window is a few microseconds; closing it needs a cross-process lock or a separate heartbeat file (not done).
 */
export function touchHeartbeat(installDir: string): boolean {
  const j = readJournal(installDir);
  if (!j || (j.state !== 'swapping' && j.state !== 'awaiting-health')) return false;
  saveJournal(installDir, { ...j, heartbeat: Date.now() });
  return true;
}

export function markCommitted(installDir: string): void {
  const j = readJournal(installDir);
  if (!j || j.state === 'committed') return;
  saveJournal(installDir, { ...j, state: 'committed', heartbeat: Date.now() });
  writeOutcome(installDir, { from: j.from, to: j.to, result: 'ok' });
  try { removeOwned(installDir, join(upDir(installDir), 'staging')); } catch { /* ignore */ }
}

/**
 * Deletes the previous copy (.update/prev: the old node_modules and runtime are ~700 MB) once the new build has started healthy.
 * Until then it is the rollback. Async so it never blocks the app's main thread; safe to call twice or with nothing there.
 */
export async function cleanPrev(installDir: string): Promise<void> {
  const base = resolve(upDir(installDir));
  const target = resolve(prevDir(installDir));
  if (!target.startsWith(base + sep) || isLink(target)) return;
  try { await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* leftovers are harmless; the next swap removes them */ }
}

/**
 * Deletes the prepared runtime copy (.update/runtime-copy, ~370 MB) after an update landed. Only when: the journal says committed, no
 * update marker is left (the helper that ran from the copy has ended it), and the copy was made BEFORE that commit (a copy prepared
 * afterwards is for the next update). Returns whether it removed anything. Never throws.
 */
export async function cleanupRuntimeCopy(installDir: string): Promise<boolean> {
  try {
    const dir = join(upDir(installDir), RUNTIME_COPY_DIR);
    if (!existsSync(dir) || isLink(dir)) return false;
    const j = readJournal(installDir);
    if (!j || j.state !== 'committed') return false;
    if (existsSync(join(upDir(installDir), MARKER_FILE_NAME))) return false;
    let madeAt = 0;
    try { madeAt = (JSON.parse(readFileSync(join(dir, '.copy-stamp.json'), 'utf8')) as { at?: number }).at ?? 0; } catch { /* no readable stamp: not a usable copy anyway */ }
    if (madeAt > j.heartbeat) return false;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    return !existsSync(dir);
  } catch { return false; }
}

/**
 * The new build confirms itself only once its core really answers /health with THIS version. A start that is slow, or whose core
 * never came up, must not confirm (and so must not delete the previous copy): the helper's own window decides that case.
 */
export async function confirmWhenHealthy(installDir: string, runningVersion: string, getHealth: () => Promise<{ ok?: boolean; version?: string } | null>): Promise<boolean> {
  let h: { ok?: boolean; version?: string } | null = null;
  try { h = await getHealth(); } catch { h = null; }
  if (!h || h.ok !== true || h.version !== runningVersion) return false;
  await settleAfterStart(installDir, runningVersion);
  return true;
}

/**
 * Runs at every start of the app. When the update journal names the running version, the swap landed: confirm it if the helper
 * has not, and delete the previous copy. The helper that did the swap is the OLD version's copy of this file, so it may know
 * nothing about cleaning; the new build does it here instead. Never throws.
 */
export async function settleAfterStart(installDir: string, runningVersion: string): Promise<void> {
  try {
    const j = readJournal(installDir);
    if (!j || j.to !== runningVersion) return;
    const note = (line: string): void => { try { appendFileSync(join(upDir(installDir), 'apply.log'), `[${new Date().toISOString()}] ${line}
`); } catch { /* ignore */ } };
    if (j.state === 'awaiting-health') { markCommitted(installDir); note(`new build ${runningVersion} started healthy and confirmed the update`); }
    else if (j.state !== 'committed') return;
    const had = existsSync(prevDir(installDir));
    await cleanPrev(installDir);
    if (had) note(`new build ${runningVersion} removed the previous copy`);
    if (await cleanupRuntimeCopy(installDir)) note(`new build ${runningVersion} removed the prepared runtime copy`);
  } catch { /* a failed cleanup only leaves a folder behind */ }
}

/**
 * A full-package swap on Windows runs its helper from a copy of the Electron folder in the temp folder (legion-apply-<pid>). That
 * process cannot delete the folder it runs from, so a LATER start removes copies older than `maxAgeMs`. Only plain directories
 * named legion-apply-<digits> are touched. Returns the names removed.
 */
export function cleanStaleApplyCopies(tmpRoot: string, o: { maxAgeMs: number; nowMs: number }): string[] {
  const gone: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(tmpRoot); } catch { return gone; }
  for (const n of names) {
    if (!/^legion-apply-\d+$/.test(n)) continue;
    const p = join(tmpRoot, n);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory() || o.nowMs - st.mtimeMs < o.maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      gone.push(n);
    } catch { /* in use or locked: the next start tries again */ }
  }
  return gone;
}

/**
 * How long the new build gets to report healthy. A full package replaces ~7,400 files that an antivirus scanner reads on first
 * use, so its first start can be slow on an ordinary disk: it gets 180 s (code-only updates keep 60 s). A job may set its own.
 */
export const HEALTH_BASE_MS = 60_000;
export const HEALTH_FULL_MS = 180_000;
export const HEALTH_EXTENSION_MS = 120_000;
export function healthWindow(job: Pick<ApplyJob, 'names' | 'healthTimeoutMs' | 'healthExtensionMs'>): { baseMs: number; extensionMs: number } {
  const full = !!job.names?.includes('node_modules');
  return { baseMs: job.healthTimeoutMs ?? (full ? HEALTH_FULL_MS : HEALTH_BASE_MS), extensionMs: job.healthExtensionMs ?? HEALTH_EXTENSION_MS };
}

/**
 * Called by main at every start, BEFORE the core is spawned. `swapping` = the helper died mid-swap: roll back. `awaiting-health` with the
 * running build not being the new one and a stale heartbeat: roll back. Running build == new one: leave it (main confirms it with markCommitted).
 */

/** The singular recovery decision (pure, inlined so this helper stays node-only). */
function judgeRecovery(journal: Journal | null, runningVersion: string): RecoveryVerdict {
  if (!journal) return { action: 'clean', reason: 'no journal: nothing was in flight' };
  const match = runningVersion === journal.to;
  switch (journal.state) {
    case 'swapping':
      return { action: 'swap-back', reason: `interrupted during the swap to ${journal.to}: restoring ${journal.from}` };
    case 'awaiting-health':
      return match
        ? { action: 'complete', reason: `the swap to ${journal.to} landed and that build is running: confirm it` }
        : { action: 'swap-back', reason: `the swap to ${journal.to} never went live (running ${runningVersion}): restoring ${journal.from}` };
    case 'committed':
      return { action: 'clean', reason: `the update to ${journal.to} was already committed` };
    case 'rolled-back':
      return { action: 'clean', reason: 'a rollback is already on record: nothing to recover (idempotent)' };
    default:
      return { action: 'clean', reason: `unrecognised journal state ${String((journal as { state?: unknown }).state)}: nothing to act on` };
  }
}

/** True while a swap is journaled as `swapping` and its helper still beats: files are moving right now and nothing may be put back. */
export function swapInFlight(installDir: string, ctx: { nowMs?: number; staleMs?: number } = {}): boolean {
  const j = readJournal(installDir);
  return !!j && j.state === 'swapping' && (ctx.nowMs ?? Date.now()) - j.heartbeat <= (ctx.staleMs ?? 120_000);
}

export async function recoverInterrupted(installDir: string, ctx: { runningVersion: string; nowMs?: number; staleMs?: number }): Promise<'none' | 'rolled-back' | 'awaiting-confirm'> {
  const j = readJournal(installDir);
  if (!j) return 'none';
  const now = ctx.nowMs ?? Date.now();
  // A live helper may still be deciding: defer when the heartbeat is fresh (judgeRecovery has no clock).
  if (j.state === 'awaiting-health' && ctx.runningVersion !== j.to && now - j.heartbeat <= (ctx.staleMs ?? 120_000)) return 'none';
  // A reopened app must not rename files back under a helper that is still swapping them. The caller waits (swapInFlight) and asks again.
  if (j.state === 'swapping' && now - j.heartbeat <= (ctx.staleMs ?? 120_000)) return 'none';
  // Singular recovery decision (teardown.ts judgeRecovery).
  const v = judgeRecovery(j, ctx.runningVersion);
  if (v.action === 'swap-back') { await rollback(installDir, v.reason); return 'rolled-back'; }
  return v.action === 'complete' ? 'awaiting-confirm' : 'none';
}

/**
 * What main calls at every start: waits while a live helper is still swapping (its heartbeat is fresh), then recovers. The wait ends by itself
 * when the heartbeat lapses (the helper died) or at `maxWaitMs`, so a start is never held for long. Returns what recoverInterrupted says.
 */
export async function recoverAfterLiveSwap(installDir: string, ctx: { runningVersion: string; sleep?: (ms: number) => Promise<void>; now?: () => number; maxWaitMs?: number; pollMs?: number; staleMs?: number }): Promise<'none' | 'rolled-back' | 'awaiting-confirm'> {
  const now = ctx.now ?? Date.now;
  const t0 = now();
  const sleep = ctx.sleep ?? sleepMs;
  while (swapInFlight(installDir, { nowMs: now(), ...(ctx.staleMs ? { staleMs: ctx.staleMs } : {}) }) && now() - t0 < (ctx.maxWaitMs ?? 150_000)) await sleep(ctx.pollMs ?? 2000);
  return recoverInterrupted(installDir, { runningVersion: ctx.runningVersion, nowMs: now(), ...(ctx.staleMs ? { staleMs: ctx.staleMs } : {}) });
}

// ------------------------------------------------------------------ the helper process

export interface Relaunch { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }
export interface ApplyJob {
  installDir: string; stagedDir: string; parentPid: number; port: number; from: string; to: string; relaunch: Relaunch;
  healthTimeoutMs?: number; /** One extra wait, used only when the new build's process is still alive at the end of the first window. */ healthExtensionMs?: number; parentWaitMs?: number; portFreeMs?: number; swapRetryMs?: number;
  /** The names to swap; omitted = CODE_SET (code-only), FULL_PACKAGE_SET = code set + node_modules + runtime. Validated by main-logic commitMatches before it is written here. */
  names?: readonly string[];
}
/** `finished`: the re-exec copy ran and ended by itself with a non-ok result, so it already wrote the outcome and started the app; the parent must do neither. */
export type ReExecResult = { ok: true } | { ok: false; error: string; finished?: boolean };
export interface ApplyDeps {
  isAlive(pid: number): boolean;
  health(port: number): Promise<{ ok: boolean; version?: string } | null>;
  spawnApp(r: Relaunch): { pid?: number } | null;
  killTree(pid: number): Promise<void>;
  /** Full-package swaps on Windows: re-run this helper from a runtime outside the install, returning to nothing. */
  reExec?(jobFile: string): ReExecResult | Promise<ReExecResult>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  step?: (label: string) => void;
  /** Graceful core shutdown before swap (teardown.ts). Returns ok:false to cancel the update. */
  gracefulTeardown?: (timeoutMs: number) => Promise<{ ok: boolean; error?: string }>;
  /** Cross-process update marker (update-marker.ts). */
  marker?: {
    begin(info: MarkerInfo): BeginResult; end(): void; isInProgress(): boolean;
    /** The process the re-exec starts takes over the marker of the process that started it (same target), instead of being refused by it. */
    adopt?(info: MarkerInfo): BeginResult;
    /** Refreshes the marker's heartbeat. */
    touch?(): void;
  };
  /** Data backup before any file is touched (state-preflight.ts). Fail-closed. */
  runPreflight?: () => PreflightResult;
  /** External relaunch waiter (relaunch-waiter.ts). */
  startWaiter?: (opts: { oldPid: number; newCmd: string; newArgs: string[] }) => Promise<{ ok: boolean; waiterPid?: number; error?: string }>;
  /** Update attempt history (metrics.ts). */
  recordAttempt?: (attempt: UpdateAttemptRec) => void;
  /** Progress events for the update panel (progress.ts). */
  progress?: ProgressSink;
}

export async function runApply(job: ApplyJob, d: ApplyDeps): Promise<Outcome['result']> {
  const { installDir } = job;
  const progress: ProgressSink = d.progress ?? (() => undefined);
  const startTime = Date.now();
  const finish = (result: Outcome['result'], reason?: string): Outcome['result'] => {
    if (d.recordAttempt) {
      d.recordAttempt({
        at: startTime, from: job.from, to: job.to,
        result: result === 'ok' ? 'ok' : result === 'rolled-back' ? 'rolled-back' : result === 're-exec' ? 're-exec' : 'failed',
        durationMs: Date.now() - startTime,
        ...(reason ? { reason } : {})
      });
    }
    return result;
  };
  let beatAt = 0;
  const beatMarker = (): void => { const t = Date.now(); if (d.marker?.touch && t - beatAt >= 2000) { beatAt = t; try { d.marker.touch(); } catch { /* the lease just ages */ } } };
  const waitUntil = async (cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    for (;;) { beatMarker(); if (await cond()) return true; if (Date.now() >= end) return false; await d.sleep(250); }
  };
  // Cross-process update marker: refuse if another update owns this install (update-marker.ts).
  if (d.marker) {
    const info = { fromVersion: job.from, toVersion: job.to };
    // A re-exec'd process (or one started straight from the prepared runtime copy) carries LEGION_APPLY_REEXEC: it adopts the marker.
    const begin = process.env.LEGION_APPLY_REEXEC === '1' && d.marker.adopt ? d.marker.adopt(info) : d.marker.begin(info);
    if (!begin.ok) {
      d.log(`update refused: ${begin.message}`);
      writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: begin.message });
      return finish('failed', begin.message);
    }
  }
  // On Windows this helper runs from <install>/node_modules (electron.exe as node). A full-package swap must
  // rename the very directory the helper is loaded from, which Windows refuses with EPERM no matter how often
  // it is retried (the running image does not share delete). Unload first: re-run the helper from a copy of the
  // runtime in the system temp dir (env-guarded against loops), and let that fresh process own the swap and
  // every outcome after it. The parent and port waits run again in the fresh process.
  if (process.platform === 'win32' && job.names?.includes('node_modules') && process.env.LEGION_APPLY_REEXEC !== '1') {
    d.log('full package: re-running the swap helper from a runtime outside the install (node_modules must move)');
    if (d.reExec) {
      const r = await d.reExec(process.argv[2] ?? '');
      if (r.ok) return finish('re-exec');
      if (r.finished) { const o = readOutcome(installDir); return finish('failed', o?.reason ?? r.error); }
      // Without the re-exec the helper would try to rename the folder it runs from, which Windows refuses. Say so and stop:
      // nothing was changed, and the old app is started again (this process is the only one that can still do that).
      const reason = `Legion could not prepare the update helper (${r.error}). Nothing was changed.`;
      d.log(reason);
      writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason });
      d.spawnApp(job.relaunch);
      if (d.marker) d.marker.end();
      return finish('failed', reason);
    }
  }
  d.log(`apply ${job.from} -> ${job.to} [${APPLY_HELPER_STAMP}]`);
  // Data backup before any file is touched (state-preflight.ts). Fail closed.
  if (d.runPreflight) {
    progress({ stage: 'preflight', message: 'Backing up data', percent: null });
    const pf = d.runPreflight();
    if (!pf.ok) {
      d.log(`preflight failed: ${pf.error}`);
      writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: `preflight: ${pf.error}` });
      if (d.marker) d.marker.end();
      return finish('failed', `preflight: ${pf.error}`);
    }
    d.log(`preflight: backed up ${pf.backedUp.length} entries`);
  }
  progress({ stage: 'teardown', message: 'Waiting for the app to close', percent: null });
  if (!(await waitUntil(() => !d.isAlive(job.parentPid), job.parentWaitMs ?? 30_000))) { d.log('the app is still running: nothing was changed'); writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: 'the app did not exit in time; nothing was changed' }); if (d.marker) d.marker.end(); return finish('failed', 'the app did not exit in time'); }
  // A core that still answers means files are in use: never swap under it (health-based guard).
  if (!(await waitUntil(async () => (await d.health(job.port)) === null, job.portFreeMs ?? 10_000))) { d.log('a core still answers on the port: nothing was changed'); writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: 'a Legion core is still running; nothing was changed' }); d.spawnApp(job.relaunch); if (d.marker) d.marker.end(); return finish('failed', 'a Legion core is still running'); }
  // Graceful core shutdown before swap (teardown.ts). Never swap files under a running core.
  progress({ stage: 'teardown', message: 'Stopping the core', percent: null });
  const td = d.gracefulTeardown ? await d.gracefulTeardown(job.portFreeMs ?? 5000) : { ok: true };
  if (!td.ok) {
    d.log(`teardown failed: ${td.error}`);
    writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: td.error });
    d.spawnApp(job.relaunch);
    if (d.marker) d.marker.end();
    return finish('failed', td.error);
  }
  // Swap (journaled rename).
  progress({ stage: 'swap', message: 'Installing the update', percent: 50 });
  beatAt = 0; beatMarker();
  try {
    await swapIn({ installDir, stagedDir: job.stagedDir, from: job.from, to: job.to, retryMs: job.swapRetryMs ?? 15_000, ...(job.names ? { names: job.names } : {}), ...(d.step ? { step: d.step } : {}) });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    d.log(`swap failed: ${reason}`);
    const code = (e as NodeJS.ErrnoException).code;
    const msg = ['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '') ? 'files in use: close other Legion windows or tools started in the Legion folder, then try again' : reason;
    writeOutcome(installDir, { from: job.from, to: job.to, result: 'failed', reason: msg });
    d.spawnApp(job.relaunch);
    if (d.marker) d.marker.end();
    return finish('failed', msg);
  }
  d.log('swapped; starting the new build');
  // Relaunch via external waiter (relaunch-waiter.ts) so the old process is provably gone first.
  progress({ stage: 'relaunch', message: 'Starting the new build', percent: 80 });
  let pid: number | undefined;
  if (d.startWaiter) {
    const r = await d.startWaiter({
      oldPid: job.parentPid,
      newCmd: job.relaunch.cmd,
      newArgs: job.relaunch.args
    });
    if (!r.ok) { d.log(`relaunch deferred: ${r.error}`); } else { pid = r.waiterPid; }
  } else {
    const child = d.spawnApp(job.relaunch);
    pid = child?.pid;
  }
  // Health check of the new build.
  progress({ stage: 'health', message: 'Waiting for the new build', percent: 90 });
  const win = healthWindow(job);
  const isHealthy = async (): Promise<boolean> => {
    touchHeartbeat(installDir);
    beatMarker();
    const h = await d.health(job.port);
    return !!h && h.ok && h.version === job.to;
  };
  let healthy = await waitUntil(isHealthy, win.baseMs);
  // One bounded extension: a first start that is merely slow (its process is still there) should not be rolled back and then
  // blocked for days. A process that has already died gets no extension.
  if (!healthy && pid && d.isAlive(pid)) {
    d.log(`the new build is still starting after ${Math.round(win.baseMs / 1000)} s: waiting ${Math.round(win.extensionMs / 1000)} s more`);
    healthy = await waitUntil(isHealthy, win.extensionMs);
  }
  if (healthy) {
    markCommitted(installDir);
    await cleanPrev(installDir);
    d.log('the new build is healthy');
    progress({ stage: 'health', message: 'Update complete', percent: 100 });
    if (d.marker) d.marker.end();
    return finish('ok');
  }
  d.log('the new build did not become healthy: rolling back');
  progress({ stage: 'error', message: 'Update failed, rolling back', percent: null });
  if (pid) await d.killTree(pid); // by PID, never by name
  await waitUntil(async () => (await d.health(job.port)) === null, job.portFreeMs ?? 10_000);
  await rollback(installDir, `the new build did not report healthy on 127.0.0.1:${job.port} within ${Math.round(win.baseMs / 1000)} s`, job.swapRetryMs ?? 15_000);
  d.spawnApp(job.relaunch);
  if (d.marker) d.marker.end();
  return finish('rolled-back');
}
export function realDeps(installDir: string, job?: { port: number }): ApplyDeps {
  const port = job?.port ?? 4747;
  return {
    marker: fileMarker(installDir),
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
    reExec: async (jobFile) => {
      // The Electron folder (runtime/electron in a package install) is copied whole: electron.exe cannot boot as node without its resources.
      const srcDir = dirname(process.execPath);
      const dir = join(tmpdir(), `legion-apply-${process.pid}`);
      const env: Record<string, string | undefined> = { ...process.env, LEGION_APPLY_REEXEC: '1' };
      const undo = (): void => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a later start removes it */ } };
      try { cpSync(srcDir, dir, { recursive: true }); } catch (e) { undo(); return { ok: false, error: `could not copy the runtime to the temp folder: ${e instanceof Error ? e.message : String(e)}` }; }
      try {
        const startedAt = Date.now();
        const c = spawn(join(dir, basename(process.execPath)), [process.argv[1] ?? '', jobFile], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: false, env });
        let spawnError = '';
        c.on('error', (e) => { spawnError = e.message; });
        c.unref();
        // The fresh process owns everything from here. If it dies at once nothing would restart Legion, so look before giving up.
        await sleepMs(1500);
        if (spawnError) { undo(); return { ok: false, error: `the helper copy did not start: ${spawnError}` }; }
        if (c.exitCode !== null) {
          // Exit 1 is the copy's own "I finished, not ok" (see the entry point below): it wrote the outcome and started the app itself.
          // Any other early exit is a copy that never got going, and only the parent can say so.
          const o = readOutcome(installDir);
          const own = c.exitCode === 1 && !!o && o.result !== 're-exec' && Date.parse(o.at) >= startedAt;
          undo(); return { ok: false, error: `the helper copy stopped at once (exit ${c.exitCode})`, ...(own ? { finished: true } : {}) };
        }
        return { ok: true };
      } catch (e) { undo(); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
    sleep: sleepMs,
    log: (line) => { try { appendFileSync(join(upDir(installDir), 'apply.log'), `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ } },
    gracefulTeardown: async (timeoutMs: number) => {
      // Best-effort core shutdown via the admin endpoint, then wait for the port to go silent.
      // The port is the job's (a pinned or configured port, not always 4747). There is no shutdown route on the core yet, so this is a no-op
      // plus the health wait below; the only thing that stops a core is its parent app.
      try { await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* core may not be running */ }
      const end = Date.now() + timeoutMs;
      for (;;) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
          if (!r.ok) return { ok: true };
        } catch { return { ok: true }; }
        if (Date.now() >= end) return { ok: false, error: 'the Legion core did not exit in time; nothing was changed' };
        await sleepMs(250);
      }
    },
  };
}

// Entry point: `electron.exe .update/run/apply.mjs <job.json>` (ELECTRON_RUN_AS_NODE=1). Not run when this file is imported.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const jobFile = process.argv[2] ?? '';
  let job: ApplyJob | null = null;
  try { job = JSON.parse(readFileSync(jobFile, 'utf8')) as ApplyJob; } catch { /* no job: nothing to do */ }
  if (job) void (async () => { try { cleanStaleApplyCopies(tmpdir(), { maxAgeMs: 86_400_000, nowMs: Date.now() }); } catch { /* best effort */ } return runApply(job, realDeps(job.installDir, job)); })().then((r) => process.exit(r === 'ok' || r === 're-exec' ? 0 : 1)).catch(() => process.exit(2));
}
