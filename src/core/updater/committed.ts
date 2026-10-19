/**
 * "Is the update that is running committed?", decided read-only from the updater's own files in <install>/.update.
 * Used only to decide when the old plain keys.json may be retired (secrets.ts). A start that has no updater state at all (a fresh
 * install, a dev run from a checkout) counts as committed.
 * A committed journal counts only when its target is the running version. Anything unclear is "not committed": the plain copy then stays.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../../shared/config.js';
import { MARKER_FILE_NAME, readJournal, UPDATE_DIR } from './apply.js';

export function updateCommitted(installDir: string, version: string = VERSION): boolean {
  try {
    const up = join(installDir, UPDATE_DIR);
    if (!existsSync(up)) return true;
    if (existsSync(join(up, MARKER_FILE_NAME))) return false; // an update is running, or died and left its lease: not settled
    const j = readJournal(installDir);
    if (!j) return !existsSync(join(up, 'journal.json')); // no journal is nothing in flight; an unreadable one is not "committed"
    // A committed journal counts only for the version that is running now: a stale one from an earlier update (then a manual reinstall
    // of this version into the same folder) says nothing about this tree.
    if (j.state === 'committed') return j.to === version;
    return j.state === 'rolled-back';
  } catch { return false; }
}
