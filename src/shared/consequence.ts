/**
 * What happens if the owner says yes to this ask: a level, tags and a short chip. Pure and fail-safe.
 *
 * Levels: 0 a decision with no side effect beyond the answer; 1 read-only inside the project; 2 a reversible local change or an
 * untrusted proposal; 3 irreversible, leaves your computer, spends money, or UNKNOWN.
 *
 * Fail-safe rules (spec 4.10, 5.3):
 *  - Unknown is level 3, tag 'unknown', certain false. A tool name or shell program with no rule, an unparseable command, a command
 *    the shell floor refuses or cannot read, input of an unexpected shape: all land there. The rules are DATA (TOOL_RULES,
 *    PROGRAM_RULES), so a missing entry can never lower a level.
 *  - `certain` is what lets the digest offer an inline Allow. Not certain: the row offers Open instead.
 *  - `classify` may throw; callers use `classifySafe`, which maps a throw to unknown.
 */
import { refuseCatastrophic, unjudgeableCommand } from '../core/exec/shell-floor.js';
import { AWAY_COPY } from './away-copy.js';

export type ConsequenceTag = 'spends' | 'leaves' | 'deletes' | 'irreversible' | 'edits' | 'reads' | 'decides' | 'unknown' | 'net' | 'runs-code';
export type ConsequenceLevel = 0 | 1 | 2 | 3;
export interface Consequence { level: ConsequenceLevel; tags: ConsequenceTag[]; chip: string; ing?: string; certain: boolean }

export interface ConsequenceCall {
  kind: 'approval' | 'question' | 'proposal' | 'reads';
  toolName: string;
  input: unknown;
  /** The project's folders. Absent or empty: there is no "inside" to check against. */
  projectFolders?: string[];
}

export const UNKNOWN_CHIP = AWAY_COPY.chip.unknown;
const UNKNOWN: Consequence = { level: 3, tags: ['unknown'], chip: UNKNOWN_CHIP, certain: false };
export const unknownConsequence = (): Consequence => ({ ...UNKNOWN, tags: [...UNKNOWN.tags] });

const C = AWAY_COPY.chip;
const rule = (level: ConsequenceLevel, tags: ConsequenceTag[], chip: string, ing?: string): Consequence => ({ level, tags, chip, certain: true, ...(ing ? { ing } : {}) });
const LEAVES = (ing = 'Sending'): Consequence => rule(3, ['leaves', 'irreversible'], C.leaves, ing);
const DELETES = (): Consequence => rule(3, ['deletes', 'irreversible'], C.deletes, 'Deleting');

/* ---------- paths ---------- */

/** An absolute path in a comparable form (forward slashes, no . or .., lower case for drive paths), or null when it is relative. */
function absolute(p: string): string | null {
  const s = p.replace(/\\/g, '/');
  const drive = /^[a-z]:\//i.test(s);
  if (!drive && !s.startsWith('/')) return null;
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  const joined = (s.startsWith('//') ? '//' : drive ? '' : '/') + out.join('/');
  return drive ? joined.toLowerCase() : joined;
}

/** true inside, false outside, null when it cannot be told (a relative or missing path). */
function insideFolders(path: unknown, folders: readonly string[]): boolean | null {
  if (typeof path !== 'string' || !path) return null;
  const p = absolute(path);
  if (p === null) return null;
  for (const f of folders) {
    const root = absolute(f);
    if (root === null) continue;
    if (p === root || p.startsWith(root.endsWith('/') ? root : root + '/')) return true;
  }
  return false;
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
function pathOf(input: Record<string, unknown>): unknown {
  for (const k of PATH_KEYS) if (typeof input[k] === 'string' && input[k]) return input[k];
  return undefined;
}

/* ---------- shell ---------- */

type Sub = { level: ConsequenceLevel; tags: ConsequenceTag[]; chip: string; ing?: string; /** flags that make the call something else (all lower case). */ flagRules?: Array<{ flags: string[]; to: Consequence }>; /** Any of these flags (prefix match for --long=value) makes the call unknown: it runs something else. */ unknownFlags?: string[]; /** Reads the arguments after the subcommand itself; undefined means "use the rule above". */ inspect?: (args: string[]) => Consequence | undefined };
interface ProgramRule extends Sub {
  /** Per subcommand (git, npm, ...). When present a subcommand with no entry is unknown. */
  subs?: Record<string, Sub>;
}

/** A local build or test run: level 1, tagged `runs-code` so Smart asks for it once an agent changed a build or script file (needsApproval). */
const LOCAL = (): Consequence => rule(1, ['runs-code'], C.localRun);
const LOCALSUB: Sub = { level: 1, tags: ['runs-code'], chip: C.localRun };
const SCRIPTS_OK = /^(test|build|lint|typecheck|check|format)$/;
/** `npm|pnpm|yarn run <script>`: only the listed script names; extra flags or any other name stay unknown. */
const runScript = (args: string[]): Consequence | undefined => {
  const plain = args.filter((a) => a !== '--silent' && a !== '--quiet');
  return plain.length === 1 && SCRIPTS_OK.test(plain[0]!) ? LOCAL() : undefined;
};
const pkgManager = (): ProgramRule => ({ level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--script-shell', '--node-options'], subs: {
  publish: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Publishing' },
  test: LOCALSUB,
  run: { level: 3, tags: [], chip: UNKNOWN_CHIP, inspect: runScript },
} });

