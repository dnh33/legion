/**
 * Keeps a raw stream file (core.log) from growing without limit. Electron main calls it before it opens the file for the
 * core's stdout and stderr: over the cap, the file is renamed to `<file>.1`, replacing an older copy by the rename itself.
 * Nothing is deleted first, so a failed rename (the file is held open elsewhere) loses nothing: the caller opens the
 * existing file and goes on appending.
 */
import { renameSync, statSync } from 'node:fs';

export const RAW_LOG_CAP = 5 * 1024 * 1024;

/** True when the file was rotated. Never throws. */
export function rotateRawLog(path: string, opts: { cap?: number; rename?: (from: string, to: string) => void } = {}): boolean {
  try {
    if (statSync(path).size <= (opts.cap ?? RAW_LOG_CAP)) return false;
    (opts.rename ?? renameSync)(path, `${path}.1`);
    return true;
  } catch { return false; }
}
