/**
 * Copies the repository's context layer into the Legion data directory, so the agents Legion runs can read it.
 *
 * The copy is one-way and never deletes: a note the user drops into `~/.legion/context/` survives every sync, because
 * a sync that removed it would be a sync that lost work. Overwrite happens only for a path the repo also has, and a
 * local copy that is newer than the repo's is left alone.
 *
 * Every path in the result is relative to the context root, because that is what `house_read` takes and what the log
 * and the `/api/house` route report. An absolute path here would be a path no tool can use.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { SHIPPED_DIRS, SHIPPED_FILES, normalisePath } from './context.js';
import { readManifest, writeManifest } from './trust.js';

export interface SyncResult {
  written: string[];
  skipped: string[];
  /** Paths where the data copy was newer than the repo copy, so the repo's version was left alone. */
  keptNewer: string[];
  /** Paths already identical to the repo copy, so nothing was copied. */
  unchanged: string[];
}

const MAX_COPY_BYTES = 2_000_000;

/** One repo file, addressed by its path inside the layer. */
function copyOne(repoRoot: string, target: string, rel: string, res: SyncResult): void {
  const src = join(repoRoot, rel);
  const dst = join(target, rel);
  try {
    const st = statSync(src);
    if (!st.isFile()) { res.skipped.push(rel); return; }
    if (st.size > MAX_COPY_BYTES) { res.skipped.push(rel); return; }
    if (existsSync(dst)) {
      const dstSt = statSync(dst);
      // copyFileSync preserves mtime, so an untouched copy has exactly the repo's mtime and size. Comparing those two
      // makes a second sync a no-op instead of rewriting the whole layer on every start, which is what a naive
      // "newer means changed" check gets wrong here.
      if (dstSt.mtimeMs === st.mtimeMs && dstSt.size === st.size) { res.unchanged.push(rel); return; }
      // A newer local copy is the user's; do not overwrite it with an older repo file.
      if (dstSt.mtimeMs > st.mtimeMs) { res.keptNewer.push(rel); return; }
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    res.written.push(rel);
  } catch {
    res.skipped.push(rel);
  }
}

/** Every `.md` under `dir`, relative to `root`, forward-slashed. */
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
  const res: SyncResult = { written: [], skipped: [], keptNewer: [], unchanged: [] };
  if (!existsSync(repoRoot)) return res;
  mkdirSync(target, { recursive: true });

  const copy = (rel: string): void => copyOne(repoRoot, target, normalisePath(rel), res);

  for (const rel of SHIPPED_FILES) copy(rel);

  // Directories copied whole, because an ADR or a skill is useless without its neighbours.
  for (const dir of SHIPPED_DIRS) {
    for (const rel of mdFiles(repoRoot, dir)) copy(rel);
  }
  // context/*.json is machine-readable; house_recall does not read it but house_read can, and a future tool can.
  for (const rel of mdFiles(repoRoot, 'context')) copy(rel);
  for (const rel of SHIPPED_FILES) {
    if (rel.endsWith('.json')) copy(rel);
  }

  // Record what this app shipped, so a read can tell the app's own words from something edited since. Only files whose
  // bytes match the repo count as shipped: a `keptNewer` file is the user's edit by definition, so it gets no entry and
  // therefore reads as untrusted. That is the fail-closed direction, and it is the same choice ADR 0004 makes for an
  // unreadable lockfile — a hash we do not have is never treated as a match.
  const shipped: Record<string, string> = {};
  const record = (rel: string): void => {
    try {
      shipped[normalisePath(rel)] = createHash('sha256').update(readFileSync(join(target, rel))).digest('hex');
    } catch {
      /* unreadable now; not shipped as far as trust is concerned */
    }
  };
  for (const rel of [...res.written, ...res.unchanged]) record(rel);
  writeManifest(target, shipped);

  return res;
}