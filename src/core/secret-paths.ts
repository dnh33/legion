import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

/**
 * Which file paths hold secrets (gates PR 2): an agent that reads one of these may not then send anything out without asking.
 * Documented-shape files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) and public keys (`id_rsa.pub`) are left alone.
 * Matches by name or path segment, with either slash, in any case. A path check only: nothing here opens a file.
 */
const NAMES = /(^|[\\/])(\.env(\.(?!(example|sample|template|dist)$)[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)(?!\.pub$)[\w.-]*|credentials|[^\\/]+\.(pem|key|p12|pfx))$/i;
/** Whole directories of credentials, and exact files inside a dot-directory. */
const DIRS = /(^|[\\/])\.(ssh|aws|gnupg)[\\/]|(^|[\\/])\.docker[\\/]config\.json$|(^|[\\/])\.kube[\\/]config$/i;

export const isSecretPath = (p: string): boolean => NAMES.test(p) || DIRS.test(p);

/** An extra test for paths that are secret by where they are, not by their name (Legion's own key files in its data folder). The engine supplies it. */
export interface SecretLocation {
  /** The folder a relative word means when no `cd` came before it. */
  cwd: string;
  /** Legion's data folder (what the card says a search can reach into). */
  dataFolder: string;
  /** Is this path one of Legion's key files or inside one of its key folders? `cwd` overrides the folder a relative path means. */
  inside(path: string, cwd?: string): boolean;
  /** Is this path the data folder, a folder between it and a key folder, or a folder above it? A recursive search from there reaches key files. */
  reaches(path: string, cwd?: string): boolean;
  /** Could this file name pattern (the last part of a glob) match a key file? */
  globReaches(glob: string): boolean;
}

/** A leading `~`, `$HOME`, `${HOME}`, `%HOME%`, `%USERPROFILE%`, `$env:HOME` or `$env:USERPROFILE` means the home folder; the rest of the word is kept. */
const HOME_LEAD = /^(?:~(?=[\\/]|$)|\$\{HOME\}|\$HOME(?![\w])|%HOME%|%USERPROFILE%|\$env:HOME(?![\w])|\$env:USERPROFILE(?![\w]))/i;
export function expandHomeWord(word: string): string {
  if (!HOME_LEAD.test(word)) return word;
  let home = '';
  try { home = homedir(); } catch { /* no home folder known */ }
  return home ? word.replace(HOME_LEAD, home) : word;
}

/** Programs whose later words are files they read, copy or send. A program not in this list is a known gap. */
const READERS: ReadonlySet<string> = new Set(['cat', 'type', 'more', 'less', 'head', 'tail', 'get-content', 'gc', 'select-string', 'sls', 'findstr', 'grep', 'rg', 'awk', 'sed', 'cp', 'copy', 'copy-item', 'xcopy', 'robocopy', 'base64', 'certutil', 'openssl', 'scp', 'curl', 'wget', 'strings', 'xxd', 'od', 'hexdump', 'sort', 'bat']);
/** A shell drops quote marks inside a word too (`"$HOME"/.legion`), so every one goes before the home expansion and the path test. */
const unquote = (s: string): string => s.replace(/["'`]/g, '');

/** File names Legion's key folders hold, kept even when a folder is empty or missing (so a search before the first key is saved still counts). */
const KNOWN_KEY_FILES = ['keys.json', 'keys.enc', 'keys-keep.json', 'key.bin', 'gates-key.bin', 'app.json'];

/** The file names under the key folders (and the key files themselves), a bounded walk, plus the names above. Names only. */
export function secretFileNames(roots: readonly string[]): string[] {
  const out = new Set<string>(KNOWN_KEY_FILES);
  let budget = 400;
  const walk = (p: string, depth: number): void => {
    if (budget-- <= 0) return;
    try {
      if (statSync(p).isDirectory()) { if (depth < 3) for (const n of readdirSync(p)) walk(join(p, n), depth + 1); } else out.add(basename(p));
    } catch { /* a folder or file that is not there holds no names */ }
  };
  for (const r of roots) walk(r, 0);
  return [...out];
}

/** Turns the last part of a glob into a test (`*`, `?`, `{a,b}` and `[...]` understood; case does not matter). */
function globRegex(glob: string): RegExp {
  const seg = glob.split(/[\\/]/).pop() || '*';
  let re = '';
  let brace = 0;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === '*') { re += '.*'; while (seg[i + 1] === '*') i++; }
    else if (c === '?') re += '.';
    else if (c === '{') { re += '(?:'; brace++; }
    else if (c === '}' && brace > 0) { re += ')'; brace--; }
    else if (c === ',' && brace > 0) re += '|';
    else if (c === '[') { const end = seg.indexOf(']', i + 1); if (end > i) { re += seg.slice(i, end + 1).replace(/\\/g, '\\\\'); i = end; } else re += '\\['; }
    else re += c.replace(/[.+^$()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Could this glob match any of these names? A glob that cannot be read as a pattern counts as yes (it fails towards the card). */
export function globMatchesAny(glob: string, names: readonly string[]): boolean {
  // Shapes the check cannot read with certainty fail toward the card: a leading `!` (rg reads it as "everything except"), whitespace or a comma
  // outside braces (a tool may split the string into several globs).
  if (glob.startsWith('!') || /\s/.test(glob) || /,/.test(glob.replace(/\{[^}]*\}/g, ''))) return true;
  try { const re = globRegex(glob); return names.some((n) => re.test(n)); } catch { return true; }
}

/** Is this path secret by its name, or by where it is (Legion's own key files)? */
const secretPath = (p: string, where?: SecretLocation, cwd?: string): boolean => isSecretPath(p) || where?.inside(expandHomeWord(p), cwd) === true;

/**
 * What a check found. `hit` is the word as written (what the card used to name), `path` the full path it means (resolved against the folder the
 * call or the command's own `cd` put it in), and `search` is true when the path only CONTAINS Legion's key folders (the data folder, a folder
 * above it): a search from there can read the keys, but the path itself is not a key file.
 */
export interface SecretFound { hit: string; path: string; search: boolean }
const shown = (text: string, where?: SecretLocation, cwd?: string): string => {
  if (!where) return text;
  try { return resolve(cwd ?? where.cwd, expandHomeWord(text)); } catch { return text; }
};

/**
 * A path that may hold wildcards. Tested with the wildcards dropped and with them replaced by `x`. A folder before the first wildcard that
 * holds key files (the data folder, or a folder above it), followed by a pattern that can match a key file name, counts too: `<data>/*\/keys.json`.
 */
function wildcardPathHit(value: unknown, where?: SecretLocation, cwd?: string): SecretFound | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (secretPath(value.replace(/[*?]/g, ''), where, cwd) || secretPath(value.replace(/[*?]/g, 'x'), where, cwd)) return { hit: value, path: shown(value, where, cwd), search: false };
  const at = value.search(/[*?{[]/);
  if (at < 0 || !where) return undefined;
  const base = value.slice(0, at).replace(/[\\/][^\\/]*$/, '');
  if (!base) return undefined;
  const last = value.slice(base.length).split(/[\\/]/).pop() || '*';
  return where.reaches(expandHomeWord(base), cwd) && where.globReaches(last) ? { hit: value, path: shown(base, where, cwd), search: true } : undefined;
}

/**
 * A search tool (Grep, Glob) rooted at `root` (the folder it searches; absent means the call's folder) and limited by `glob`. It is a secret read when
 * the root or the glob names a key file or key folder, or when the root is the data folder, a folder above it or a folder between it and a key
 * folder and the glob can match a key file (no glob at all can).
 */
function searchHit(where: SecretLocation | undefined, root: unknown, glob: unknown): SecretFound | undefined {
  const r = typeof root === 'string' && root !== '' ? expandHomeWord(root) : undefined;
  const g = typeof glob === 'string' && glob !== '' ? expandHomeWord(glob) : undefined;
  const a = wildcardPathHit(r, where);
  if (a) return { ...a, hit: root as string };
  const b = wildcardPathHit(g, where);
  if (b) return { ...b, hit: glob as string };
  const c = r && g ? wildcardPathHit(isAbsolute(g) ? g : join(r, g), where) : undefined;
  if (c) return { ...c, hit: glob as string };
  if (where && where.reaches(r ?? '.') && (g === undefined || where.globReaches(g))) return { hit: (root as string | undefined) ?? '.', path: shown(r ?? '.', where), search: true };
  return undefined;
}

/** Search programs: their first plain word is the text to find, so `grep -r credentials src` is not a read (a word with a slash or a leading dot still counts). */
const SEARCHERS: ReadonlySet<string> = new Set(['grep', 'rg', 'findstr', 'select-string', 'sls', 'awk', 'sed']);
/** Programs that move the shell's folder: the words after them mean that folder. */
const NAV: ReadonlySet<string> = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
/** Programs that list a folder. With a pipe after them, what they list is read by the next program. */
const LISTERS: ReadonlySet<string> = new Set(['get-childitem', 'gci', 'dir', 'ls']);

/** Does this program read every file under the folders it is given? */
function recursiveRead(first: string, flags: string[], piped: boolean, whole: string): boolean {
  if (first === 'rg' || first === 'ag' || first === 'ack') return true;
  if (first === 'grep' || first === 'egrep' || first === 'fgrep') return flags.some((w) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(w) || w === '--recursive' || w === '--dereference-recursive');
  if (first === 'findstr') return flags.some((w) => /^\/s$/i.test(w));
  if (first === 'select-string' || first === 'sls') return flags.some((w) => /^-r(ec(urse)?)?$/i.test(w));
  if (LISTERS.has(first)) return piped && flags.some((w) => /^-r(ec(urse)?)?$/i.test(w) || /^-[A-Za-z]*R[A-Za-z]*$/.test(w) || /^\/s$/i.test(w));
  if (first === 'find') return piped || /\s-exec\b/.test(whole);
  return false;
}

function shellHit(command: string, where?: SecretLocation): SecretFound | undefined {
  // a redirect such as 2>&1 or &> is not a command break; brackets and redirects around a word are not part of it
  const parts = command.replace(/\d*>&\d*|&>/g, ' ').split(/([;|&\n\r]+)/);
  let cwd = where?.cwd;
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i]!;
    const piped = (parts[i + 1] ?? '').includes('|');
    const words = seg.replace(/[()<>]/g, ' ').trim().split(/\s+/).filter(Boolean);
    const first = unquote(words[0] ?? '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
    if (where && NAV.has(first)) {
      // the words after a folder change mean that folder; a target the check cannot read (a variable) leaves the folder as it was;
      // a bare `cd` means the home folder
      const target = words.slice(1).map(unquote).filter((w) => !w.startsWith('-') && !/^\/d$/i.test(w)).pop();
      if (!target && first === 'cd') { try { cwd = homedir(); } catch { /* the folder stays as it was */ } continue; }
      const expanded = target ? expandHomeWord(target) : '';
      if (expanded && !/[$%`]/.test(expanded)) { try { cwd = resolve(cwd ?? '.', expanded); } catch { /* the folder stays as it was */ } }
      continue;
    }
    const recursive = recursiveRead(first, words.slice(1).map(unquote), piped, seg);
    // a listing that a pipe passes on reads whatever it names, with or without a recursive flag
    const lists = piped && LISTERS.has(first);
    if (!READERS.has(first) && !recursive && !lists) continue;
    let pattern = SEARCHERS.has(first);
    let sawPath = false;
    for (const w of words.slice(1)) {
      const f = unquote(unquote(w).replace(/^--[\w-]+=/, '').replace(/^-[\w-]+:/, '').replace(/^@/, ''));
      if (!f || f.startsWith('-')) continue;
      if (pattern) { pattern = false; if (!/[\\/]/.test(f) && !f.startsWith('.')) continue; }
      sawPath = true;
      if (isSecretPath(f)) return { hit: f, path: shown(f, where, cwd), search: false };
      const wild = wildcardPathHit(f, where, cwd);
      if (wild) return wild;
      if (recursive && where?.reaches(expandHomeWord(f), cwd)) return { hit: f, path: shown(f, where, cwd), search: true };
    }
    // a recursive search given no folder searches the folder the shell is in
    if (recursive && !sawPath && where?.reaches('.', cwd)) return { hit: '.', path: shown('.', where, cwd), search: true };
  }
  return undefined;
}

/**
 * The secret file a tool call reads, with where it is and whether it is a search folder (see SecretFound), or undefined. Read: `file_path`. LS:
 * `path`, `glob`, `pattern`. Grep: `path` and `glob` (its `pattern` is text to find, not a file, so a search for the word "credentials" is not a
 * read). Glob: `path` and `pattern`. Shell tools: a reader program (see READERS) in any `;`, `|`, `&` or newline segment, with a secret path among
 * its later words; a listing passed on by a pipe counts the same. Gaps: a program not listed, `cat $X`, a renamed file, and (without `where`) a
 * search over a folder that does not name the file. `where` (optional) also counts a path that is secret by its location: the engine passes the
 * check for Legion's own key files (providers, connectors, the gates folder and key), resolved against the call's folder. With it, a recursive
 * search (Grep, Glob, grep -r, rg, findstr /s, a recursive listing piped on) from the data folder, a folder above it or a folder between it and a
 * key folder is a read, and a shell `cd` earlier in the same command changes the folder its words mean (a bare `cd` is the home folder).
 */
export function secretReadDetail(toolName: string, input: Record<string, unknown>, where?: SecretLocation): SecretFound | undefined {
  if (toolName === 'Read' || toolName === 'mcp__host__read_file') { const p = toolName === 'Read' ? input.file_path : input.path; return typeof p === 'string' && secretPath(p, where) ? { hit: p, path: shown(p, where), search: false } : undefined; }
  if (toolName === 'LS') {
    for (const k of ['path', 'glob', 'pattern']) { const v = input[k]; const f = typeof v === 'string' ? wildcardPathHit(expandHomeWord(v), where) : undefined; if (f) return { ...f, hit: v as string }; }
    return undefined;
  }
  if (toolName === 'Grep') return searchHit(where, input.path, input.glob);
  if (toolName === 'Glob') return searchHit(where, input.path, input.pattern) ?? (typeof input.glob === 'string' ? searchHit(where, input.path, input.glob) : undefined);
  if ((toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'Monitor' || toolName.startsWith('mcp__host__')) && typeof input.command === 'string') return shellHit(input.command, where);
  return undefined;
}

/** The word of the secret read (see `secretReadDetail`), or undefined. */
export const secretReadHit = (toolName: string, input: Record<string, unknown>, where?: SecretLocation): string | undefined => secretReadDetail(toolName, input, where)?.hit;
