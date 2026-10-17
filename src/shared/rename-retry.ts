/**
 * Replaces a file by renaming over it, and never leaves a moment with no file. On Windows a rename onto a file that another program holds
 * open (an antivirus scan, a sync client, a backup) fails with EPERM, EBUSY or EACCES for a short while; the answer is to wait and try
 * again, not to delete the target first. Synchronous on purpose: the callers are the key stores' atomic writes.
 */
import { renameSync } from 'node:fs';

export interface RenameRetryDeps {
  rename?: (from: string, to: string) => void;
  /** Waits this many milliseconds. */
  sleep?: (ms: number) => void;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DELAYS_MS = [10, 20, 40, 80, 120, 160, 200, 250];

const blockingSleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Renames `from` over `to`. Retries a locked target a few times (about one second in all); any other error, or the last one, is thrown. */
export function renameWithRetry(from: string, to: string, deps: RenameRetryDeps = {}): void {
  const rename = deps.rename ?? renameSync;
  const sleep = deps.sleep ?? blockingSleep;
  for (let i = 0; ; i++) {
    try { rename(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code || !RETRY_CODES.has(code) || i >= DELAYS_MS.length) throw e;
      sleep(DELAYS_MS[i]!);
    }
  }
}
