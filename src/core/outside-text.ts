/**
 * When does a tool call bring text in that somebody else wrote? Two kinds of call decide it:
 *
 *  - a shell command: it brings outside text in when it reaches the network, when Legion cannot read it with certainty, or when it
 *    reads a file outside the project. A local command in the project (git status, a search, a test run) does not. The command is
 *    judged by the same classifier the approval cards use (`classifySafe`), which fails closed: a compound, wrapped or
 *    unparseable command is unknown, and unknown counts as outside. Strict mode keeps the older rule: every shell command counts.
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
import { classifySafe } from '../shared/consequence.js';

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
  /** A run that read outside text left files in the project folder: a test or build run may now run what an injection wrote. */
  markedCode?: boolean;
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

/** Programs that run code given on their own command line (or in a flag): they can do anything, so Legion cannot call the call local. */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python2', 'python3', 'py', 'perl', 'ruby', 'php', 'lua', 'pwsh', 'powershell', 'cmd', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '-r', '-command', '-encodedcommand', '-ec', '/c', '/k', 'eval']);
/** Short flags clustered with e, c, p or r (-pe, -ne, -ce), and the long flags that run or preload code. */
const CODE_CLUSTER = /^-(?!-)[A-Za-z]*[ecpr][A-Za-z]*$/i;
const CODE_LONG = /^--(eval|print|import|require|env-file|loader|experimental-loader|input-type)\b/i;
function runsInlineCode(command: string): boolean {
  const words = command.split(/\s+/).filter(Boolean).map((w) => w.replace(/^["'`]+|["'`]+$/g, ''));
  for (let i = 0; i < words.length; i++) {
    const base = words[i]!.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    if (!INTERPRETERS.has(base) && !INTERPRETERS.has(base.replace(/[\d.]+$/, ''))) continue;
    if (words.slice(i + 1).some((w) => CODE_FLAGS.has(w.toLowerCase()) || CODE_CLUSTER.test(w) || CODE_LONG.test(w))) return true;
  }
  return false;
}

/** A single plain command with nothing that chains, redirects or substitutes. */
const PLAIN = /^[^;&|<>`$()\n\r]+$/;
/** Flags (any spelling, including shortened ones) that make a git call run another program or reach another place. */
const GIT_RUNS_OTHERS_LONG = ['exec', 'interactive', 'upload-pack', 'receive-pack', 'config', 'config-env', 'recurse-submodules', 'recursive'];
/** git takes any unique start of a long option (`--ex` is `--exec`), so every start of a dangerous one counts, as well as the whole word. */
const GIT_RUNS_OTHERS = { test: (w: string): boolean => { const m = /^--([a-z-]+)/i.exec(w); if (!m) return false; const n = m[1]!.toLowerCase(); return GIT_RUNS_OTHERS_LONG.some((d) => d.startsWith(n)); } };
/** Short flags of `git rebase` that run a command (-x) or open an editor (-i), also clustered or with the value attached. */
const REBASE_RUNS = /^-(?!-)[A-Za-z]*[xi]/;
/** Git calls that work on this repository only and bring no text in (no fetch, pull, clone, submodule update, remote reads). */
const LOCAL_GIT = /^git\s+(checkout|switch|stash|restore|reset|rebase|cherry-pick|tag|worktree|rev-parse|ls-files|merge-base|show-ref|describe|reflog)(\s|$)/;
/** gh calls that make or finish our own work: what they print is an address, a status or names we chose, not text another person wrote. */
const LOCAL_GH = /^gh\s+(pr\s+(create|ready|checks)|run\s+(watch|rerun))(\s|$)/;
function knownLocal(command: string): boolean {
  const c = command.trim();
  if (!PLAIN.test(c)) return false;
  const words = c.split(/\s+/);
  if (words.some((w) => GIT_RUNS_OTHERS.test(w))) return false;
  if (/^git\s+rebase(\s|$)/.test(c) && words.slice(2).some((w) => REBASE_RUNS.test(w))) return false;
  return LOCAL_GIT.test(c) || LOCAL_GH.test(c);
}

/**
 * Package runners fetch and run a program from the registry unless it is already installed in the project. Only `npx <program>` (and the
 * exec forms) of a program that sits in a `node_modules/.bin` of the project, with no flag that asks for another package, is local.
 */
function packageRunnerReason(command: string, roots: readonly string[]): string | undefined {
  const words = command.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase();
    const viaManager = (w === 'npm' || w === 'pnpm' || w === 'yarn') && ['exec', 'dlx', 'x'].includes((words[i + 1] ?? '').toLowerCase());
    if (!(w === 'npx' || w === 'pnpx' || w === 'bunx' || viaManager)) continue;
    const may = 'a package runner that may download code';
    if (!PLAIN.test(command)) return may;
    if (viaManager && (words[i + 1] ?? '').toLowerCase() !== 'exec') return may;
    const rest = words.slice(i + (viaManager ? 2 : 1));
    if (rest.some((x) => /^(--yes|-y|-p|--package(=.*)?|--call(=.*)?|-c|--node-options.*)$/i.test(x))) return may;
    const bin = rest.find((x) => !x.startsWith('-'));
    if (!bin || !/^[\w.@-]+$/.test(bin)) return may;
    const local = roots.some((r) => ['', '.cmd', '.ps1'].some((ext) => existsSync(join(r, 'node_modules', '.bin', bin + ext))));
    if (!local) return may;
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

/** Programs that run a project's files: while a marked run has left files in the project they are not trusted. */
const RUNNERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python2', 'python3', 'py', 'perl', 'ruby', 'php', 'lua', 'pwsh', 'powershell', 'bash', 'sh', 'zsh', 'fish', 'cmd', 'npm', 'pnpm', 'yarn', 'npx', 'pnpx', 'bunx', 'make', 'cargo', 'go', 'mvn', 'gradle', 'dotnet', 'tsx', 'ts-node', 'tsc', 'pytest', 'jest', 'vitest', 'mocha', 'java', 'javac', 'rustc', 'gcc', 'cc']);
function runsProjectFiles(command: string): boolean {
  return command.split(/[\s;&|()]+/).some((w) => RUNNERS.has(w.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|ps1)$/, '').replace(/^["'`]+|["'`]+$/g, '')));
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
      if (!input || typeof input.command !== 'string' || !input.command.trim()) return 'a command Legion could not read';
      if (runsInlineCode(input.command)) return 'a command that runs code given on its command line';
      const runner = packageRunnerReason(input.command, c.roots);
      if (runner) return runner;
      const pc: PathCtx = { cwd: c.cwd, roots: c.roots, home: c.home };
      if (c.outsideFiles) {
        if (NAMES_THIRD_PARTY.test(input.command) || searchesEverything(input.command)) return R_THIRD;
        // the host shell can be pointed at another folder with its own cwd field
        if (typeof input.cwd === 'string' && input.cwd) { const r = outsidePathReason(input.cwd, pc); if (r) return r; }
      }
      if (c.markedCode && runsProjectFiles(input.command)) return 'a program run while files written by a run that read outside text are in the project';
      if (knownLocal(input.command)) return undefined;
      if (c.outsideFiles) { const r = pathWordReason(input.command, pc); if (r) return r; }
      const k = classifySafe({ kind: 'approval', toolName: name, input, projectFolders: [...c.roots], home: c.home });
      if (k.tags.includes('net')) return 'a command that reaches the network';
      if (!k.certain || k.tags.includes('unknown')) return 'a command Legion cannot check';
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
