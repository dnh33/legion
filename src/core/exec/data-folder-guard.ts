/**
 * Does a shell command touch Legion's own protected files (gate settings, the gates key, projects, config, state, connectors, providers, armory,
 * away)? Pure apart from the disk reads of `canonicalLocal`: the engine decides what to do with the answer (a card with no Remember).
 *
 * Default deny. The command is read as text, not run:
 * - It is normalised the way the shell reads it: quotes, bash backslash escapes, `$'...'`, the pwsh backtick and the cmd caret;
 *   `~` and the known folder variables (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, TMP, TMPDIR) from the run's environment.
 * - Hidden commands are read too: `$(...)`, backticks, heredoc bodies, `<<<`, and the strings given to iex / Invoke-Expression,
 *   Start-Process -ArgumentList, cmd /c, powershell -Command, bash -c, node -e and python -c.
 * - It is cut into simple commands. Each word, resolved against the working folder it will have (`cd`, `pushd`, `popd`,
 *   `Set-Location`, `Push-Location`, `Pop-Location`, `git -C`), is compared with the protected set in canonical spelling
 *   (`canonicalLocal`). A word that is a protected entry, is inside one, or holds one (the data folder, the home folder, the drive
 *   root) is a hit, and so is an existing hardlink to a protected file.
 * - A hit counts unless every part of the command only reads (`READERS`, git status/log/diff/show, echo with no redirection).
 *   A redirection into a protected path always counts.
 *
 * `names`: a word is (or holds) a protected path. `hidden`: a word could be one and the guard cannot tell: an unknown variable,
 * `$(...)`, `~user`, a brace list, an unresolved 8.3 name, a relative word after a `cd` that can fail or does not last, a line that
 * sets HOME, TEMP or CDPATH or redefines `cd`, or an encoded PowerShell command.
 * Limit, stated plainly: this is text matching. A script or program that builds its path when it runs gets past it; only an OS
 * sandbox stops that. The signed gates folder is the real barrier.
 */
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { canonicalLocal, canonicalSet, foldCase, hitsCanonical, isHardlinkToProtected, isOpaqueDevicePath } from './canonical-path.js';

export type ShellKindName = 'sh' | 'pwsh' | 'cmd';
export type FolderHit = 'none' | 'names' | 'hidden';

const WIN = process.platform === 'win32';
const P = WIN ? win32 : posix;

