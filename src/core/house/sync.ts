/**
 * Copies the repository's context layer into the Legion data directory, so the agents Legion runs can read it.
 *
 * The copy is one-way and never deletes: a note the user drops into `~/.legion/context/` survives every sync, because
 * a sync that removed it would be a sync that lost work. Overwrite happens only for a path the source also has, and a
 * local copy that is newer than the source's is left alone.
 *
 * Two sources, resolved per path: `dist/context-layer/` (staged by scripts/copy-static.mjs, and the only one a
 * packaged install has, because CODE_SET ships `dist` and never the repository root) and then `repoRoot` itself (a
 * source install, where the files are still in the working tree). Nearness buys nothing: the staged copy is hashed
 * and compared like any other, so a hand-edited `dist/context-layer/AGENTS.md` cannot pass as the app's own words.
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

/**
 * Where the layer's content is read from, per path.
 *
 * A packaged install has it in `dist/context-layer/` (staged by scripts/copy-static.mjs) and NOT in the install root,
 * because CODE_SET ships `dist` and never the repository root -- that is the whole reason 0.2.3-a shipped an empty
 * layer. A source install has it in the root. So resolution is per path, staged tree first, and a file present in
 * only one of the two is still found rather than reported missing.
 */
class LayerSource {
  constructor(private readonly staged: string, private readonly root: string) {}

  /** The file backing `rel`, or null when neither tree has it. */
  file(rel: string): string | null {
    for (const base of [this.staged, this.root]) {
      const abs = join(base, rel);
      try { if (statSync(abs).isFile()) return abs; } catch { /* not in this tree */ }
    }
    return null;
  }

  /** The directory backing `rel`, or null when neither tree has it. */
  dir(rel: string): string | null {
    for (const base of [this.staged, this.root]) {
      const abs = join(base, rel);
      try { if (statSync(abs).isDirectory()) return abs; } catch { /* not in this tree */ }
    }
    return null;
  }

  get any(): boolean { return existsSync(this.staged) || existsSync(this.root); }
}

/**
 * Every file under `rel` with one of `exts`, as layer-relative forward-slashed paths.
 *
 * Walks through `LayerSource` rather than a fixed root so a staged-only install and a source-only install both
 * enumerate, and a path that exists in one tree but not the other is still found.
 */
function walk(src: LayerSource, rel: string, exts: readonly string[], out: string[] = []): string[] {
  const abs = src.dir(rel);
  if (!abs) return out;
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const child = normalisePath(join(rel, name));
    if (src.dir(child)) walk(src, child, exts, out);
    else if (exts.some((e) => name.endsWith(e)) && src.file(child)) out.push(child);
  }
  return out;
}

