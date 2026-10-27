/**
 * When does a tool call bring text in that somebody else wrote? Two kinds of call decide it:
 *
 *  - a shell command: it brings outside text in only when it fetches text (`curl`, `wget`, a `gh` read of an issue, a pull request, a run log or the
 *    API), or when its words name a place outside the project (a file outside it, third-party code, a cloned repository). Running a program does
 *    not: a test, a build, `node -e`, `make` or an unknown tool is judged by what it reads, never by what it is. Strict mode keeps the older rule:
 *    every shell command counts.
 *  - a file read (Read, Grep, Glob, LS, the host read tool): it brings outside text in when the path is outside the project,
 *    inside third-party code (node_modules, vendor, ...), or inside another repository that sits in the project folder (a clone).
 *    The path is resolved through shortcuts (symlinks and junctions) and real file names before it is compared, so a link inside
 *    the project that leads out is judged by where it leads.
 *
 * Every other tool keeps the engine's own rule (`taintsRun`). This module only answers for the tools named above and returns
 * undefined for the rest. The answer is a short reason shown to the owner, or undefined when the call brings nothing in.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type TaintShellMode = 'local' | 'strict';

/** Folders that hold other people's code, whatever the project says. */
const THIRD_PARTY = new Set(['node_modules', 'vendor', 'third_party', 'third-party', 'bower_components', 'site-packages', 'dist-packages', 'pods', 'carthage', '.yarn', '.terraform', '.pnpm-store', '.git']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Monitor', 'mcp__host__shell']);
const FILE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'], Grep: ['path'], Glob: ['path'], LS: ['path'], mcp__host__read_file: ['path'],
};

const R_OUTSIDE = 'a file outside this project';
const R_THIRD = 'third-party code in this project';
const R_REPO = 'another repository inside this project';

/** A file system that does not tell Foo from foo (Windows, macOS): compare lower case. */
const folds = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => (folds ? p.toLowerCase() : p);

/** The real path of a path that may not exist yet: the nearest folder that exists is resolved, the rest is appended as written. */
function realOf(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync.native(cur), ...tail.reverse()); } catch { /* not there yet */ }
    const up = dirname(cur);
    if (up === cur) break;
    tail.push(cur.slice(up.length).replace(/^[\\/]+/, ''));
    cur = up;
  }
  return abs;
}

/** `p` below `root` (or equal): the path from root, or undefined when it is not inside. */
function below(root: string, p: string): string | undefined {
  const rel = relative(norm(root), norm(p));
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel;
}

export interface PathCtx {
  /** Where a relative path starts. */
  cwd: string;
  /** The folders that count as this project (its folder, else the agent's working folder). Empty: nothing is inside. */
  roots: readonly string[];
  /** The owner's home folder: Claude Code's own spill folder is looked for under it (and under CLAUDE_CONFIG_DIR). Absent: there is no spill folder. */
  home?: string;
}

/**
 * The tool-results folder Claude Code spills long output into: `<home>/.claude/projects/<project>/<session>/tool-results/<file>`. What is in it was judged
 * when the tool ran, so reading it back brings nothing new in. Only that exact place counts, never the same layout somewhere else.
 */