const R1: Sub = { level: 1, tags: ['reads'], chip: C.readOnly };
/** git reads that can write a file (--output) or run a configured program (--ext-diff, --textconv). */
const GITREAD: Sub = { level: 1, tags: ['reads'], chip: C.readOnly, unknownFlags: ['--ext-diff', '--textconv'], flagRules: [{ flags: ['--output'], to: { level: 2, tags: ['edits'], chip: C.writesFile, certain: true } }] };
const R2: Sub = { level: 2, tags: ['edits'], chip: C.edits };
/** A git command that talks to a remote: it reaches the network, so Smart asks for it (level 2 stays). */
const NETSUB: Sub = { level: 2, tags: ['net'], chip: C.fetches };

/** A method word that sends data out. */
const WRITE_METHOD = /^(post|put|delete|patch)$/i;

/** A web request leaves your computer: every Consequence a web rule returns carries `net` on top of its own tags (an upload keeps `leaves`). */
const netTagged = (rule: (args: string[]) => Consequence | undefined) => (args: string[]): Consequence | undefined => {
  const c = rule(args);
  return c && { ...c, tags: [...new Set<ConsequenceTag>([...c.tags, 'net'])] };
};

/** curl's options, case sensitive (-d data, -F form, -T upload, -X method), also clustered or attached: `-sSd @f`, `-d@secrets`, `-XPOST`. */
const curlRule = netTagged((args: string[]): Consequence | undefined => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const l = a.toLowerCase();
      if (l === '--request') { if (!/^(get|head)$/i.test(args[i + 1] ?? 'get')) return LEAVES(); continue; }
      if (l.startsWith('--request=')) { if (!/^(get|head)$/i.test(l.slice(10))) return LEAVES(); continue; }
      if (/^--(data|form|json|upload-file)/.test(l)) return LEAVES();
      continue;
    }
    if (!a.startsWith('-') || a.length < 2) continue;
    if (/^-[A-Za-z]*[dFT]/.test(a)) return LEAVES();
    const x = a.indexOf('X');
    if (x > 0) {
      const attached = a.slice(x + 1);
      if (!/^(get|head)$/i.test(attached || args[i + 1] || 'get')) return LEAVES();
    }
  }
  return undefined;
});

/** wget's options that send a body or use another method. */
const wgetRule = netTagged((args: string[]): Consequence | undefined => {
  for (let i = 0; i < args.length; i++) {
    const l = args[i]!.toLowerCase();
    if (/^--(post|body)-(data|file)/.test(l)) return LEAVES();
    if (l === '--method') { if (!/^(get|head)$/i.test(args[i + 1] ?? 'get')) return LEAVES(); continue; }
    if (l.startsWith('--method=')) { if (!/^(get|head)$/i.test(l.slice(9))) return LEAVES(); continue; }
  }
  return undefined;
});

/** PowerShell's web cmdlets (and the aliases curl and wget are there): parameters may be shortened (-me Post). */
const pwshWebRule = netTagged((args: string[]): Consequence | undefined => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (/^-me(t(h(o(d)?)?)?)?$/i.test(a)) { if (!/^(get|head)$/i.test(args[i + 1] ?? 'get')) return LEAVES(); continue; }
    if (/^-(b|bo|bod|body|in|inf|infi|infil|infile|fo|for|form)$/i.test(a)) return LEAVES();
  }
  return undefined;
});

