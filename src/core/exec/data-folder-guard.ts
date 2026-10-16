/**
 * Does a shell command change Legion's own protected files (gate settings, the gates key, projects, config, state, armory, away)?
 * Pure apart from the disk reads of `canonicalLocal`: the engine decides what to do with the answer (a card with no Remember).
 *
 * The command is read as text, not run. It is cut into simple commands (`&&`, `||`, `;`, `|`, newlines, braces, parentheses). Each one
 * is read in order with the working folder it will have: the run's folder, moved by `cd`, `pushd`, `popd`, `Set-Location`, `sl`,
 * `chdir` earlier in the line, and by `git -C <dir>`. Only a command that can write, move, delete, rename or link is looked at (see
 * `WRITERS`), and every redirection `>` / `>>` counts as a write to its target. Each path it names is turned into one canonical
 * spelling (`canonicalLocal`: relative paths, `..`, admin shares, `\\?\`, trailing dots, 8.3 names and junctions) and compared with
 * the same protected set the file tools use (`isProtected`). Plain reads (cat, Get-Content, ls, rg, git log) are free.
 *
 * `names`: a path it names is protected. `hidden`: a command that can write names a path that is built when it runs (an unknown
 * variable, `$(...)`, a backtick, `~user`, a brace list, a wildcard) or a folder the guard lost track of, so it could point there.
 * Limit, stated plainly: this is text matching. A script that builds its path elsewhere gets past it; the signed gates folder is the
 * real barrier.
 */
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { canonicalLocal, isOpaqueDevicePath, isProtected } from './canonical-path.js';

export type ShellKindName = 'sh' | 'pwsh' | 'cmd';
export type FolderHit = 'none' | 'names' | 'hidden';

const WIN = process.platform === 'win32';
const P = WIN ? win32 : posix;

/** Commands that can write, move, delete, rename or link (lower case, without folder or `.exe`). Every path they name is checked. */
const WRITERS = new Set([
  'rm', 'del', 'erase', 'rd', 'rmdir', 'mv', 'move', 'ren', 'rename', 'cp', 'copy', 'xcopy', 'robocopy', 'unlink', 'shred', 'rsync',
  'remove-item', 'ri', 'move-item', 'mi', 'copy-item', 'cpi', 'rename-item', 'rni', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
  'clear-content', 'new-item', 'ni', 'set-itemproperty', 'export-csv', 'export-clixml', 'tee-object', 'set-acl', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
  'mklink', 'ln', 'tee', 'dd', 'truncate', 'touch', 'mkdir', 'md', 'install', 'chmod', 'chown', 'attrib', 'icacls', 'takeown', 'subst', 'curl', 'wget',
  'tar', 'unzip', '7z', 'zip', 'expand-archive', 'compress-archive', 'expand',
]);
const LINKERS = new Set(['mklink', 'ln', 'new-item', 'ni']);
/** Interpreters whose one-liner (`-e`, `-c`) can write anything. */
const ONELINERS = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'perl', 'ruby']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']);
const GIT_WRITES = new Set(['add', 'am', 'apply', 'checkout', 'clean', 'clone', 'commit', 'init', 'merge', 'mv', 'pull', 'fetch', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'cherry-pick', 'tag', 'branch', 'config', 'worktree', 'submodule', 'gc', 'update-index', 'checkout-index', 'format-patch']);
const GIT_PATHS = new Set(['add', 'am', 'apply', 'checkout', 'clean', 'clone', 'init', 'mv', 'reset', 'restore', 'rm', 'switch', 'worktree', 'checkout-index', 'format-patch', 'update-index', 'config']);
const GIT_PATH_VARS = new Set(['add', 'mv', 'rm', 'clean', 'apply', 'am', 'clone', 'init', 'restore', 'checkout-index']);
const SKIP_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'sudo', 'time', 'env', 'command', 'exec', 'nohup', 'call', 'start', 'xargs', 'builtin', 'noglob']);
const MARKERS = /homedir|appdata|userprofile|os\.path|pathlib|join\(|resolve\(|environ|getenv|process\.env|\$env:|\bhome\b/i;

interface Tok { text: string; op?: '>' | '<' | 'sep' }

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
function expand(text: string, get: (n: string) => string | undefined): string {
  const val = (n: string, whole: string): string => get(n) ?? whole;
  return text
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gi, (w, n: string) => val(n, w))
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (w, n: string) => val(n, w))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (w, n: string) => val(n, w))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (w, n: string) => val(n, w))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (w, n: string) => val(n, w));
}

