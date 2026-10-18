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
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join, posix, win32 } from 'node:path';

const WIN = process.platform === 'win32';
const P = WIN ? win32 : posix;

/** A device path that cannot be turned into a drive path by reading it. */
export function isOpaqueDevicePath(p: string): boolean {
  return /^[\\/]{2}[?.][\\/](?:volume\{|globalroot|harddiskvolume|device[\\/])/i.test(p);
}

/** An IPv4 address in any spelling Windows accepts (`127.1`, `0x7f.0.0.1`, `2130706433`) as dotted decimal; undefined when it is not one. */
function ipv4(h: string): string | undefined {
  const parts = h.split('.');
  if (parts.length < 1 || parts.length > 4) return undefined;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/i.test(p)) return undefined;
    nums.push(/^0x/i.test(p) ? parseInt(p.slice(2), 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : Number(p));
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return undefined;
  const bytes = [...nums];
  for (let i = 4 - nums.length - 1; i >= 0; i--) bytes.push(Math.floor(last / 256 ** i) % 256);
  return bytes.join('.');
}

/** An IPv6 address (also `[...]`, `...ipv6-literal.net`, with a zone) as eight full lower-case groups; undefined when it is not one. */
function ipv6(h: string): string | undefined {
  let s = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (s.endsWith('.ipv6-literal.net')) s = s.slice(0, -'.ipv6-literal.net'.length).replace(/s.*$/, '').replace(/-/g, ':');
  s = s.replace(/%.*$/, '');
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return undefined;
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail4) { const v4 = ipv4(tail4[1]!); if (!v4) return undefined; const b = v4.split('.').map(Number); s = s.slice(0, -tail4[1]!.length) + ((b[0]! << 8) | b[1]!).toString(16) + ':' + ((b[2]! << 8) | b[3]!).toString(16); }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const a = halves[0] ? halves[0].split(':') : [];
  const b = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - a.length - b.length : 0;
  const groups = [...a, ...Array<string>(Math.max(fill, 0)).fill('0'), ...b];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

let hostCache: { at: number; names: Set<string> } | undefined;
/** The names and every address of this computer (loopback, the host name, each network interface, v4 and v6), cached for a minute. */
function localHosts(): Set<string> {
  if (hostCache && Date.now() - hostCache.at < 60_000) return hostCache.names;
  const names = new Set(['localhost', 'localhost.localdomain', '0.0.0.0', ipv6('::1')!, ipv6('::')!]);
  try { const n = hostname().toLowerCase(); if (n) names.add(n); } catch { /* none */ }
  try {
    for (const a of Object.values(networkInterfaces()).flat()) {
      if (!a) continue;
      const v = a.family === 'IPv6' || (a.family as unknown) === 6 ? ipv6(a.address) : ipv4(a.address);
      if (v) names.add(v);
    }
  } catch { /* none */ }
  hostCache = { at: Date.now(), names };
  return names;
}

/** Is this UNC host this computer? Any 127.x address, an own address in any spelling, the host name with or without a domain. */
function isLocalHost(raw: string): boolean {
  const h = raw.toLowerCase().replace(/\.$/, '');
  const names = localHosts();
  if (names.has(h)) return true;
  const v4 = ipv4(h);
  if (v4) return v4.startsWith('127.') || names.has(v4);
  const v6 = ipv6(h);
  if (v6) {
    const mapped = /^0000:0000:0000:0000:0000:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(v6);
    if (mapped) { const n = parseInt(mapped[1]! + mapped[2]!, 16); const d = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); return d.startsWith('127.') || names.has(d); }
    return names.has(v6);
  }
  const short = h.split('.')[0]!;
  try { return short === hostname().toLowerCase(); } catch { return false; }
}

/** `\\?\` and `\\.\` prefixes, and admin-share spellings of this computer, as a plain drive path. */
function dropPrefixes(raw: string): string {
  let s = raw.replace(/\//g, '\\');
  s = s.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[a-z]:)/i, '');
  const m = /^\\\\([^\\]+)\\([a-z])\$(?:\\(.*))?$/i.exec(s);
  if (m && isLocalHost(m[1]!)) return `${m[2]!.toUpperCase()}:\\${m[3] ?? ''}`;
  return s;
}