const webRule = (args: string[]): Consequence | undefined => curlRule(args) ?? wgetRule(args) ?? pwshWebRule(args);

/** Does the argument list carry this flag (lower case)? A short flag also matches clustered or attached (-ro, -ofile); a long one with =value. */
const hasFlag = (lowered: readonly string[], f: string): boolean =>
  lowered.some((a) => a === f || (f.length > 2 ? a.startsWith(f + '=') : /^-[a-z]$/.test(f) && /^-[^-]/.test(a) && a.includes(f[1]!)));

const positional = (args: readonly string[]): string[] => args.filter((a) => !a.startsWith('-'));
const WRITES = (): Consequence => rule(2, ['edits'], C.writesFile);

/** Shell programs by lower-case name (no path, no .exe). A program not here is unknown. */
export const PROGRAM_RULES: Record<string, ProgramRule> = {
  // read only
  ls: R1, dir: R1, pwd: R1, cat: R1, type: R1, head: R1, tail: R1, wc: R1, grep: R1, stat: R1, du: R1, df: R1,
  whoami: R1, which: R1, where: R1, echo: R1, printf: R1, cut: R1, basename: R1, dirname: R1, realpath: R1, uname: R1,
  'get-childitem': R1, gci: R1, 'get-content': R1, gc: R1, 'get-location': R1, 'select-string': R1, sls: R1, 'measure-object': R1,
  'write-output': R1, 'write-host': R1, 'test-path': R1, cd: R1, 'set-location': R1,
  rg: { ...R1, unknownFlags: ['--pre', '--pre-glob'] },
  fd: { ...R1, unknownFlags: ['-x', '-X', '--exec', '--exec-batch'] },
  sort: { ...R1, unknownFlags: ['--compress-program'], flagRules: [{ flags: ['-o', '--output'], to: WRITES() }] },
  date: { ...R1, unknownFlags: ['-s', '--set'], inspect: (a) => (positional(a).some((p) => /^\d{8,12}(\.\d\d)?$/.test(p)) ? unknownConsequence() : undefined) },
  find: { ...R1, unknownFlags: ['-exec', '-execdir', '-ok', '-okdir'], flagRules: [{ flags: ['-delete'], to: DELETES() }, { flags: ['-fprint', '-fprint0', '-fprintf', '-fls'], to: WRITES() }] },
  tree: { ...R1, flagRules: [{ flags: ['-o'], to: WRITES() }] },
  uniq: { ...R1, inspect: (a) => (positional(a).length >= 2 ? WRITES() : undefined) },
  hostname: { ...R1, inspect: (a) => (positional(a).length ? unknownConsequence() : undefined) },
  file: { ...R1, unknownFlags: ['--compile'] },
  // reversible local changes
  mkdir: R2, md: R2, touch: R2, cp: R2, copy: R2, 'copy-item': R2, mv: R2, move: R2, 'move-item': R2, ren: R2, rename: R2, 'rename-item': R2,
  'new-item': R2, 'set-content': R2, 'add-content': R2, 'out-file': R2, chmod: R2,
  tee: { level: 2, tags: ['edits'], chip: C.writesFile },
  // deletes
  rm: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  rmdir: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  rd: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  del: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  erase: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  'remove-item': { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  ri: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  shred: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  unlink: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
  // leaves your computer
  curl: { level: 2, tags: ['net'], chip: C.fetches, inspect: webRule },
  wget: { level: 2, tags: ['net'], chip: C.fetches, inspect: webRule },
  'invoke-webrequest': { level: 2, tags: ['net'], chip: C.fetches, inspect: pwshWebRule },
  iwr: { level: 2, tags: ['net'], chip: C.fetches, inspect: pwshWebRule },
  'invoke-restmethod': { level: 2, tags: ['net'], chip: C.fetches, inspect: pwshWebRule },
  irm: { level: 2, tags: ['net'], chip: C.fetches, inspect: pwshWebRule },
  git: {
    level: 1, tags: ['reads'], chip: C.readOnly,
    subs: {
      status: R1, 'ls-files': R1, 'rev-parse': R1, describe: R1, shortlog: R1,
      log: GITREAD, diff: GITREAD, show: GITREAD, blame: GITREAD,
      add: R2, commit: R2, merge: R2, pull: { ...R2, tags: ['edits', 'net'] }, fetch: NETSUB, clone: NETSUB,
      push: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Pushing' },
      clean: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
      reset: { ...R2, flagRules: [{ flags: ['--hard'], to: DELETES() }] },
    },
  },
  npm: pkgManager(), yarn: pkgManager(), pnpm: pkgManager(),
  npx: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--node-options'], inspect: (a) => (a.length === 2 && a[0] === 'tsc' && a[1] === '--noEmit' ? LOCAL() : undefined) },
  node: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--node-options'], inspect: (a) => (a[0] === '--test' ? LOCAL() : undefined) },
  pytest: { level: 1, tags: ['runs-code'], chip: C.localRun, unknownFlags: ['-p', '--pyargs'] },
  cargo: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--config', '-z'], subs: { publish: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Publishing' }, test: LOCALSUB, build: LOCALSUB, check: LOCALSUB } },
  go: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['-exec', '--exec', '-toolexec', '--toolexec', '-vettool', '--vettool'], subs: { test: LOCALSUB, build: LOCALSUB, vet: LOCALSUB } },
  gh: { level: 3, tags: [], chip: UNKNOWN_CHIP, subs: { release: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Publishing' } } },
};

/** The shell tools: their input.command is read as a shell command. */
const SHELL_TOOL_KIND: Record<string, 'sh' | 'pwsh' | 'either'> = { Bash: 'sh', PowerShell: 'pwsh', Monitor: 'sh', mcp__host__shell: 'either' };

interface Parsed { segments: string[][]; redirects: boolean }

/** Splits a command into segments of words. Null when it cannot be read with certainty (substitutions, groups, open quotes, ...). */
function parseShell(cmd: string): Parsed | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let inWord = false;
  let redirects = false;
  let pendingRedirect = false;
  const endWord = (): boolean => {
    if (!inWord) return true;
    if (cur.startsWith('#')) return false;
    if (pendingRedirect) {
      pendingRedirect = false;
      if (/^(\/dev\/null|nul|&\d)$/i.test(cur)) { cur = ''; inWord = false; return true; }
      redirects = true; cur = ''; inWord = false; return true;
    }
    words.push(cur); cur = ''; inWord = false; return true;
  };
  const endSegment = (): boolean => {
    if (!endWord()) return false;
    if (words.length) segments.push(words);
    words = [];
    return true;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += cmd.slice(i + 1, end); inWord = true; i = end; continue;
    }
    if (ch === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        const c = cmd[j]!;
        if (c === '$' || c === '`') return null;
        if (c === '\\' && j + 1 < cmd.length && (cmd[j + 1] === '"' || cmd[j + 1] === '\\')) { cur += cmd[j + 1]; j++; continue; }
        cur += c;
      }
      if (j >= cmd.length) return null;
      i = j; continue;
    }
    if (ch === '$' || ch === '`' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '<') return null;
    if (ch === '\\') { cur += ch; inWord = true; if (cmd[i + 1] === '\n') { cur = cur.slice(0, -1); i++; } continue; }
    if (ch === '>') {
      if (!endWord()) return null;
      while (cmd[i + 1] === '>' || cmd[i + 1] === '&' || cmd[i + 1] === '|') { i++; if (cmd[i] === '&' && /\d/.test(cmd[i + 1] ?? '')) { i++; pendingRedirect = false; } }
      // "2>&1": a redirect into a stream, not a file
      if (cmd[i] === '&' || /&\d/.test(cmd.slice(Math.max(0, i - 1), i + 1))) { continue; }
      pendingRedirect = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') { if (!endWord()) return null; continue; }
    if (ch === '\r' || ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      if (!endSegment()) return null;
      continue;
    }
    cur += ch; inWord = true;
  }
  if (!endSegment()) return null;
  if (pendingRedirect) return null;
  return { segments, redirects };
}