/** Splits a command line into words and operators, quote-aware. `$(...)` stays inside its word. Backslashes are path separators, not escapes. */
function tokenize(cmd: string): Tok[] {
  const out: Tok[] = [];
  let cur = ''; let has = false; let quote = ''; let depth = 0;
  const flush = (): void => { if (has) out.push({ text: cur }); cur = ''; has = false; };
  const sep = (): void => { flush(); out.push({ text: ';', op: 'sep' }); };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) { if (c === quote) quote = ''; else cur += c; continue; }
    if (depth > 0) { cur += c; if (c === '(') depth++; else if (c === ')') depth--; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '$' && cmd[i + 1] === '(') { cur += '$('; has = true; depth = 1; i++; continue; }
    if (c === '\r' || c === '\n' || c === ';' || c === '|' || c === '(' || c === ')') { sep(); if (c === '|' && cmd[i + 1] === '|') i++; continue; }
    if (c === '&') {
      // `2>&1` and `>&2` are not a separator; `&&` and a lone `&` are
      if (cmd[i - 1] === '>' || cmd[i + 1] === '>') { cur += c; has = true; continue; }
      sep(); if (cmd[i + 1] === '&') i++; continue;
    }
    if (c === '>' || c === '<') {
      if (c === '>' && /^\d+$/.test(cur)) { cur = ''; has = false; } else flush();
      let j = i + 1;
      while (cmd[j] === '>' || cmd[j] === '|') j++;
      if (c === '>' && cmd[j] === '&') { j++; while (/[0-9-]/.test(cmd[j] ?? '')) j++; i = j - 1; continue; }
      out.push({ text: c, op: c });
      i = j - 1; continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    cur += c; has = true;
  }
  flush();
  return out;
}

