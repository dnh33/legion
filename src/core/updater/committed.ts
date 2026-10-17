/**
 * "Is the update that is running committed?", decided read-only from the updater's own files in <install>/.update.
 * Used only to decide when the old plain keys.json may be retired (secrets.ts). A start that has no updater state at all (a fresh
 * install, a dev run from a checkout) counts as committed. Anything unclear is "not committed": the plain copy then stays.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER_FILE_NAME, readJournal, UPDATE_DIR } from './apply.js';

export function updateCommitted(installDir: string): boolean {
  try {
    const up = join(installDir, UPDATE_DIR);
    if (!existsSync(up)) return true;
    if (existsSync(join(up, MARKER_FILE_NAME))) return false; // an update is running, or died and left its lease: not settled
    const j = readJournal(installDir);
    if (!j) return !existsSync(join(up, 'journal.json')); // no journal is nothing in flight; an unreadable one is not "committed"
    return j.state === 'committed' || j.state === 'rolled-back';
  } catch { return false; }
}
