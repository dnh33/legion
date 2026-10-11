/**
 * The preflight step: copies the user data out of the data dir into <install>/.update/backup-<timestamp> BEFORE any
 * update file is touched, so a failed update can never lose data.
 *
 * FAIL CLOSED by contract: any copy error, or a whole run exceeding PREFLIGHT_TIMEOUT_MS, returns ok:false and the
 * caller MUST cancel the update. A partial `backedUp` list is still reported so a human can see what was saved.
 * Missing entries (a fresh install may not have every file) are skipped silently.
 *
 * Pure core + injected I/O, the same style as runApply: no filesystem calls of its own, so the tests drive every
 * path (including a thrown copy and the 30 s deadline) with mocked deps and no real files.
 */
import { join } from 'node:path';

/**
 * What is copied out of the data dir (dataDir()) before an update. `state.db` is the SQLite store name;
 * `state.json` is the JSON store this build actually writes (src/core/store.ts); `messages` is the messages
 * directory entry (src/core/store.ts messagesDir: per-task .jsonl files) — copyFile receives it as a directory
 * source/destination pair and the injected implementation decides what a directory copy means (recursive
 * copy, or a metadata-only copy). An entry that does not exist is skipped silently.
 */
export const BACKUP_ENTRIES: readonly string[] = Object.freeze(['state.db', 'state.json', 'config.json', 'projects.json', 'messages']);

/** The whole operation must finish within this. Copying is synchronous, so the deadline is checked around each entry. */
export const PREFLIGHT_TIMEOUT_MS = 30_000;

export interface PreflightDeps {
  dataDir: string;
  backupDir: string;
  copyFile(src: string, dst: string): void;
  mkdir(path: string): void;
  exists(path: string): boolean;
  now(): number;
  log(msg: string): void;
}

export type PreflightResult = { ok: true; backedUp: string[] } | { ok: false; error: string; backedUp: string[] };

/** Backs up BACKUP_ENTRIES from `dataDir` into `backupDir` (the caller names it, e.g. .update/backup-<timestamp>). */
export function runPreflight(d: PreflightDeps): PreflightResult {
  const backedUp: string[] = [];
  const started = d.now();
  const over = (): boolean => d.now() - started >= PREFLIGHT_TIMEOUT_MS;
  const fail = (error: string): PreflightResult => { d.log(`preflight: ${error}`); return { ok: false, error, backedUp }; };
  try {
    if (!d.exists(d.backupDir)) d.mkdir(d.backupDir);
    for (const name of BACKUP_ENTRIES) {
      if (over()) return fail(`state backup timed out after ${PREFLIGHT_TIMEOUT_MS / 1000} s`);
      const src = join(d.dataDir, name);
      if (!d.exists(src)) continue; // a fresh install may not have every file yet
      d.log(`preflight: backing up ${name}`);
      d.copyFile(src, join(d.backupDir, name));
      backedUp.push(name);
    }
    if (over()) return fail(`state backup timed out after ${PREFLIGHT_TIMEOUT_MS / 1000} s`);
    d.log(`preflight: backed up ${backedUp.length} of ${BACKUP_ENTRIES.length} entries`);
    return { ok: true, backedUp };
  } catch (e) {
    return fail(`state backup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