/** Commands that only read (lower case, without folder or `.exe`). A line made only of these is free, whatever it names. */
const READERS = new Set([
  'cat', 'type', 'more', 'less', 'head', 'tail', 'get-content', 'gc', 'get-childitem', 'gci', 'dir', 'ls', 'get-item', 'gi', 'test-path',
  'select-string', 'sls', 'rg', 'grep', 'findstr', 'wc', 'stat', 'pwd', 'get-location',
]);
/** Print their words: the words are text, not paths (read for protected names only); read-only when nothing is redirected. */
const ECHOS = new Set(['echo', 'write-output']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse']);
const NAV = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location']);
/** Words that do nothing by themselves (the end of a loop or a branch). */
const NEUTRAL = new Set(['done', 'fi', 'esac', 'true', ':', 'for']);
const LINKERS = new Set(['mklink', 'ln', 'new-item', 'ni']);
/** Interpreters whose one-liner (`-e`, `-c`) or here-doc can write anything. */
const ONELINERS = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'perl', 'ruby']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']);
const SKIP_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'sudo', 'time', 'env', 'command', 'exec', 'nohup', 'call', 'start', 'xargs', 'builtin', 'noglob']);
/** A quote's closing mark: the plain quotes, and the bracket pairs of Perl's q() and Ruby's %q[]. */
const QUOTE_CLOSE: Record<string, string> = { "'": "'", '"': '"', '`': '`', '(': ')', '[': ']', '{': '}', '<': '>' };
/** Code that builds a path from the home folder or the environment: it can reach the data folder without naming it. */
const HOME_MARKERS = /homedir|appdata|userprofile|expanduser|environ|getenv|process\.env|\$env:|\bhome\b/i;
/** Code that builds a path from parts. Alone that is ordinary work (nearly every pathlib script); near a protected name it could point there. */
const BUILD_MARKERS = /os\.path|pathlib|join\(|resolve\(|\bPath\(/i;
/** The folder variables read from the run's environment. Any other variable is unknown. */
const KNOWN = ['home', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp', 'tmpdir'];

const VARS = '(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|CDPATH)';
/** The line sets a folder variable (or CDPATH): `~`, `$HOME` and `cd` no longer mean what the run's environment says. */
const REASSIGN = new RegExp([
  `(?:^|[^\\w$.:-])(?:\\$\\{?env:|\\$)?${VARS}\\}?\\s*\\+?=`,
  `\\b(?:read|unset|for)\\s+(?:-\\w+\\s+)*${VARS}\\b`,
  `\\b(?:set-item|si|new-item|ni|set-content|sc|remove-item|ri|clear-item|cli)\\b[^\\n;|&]*\\benv:${VARS}\\b`,
  `\\b(?:set-variable|sv|new-variable|nv|remove-variable|rv)\\s+(?:-name\\s+)?${VARS}\\b`,
  'setenvironmentvariable',
  `\\bset\\s+"?${VARS}=`,
].join('|'), 'i');
const NAVS = '(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)';
/** The line redefines `cd` (a function, an alias): its moves cannot be followed. */
const REDEFINE = new RegExp(`(?:^|[\\s;&|(){}])(?:function\\s+${NAVS}\\b|${NAVS}\\s*\\(\\s*\\)|alias\\s+${NAVS}=|(?:set-alias|sal|new-alias|nal)\\s+(?:-name\\s+)?${NAVS}\\b|doskey\\s+${NAVS}=)`, 'i');
const lineUnknown = (text: string): boolean => REASSIGN.test(text) || REDEFINE.test(text);

/** Paths inside a longer word (code, a quoted list, `-o<path>`): drive, UNC, `~/...` and `../...` spellings. */
const EMBED = /[A-Za-z]:[\\/][^\s'"`,;|()<>]*|(?<![\w:])[\\/]{2}[^\s'"`,;|()<>]+|(?<![\w.~-])~(?=[\\/]|$|[\s'"`,;)])[^\s'"`,;|()<>]*|(?<![\w.-])(?:\.\.[\\/])+[^\s'"`,;|()<>]*/g;
/** A literal `$` from single quotes: never a variable, put back before the path is read. */
const LIT = '';

type Op = '>' | '<' | '&&' | '||' | ';' | '&' | '|' | '(' | ')';
interface Tok { text: string; alt?: string; op?: Op; subs?: string[]; doc?: boolean }
/** Where the next command runs: the folders it may be in; `exact` when there is only one and it is certain. */
interface Where { cwds: string[]; exact: boolean }

function lookup(env: NodeJS.ProcessEnv, home: string): (name: string) => string | undefined {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && KNOWN.includes(k.toLowerCase())) m.set(k.toLowerCase(), v);
  const h = m.get('userprofile') ?? m.get('home') ?? home;
  if (!m.has('home')) m.set('home', h);
  if (!m.has('userprofile')) m.set('userprofile', h);
  if (!m.has('appdata')) m.set('appdata', `${h}/AppData/Roaming`);
  if (!m.has('localappdata')) m.set('localappdata', `${h}/AppData/Local`);
  return (name) => m.get(name.toLowerCase());
}

/** Fills in the known folder variables. What is left unresolved stays in the text. */
function expand(text: string, get: (n: string) => string | undefined): string {
  const val = (n: string, whole: string): string => get(n) ?? whole;
  return text
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gi, (w, n: string) => val(n, w))
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (w, n: string) => val(n, w))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (w, n: string) => val(n, w))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (w, n: string) => val(n, w))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (w, n: string) => val(n, w));
}