/** A path on another computer (UNC that did not fold into a drive path). It is never read: a stat could wait on the network. */
const isRemote = (p: string): boolean => WIN && /^[\\/]{2}/.test(p);

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
  if (isRemote(s)) return s.toLowerCase(); // another computer: no resolve against cwd, no disk read
  s = P.resolve(opts.cwd ?? process.cwd(), s);
  if (WIN) s = cleanSegments(s); // a `..` step can leave a cleaned segment behind
  if (!isRemote(s)) s = realParent(s);
  if (WIN) s = cleanSegments(s);
  return WIN ? s.toLowerCase() : s;
}

/** The protected set in canonical spelling: work it out once per check, not once per path. */
export const canonicalSet = (set: readonly string[]): string[] => set.map((t) => canonicalLocal(t));

const under = (c: string, r: string): boolean => c.startsWith(r.endsWith(P.sep) ? r : r + P.sep);

/** Is canonical `c` a protected entry or inside one, or (with `above`) a folder that holds one (the data folder, the home folder, the drive root)? */
export function hitsCanonical(c: string, canon: readonly string[], above = false): boolean {
  return canon.some((r) => c === r || under(c, r) || (above && under(r, c)));
}

/** Is `p` one of the protected files or folders, or inside one? Every spelling counts; an opaque device path always does. */
export function isProtected(p: string, set: readonly string[], cwd?: string): boolean {
  if (isOpaqueDevicePath(p)) return true;
  return hitsCanonical(canonicalLocal(p, cwd ? { cwd } : {}), canonicalSet(set));
}

/** File identity (volume and file index), read on local paths only. */
function identity(p: string): { id: string; links: bigint; file: boolean; dir: boolean } | undefined {
  if (isRemote(p)) return undefined;
  try { const s = statSync(p, { bigint: true }); return { id: `${s.dev}:${s.ino}`, links: s.nlink, file: s.isFile(), dir: s.isDirectory() }; } catch { return undefined; }
}

/** Every file identity in the protected set (folders walked, bounded). */
function protectedIds(set: readonly string[]): Set<string> {
  const ids = new Set<string>();
  let budget = 5000;
  const walk = (p: string, depth: number): void => {
    const s = identity(p);
    if (!s || budget-- <= 0) return;
    if (s.file) ids.add(s.id);
    else if (s.dir && depth < 8) { let names: string[] = []; try { names = readdirSync(p); } catch { /* none */ } for (const n of names) walk(join(p, n), depth + 1); }
  };
  for (const t of canonicalSet(set)) walk(t, 0);
  return ids;
}

/**
 * Is `p` an existing hardlink to a protected file (same volume and file index)? A file with one link is never one, so the protected
 * set is only walked for a file with more than one link; `cache` keeps that walk for one run (or one command check).
 */
export function isHardlinkToProtected(p: string, set: readonly string[], cwd?: string, cache: { ids?: Set<string> } = {}): boolean {
  const c = canonicalLocal(p, cwd ? { cwd } : {});
  const s = identity(c);
  if (!s || !s.file || s.links < 2n) return false;
  cache.ids ??= protectedIds(set);
  return cache.ids.has(s.id);
}

/**
 * The files and folders no agent may change: the gates folder, the gates key, config, state, the project list, the connectors
 * folder (its key and tokens) and the providers folder (the provider API keys) inside the data folder (NOT the whole folder: agents' workspaces and other folders in it stay free).
 * One list for the file tools and the shell guard.
 */
export function dataFolderTargets(dataDir: string): string[] {
  return ['gates', 'gates-key.bin', 'gates-key.unconfirmed', 'config.json', 'state.json', 'projects.json', 'connectors', 'providers'].map((n) => join(dataDir, n));
}

/**
 * Legion's own program folder (its code, launcher and updater state), as a protected target, but only for an installed Legion: a prebuilt package
 * (`isPackage`) or a folder the Mac and Linux installer marked (`.legion-install.json`). A dev or test checkout has neither and stays free to edit.
 */
export function installFolderTargets(root: string, isPackage: boolean, exists: (p: string) => boolean = existsSync): string[] {
  return isPackage || exists(join(root, '.legion-install.json')) ? [root] : [];
}

/** The data-folder targets (when `dataDir` is given) plus every module's own `protectedPaths()`. */
export function protectedTargets(dataDir: string | undefined, modules: ReadonlyArray<{ protectedPaths?(): string[] }>): string[] {
  const out = dataDir ? dataFolderTargets(dataDir) : [];
  for (const m of modules) {
    try { out.push(...(m.protectedPaths?.() ?? [])); } catch { /* none */ }
  }
  return out;
}