function isSpill(real: string, home: string | undefined): boolean {
  const bases = [home ? join(home, '.claude', 'projects') : '', process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : ''].filter(Boolean);
  for (const b of bases) {
    const rel = below(realOf(b), real);
    if (!rel) continue;
    const parts = rel.split(sep).filter(Boolean);
    if (parts.length === 4 && parts[2]!.toLowerCase() === 'tool-results') return true;
  }
  return false;
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * The repository a path belongs to: the nearest folder above it that holds a .git, and the shared git folder. A worktree's .git is a file that
 * points into `<main>/.git/worktrees/<name>`; its shared folder is `<main>/.git`, so the main folder and every worktree of it have the same one.
 * A clone or a submodule has a different one.
 */
function repoOf(real: string): { top: string; common: string } | undefined {
  let dir = isDir(real) ? real : dirname(real);
  for (let i = 0; i < 64; i++) {
    const g = join(dir, '.git');
    let st;
    try { st = statSync(g); } catch { st = undefined; }
    if (st?.isDirectory()) return { top: dir, common: norm(realOf(g)) };
    if (st?.isFile()) {
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
        if (m) {
          const gd = resolve(dir, m[1]!.trim());
          const w = /^(.*)[\\/]worktrees[\\/][^\\/]+$/.exec(gd);
          if (!w) return { top: dir, common: norm(realOf(gd)) };
          // a worktree only when the main repository points back at this very .git file; a planted file that merely names one is its own repository
          let back = false;
          try { back = norm(realOf(resolve(gd, readFileSync(join(gd, 'gitdir'), 'utf8').trim()))) === norm(realOf(g)); } catch { /* nobody points back */ }
          return { top: dir, common: back ? norm(realOf(w[1]!)) : norm(g) };
        }
      } catch { /* an unreadable .git file: treated as its own repository below */ }
      return { top: dir, common: norm(g) };
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** A path under `root` (already known to be below it): is it a first-party file? */
function insideReason(root: string, real: string, rel: string): string | undefined {
  const parts = rel.split(sep).filter(Boolean).map((s) => s.toLowerCase());
  if (parts.some((s) => THIRD_PARTY.has(s))) return R_THIRD;
  // a folder below the root that has its own .git is somebody else's repository (a clone, a submodule), unless it is a worktree of this one
  const mine = repoOf(root);
  let dir = isDir(real) ? real : dirname(real);
  for (let i = 0; i < 64 && below(root, dir) !== undefined && norm(dir) !== norm(root); i++) {
    if (existsSync(join(dir, '.git'))) {
      const theirs = repoOf(dir);
      if (!mine || !theirs || theirs.common !== mine.common) return R_REPO;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Why this path counts as outside text, or undefined when it is a first-party file of the project. Never throws. */
export function outsidePathReason(raw: string, ctx: PathCtx): string | undefined {
  try {
    if (typeof raw !== 'string' || !raw.trim()) return R_OUTSIDE;
    if (raw.startsWith('~')) return R_OUTSIDE;
    const real = realOf(isAbsolute(raw) ? raw : resolve(ctx.cwd, raw));
    if (isSpill(real, ctx.home)) return undefined;
    const roots = ctx.roots.filter(Boolean).map(realOf);
    for (const root of roots) {
      const rel = below(root, real);
      if (rel !== undefined) return insideReason(root, real, rel);
    }
    // not under a project folder: another worktree of the same repository still is the project
    const there = repoOf(real);
    if (there) {
      for (const root of roots) {
        const mine = repoOf(root);
        if (mine && mine.common === there.common) return insideReason(there.top, real, below(there.top, real) ?? '');
      }
    }
    return R_OUTSIDE;
  } catch {
    return R_OUTSIDE;
  }
}

export interface ToolTaintCall extends PathCtx {
  toolName: string;
  input: unknown;
  home: string;
  /** local: judge each command; strict: every shell command counts. */
  shell: TaintShellMode;
  /** Whether a file read outside the project (or in third-party code) counts. */
  outsideFiles: boolean;
}

/** Tools that hand back the output of a shell command that already started: judged when it started. */
const BACKGROUND_SHELL_TOOLS: ReadonlySet<string> = new Set(['BashOutput', 'KillShell', 'TaskOutput']);

/** Whether this module answers for the tool (shell commands, file reads, background shell output). Every other tool keeps the engine's own rule. */
export function judgesTool(name: string): boolean {
  return SHELL_TOOLS.has(name) || BACKGROUND_SHELL_TOOLS.has(name) || Object.prototype.hasOwnProperty.call(FILE_TOOLS, name);
}

/**
 * Words in a command that name a place, resolved like a file path would be: a shortcut that leads out, a clone, third-party code. A word with a
 * `/` or `\` in it is a path; a bare word counts when something of that name exists in the working folder (`rg foo jn`, `cd clone2`).
 */
function pathWordReason(command: string, ctx: PathCtx): string | undefined {
  let checked = 0;
  for (const raw of command.split(/\s+/)) {
    const w = raw.replace(/^["'`]+|["'`;]+$/g, '').replace(/^\d*[<>]+&?/, '');
    if (!w || w.startsWith('-') || w.includes('://') || w.includes('$') || /[*?[{]/.test(w)) continue;
    if (/^\/dev\/(null|stdin|stdout|stderr)$/.test(w)) continue;
    if (!/[\\/]/.test(w) && !existsSync(resolve(ctx.cwd, w))) continue;
    if (++checked > 600) return 'a command with more paths than Legion checks';
    const r = outsidePathReason(w, ctx);
    if (r) return r;
  }
  return undefined;
}

/** A command that names code somebody else wrote (a dependency folder, a submodule's git data). */
const NAMES_THIRD_PARTY = /(^|[\s"'=/\\])(node_modules|vendor|third_party|third-party|bower_components|site-packages|dist-packages|pods|carthage|\.yarn|\.terraform|\.pnpm-store)([\s"'/\\]|$)|\.git[\\/]/i;

/** ripgrep with its ignore rules off searches the dependency folders too. */
function searchesEverything(command: string): boolean {
  const words = command.split(/\s+/);
  const i = words.findIndex((w) => /^rg(\.exe)?$/i.test(w));
  return i >= 0 && words.slice(i + 1).some((w) => /^-(?!-)[A-Za-z]*u+$/.test(w) || /^--(no-ignore|unrestricted|hidden)/i.test(w));
}

/**
 * Commands whose output IS text somebody else wrote: fetchers that print a page, and the `gh` verbs that read issues, pull requests, discussions,
 * logs or the API. Running any other program never brings outside text in by itself: it is not judged by what it is, only by what it reads.
 * `gh pr create`, `checks`, `run watch` and `run rerun` print an address or a status we chose, so they are not here.
 */
const FETCHERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'aria2c', 'start-bitstransfer', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'telnet']);
/** A fetch spelled inside a one-liner, or `certutil -urlcache`: the words give it away even though the program is not a fetcher by name. */
const FETCH_WORDS = /DownloadString|DownloadFile|Net\.WebClient|-urlcache/i;
const GH_READS = /(?:^|[ \t;&|(])gh[ \t]+(?:(?:issue|pr|release|discussion|gist)[ \t]+(?:view|list|diff)|api|search)(?:[ \t]|$)|(?:^|[ \t;&|(])gh[ \t]+run[ \t]+view[^;&|]*--log/i;
function readsOutsideText(command: string): boolean {
  if (GH_READS.test(command) || FETCH_WORDS.test(command)) return true;
  const bare = (w: string): string => w.replace(/^["'`]+|["'`]+$/g, '').split('\\').join('/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|ps1)$/, '');
  return command.split(/[\s;&|()`$<>]+/).some((w) => FETCHERS.has(bare(w)));
}

/** The text of the first of these fields that holds a string. */
function firstString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  return undefined;
}

/** The part of a Glob pattern that is a folder, when the pattern starts at an absolute path or `~`. */
function patternBase(pattern: string): string | undefined {
  const p = pattern.replace(/\\/g, '/');
  if (!(p.startsWith('/') || p.startsWith('~') || /^[a-z]:\//i.test(p))) return undefined;
  const cut = p.search(/[*?[{]/);
  return cut < 0 ? p : p.slice(0, cut);
}

/** Why this call brings outside text in, or undefined when it does not (or when this module does not judge the tool). */
export function toolTaintReason(c: ToolTaintCall): string | undefined {
  try {
    const name = c.toolName;
    if (BACKGROUND_SHELL_TOOLS.has(name)) return c.shell === 'strict' ? 'a shell command (strict mode)' : undefined;
    if (SHELL_TOOLS.has(name)) {
      if (c.shell === 'strict') return 'a shell command (strict mode)';
      const input = c.input && typeof c.input === 'object' && !Array.isArray(c.input) ? c.input as Record<string, unknown> : undefined;
      if (!input || typeof input.command !== 'string' || !input.command.trim()) return undefined;
      const pc: PathCtx = { cwd: c.cwd, roots: c.roots, home: c.home };
      if (c.outsideFiles) {
        if (NAMES_THIRD_PARTY.test(input.command) || searchesEverything(input.command)) return R_THIRD;
        // the host shell can be pointed at another folder with its own cwd field
        if (typeof input.cwd === 'string' && input.cwd) { const r = outsidePathReason(input.cwd, pc); if (r) return r; }
        const r = pathWordReason(input.command, pc);
        if (r) return r;
      }
      if (readsOutsideText(input.command)) return 'a command that reads text from the web or GitHub';
      return undefined;
    }
    const fields = Object.prototype.hasOwnProperty.call(FILE_TOOLS, name) ? FILE_TOOLS[name] : undefined;
    if (!fields) return undefined;
    if (!c.outsideFiles) return undefined;
    const input = c.input && typeof c.input === 'object' && !Array.isArray(c.input) ? c.input as Record<string, unknown> : undefined;
    if (!input) return R_OUTSIDE;
    const ctx: PathCtx = { cwd: c.cwd, roots: c.roots, home: c.home };
    if (name === 'Grep' && typeof input.glob === 'string' && NAMES_THIRD_PARTY.test(input.glob)) return R_THIRD;
    if (name === 'Read' || name === 'mcp__host__read_file') {
      const p = firstString(input, fields);
      return p === undefined ? R_OUTSIDE : outsidePathReason(p, ctx);
    }
    // Grep, Glob, LS: no path means the working folder; a Glob pattern that starts at an absolute folder counts as that folder
    const p = firstString(input, fields);
    if (p !== undefined) { const r = outsidePathReason(p, ctx); if (r) return r; }
    if (name === 'Glob' && typeof input.pattern === 'string') {
      const base = patternBase(input.pattern);
      if (base !== undefined) { const r = outsidePathReason(base, ctx); if (r) return r; }
    }
    return undefined;
  } catch {
    return 'a call Legion could not check';
  }
}
