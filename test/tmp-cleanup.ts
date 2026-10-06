/**
 * Temp directories for tests, removed when the test process exits.
 *
 * Every `mkdtempSync(join(tmpdir(), ...))` in the suite used to be left behind:
 * one run created tens of thousands of `legion-*` directories under the OS temp
 * folder and nothing ever removed them, eventually filling C:. Route every test
 * temp dir through tempDir() so this process removes what it made.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = new Set<string>();

/**
 * A temp dir in the OS temp folder, removed when this test process exits.
 *
 * `live` holds only dirs this process created, so the sweep never touches a
 * sibling test process's dirs. (node:test runs one process per file in parallel;
 * a snapshot of "all legion-* dirs" would race and delete a sibling's in-use
 * dir.)
 *
 * The path is the real, long form. A CI runner's TEMP is an 8.3 short name (C:\Users\RUNNER~1\...) and macOS's is the
 * /var -> /private/var link, while the code under test canonicalises paths. `.native` is the variant that expands 8.3
 * names; the JS realpathSync does not.
 */
export function tempDir(prefix = 'legion-tmp-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  live.add(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of live) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked; leave it */ }
  }
});
