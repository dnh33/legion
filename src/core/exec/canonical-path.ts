/**
 * One way to name a local path, so "is this the protected file?" is a string compare.
 * Pure apart from reading the disk for real names (`fs.realpathSync.native`): the shell guard and the file-tool guard both use it.
 *
 * Folded into one spelling (Windows): `\\?\C:\x`, `\\?\UNC\localhost\c$\x`, `\\localhost\c$\x`, `//127.0.0.1/c$/x`, `\\[::1]\c$\x` and
 * `\\<this computer>\c$\x` become `c:\x`; trailing dots and spaces are dropped from every segment (`state.json. ` is `state.json`);
 * `.` and `..` are resolved; a relative path is resolved against `cwd`; short 8.3 names and junctions are replaced by the real
 * names, found through the deepest parent that exists; the result is lower case. A path that names a device by volume
 * (`\\?\Volume{...}`, `\\.\GLOBALROOT`) has no local spelling: `isOpaqueDevicePath` says so and `isProtected` refuses it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, posix, win32 } from 'node:path';

const WIN = process.platform === 'win32';
const P = WIN ? win32 : posix;

/** A device path that cannot be turned into a drive path by reading it. */
export function isOpaqueDevicePath(p: string): boolean {
  return /^[\\/]{2}[?.][\\/](?:volume\{|globalroot|harddiskvolume|device[\\/])/i.test(p);
}

function localHosts(): Set<string> {
  const h = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0:0:0:0:0:0:0:1', 'localhost.localdomain']);
  try { const n = hostname().toLowerCase(); if (n) h.add(n); } catch { /* none */ }
  return h;
}

/** `\\?\` and `\\.\` prefixes, and admin-share spellings of this computer, as a plain drive path. */
function dropPrefixes(raw: string): string {
  let s = raw.replace(/\//g, '\\');
  s = s.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[a-z]:)/i, '');
  const m = /^\\\\([^\\]+)\\([a-z])\$(?:\\(.*))?$/i.exec(s);
  if (m && localHosts().has(m[1]!.toLowerCase())) return `${m[2]!.toUpperCase()}:\\${m[3] ?? ''}`;
  return s;
}

/** Each segment loses trailing dots and spaces (Windows ignores them); a segment left empty goes. `.` and `..` stay for the resolver. */
function cleanSegments(p: string): string {
  const root = P.parse(p).root;
  const kept: string[] = [];
  for (const seg of p.slice(root.length).split(/[\\/]+/)) {
    if (seg === '.' || seg === '..') { kept.push(seg); continue; }
    const t = seg.replace(/[. ]+$/, '');
    if (t) kept.push(t);
  }
  return root + kept.join(P.sep);
}

/** The path with its deepest existing parent replaced by the real name (8.3 names, junctions, links). */
function realParent(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) {
      try { return dropPrefixes(join(realpathSync.native(cur), ...tail.reverse())); } catch { return p; }
    }
    const up = P.dirname(cur);
    if (up === cur) return p;
    tail.push(P.basename(cur));
    cur = up;
  }
  return p;
}

export function canonicalLocal(p: string, opts: { cwd?: string } = {}): string {
  let s = WIN ? cleanSegments(dropPrefixes(p)) : p;
  s = P.resolve(opts.cwd ?? process.cwd(), s);
  if (WIN) s = cleanSegments(s); // a `..` step can leave a cleaned segment behind
  s = realParent(s);
  if (WIN) s = cleanSegments(s);
  return WIN ? s.toLowerCase() : s;
}

/** Is `p` one of the protected files or folders, or inside one? Every spelling counts; an opaque device path always does. */
export function isProtected(p: string, set: readonly string[], cwd?: string): boolean {
  if (isOpaqueDevicePath(p)) return true;
  const c = canonicalLocal(p, cwd ? { cwd } : {});
  return set.some((t) => {
    const r = canonicalLocal(t);
    return c === r || c.startsWith(r.endsWith(P.sep) ? r : r + P.sep);
  });
}

/**
 * The files and folders no agent may change: the gates folder, the gates key, config, state and the project list inside the data
 * folder (NOT the whole folder: agents' workspaces and other folders in it stay free). One list for the file tools and the shell guard.
 */
export function dataFolderTargets(dataDir: string): string[] {
  return ['gates', 'gates-key.bin', 'config.json', 'state.json', 'projects.json'].map((n) => join(dataDir, n));
}

/** The data-folder targets (when `dataDir` is given) plus every module's own `protectedPaths()`. */
export function protectedTargets(dataDir: string | undefined, modules: ReadonlyArray<{ protectedPaths?(): string[] }>): string[] {
  const out = dataDir ? dataFolderTargets(dataDir) : [];
  for (const m of modules) {
    try { out.push(...(m.protectedPaths?.() ?? [])); } catch { /* none */ }
  }
  return out;
}
