/**
 * File-system helpers that do not follow symbolic links where it matters: the live export folder and the place sandbox exports are written to
 * both live inside an agent's workspace, which a bot with a Bash tool can write to (and plant links in).
 *
 *  - resolveFolder: the REAL path of a folder that may not exist yet. Refuses a folder that is itself a link, or whose real path leaves its
 *    parent (a link in the last segment). The static check, the wrapper that defines LEGION_EXPORT_DIR and the approval card all use the
 *    resolved path, so what the user reads, what is checked and where a script writes agree.
 *  - findLink: a symbolic link (or Windows junction) anywhere under a folder, a few levels deep.
 *  - safeWriteFile: writes with O_EXCL to a fresh temp name in the target folder and renames it over the final name. rename replaces a link
 *    at the final name instead of writing through it, and the folder is checked with lstat first.
 *
 * Limit (see docs/BLENDER.md): a check followed by a write is not atomic. A same-user process that swaps a folder for a link between the two
 * can still win a race; these checks stop the planted-link cases, not a live attacker.
 */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';

const win = process.platform === 'win32';
const same = (a: string, b: string): boolean => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

export type Resolved = { ok: true; dir: string } | { ok: false; error: string };

/** Real path of `dir` (which need not exist): the real path of its nearest existing ancestor plus the missing segments. */
export function resolveFolder(dir: string): Resolved {
  const abs = resolve(dir);
  const missing: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return { ok: false, error: `no part of ${abs} exists` };
    missing.unshift(basename(cur));
    cur = parent;
  }
  let real: string;
  try { real = realpathSync(cur); } catch (e) { return { ok: false, error: `cannot resolve ${cur}: ${e instanceof Error ? e.message : String(e)}` }; }
  // an existing folder must be a real folder, not a link to somewhere else
  if (!missing.length) {
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) return { ok: false, error: `${abs} is a symbolic link` };
      if (!st.isDirectory()) return { ok: false, error: `${abs} is not a folder` };
      const parentReal = realpathSync(dirname(abs));
      if (!same(real, join(parentReal, basename(abs)))) return { ok: false, error: `${abs} resolves to ${real}, outside its parent folder` };
    } catch (e) { return { ok: false, error: `cannot check ${abs}: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  return { ok: true, dir: join(real, ...missing) };
}

/** True when `child` is `root` or inside it (after both are real paths). */
export function isInside(child: string, root: string): boolean {
  const c = win ? child.toLowerCase() : child;
  const r = win ? root.toLowerCase() : root;
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * The first symbolic link under `dir`, or null when it is clean. Depth and entry limits keep this cheap, and they FAIL CLOSED: when a limit is hit, or a
 * folder cannot be read, the result names that place (a string, so callers refuse) instead of reporting "no link".
 */
export function findLink(dir: string, maxDepth = 4, maxEntries = 3000): string | null {
  let seen = 0;
  const walk = (d: string, depth: number): string | null => {
    let names: string[];
    try { names = readdirSync(d); } catch { return `${d} (could not be read)`; }
    for (const n of names) {
      if (++seen > maxEntries) return `${d} (more than ${maxEntries} entries; too many to check for links)`;
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) return p;
      if (st.isDirectory()) {
        if (depth >= maxDepth) return `${p} (nested deeper than ${maxDepth} levels; too deep to check for links)`;
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return existsSync(dir) ? walk(dir, 0) : null;
}

/**
 * Writes `data` as `<dir>/<name>` without following a link: `dir` must be a real folder (created if missing) and the file is renamed into
 * place from a fresh O_EXCL temp file. Throws with a plain message when it refuses.
 */
export function safeWriteFile(dir: string, name: string, data: Buffer): string {
  if (name !== basename(name) || /[\\/\0]/.test(name)) throw new Error(`unsafe file name ${JSON.stringify(name)}`);
  mkdirSync(dir, { recursive: true });
  const r = resolveFolder(dir);
  if (!r.ok) throw new Error(`refusing to write into ${dir}: ${r.error}`);
  const tmp = join(r.dir, `.legion-${randomBytes(6).toString('hex')}.part`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, data);
    try { fsyncSync(fd); } catch { /* best effort */ }
  } catch (e) { closeSync(fd); try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
  closeSync(fd);
  const final = join(r.dir, name);
  try { renameSync(tmp, final); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
  return final;
}
