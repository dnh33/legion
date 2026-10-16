/**
 * Does a shell command work on Legion's own data folder (gate settings, the gates key, projects, config, armory, away)?
 * Pure: the engine decides what to do with the answer (a card with no Remember, unless the command only reads).
 *
 * The command is read as text, not run: known variables (`~`, `$HOME`, `%APPDATA%`, `$env:USERPROFILE`, anything in `env`) are
 * filled in, slashes and case are made equal, `.` and `..` steps are folded, and the Git Bash (`/c/...`) and WSL (`/mnt/c/...`)
 * drive spellings become `c:/...`. Then the folder is looked for as a path. A path that is still built when the command runs (an
 * unknown variable, `$(...)`, a backtick, a short 8.3 name) could point there and answers `hidden`.
 */
import { homedir } from 'node:os';

export type ShellKindName = 'sh' | 'pwsh' | 'cmd';
export type FolderHit = 'none' | 'names' | 'hidden';

const fwd = (p: string): string => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
const norm = (p: string): string => fwd(p).replace(/\/+$/, '');

function lookup(env: NodeJS.ProcessEnv, home: string): (name: string) => string | undefined {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') m.set(k.toLowerCase(), v);
  const h = m.get('userprofile') ?? m.get('home') ?? home;
  if (!m.has('home')) m.set('home', h);
  if (!m.has('userprofile')) m.set('userprofile', h);
  if (!m.has('appdata')) m.set('appdata', `${h}/AppData/Roaming`);
  if (!m.has('localappdata')) m.set('localappdata', `${h}/AppData/Local`);
  return (name) => m.get(name.toLowerCase());
}

/** Fills in the variables whose value is known. What is left unresolved stays in the text. */
function expand(command: string, get: (n: string) => string | undefined, home: string): string {
  const val = (n: string, whole: string): string => get(n) ?? whole;
  let t = command
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gi, (w, n: string) => val(n, w))
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (w, n: string) => val(n, w))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (w, n: string) => val(n, w))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (w, n: string) => val(n, w))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (w, n: string) => val(n, w));
  t = t.replace(/(^|[\s"'=:(;|&>])~(?=[\\/\s"';|&)]|$)/g, (_w, pre: string) => `${pre}${home}`);
  return t;
}

/** Slashes, case, drive spellings, quotes and `.`/`..` steps made equal, so one string compare finds the folder. */
function flatten(t: string): string {
  let s = fwd(t).replace(/["'`]/g, '');
  s = s.replace(/(^|[\s=:(;|&<>])\/(?:mnt\/|cygdrive\/)?([a-z])\//g, (_w, pre: string, d: string) => `${pre}${d}:/`);
  s = s.replace(/\/\.(?=\/)/g, '');
  for (let i = 0; i < 20; i++) {
    const n = s.replace(/\/(?!\.\.\/)[^/\s;|&<>()]+\/\.\.(?=\/|$|[\s;|&<>()])/g, '');
    if (n === s) break;
    s = n;
  }
  return s;
}

/** Variables and substitutions that were not filled in. `$_`, `$true`, `$false`, `$null`, `$?` and `$5` are not paths. */
function hasHidden(t: string, kind: ShellKindName): boolean {
  if (/\$[({]/.test(t) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(t)) return true;
  if (kind === 'sh' && t.includes('`')) return true;
  for (const m of t.matchAll(/\$(env:)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (!m[1] && /^(_|true|false|null)$/i.test(m[2]!)) continue;
    return true;
  }
  return false;
}

export function dataFolderHit(command: string, kind: ShellKindName, folders: readonly string[], env: NodeJS.ProcessEnv = process.env): FolderHit {
  const home = (() => { try { return homedir(); } catch { return ''; } })();
  const get = lookup(env, home);
  const userHome = get('userprofile') ?? home;
  const expanded = expand(command, get, userHome);
  const flat = flatten(expanded);
  const roots = folders.map((f) => norm(expand(f, get, userHome))).filter(Boolean);
  for (const r of roots) {
    let at = flat.indexOf(r);
    while (at !== -1) {
      const next = flat[at + r.length];
      if (next === undefined || !/[a-z0-9_.~$%-]/.test(next)) return 'names';
      at = flat.indexOf(r, at + 1);
    }
  }
  // a wildcard that could stand for the folder: `C:/Users/x/AppData/Roaming/leg*/gates`
  for (const w of flat.split(/[\s;|&<>()]+/)) {
    const g = w.search(/[*?[]/);
    if (g < 3) continue;
    const lit = w.slice(0, g);
    if (!/[:/]/.test(lit)) continue;
    if (roots.some((r) => r.startsWith(lit))) return 'names';
  }
  if (hasHidden(expanded, kind)) return 'hidden';
  // a short (8.3) name such as DANIE~1 is a path that cannot be told apart from the folder by reading
  if (/[a-z0-9_]{1,8}~[0-9]/i.test(expanded) && /[\\/]/.test(expanded)) return 'hidden';
  return 'none';
}