const lc = (s: string): string => s.toLowerCase();

function withTags(base: Sub, certain = true): Consequence {
  return { level: base.level, tags: [...base.tags], chip: base.chip, certain, ...(base.ing ? { ing: base.ing } : {}) };
}

/** One segment's consequence. */
function classifySegment(words: string[]): Consequence {
  const first = words[0]!;
  // a program named by a path, or an assignment before it, could be anything
  if (/[\\/]/.test(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return unknownConsequence();
  const name = lc(first).replace(/\.exe$/, '');
  if (!Object.prototype.hasOwnProperty.call(PROGRAM_RULES, name)) return unknownConsequence();
  const pr = PROGRAM_RULES[name]!;
  let args = words.slice(1);
  const lowered = args.map(lc);
  if (pr.unknownFlags?.some((f) => hasFlag(lowered, f))) return unknownConsequence();
  let base: Sub = pr;
  if (pr.subs) {
    // git: options before the subcommand are skipped when they are the harmless kind
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) {
      const a = lc(args[i]!);
      // -C changes the folder; -c sets a config value that can name a program to run (core.pager, an alias): unknown
      if (name === 'git' && args[i] === '-C') { i += 2; continue; }
      if (name === 'git' && a === '--no-pager') { i++; continue; }
      if (name !== 'git' && (a === '--silent' || a === '--quiet')) { i++; continue; }
      return unknownConsequence();
    }
    const sub = args[i] ? lc(args[i]!) : '';
    if (!sub || !Object.prototype.hasOwnProperty.call(pr.subs, sub)) return unknownConsequence();
    base = pr.subs[sub]!;
    args = args.slice(i + 1);
  }
  const subLowered = args.map(lc);
  if (base.unknownFlags?.some((f) => hasFlag(subLowered, f))) return unknownConsequence();
  const flagged = base.flagRules?.find((r) => r.flags.some((f) => hasFlag(subLowered, f)));
  if (flagged) return { ...flagged.to, tags: [...flagged.to.tags] };
  const inspected = base.inspect?.(args) ?? pr.inspect?.(args);
  if (inspected) return inspected;
  return withTags(base);
}

function combine(parts: Consequence[]): Consequence {
  const worst = Math.max(...parts.map((p) => p.level)) as ConsequenceLevel;
  const top = parts.filter((p) => p.level === worst);
  const uncertain = parts.some((p) => !p.certain);
  const unknown = parts.some((p) => p.tags.includes('unknown'));
  const tags = [...new Set(parts.flatMap((p) => p.tags))];
  const lead = unknown ? parts.find((p) => p.tags.includes('unknown') && p.level === worst) ?? top[0]! : top[0]!;
  return { level: worst, tags, chip: lead.chip, certain: !uncertain, ...(lead.ing && !unknown ? { ing: lead.ing } : {}) };
}

/** Programs whose arguments are text, not paths. */
const TEXT_ARGS: ReadonlySet<string> = new Set(['echo', 'printf', 'write-output', 'write-host', 'pwd', 'whoami', 'hostname', 'uname', 'date']);
/** Programs whose first plain argument is a pattern, not a path. */
const PATTERN_FIRST: ReadonlySet<string> = new Set(['grep', 'rg', 'fd', 'select-string', 'sls']);
/** Places that hold secrets: reading them is never "read only, inside this project", wherever they are. */
const SECRET_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.config[\\/]gcloud|\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|credentials?|secrets?(\.[^\\/]*)?|[^\\/]*\.(pem|key|pfx|p12|kdbx))$/i;
const PATH_LIKE = /^([\\/~.]|[A-Za-z]:)|[\\/]/;

