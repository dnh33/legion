/**
 * The prepared runtime copy. A full-package swap renames the folder the helper runs from (runtime/electron holds the electron.exe that
 * runs it), which Windows refuses, so the helper used to copy that folder (about 370 MB) AFTER the app had closed: a silent 36 s.
 * Instead the app copies it ahead of time, off the critical path, into <install>/.update/runtime-copy (inside .update, which the swap
 * never renames), verifies it, and starts the helper from it. A missing or stale copy falls back to the helper's own re-exec.
 *
 * Verification is by size: the exe's size, plus the file count and total bytes of the whole folder, compared with the running runtime
 * and with what was stamped when the copy finished. The folder only gets its final name after the stamp is written, so a half copy
 * never looks complete.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RUNTIME_COPY_DIR, UPDATE_DIR } from './apply.js';

export const runtimeCopyDir = (installDir: string): string => join(installDir, UPDATE_DIR, RUNTIME_COPY_DIR);
const STAMP = '.copy-stamp.json';

export interface CopyStamp { exeName: string; exeSize: number; files: number; bytes: number; at: number }
/** Room left on the disk after the copy, so a copy never takes the last of it. */
export const RUNTIME_COPY_MARGIN_BYTES = 512 * 1024 * 1024;
export interface CopyArgs {
  installDir: string; srcDir: string; exeName: string;
  /** Free bytes on the volume that holds `dir` (default: statfs, as the package stage does). */
  freeBytes?: (dir: string) => number;
  marginBytes?: number;
}
const defaultFree = (dir: string): number => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };

/** Not enough room for the copy: asked again only when the next update is staged (see shouldPrepare). */
export type PrepareResult = { ok: true; reused: boolean } | { ok: false; error: string; lowDisk?: boolean };

export interface PrepareGate { preparing: boolean; retryAt: number; lowDiskVersion: string | null }
/**
 * Should the app try to make the copy now? Not while one is running, not before a failure's delay is over, and never again for an
 * update that already found the disk too full (the same update, however long it waits, will not have more room).
 */
export function shouldPrepare(g: PrepareGate, now: number, stagedVersion: string | undefined): boolean {
  if (g.preparing || now < g.retryAt) return false;
  if (g.lowDiskVersion !== null && g.lowDiskVersion === stagedVersion) return false;
  return true;
}

function measure(dir: string): { files: number; bytes: number } {
  let files = 0; let bytes = 0;
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      if (n === STAMP) continue;
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p); else { files++; bytes += st.size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

export type VerifyResult = { ok: true; dir: string; exe: string } | { ok: false; reason: string };
/** Is there a finished copy that matches the runtime that is running now? Cheap (stat only), so it is safe at apply time. */
export function verifyRuntimeCopy(a: CopyArgs): VerifyResult {
  const dir = runtimeCopyDir(a.installDir);
  try {
    if (!existsSync(dir)) return { ok: false, reason: 'no copy has been prepared' };
    if (lstatSync(dir).isSymbolicLink()) return { ok: false, reason: 'the copy folder is a link' };
    const stamp = JSON.parse(readFileSync(join(dir, STAMP), 'utf8')) as Partial<CopyStamp>;
    const exe = join(dir, a.exeName);
    const srcExe = statSync(join(a.srcDir, a.exeName)).size;
    if (stamp.exeName !== a.exeName || stamp.exeSize !== srcExe) return { ok: false, reason: 'the runtime changed since the copy was made' };
    if (statSync(exe).size !== srcExe) return { ok: false, reason: 'the copied exe has the wrong size' };
    const mine = measure(dir);
    const theirs = measure(a.srcDir);
    if (mine.files !== theirs.files || mine.bytes !== theirs.bytes || mine.files !== stamp.files || mine.bytes !== stamp.bytes) return { ok: false, reason: 'the copy does not match the runtime' };
    return { ok: true, dir, exe };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const from = join(src, e.name); const to = join(dest, e.name);
    if (e.isSymbolicLink()) throw new Error(`refusing to copy a link: ${e.name}`);
    if (e.isDirectory()) await copyTree(from, to);
    else { await copyFile(from, to); await tick(); } // one file at a time, yielding in between: the app stays responsive
  }
}

/**
 * Makes the copy (async, file by file) unless a verified one exists already. Builds into a temporary folder and renames it into place
 * once the stamp is written. Never throws; a failure leaves nothing half-built.
 */
export async function prepareRuntimeCopy(a: CopyArgs): Promise<PrepareResult> {
  if (verifyRuntimeCopy(a).ok) return { ok: true, reused: true };
  // Room first: a 370 MB copy on a nearly full disk would fill it, fail, and leave the apply worse off. Short: copy nothing.
  try {
    const need = measure(a.srcDir).bytes + (a.marginBytes ?? RUNTIME_COPY_MARGIN_BYTES);
    const free = (a.freeBytes ?? defaultFree)(a.installDir);
    if (free < need) return { ok: false, lowDisk: true, error: `not enough free disk space for the runtime copy (${Math.ceil(need / 1048576)} MB needed, ${Math.floor(free / 1048576)} MB free)` };
  } catch { /* the room cannot be read: go on, a real shortage fails the copy and is cleaned up below */ }
  const final = runtimeCopyDir(a.installDir);
  const tmp = join(a.installDir, UPDATE_DIR, `${RUNTIME_COPY_DIR}.tmp-${process.pid}`);
  try {
    mkdirSync(join(a.installDir, UPDATE_DIR), { recursive: true });
    await rm(tmp, { recursive: true, force: true });
    await rm(final, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await copyTree(a.srcDir, tmp);
    const m = measure(tmp);
    const stamp: CopyStamp = { exeName: basename(a.exeName), exeSize: statSync(join(tmp, a.exeName)).size, files: m.files, bytes: m.bytes, at: Date.now() };
    writeFileSync(join(tmp, STAMP), JSON.stringify(stamp));
    renameSync(tmp, final);
    const v = verifyRuntimeCopy(a);
    if (!v.ok) { await rm(final, { recursive: true, force: true }); return { ok: false, error: v.reason }; }
    return { ok: true, reused: false };
  } catch (e) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* the next prepare or the next start removes it */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function removeRuntimeCopy(installDir: string): Promise<boolean> {
  const dir = runtimeCopyDir(installDir);
  try {
    if (!existsSync(dir)) return true;
    if (lstatSync(dir).isSymbolicLink()) return false;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    return !existsSync(dir);
  } catch { return false; }
}

/** What the app starts as the helper: the verified copy (and the env that tells the helper it is already outside the install), else the running runtime. */
export function planApplySpawn(a: CopyArgs): { cmd: string; fromCopy: boolean; env: Record<string, string> } {
  const v = verifyRuntimeCopy(a);
  if (v.ok) return { cmd: v.exe, fromCopy: true, env: { LEGION_APPLY_REEXEC: '1' } };
  return { cmd: join(a.srcDir, a.exeName), fromCopy: false, env: {} };
}