const hasHiddenVar = (t: string): boolean => {
  if (/\$[({]/.test(t) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(t) || t.includes('`')) return true;
  for (const m of t.matchAll(/\$(env:)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (!m[1] && /^(_|true|false|null)$/i.test(m[2]!)) continue;
    return true;
  }
  return false;
};

const globToRe = (seg: string): RegExp => new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** Does a path with wildcards match something under (or above) a protected root? Compared segment by segment. */
function globHitsSet(raw: string, set: readonly string[], cwd: string): boolean {
  const norm = raw.replace(/\\/g, '/');
  const segs = norm.split('/');
  const g = segs.findIndex((s) => /[*?[]/.test(s));
  const prefix = segs.slice(0, g).join('/');
  const base = canonicalLocal(prefix === '' && norm.startsWith('/') ? '/' : prefix || '.', { cwd }).split(/[\\/]+/).filter(Boolean);
  const rest = segs.slice(g).filter(Boolean);
  for (const t of set) {
    const r = canonicalLocal(t).split(/[\\/]+/).filter(Boolean);
    if (r.length < base.length || base.some((s, i) => s !== r[i])) continue;
    const tail = r.slice(base.length);
    const n = Math.min(tail.length, rest.length);
    let ok = true;
    for (let i = 0; i < n; i++) if (!globToRe(rest[i]!).test(tail[i]!)) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** Walks the tokens of one command line. */
class Reader {
  names = false;
  hidden = false;
  private stack: string[] = [];
  private cwd: string | undefined;

  constructor(private readonly set: readonly string[], cwd: string, private readonly kind: ShellKindName, private readonly get: (n: string) => string | undefined, private readonly home: string, private readonly depth: number) { this.cwd = cwd; }

  /** One path token. `base` is the folder a relative path is read from (undefined: lost track of it). */
  private path(raw: string, base: string | undefined): void {
    if (this.names) return;
    if (!raw) return;
    let t = expand(raw, this.get);
    if (hasHiddenVar(t) || (this.kind === 'cmd' && t.includes('^')) || (this.kind === 'pwsh' && (t.includes('+') || t.startsWith('[') || t.includes('::')))) { this.hidden = true; return; }
    if (t === '~' || /^~[\\/]/.test(t)) t = this.home + t.slice(1);
    else if (t.startsWith('~')) { this.hidden = true; return; }
    if (/\{[^}]*,[^}]*\}|\{\d+\.\.\d+\}/.test(t)) { this.hidden = true; return; }
    if (WIN) t = t.replace(/^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/, (_w, d: string) => `${d}:`);
    if (isOpaqueDevicePath(t)) { this.names = true; return; }
    const rooted = P.isAbsolute(t) || /^[\\/]/.test(t);
    if (!rooted && base === undefined) { this.hidden = true; return; }
    const from = base ?? process.cwd();
    try {
      if (/[*?[]/.test(t)) { if (globHitsSet(t, this.set, from)) this.names = true; return; }
      const c = canonicalLocal(t, { cwd: from });
      if (/~\d(?:[\\/]|$)/.test(c)) { this.hidden = true; return; } // a short (8.3) name that did not resolve cannot be told apart
      if (isProtected(t, this.set, from)) this.names = true;
    } catch { this.hidden = true; }
  }

  /** Moves the working folder for cd, pushd, popd, Set-Location. */
  private chdir(args: string[]): void {
    const word = args.filter((a) => !/^\/d$/i.test(a) && !/^-(path|literalpath|l|p)$/i.test(a))[0];
    if (this.cwd === undefined) return;
    let t = word === undefined ? '~' : expand(word, this.get);
    if (word !== undefined && (hasHiddenVar(t) || t === '-' || (t.startsWith('~') && !/^~([\\/]|$)/.test(t)) || /[*?[{]/.test(t))) { this.cwd = undefined; return; }
    if (t === '~' || /^~[\\/]/.test(t)) t = this.home + t.slice(1);
    if (WIN) t = t.replace(/^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/, (_w, d: string) => `${d}:`);
    try { this.cwd = P.resolve(this.cwd, t); } catch { this.cwd = undefined; }
  }

  run(toks: Tok[]): void {
    let seg: Tok[] = [];
    const end = (): void => { if (seg.length) this.segment(seg); seg = []; };
    for (const t of toks) { if (t.op === 'sep' || t.text === '{' || t.text === '}') end(); else seg.push(t); }
    end();
  }

  private segment(seg: Tok[]): void {
    // redirections: the target of > and >> is written; the target of < is only read
    const words: string[] = [];
    const targets: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i]!;
      if (t.op === '>') { const n = seg[i + 1]; if (n && !n.op) { targets.push(n.text); i++; } continue; }
      if (t.op === '<') { if (seg[i + 1] && !seg[i + 1]!.op) i++; continue; }
      words.push(t.text);
    }
    for (const r of targets) if (!/^(\/dev\/null|nul|\$null)$/i.test(r)) this.path(r, this.cwd);
    let k = 0;
    while (k < words.length && (SKIP_WORDS.has(words[k]!.toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!) || words[k] === '&' || words[k] === '.')) k++;
    if (k >= words.length) return;
    let head = words[k]!.replace(/^[{(]+/, '');
    const name = head.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
    const args = words.slice(k + 1);
    if (name === 'cd' || name === 'chdir' || name === 'pushd' || name === 'set-location' || name === 'sl' || name === 'popd') {
      if (name === 'popd') { this.cwd = this.stack.pop() ?? this.cwd; return; }
      if (name === 'pushd') this.stack.push(this.cwd ?? '');
      if (this.kind === 'cmd' && name === 'cd' && args.length === 0) return;
      this.chdir(args);
      return;
    }
    if (name === 'git') { this.git(args); return; }
    if (SHELLS.has(name)) { this.nested(name, args); return; }
    if (ONELINERS.has(name)) {
      const i = args.findIndex((a) => /^(-e|-c|-p|--eval|-pe)$/.test(a));
      if (i >= 0 && args[i + 1] !== undefined) this.script(args[i + 1]!);
      return;
    }
    if (name === 'sed' || name === 'perl') { if (!args.some((a) => /^-[a-z]*i/.test(a) || a === '--in-place')) return; }
    else if (!WRITERS.has(name)) return;
    this.writerArgs(name, args);
  }

  /** The paths a writing command names: every word that is not a switch, plus the value of `--opt=value`. */
  private writerArgs(name: string, args: string[]): void {
    const paths: string[] = [];
    for (const a of args) {
      if (/^\/[a-z?]{1,2}$/i.test(a) && this.kind === 'cmd') continue; // /s /q /y /d /J
      if (/^-/.test(a)) {
        const v = a.slice(a.search(/[=:]/) + 1);
        if (/[=:]/.test(a) && v && a.search(/[=:]/) > 0) paths.push(v);
        continue;
      }
      paths.push(a.includes('=') && /^[a-z]+=/i.test(a) ? a.slice(a.indexOf('=') + 1) : a);
    }
    for (const p of paths) this.path(p, this.cwd);
    // a link's target may be relative to the link, not to the folder the command runs in
    if (LINKERS.has(name) && this.cwd !== undefined) {
      for (const link of paths) {
        let at: string;
        try { at = dirname(P.resolve(this.cwd, expand(link, this.get))); } catch { continue; }
        for (const other of paths) if (other !== link && !P.isAbsolute(other)) this.path(other, at);
      }
    }
  }

  private git(args: string[]): void {
    let dir = this.cwd;
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a === '-C') { const d = args[++i]; if (d !== undefined && dir !== undefined) { const save = this.cwd; this.cwd = dir; this.chdir([d]); dir = this.cwd; this.cwd = save; } else dir = undefined; continue; }
      if (a === '-c' || a === '--exec-path') { i++; continue; }
      if (/^--(git-dir|work-tree)=/.test(a)) { this.path(a.slice(a.indexOf('=') + 1), dir); continue; }
      if (a.startsWith('-')) continue;
      break;
    }
    const sub = args[i]?.toLowerCase();
    if (!sub || !GIT_WRITES.has(sub)) return;
    // a writing git command works in the folder it runs in
    if (dir === undefined) { this.hidden = true; return; }
    this.path('.', dir);
    if (!GIT_PATHS.has(sub)) return;
    let afterDashes = false;
    for (const a of args.slice(i + 1)) {
      if (a === '--') { afterDashes = true; continue; }
      if (a.startsWith('-') && !afterDashes) continue;
      if (hasHiddenVar(expand(a, this.get)) && !afterDashes && !GIT_PATH_VARS.has(sub)) continue;
      this.path(a, dir);
    }
  }

  private nested(name: string, args: string[]): void {
    if (this.depth >= 3) { this.hidden = true; return; }
    let text: string | undefined;
    const kind: ShellKindName = name === 'cmd' ? 'cmd' : name === 'bash' || name === 'sh' || name === 'zsh' ? 'sh' : 'pwsh';
    if (name === 'cmd') { const i = args.findIndex((a) => /^\/[ck]$/i.test(a)); if (i >= 0) text = args.slice(i + 1).join(' '); }
    else if (kind === 'sh') { const i = args.findIndex((a) => /^-[a-z]*c$/.test(a)); if (i >= 0) text = args[i + 1]; }
    else {
      if (args.some((a) => /^-(e|ec|enc|encodedcommand)$/i.test(a))) { this.hidden = true; return; }
      const i = args.findIndex((a) => /^-(c|command)$/i.test(a));
      if (i >= 0) text = args.slice(i + 1).join(' ');
    }
    if (text === undefined) return;
    const inner = new Reader(this.set, this.cwd ?? '', kind, this.get, this.home, this.depth + 1);
    if (this.cwd === undefined) inner.cwd = undefined;
    inner.run(tokenize(text));
    if (inner.names) this.names = true;
    if (inner.hidden) this.hidden = true;
  }

  /** A one-liner (`node -e`, `python -c`): look for protected paths in its text. */
  private script(code: string): void {
    const found = code.match(/[A-Za-z]:[\\/][^'"`\s)]*|(?:\.{1,2}|~)?[\\/][^'"`\s)]+|\.\.?[\\/]|~[^'"`\s)]*/g) ?? [];
    for (const f of found) this.path(f.replace(/\\\\/g, '\\'), this.cwd);
    if (!this.names && MARKERS.test(code) && !found.some((f) => /^[A-Za-z]:[\\/]/.test(f))) this.hidden = true;
  }
}

/**
 * @param protectedSet the protected files and folders (`protectedTargets(...)`): one set for the file tools and the shell
 * @param opts.cwd the folder the run's shell starts in (relative paths are read from here)
 */
export function dataFolderHit(command: string, kind: ShellKindName, protectedSet: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): FolderHit {
  const home = (() => { try { return homedir(); } catch { return ''; } })();
  const get = lookup(opts.env ?? process.env, home);
  const userHome = get('userprofile') ?? home;
  const r = new Reader(protectedSet, opts.cwd ?? process.cwd(), kind, get, userHome, 0);
  r.run(tokenize(command));
  return r.names ? 'names' : r.hidden ? 'hidden' : 'none';
}
