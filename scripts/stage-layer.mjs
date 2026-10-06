// Stages the house context layer into a folder (dist/context-layer in a build). Split out of copy-static.mjs so a test can run it
// against a fixture tree; copy-static.mjs calls it with the real lists.
//
// The shipped folders are walked RECURSIVELY, with the same file filters as `walk()` in src/core/house/sync.ts: every
// .md file under a shipped directory, plus every .json under `context/`. Nothing else is staged, so a skill's scripts and
// licence files stay out of a packaged install (Legion never runs a skill's scripts), and the sync, which walks the same
// way, finds exactly what was staged.
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Directories whose .json files are staged too (machine-readable facts). Mirrors the `context` walk in sync.ts. */
export const JSON_DIRS = ['context'];

/**
 * @param {{ files: string[], dirs: string[], from?: string, out: string }} opts
 *   `from` is the repository root (default: the working directory); paths in `files` and `dirs` are relative to it.
 * @returns {{ staged: number, missing: number, paths: string[] }}
 */
export function stageLayer({ files, dirs, from = '.', out }) {
  rmSync(out, { recursive: true, force: true }); // a removed ADR or skill must not survive in dist
  let staged = 0, missing = 0;
  const paths = [];

  const stage = (rel) => {
    const src = join(from, rel);
    const dst = join(out, rel);
    try {
      if (!statSync(src).isFile()) { missing++; return; }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      staged++;
      paths.push(rel);
    } catch { missing++; }
  };

  const walk = (rel, exts) => {
    let names;
    try { names = readdirSync(join(from, rel)).sort(); } catch { return; }
    for (const name of names) {
      const child = `${rel}/${name}`;
      let st;
      try { st = statSync(join(from, child)); } catch { continue; }
      if (st.isDirectory()) walk(child, exts);
      else if (st.isFile() && exts.some((e) => name.endsWith(e))) stage(child);
    }
  };

  for (const rel of files) stage(rel);
  for (const dir of dirs) {
    if (!existsSync(join(from, dir))) { missing++; continue; }
    walk(dir, JSON_DIRS.includes(dir) ? ['.md', '.json'] : ['.md']);
  }
  return { staged, missing, paths };
}