/** One source file, addressed by its path inside the layer. */
function copyOne(src: LayerSource, target: string, rel: string, res: SyncResult): void {
  const from = src.file(rel);
  if (!from) { res.skipped.push(rel); return; }
  const dst = join(target, rel);
  try {
    const st = statSync(from);
    if (!st.isFile()) { res.skipped.push(rel); return; }
    if (st.size > MAX_COPY_BYTES) { res.skipped.push(rel); return; }
    if (existsSync(dst)) {
      const dstSt = statSync(dst);
      // copyFileSync preserves mtime, so an untouched copy has exactly the source's mtime and size. Comparing those two
      // makes a second sync a no-op instead of rewriting the whole layer on every start, which is what a naive
      // "newer means changed" check gets wrong here.
      if (dstSt.mtimeMs === st.mtimeMs && dstSt.size === st.size) { res.unchanged.push(rel); return; }
      // A newer local copy is the user's; do not overwrite it with an older source file.
      if (dstSt.mtimeMs > st.mtimeMs) { res.keptNewer.push(rel); return; }
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(from, dst);
    res.written.push(rel);
  } catch {
    res.skipped.push(rel);
  }
}

/**
 * Syncs the layer. `repoRoot` is the Legion installation (what ships to users); in a dev checkout it is the repo, and
 * that is fine because the copy is content, not behaviour.
 */
export function syncContext(repoRoot: string, dataDir: string): SyncResult {
  const target = resolve(dataDir, 'context');
  const res: SyncResult = { written: [], skipped: [], keptNewer: [], unchanged: [] };
  const src = new LayerSource(join(repoRoot, 'dist', 'context-layer'), repoRoot);
  if (!src.any) return res;
  mkdirSync(target, { recursive: true });

  const copy = (rel: string): void => copyOne(src, target, normalisePath(rel), res);

  for (const rel of SHIPPED_FILES) copy(rel);

  // Directories copied whole, because an ADR is useless without its neighbours.
  for (const dir of SHIPPED_DIRS) {
    for (const rel of walk(src, dir, ['.md'])) copy(rel);
  }
  // context/*.json is machine-readable; house_recall does not read it but house_read can, and a future tool can.
  for (const rel of walk(src, 'context', ['.json'])) copy(rel);

  // Record what this app shipped, so a read can tell the app's own words from something edited since.
  //
  // The manifest is CARRIED FORWARD, not rebuilt from this sync's results. Rebuilding it was a one-way ratchet: an
  // edited file is `keptNewer`, so it was in neither `written` nor `unchanged`, so its entry vanished on the next
  // start -- and since a missing entry reads as untrusted, reverting the edit by hand could never restore trust, the
  // opposite of the rule ADR 0009 states.
  //
  // An entry is the hash of what the app SHIPPED, so it is kept even after the file drifts. Nothing needs to delete it:
  // `isShipped` compares the current bytes against the entry, so drift reads as untrusted while the record of what was
  // shipped survives -- and reverting the bytes matches the entry again and trust returns on its own. Dropping the entry
  // on drift is what made the loss permanent, so it is exactly what must not happen.
  //
  // This cannot launder an edit. Carrying an entry forward is not recording one: an entry only ever enters this file
  // for a path the app itself copied (`written` / `unchanged`, below). An agent's edit to AGENTS.md is `keptNewer`, so
  // no fresh hash is taken from its new bytes, and the stale entry makes it read untrusted rather than trusted.
  const shipped: Record<string, string> = { ...readManifest(target) };
  // Hash the SOURCE bytes, never the copy's. Hashing the copy is what makes the manifest forgeable: a file the sync
  // left alone is `keptNewer`, so it is in neither `written` nor `unchanged`, so any entry it carries is one something
  // else wrote -- and an agent that can write the context folder can write .shipped.json too. Hashing the source
  // instead makes the manifest a function of what the app ships, which nothing in the data directory can influence:
  //
  //   - an agent edits AGENTS.md -> keptNewer -> the entry is the source hash, the bytes on disk differ -> untrusted
  //   - an agent forges an entry for its own bytes -> the next sync overwrites it with the source hash -> untrusted
  //   - the edit is reverted by hand -> the bytes match the source hash again -> trusted, with nothing to re-click
  //
  // The last one is the property ADR 0009 requires, and it survives precisely because the entry never depended on the
  // edited bytes.
  for (const rel of [...res.written, ...res.unchanged, ...res.keptNewer]) {
    const from = src.file(rel);
    if (!from) continue;
    try {
      shipped[normalisePath(rel)] = createHash('sha256').update(readFileSync(from)).digest('hex');
    } catch {
      /* unreadable now; not shipped as far as trust is concerned */
    }
  }
  // A file that is gone must not keep an entry: it would look shipped to a reader that never sees the bytes.
  for (const rel of Object.keys(shipped)) {
    if (!existsSync(join(target, rel))) delete shipped[normalisePath(rel)];
  }
  writeManifest(target, shipped);

  // Adoption is NOT written here. It is the owner's decision, so it lives in the data directory rather than the layer --
  // see `adoptedPath` in ./trust.ts for the measured reason. Nothing in this function may reintroduce it, because a
  // manifest an agent can write is a manifest an agent can grant itself.

  return res;
}