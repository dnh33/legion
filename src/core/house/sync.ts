/**
 * Copies the repository's context layer into the Legion data directory, so the agents Legion runs can read it.
 *
 * The copy is one-way and never deletes: a note the user drops into `~/.legion/context/` survives every sync, because
 * a sync that removed it would be a sync that lost work. Overwrite happens only for a path the repo also has.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SHIPPED_DIRS, SHIPPED_FILES, normalisePath } from './context.js';

export interface SyncResult {
  written: string[];
  skipped: string[];
  /** True when the data copy was newer than the repo copy, so the repo's version was left alone. */
  keptNewer: string[];
}

const MAX_COPY_BYTES = 2_000_000;

/** One repo file: copy it if the target is absent, older, or byte-identical is impossible to care about. */
function copyOne(src: string, dst: string, res: SyncResult): void {
  const rel = normalisePath(dst);
  try {
    const st = statSync(src);
    if (!st.isFile()) { res.skipped.push(rel); return; }
    if (st.size > MAX_COPY_BYTES) { res.skipped.push(rel); return; }
    if (existsSync(dst)) {
      const dstSt = statSync(dst);
      // A newer local copy is the user's; do not overwrite it with an older repo file.
      if (dstSt.mtimeMs > st.mtimeMs && dstSt.size !== st.size) { res.keptNewer.push(rel); return; }
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    res.written.push(rel);
  } catch {
    res.skipped.push(rel);
  }
}

/** Every `.md` under `dir`, relative to `root`. */
function mdFiles(root: string, dir: string, out: string[] = []): string[] {
  const abs = join(root, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const full = join(abs, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) mdFiles(root, join(dir, name), out);
    else if (st.isFile() && name.endsWith('.md')) out.push(normalisePath(join(dir, name)));
  }
  return out;
}

/**
 * Syncs the layer. `repoRoot` is the Legion installation (what ships to users); in a dev checkout it is the repo, and
 * that is fine because the copy is content, not behaviour.
 */
export function syncContext(repoRoot: string, dataDir: string): SyncResult {
  const target = resolve(dataDir, 'context');
  const res: SyncResult = { written: [], skipped: [], keptNewer: [] };
  if (!existsSync(repoRoot)) return res;
  mkdirSync(target, { recursive: true });

  for (const rel of SHIPPED_FILES) copyOne(join(repoRoot, rel), join(target, rel), res);

  for (const dir of SHIPPED_DIRS) {
    for (const rel of mdFiles(repoRoot, dir)) copyOne(join(repoRoot, rel), join(target, rel), res);
  }
  // context/*.json is machine-readable; house_recall does not read it but house_read can, and a future tool can.
  for (const rel of mdFiles(repoRoot, 'context')) copyOne(join(repoRoot, rel), join(target, rel), res);
  for (const rel of SHIPPED_FILES) {
    if (rel.endsWith('.json')) copyOne(join(repoRoot, rel), join(target, rel), res);
  }
  return res;
}