const hasHiddenVar = (t: string): boolean => {
  if (/\$[({]/.test(t) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(t) || /![A-Za-z_][A-Za-z0-9_]*!/.test(t)) return true;
  for (const m of t.matchAll(/\$(env:)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (!m[1] && /^(_|true|false|null)$/i.test(m[2]!)) continue;
    return true;
  }
  return false;
};

/** The index of the `)` that closes a `(` opened just before `i`; quotes are skipped. */
function closeParen(s: string, i: number): number {
  let depth = 1; let q = '';
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"') j++; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return s.length;
}

/** The body of a bash `$'...'` string, decoded. */
function ansiC(body: string): string {
  const named: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g, (_w, e: string) => {
    if (e[0] === 'x' || e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (e[0] === 'c' && e.length === 2) return String.fromCharCode(e.charCodeAt(1) & 31);
    return named[e] ?? e;
  }).replace(/\$/g, LIT);
}

/**
 * Splits a command line into words and operators the way the shell reads it. `text` is the word as the shell sees it; for sh, `alt`
 * keeps the backslashes (a Windows path typed without quotes). `$(...)`, backticks and process substitutions go to `subs`; a
 * heredoc body is a `doc` word of the command it feeds.
 */
function tokenize(cmd: string, kind: ShellKindName): Tok[] & { broken?: boolean } {
  const sh = kind === 'sh'; const ps = kind === 'pwsh'; const cm = kind === 'cmd';
  const out: Tok[] & { broken?: boolean } = [];
  // an unclosed quote, substitution or heredoc: the shell would not read the line the way it is cut here
  const closed = (end: number, ch?: string): void => { if (end >= cmd.length || (ch !== undefined && cmd[end] !== ch)) out.broken = true; };
  let cur = ''; let raw = ''; let has = false; let subs: string[] = [];
  const docs: Array<{ delim: string; strip: boolean }> = [];
  const flush = (): void => {
    if (has) out.push({ text: cur, ...(raw !== cur ? { alt: raw } : {}), ...(subs.length ? { subs } : {}) });
    cur = ''; raw = ''; has = false; subs = [];
  };
  const add = (t: string, r = t): void => { cur += t; raw += r; has = true; };
  const op = (o: Op): void => { flush(); out.push({ text: o, op: o }); };
  const sub = (inner: string): void => { subs.push(inner); add('$(sub)'); };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const n = cmd[i + 1];
    if ((sh || ps) && c === '$' && n === '(') { const e = closeParen(cmd, i + 2); closed(e); sub(cmd.slice(i + 2, e)); i = e; continue; }
    if (sh && (c === '<' || c === '>') && n === '(') { const e = closeParen(cmd, i + 2); closed(e); sub(cmd.slice(i + 2, e)); i = e; continue; }
    if (sh && c === '`') { let j = i + 1; while (j < cmd.length && cmd[j] !== '`') { if (cmd[j] === '\\') j++; j++; } closed(j, '`'); sub(cmd.slice(i + 1, j)); i = j; continue; }
    if (sh && c === '$' && n === "'") {
      let j = i + 2; let body = '';
      while (j < cmd.length && cmd[j] !== "'") { if (cmd[j] === '\\') { body += cmd[j]! + (cmd[j + 1] ?? ''); j += 2; } else body += cmd[j++]; }
      closed(j, "'"); add(ansiC(body)); i = j; continue;
    }
    if (c === "'") {
      let j = i + 1; let body = '';
      for (; j < cmd.length; j++) {
        if (cmd[j] === "'") { if (ps && cmd[j + 1] === "'") { body += "'"; j++; continue; } break; }
        body += cmd[j];
      }
      if (!cm) closed(j, "'"); // in cmd an apostrophe is a plain letter (`echo it's done`)
      add(cm ? body : body.replace(/\$/g, LIT)); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        const d = cmd[j]!;
        if (sh && d === '\\' && /[$`"\\\n]/.test(cmd[j + 1] ?? '')) { add(cmd[j + 1]!, `\\${cmd[j + 1]!}`); j++; continue; }
        if (ps && d === '`' && j + 1 < cmd.length) { add(cmd[j + 1]!); j++; continue; }
        if ((sh || ps) && d === '$' && cmd[j + 1] === '(') { const e = closeParen(cmd, j + 2); sub(cmd.slice(j + 2, e)); j = e; continue; }
        if (sh && d === '`') { let k = j + 1; while (k < cmd.length && cmd[k] !== '`') k++; sub(cmd.slice(j + 1, k)); j = k; continue; }
        add(d);
      }
      closed(j, '"'); has = true; i = j; continue;
    }
    if (sh && c === '\\') { if (n !== undefined && n !== '\n') add(n, `\\${n}`); i++; continue; }
    if (ps && c === '`') { if (n !== undefined && n !== '\n') add(n); i++; continue; }
    if (cm && c === '^') { if (n !== undefined && n !== '\n') add(n); i++; continue; }
    if (sh && c === '<' && n === '<' && cmd[i + 2] !== '<') {
      let j = i + 2; const strip = cmd[j] === '-'; if (strip) j++;
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      let delim = '';
      for (; j < cmd.length && !/[\s;&|<>()]/.test(cmd[j]!); j++) if (!`'"\\`.includes(cmd[j]!)) delim += cmd[j];
      flush();
      if (delim) docs.push({ delim, strip });
      i = j - 1; continue;
    }
    if (c === '\n' && docs.length) {
      flush();
      let j = i + 1;
      for (const d of docs.splice(0)) {
        const lines: string[] = [];
        let ended = false;
        while (j < cmd.length) {
          let e = cmd.indexOf('\n', j); if (e < 0) e = cmd.length;
          const line = cmd.slice(j, e).replace(/\r$/, ''); j = e + 1;
          if ((d.strip ? line.replace(/^\t+/, '') : line) === d.delim) { ended = true; break; }
          lines.push(line);
        }
        if (!ended) out.broken = true;
        out.push({ text: lines.join('\n'), doc: true });
      }
      out.push({ text: ';', op: ';' });
      i = j - 1; continue;
    }
    if (c === '\r' || c === '\n' || c === ';') { op(';'); continue; }
    if (c === '|') { if (n === '|') { op('||'); i++; } else op('|'); continue; }
    if (c === '(' || c === ')') { op(c); continue; }
    if (c === '&') {
      // `2>&1` and `>&2` are not a separator; `&&` and a lone `&` are (in pwsh a leading `&` is the call operator)
      if (cmd[i - 1] === '>' || n === '>') { add(c); continue; }
      if (n === '&') { op('&&'); i++; continue; }
      if (ps && !has && (out.length === 0 || out[out.length - 1]!.op)) continue;
      op('&'); continue;
    }
    if (c === '>' || c === '<') {
      if (/^\d+$/.test(cur) || cur === '*') { cur = ''; raw = ''; has = false; } else flush();
      let j = i + 1;
      while (cmd[j] === c || cmd[j] === '|') j++;
      if (c === '>' && cmd[j] === '&') { j++; while (/[0-9-]/.test(cmd[j] ?? '')) j++; i = j - 1; continue; }
      out.push({ text: c, op: c });
      i = j - 1; continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    add(c);
  }
  flush();
  if (docs.length) out.broken = true; // a heredoc with no body
  return out;
}

const globToRe = (seg: string): RegExp => new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** Does a path with wildcards match something under (or above) a protected root? Compared segment by segment. */
function globHitsSet(raw: string, canon: readonly string[], cwd: string): boolean {
  const norm = raw.replace(/\\/g, '/');
  const segs = norm.split('/');
  const g = segs.findIndex((s) => /[*?[]/.test(s));
  const prefix = segs.slice(0, g).join('/');
  const base = canonicalLocal(prefix === '' && norm.startsWith('/') ? '/' : prefix || '.', { cwd }).split(/[\\/]+/).filter(Boolean);
  const rest = segs.slice(g).filter(Boolean);
  for (const t of canon) {
    const r = t.split(/[\\/]+/).filter(Boolean);
    if (r.length < base.length || base.some((s, i) => foldCase(s) !== foldCase(r[i]!))) continue;
    const tail = r.slice(base.length);
    const n = Math.min(tail.length, rest.length);
    let ok = true;
    for (let i = 0; i < n; i++) if (!globToRe(rest[i]!).test(tail[i]!)) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

interface Ctx { start: string; cwdUnknown: boolean; set: readonly string[]; canon: string[]; get: (n: string) => string | undefined; home: string; ids: { ids?: Set<string> }; memo: Map<string, string> }

const uniq = (a: string[]): string[] => [...new Set(a)].slice(0, 8);
const merge = (a: Where, b: Where): Where => {
  const cwds = uniq([...a.cwds, ...b.cwds]);
  return { cwds, exact: a.exact && b.exact && cwds.length === 1 && a.cwds.length > 0 && b.cwds.length > 0 };
};

/** Walks the words of one command line (and of the commands hidden inside it). */
class Reader {
  names = false;
  hidden = false;
  redir = false;
  redirHidden = false;
  allRead = true;
  unknown = false;
  /** A `cd` ran that the guard cannot prove ends outside the protected set (the shell may stay there for the next call). */
  navUnproven = false;
  where: Where;
  private stack: Where[] = [];
  private loops = new Map<string, string[]>();

  constructor(private readonly ctx: Ctx, where: Where, private readonly kind: ShellKindName, private readonly depth: number) { this.where = where; }

  text(cmd: string): void {
    if (lineUnknown(cmd)) this.unknown = true;
    const toks = tokenize(cmd, this.kind);
    if (toks.broken) this.unknown = true; // cannot be parsed: not safe
    this.run(toks);
  }

  result(): FolderHit {
    if (this.redir) return 'names';
    if (!this.allRead && this.names) return 'names';
    if (this.unknown || this.redirHidden || (!this.allRead && this.hidden)) return 'hidden';
    return 'none';
  }

  /** A command inside this one (`$(...)`, a heredoc fed to a shell, `bash -c`, iex): read with its own reader, merged here. */
  private child(text: string, kind: ShellKindName, subshell: boolean): void {
    if (this.depth >= 4) { this.hidden = true; this.allRead = false; return; }
    const r = new Reader(this.ctx, this.where, kind, this.depth + 1);
    for (const [k, v] of this.loops) r.loops.set(k, v);
    r.text(text);
    this.names ||= r.names; this.hidden ||= r.hidden; this.redir ||= r.redir; this.redirHidden ||= r.redirHidden; this.unknown ||= r.unknown; this.navUnproven ||= r.navUnproven;
    this.allRead &&= r.allRead;
    if (!subshell && r.where !== this.where) this.where = merge(this.where, r.where);
  }

  run(toks: Tok[]): void {
    let seg: Tok[] = [];
    const saved: Where[] = [];
    for (const t of toks) {
      const boundary = (t.op && t.op !== '>' && t.op !== '<') || t.text === '{' || t.text === '}';
      if (!boundary) { seg.push(t); continue; }
      if (seg.length) this.segment(seg, t.op);
      seg = [];
      if (t.op === '(') saved.push(this.where);
      else if (t.op === ')') {
        const s = saved.pop();
        // a sh subshell's cd ends at `)`; pwsh and cmd parentheses only group, so the folder may have moved
        if (s) this.where = this.kind === 'sh' ? s : this.where === s ? s : merge(s, this.where);
      }
    }
    if (seg.length) this.segment(seg, undefined);
  }

  /** The values a word can have: loop variables (`for f in *.ts`) are tried with each of their words. */
  private variants(w: string): string[] {
    let out = [w];
    for (const [name, vals] of this.loops) {
      const re = new RegExp(`\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`, 'g');
      if (!out.some((o) => re.test(o))) continue;
      out = out.flatMap((o) => vals.map((v) => o.replace(re, v))).slice(0, 16);
    }
    return out;
  }

  /** One word, every way it can be read. `namesOnly`: text that is not a path (echo words): only a protected name counts. */
  private probe(tok: Pick<Tok, 'text' | 'alt'>, where: Where, namesOnly = false): FolderHit {
    let best: FolderHit = 'none';
    for (const spelling of tok.alt !== undefined ? [tok.text, tok.alt] : [tok.text]) {
      for (const v of this.variants(spelling)) {
        const t = expand(v, this.ctx.get);
        const cands = namesOnly ? [] : [t];
        const eq = /^-{0,2}[A-Za-z][\w.-]*[=:](.+)$/.exec(t);
        if (eq && !/^[A-Za-z]:[\\/]/.test(t)) cands.push(eq[1]!);
        for (const m of t.matchAll(EMBED)) if (m[0] !== t) cands.push(m[0]);
        if (namesOnly) for (const m of t.matchAll(EMBED)) if (m[0] === t) cands.push(m[0]);
        for (const c of cands) {
          const h = this.one(c, where);
          if (h === 'names') return 'names';
          // the alternative backslash reading and text that is not a path only ever add a protected name
          if (h === 'hidden' && !namesOnly && spelling === tok.text) best = 'hidden';
        }
      }
    }
    return best;
  }

  private one(t0: string, where: Where): FolderHit {
    let t = t0;
    if (!t) return 'none';
    if (hasHiddenVar(t)) return 'hidden';
    t = t.replace(new RegExp(LIT, 'g'), '$');
    if (this.kind === 'pwsh' && t.includes('::')) return 'hidden'; // [IO.Path]::Combine(...) builds a path
    if (t === '~' || /^~[\\/]/.test(t)) t = this.ctx.home + t.slice(1);
    else if (t.startsWith('~') && this.kind === 'sh') return 'hidden';
    if (this.kind === 'sh' && /\{[^}]*,[^}]*\}|\{\d+\.\.\d+\}/.test(t)) return 'hidden';
    if (WIN && this.kind === 'sh') t = t.replace(/^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/, (_w, d: string) => `${d}:/`);
    // PowerShell on Linux and macOS reads `\` as a folder separator too (its escape is the backtick)
    if (!WIN && this.kind === 'pwsh') t = t.replace(/\\/g, '/');
    if (isOpaqueDevicePath(t)) return 'names';
    const rooted = P.isAbsolute(t) || /^[\\/]/.test(t);
    if (!rooted && where.cwds.length === 0) return 'hidden';
    let res: FolderHit = 'none';
    for (const cwd of rooted ? [where.cwds[0] ?? process.cwd()] : where.cwds) {
      const h = this.at(t, cwd);
      if (h === 'names') return 'names';
      if (h === 'hidden') res = 'hidden';
    }
    // every folder the shell may be in was tried above; only an unknown or cut-off set, or a folder kept from an earlier call, leaves a relative word open
    return !rooted && (this.ctx.cwdUnknown || where.cwds.length >= 8) ? 'hidden' : res;
  }

  private at(t: string, cwd: string): FolderHit {
    try {
      if (/[*?[]/.test(t)) return globHitsSet(t, this.ctx.canon, cwd) ? 'names' : 'none';
      const key = `${cwd}\0${t}`;
      let c = this.ctx.memo.get(key);
      if (c === undefined) { c = canonicalLocal(t, { cwd }); this.ctx.memo.set(key, c); }
      if (/~\d[\\/]/.test(c)) return 'hidden'; // a short (8.3) folder name that did not resolve cannot be told apart
      if (hitsCanonical(c, this.ctx.canon, true)) return 'names';
      if (isHardlinkToProtected(c, this.ctx.set, undefined, this.ctx.ids)) return 'names';
      return 'none';
    } catch { return 'hidden'; }
  }

  private note(h: FolderHit): void { if (h === 'names') this.names = true; else if (h === 'hidden') this.hidden = true; }

  /** The folder after `cd <word>`. Undefined word: the home folder. An unknown word: no folder known. */
  private moved(from: Where, word: string | undefined): Where {
    let t = word === undefined ? '~' : expand(word, this.ctx.get).replace(new RegExp(LIT, 'g'), '$');
    if (word !== undefined && (hasHiddenVar(t) || t === '-' || (t.startsWith('~') && !/^~([\\/]|$)/.test(t)) || /[*?[{]/.test(t))) return { cwds: [], exact: false };
    if (t === '~' || /^~[\\/]/.test(t)) t = this.ctx.home + t.slice(1);
    if (WIN && this.kind === 'sh') t = t.replace(/^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/, (_w, d: string) => `${d}:/`);
    if (P.isAbsolute(t)) return { cwds: [P.resolve(t)], exact: true };
    if (!from.cwds.length) return { cwds: [], exact: false };
    return { cwds: uniq(from.cwds.map((c) => P.resolve(c, t))), exact: from.exact };
  }

  /** cd, pushd, popd, Set-Location, Push-Location, Pop-Location. Only a move followed by `&&` is certain; after `;`, `||`, `&` it may not have happened. */
  private nav(name: string, args: string[], next: Op | undefined): void {
    const sure = next === '&&';
    const before = this.where;
    let after: Where;
    if (name === 'popd' || name === 'pop-location') {
      const prev = this.stack.pop();
      if (!prev) return; // nothing to go back to: the folder stays
      after = prev;
    } else {
      if (name === 'pushd' || name === 'push-location') this.stack.push(before);
      if (this.kind === 'cmd' && name === 'cd' && args.length === 0) return;
      const word = args.filter((a) => !/^\/d$/i.test(a) && !/^-(path|literalpath|l|p|passthru)$/i.test(a))[0];
      after = this.moved(before, word);
      // cmd's cd without /d to another drive changes that drive's folder, not this one
      const drive = word && /^([a-z]):/i.exec(word);
      if (this.kind === 'cmd' && name === 'cd' && drive && !args.some((a) => /^\/d$/i.test(a)) && before.cwds.some((c) => c[0]?.toLowerCase() !== drive[1]!.toLowerCase())) after = merge(before, after);
    }
    // a target the guard cannot read leaves no known folder at all (a relative word after it is unknown)
    this.where = sure ? after : after.cwds.length ? merge(before, after) : { cwds: [], exact: false };
    if (this.unknown || !after.cwds.length || after.cwds.length >= 8 || after.cwds.some((c) => !this.provenOutside(c))) this.navUnproven = true;
  }

  /** The starting folder, or a folder that is not in, not above and not a protected entry: a `cd` there leaves the next call's relative words alone. */
  private provenOutside(cwd: string): boolean {
    try {
      const same = (p: string): string => (WIN ? P.resolve(p).toLowerCase() : foldCase(P.resolve(p)));
      if (same(cwd) === same(this.ctx.start)) return true;
      const c = canonicalLocal(cwd, { cwd: this.ctx.start });
      return !/~\d[\\/]/.test(c) && !hitsCanonical(c, this.ctx.canon, true);
    } catch { return false; }
  }

  private segment(seg: Tok[], next: Op | undefined): void {
    const words: Tok[] = [];
    const outs: Tok[] = [];
    const docs: Tok[] = [];
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i]!;
      if (t.op === '>') { const n = seg[i + 1]; if (n && !n.op) { outs.push(n); i++; } continue; }
      if (t.op === '<') continue; // what follows is read like any other word
      if (t.doc) { docs.push(t); continue; }
      words.push(t);
    }
    // substitutions run first (a subshell in sh)
    for (const t of seg) for (const s of t.subs ?? []) this.child(s, this.kind, this.kind === 'sh');
    for (const o of outs) {
      if (/^(\/dev\/null|nul|\$null)$/i.test(o.text)) continue;
      const h = this.probe(o, this.where);
      if (h === 'names') this.redir = true; else if (h === 'hidden') this.redirHidden = true;
    }
    let k = 0;
    const assigns: Tok[] = [];
    while (k < words.length) {
      const w = words[k]!.text; const lw = w.toLowerCase();
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { assigns.push({ text: w.slice(w.indexOf('=') + 1) }); k++; continue; }
      if ((SKIP_WORDS.has(lw) && !(this.kind === 'pwsh' && lw === 'start')) || w === '&' || w === '.') {
        k++;
        while (k < words.length && words[k]!.text.startsWith('-') && lw !== 'if' && lw !== '!') k++;
        continue;
      }
      break;
    }
    for (const a of assigns) this.note(this.probe(a, this.where));
    const head = words[k]?.text.replace(/^[{(]+/, '') ?? '';
    const name = head.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
    const args = words.slice(k + 1);
    if (k >= words.length) { this.docs(docs, ''); return; } // only assignments: nothing runs
    if (NAV.has(name)) { this.nav(name, args.map((a) => a.text), next); return; }
    if (this.kind === 'sh' && name === 'for') {
      const v = args[0]?.text; const i = args.findIndex((a) => a.text === 'in');
      const vals = i >= 0 ? args.slice(i + 1).map((a) => a.text) : [];
      if (v && /^[A-Za-z_]\w*$/.test(v) && vals.length && vals.every((x) => !hasHiddenVar(x)) && !args.some((a) => a.subs)) this.loops.set(v, vals);
      return;
    }
    if (NEUTRAL.has(name)) return;

    let ro = false;
    let base = this.where;
    const skip = new Set<number>();
    const textOnly = new Set<number>();
    if (name === 'git') {
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i]!.text;
        if (a === '-C') { const d = args[i + 1]; if (d) base = this.moved(base, d.text); i++; continue; }
        if (a === '-c' || a === '--exec-path' || a === '--namespace') { skip.add(i + 1); i++; continue; }
        if (a.startsWith('-')) continue;
        break;
      }
      const sub = args[i]?.text.toLowerCase();
      ro = sub !== undefined && GIT_READ.has(sub) && !args.some((a) => /^--output(=|$)/.test(a.text));
      // a message is text, not a path
      for (let j = i + 1; j < args.length; j++) {
        const a = args[j]!.text;
        if (/^-[A-Za-z]*m$/.test(a) || a === '--message') skip.add(j + 1);
        else if (/^--message=/.test(a) || /^-m./.test(a)) skip.add(j);
      }
      // a writing git command works on its whole folder
      if (!ro) this.note(this.probe({ text: '.' }, base));
    } else if (SHELLS.has(name)) {
      const t = this.shellText(name, args);
      if (t === null) { this.unknown = true; }
      else if (t) { this.child(t.text, t.kind, true); for (const i of t.used) skip.add(i); }
    } else if (name === 'iex' || name === 'invoke-expression') {
      const parts = args.filter((a) => !/^-command$/i.test(a.text));
      this.child(parts.map((a) => a.text).join(' '), 'pwsh', false);
    } else if (name === 'start-process' || name === 'saps' || (this.kind === 'pwsh' && name === 'start')) {
      let prog = ''; const list: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!.text;
        if (/^-(filepath|f)$/i.test(a)) { prog = args[i + 1]?.text ?? ''; i++; continue; }
        if (/^-(argumentlist|args)$/i.test(a)) { for (let j = i + 1; j < args.length && !args[j]!.text.startsWith('-'); j++) list.push(...args[j]!.text.split(',')); continue; }
        if (!a.startsWith('-') && !prog) prog = a;
      }
      if (prog) this.child(`${prog} ${list.join(' ')}`, 'pwsh', true);
    } else if (ONELINERS.has(name)) {
      for (let i = 0; i < args.length; i++) if (/^(-e|-c|-p|--eval|-pe|-ne|-le)$/.test(args[i]!.text) && args[i + 1]) { this.script(args[i + 1]!.text); skip.add(i + 1); }
    } else if (ECHOS.has(name)) {
      ro = outs.length === 0;
      args.forEach((_a, i) => textOnly.add(i));
    } else if (READERS.has(name)) {
      ro = !(name === 'rg' && args.some((a) => a.text.startsWith('--pre')));
    }
    this.docs(docs, name);
    if (!ro) this.allRead = false;
    // every word (the command word too) is read against the protected set
    this.note(this.probe(words[k]!, this.where));
    args.forEach((a, i) => {
      if (skip.has(i)) return;
      if (this.kind === 'cmd' && /^\/[a-z?]{1,2}$/i.test(a.text)) return; // /s /q /y /d /J
      this.note(this.probe(a, base, textOnly.has(i)));
    });
    // a link's target may be relative to the link, not to the folder the command runs in
    if (LINKERS.has(name) && base.cwds.length) {
      const paths = args.filter((a) => !a.text.startsWith('-') && !/^\/[a-z]$/i.test(a.text));
      for (const link of paths) {
        let at: string[];
        try { at = base.cwds.map((c) => dirname(P.resolve(c, expand(link.text, this.ctx.get)))); } catch { continue; }
        for (const other of paths) if (other !== link && !P.isAbsolute(other.text)) this.note(this.probe(other, { cwds: uniq(at), exact: base.exact }));
      }
    }
  }

  /** Heredoc bodies: commands for a shell, code for an interpreter, otherwise text (its `$(...)` still runs). */
  private docs(docs: Tok[], name: string): void {
    for (const d of docs) {
      if (SHELLS.has(name)) { this.child(d.text, name === 'cmd' ? 'cmd' : name === 'powershell' || name === 'pwsh' ? 'pwsh' : 'sh', true); continue; }
      if (ONELINERS.has(name)) { this.allRead = false; this.script(d.text); continue; }
      for (const t of tokenize(d.text, 'sh')) for (const s of t.subs ?? []) this.child(s, 'sh', true);
      this.note(this.probe(d, this.where, true));
    }
  }

  /** The command text a shell is given (`-c`, `/c`, `-Command`); null for an encoded command (it cannot be read). */
  private shellText(name: string, args: Tok[]): { text: string; kind: ShellKindName; used: number[] } | null | undefined {
    const idx = (from: number): number[] => args.map((_a, i) => i).filter((i) => i >= from);
    if (name === 'cmd') {
      const i = args.findIndex((a) => /^\/[ckr]$/i.test(a.text));
      return i >= 0 ? { text: args.slice(i + 1).map((a) => a.text).join(' '), kind: 'cmd', used: idx(i + 1) } : undefined;
    }
    if (name === 'bash' || name === 'sh' || name === 'zsh') {
      const i = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
      return i >= 0 && args[i + 1] ? { text: args[i + 1]!.text, kind: 'sh', used: [i + 1] } : undefined;
    }
    for (const a of args) {
      const s = a.text.replace(/^[-/]/, '').toLowerCase();
      if (/^[-/]/.test(a.text) && (s === 'e' || s === 'ec' || (s.length >= 2 && 'encodedcommand'.startsWith(s)))) return null;
    }
    const i = args.findIndex((a) => { const s = a.text.replace(/^[-/]/, '').toLowerCase(); return /^[-/]/.test(a.text) && (s === 'c' || (s.length >= 3 && 'command'.startsWith(s))); });
    if (i >= 0) return { text: args.slice(i + 1).map((a) => a.text).join(' '), kind: 'pwsh', used: idx(i + 1) };
    return undefined;
  }

  /** A one-liner or here-doc for an interpreter (`node -e`, `python -c`): look for protected paths in its text. */
  private script(code: string): void {
    this.allRead = false;
    const matches = [...code.matchAll(/[A-Za-z]:[\\/][^'"`\s)]*|(?:\.{1,2}|~)?[\\/][^'"`\s)]+|\.\.?[\\/]|~[^'"`\s)]*/g)];
    const found = matches.map((m) => m[0]);
    for (const m of matches) {
      const text = m[0].replace(/\\\\/g, '\\');
      // Only backslashes: an escape in the code (a line that continues, "\\n" or "\\\\" inside a longer string) is not a path. But a backslash that
      // stands alone in quotes, as in rmtree('\\') or Perl's q(\\), is the root of the drive: that one still counts.
      if (/^\\+$/.test(text)) {
        const before = code[m.index - 1], after = code[m.index + m[0].length];
        if (!(before !== undefined && after === (QUOTE_CLOSE[before] ?? null))) continue;
      }
      this.note(this.probe({ text }, this.where));
    }
    if (!this.names && !found.some((f) => /^[A-Za-z]:[\\/]/.test(f)) && (HOME_MARKERS.test(code) || (BUILD_MARKERS.test(code) && this.namesProtected(code)))) this.hidden = true;
  }

  /** The code names a protected file or folder, or the folder that holds it, by its own name (`"projects.json"`, `/ "gates"`, `"legion"`). */
  private namesProtected(code: string): boolean {
    const low = code.toLowerCase();
    const names = new Set<string>();
    for (const t of this.ctx.set) for (const n of t.split(/[\\/]+/).filter(Boolean).slice(-2)) names.add(n.toLowerCase());
    return [...names].some((n) => new RegExp(`(?:^|[^\\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(low));
  }
}

/**
 * @param protectedSet the protected files and folders (`protectedTargets(...)`): one set for the file tools and the shell
 * @param opts.cwd the folder the run's shell starts in (relative paths are read from here)
 */
export function dataFolderHit(command: string, kind: ShellKindName, protectedSet: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; cwdUnknown?: boolean } = {}): FolderHit {
  return dataFolderRead(command, kind, protectedSet, opts).hit;
}

/**
 * Like `dataFolderHit`, and says whether the line ran a `cd` the guard cannot prove ends outside the protected set (`moved`).
 * Claude Code's shell keeps its folder between calls, so the engine remembers `moved` for the rest of the run and passes it back as
 * `opts.cwdUnknown`: a relative word in a command that writes is then unknown (`hidden`). `cwds` is the folder (or folders) the shell may be in
 * after the line; the engine passes it back as `opts.cwds`, so the next call is read from where the shell now is.
 */
export function dataFolderRead(command: string, kind: ShellKindName, protectedSet: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; cwdUnknown?: boolean; cwds?: string[] } = {}): { hit: FolderHit; moved: boolean; cwds: string[] } {
  const home = (() => { try { return homedir(); } catch { return ''; } })();
  const get = lookup(opts.env ?? process.env, home);
  const start = opts.cwd ?? process.cwd();
  const ctx: Ctx = { start, cwdUnknown: opts.cwdUnknown === true, set: protectedSet, canon: canonicalSet(protectedSet), get, home: get('userprofile') ?? home, ids: {}, memo: new Map() };
  const r = new Reader(ctx, { cwds: opts.cwds?.length ? uniq([...opts.cwds]) : [start], exact: !opts.cwds || opts.cwds.length <= 1 }, kind, 0);
  r.text(command);
  return { hit: r.result(), moved: r.navUnproven, cwds: r.where.cwds };
}