/**
 * A level 1 shell read is only "inside this project" when its path-like arguments are: inside the folders, or a plain relative path.
 * Outside, a secret location, `~`, `..` or a variable cannot be told: level 2 and not certain (never lower than the file tools).
 */
function checkShellReads(c: Consequence, words: string[], folders: readonly string[]): Consequence {
  if (c.level !== 1 || !c.tags.includes('reads')) return c;
  const name = lc(words[0]!).replace(/\.exe$/, '');
  if (TEXT_ARGS.has(name)) return c;
  let skipFirst = PATTERN_FIRST.has(name);
  let verdict: 'ok' | 'outside' | 'unchecked' = 'ok';
  for (const w of words.slice(1)) {
    if (w.startsWith('-')) continue;
    if (skipFirst) { skipFirst = false; continue; }
    if (SECRET_PATH.test(w)) { verdict = 'outside'; break; }
    if (!PATH_LIKE.test(w) && !/[*?]/.test(w)) continue;
    if (w.startsWith('~') || /(^|[\\/])\.\.([\\/]|$)/.test(w) || w === '..' || /[$%]/.test(w)) { verdict = 'unchecked'; continue; }
    const abs = absolute(w);
    if (abs === null) continue; // a plain relative path stays where the command runs
    const inside = insideFolders(w, folders);
    if (inside !== true) { verdict = verdict === 'outside' ? 'outside' : inside === false ? 'outside' : 'unchecked'; }
  }
  if (verdict === 'ok') return c;
  return { level: 2, tags: ['reads'], chip: verdict === 'outside' ? C.readsOutside : C.readsUnchecked, certain: false };
}

function classifyShell(toolName: string, input: unknown, folders: readonly string[] = []): Consequence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return unknownConsequence();
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string' || !command.trim()) return unknownConsequence();
  // never looser than the floor: a command it refuses or cannot read is unknown
  const kinds = SHELL_TOOL_KIND[toolName] === 'either' ? (['sh', 'pwsh'] as const) : ([SHELL_TOOL_KIND[toolName] ?? 'sh'] as const);
  for (const k of kinds) {
    if (refuseCatastrophic(command, k) || unjudgeableCommand(command, k)) return unknownConsequence();
  }
  const parsed = parseShell(command);
  if (!parsed || !parsed.segments.length) return unknownConsequence();
  const parts = parsed.segments.map((w) => checkShellReads(classifySegment(w), w, folders));
  if (parsed.redirects) parts.push(rule(2, ['edits'], C.writesFile));
  return combine(parts);
}

/* ---------- tools ---------- */

type ToolRule = { read?: true; edit?: true; shell?: true } & Partial<Pick<Consequence, 'level' | 'tags' | 'chip' | 'ing'>>;
/** Claude Code and Legion tools by exact name. A tool not here is unknown. */
export const TOOL_RULES: Record<string, ToolRule> = {
  Read: { read: true }, Glob: { read: true }, Grep: { read: true }, LS: { read: true },
  Write: { edit: true }, Edit: { edit: true }, MultiEdit: { edit: true }, NotebookEdit: { edit: true },
  Bash: { shell: true }, PowerShell: { shell: true }, Monitor: { shell: true }, mcp__host__shell: { shell: true },
  WebFetch: { level: 3, tags: ['leaves'], chip: C.leaves },
  WebSearch: { level: 3, tags: ['leaves'], chip: C.leaves },
};

function classifyTool(call: ConsequenceCall): Consequence {
  const name = call.toolName;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(TOOL_RULES, name)) return unknownConsequence();
  const tr = TOOL_RULES[name]!;
  const folders = (call.projectFolders ?? []).filter((f) => typeof f === 'string' && f);
  if (tr.shell) return classifyShell(name, call.input, folders);
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return unknownConsequence();
  const input = call.input as Record<string, unknown>;
  if (tr.read) {
    // nothing to be inside of: never certain
    if (!folders.length) return { ...rule(1, ['reads'], C.readOnlyNoProject), certain: false };
    const target = pathOf(input);
    const where = insideFolders(target, folders);
    // a secret location is never "read only, inside this project", even inside it (same rule as shell reads)
    if (typeof target === 'string' && SECRET_PATH.test(target)) return { ...rule(2, ['reads'], C.readsOutside), certain: false };
    if (where === true) return rule(1, ['reads'], C.readOnly);
    if (where === false) return { ...rule(2, ['reads'], C.readsOutside), certain: false };
    return { ...rule(2, ['reads'], C.readsUnchecked), certain: false };
  }
  if (tr.edit) {
    if (!folders.length) return { level: 3, tags: ['edits'], chip: C.editsOutside, certain: false };
    const where = insideFolders(pathOf(input), folders);
    if (where === true) return rule(2, ['edits'], C.edits);
    return { level: 3, tags: ['edits'], chip: C.editsOutside, certain: false };
  }
  return { level: tr.level ?? 3, tags: [...(tr.tags ?? ['unknown'])], chip: tr.chip ?? UNKNOWN_CHIP, certain: true, ...(tr.ing ? { ing: tr.ing } : {}) };
}

/** The consequence of one ask. May throw; use `classifySafe` where a throw must not escape. */
export function classify(call: ConsequenceCall): Consequence {
  if (call.kind === 'question') return rule(0, ['decides'], C.decides);
  if (call.kind === 'proposal') return rule(2, ['edits'], C.proposal);
  if (call.kind === 'reads') return rule(1, ['reads'], C.readOnly);
  return classifyTool(call);
}

/** `classify`, with any throw mapped to unknown. The core and the app call this one. */
export function classifySafe(call: ConsequenceCall): Consequence {
  try { return classify(call); } catch { return unknownConsequence(); }
}
