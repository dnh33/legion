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
import { unwrapAll, unwrapCommand } from './shell-wrappers.js';

export type ConsequenceTag = 'spends' | 'leaves' | 'deletes' | 'irreversible' | 'edits' | 'reads' | 'decides' | 'unknown' | 'net' | 'runs-code';
export type ConsequenceLevel = 0 | 1 | 2 | 3;
export interface Consequence { level: ConsequenceLevel; tags: ConsequenceTag[]; chip: string; ing?: string; certain: boolean }

export interface ConsequenceCall {
  kind: 'approval' | 'question' | 'proposal' | 'reads';
  toolName: string;
  input: unknown;
  /** The project's folders. Absent or empty: there is no "inside" to check against. */
  projectFolders?: string[];
  /** The home folder, so a `~` in a shell write target can be placed. Absent: such a target counts as outside. */
  home?: string;
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

type Sub = { level: ConsequenceLevel; tags: ConsequenceTag[]; chip: string; ing?: string; /** flags that make the call something else (all lower case). */ flagRules?: Array<{ flags: string[]; to: Consequence }>; /** Any of these flags (prefix match for --long=value) makes the call unknown: it runs something else. */ unknownFlags?: string[]; /** Like unknownFlags, but each is matched whole and case sensitive (or as --name=value): for single-dash long flags, where a short one would match a cluster. */ exactFlags?: string[]; /** Reads the arguments after the subcommand itself; undefined means "use the rule above". `w` says where the command runs and what is inside the project. */ inspect?: (args: string[], w: Where) => Consequence | undefined };
interface ProgramRule extends Sub {
  /** Per subcommand (git, npm, ...). When present a subcommand with no entry is unknown. */
  subs?: Record<string, Sub>;
}

/** A local build or test run: level 1, tagged `runs-code` so Smart asks for it once an agent changed a build or script file (needsApproval). */
const LOCAL = (): Consequence => rule(1, ['runs-code'], C.localRun);
const LOCALSUB: Sub = { level: 1, tags: ['runs-code'], chip: C.localRun };
const SCRIPTS_OK = /^(test|build|lint|typecheck|check|format)(:(ts|js|ui|types|unit|run|app|core|server|client|css|fix))?$/;
/** `npm|pnpm|yarn run <script>`: only the listed script names (and the plain parts of a project they commonly take, `build:ts`); extra flags or any other name stay unknown. */
const runScript = (args: string[]): Consequence | undefined => {
  const plain = args.filter((a) => a !== '--silent' && a !== '--quiet');
  return plain.length === 1 && SCRIPTS_OK.test(plain[0]!) ? LOCAL() : undefined;
};
/** Where a shell command runs: the project's folders, the home folder if known, and whether the folder it runs in is still the project (no `cd` away). */
interface Where { folders: readonly string[]; home?: string; cwdOk: boolean }

/**
 * Is this word a place inside the project? A plain relative path stays where the command runs, so it counts while `cwdOk`. Everything the check
 * cannot read counts as outside: no folders known, a `..` step, a variable, a glob (unless `glob`), a drive-relative name, `~user`, `~` with no home known.
 */
function insideWord(word: string, w: Where, glob = false): boolean {
  if (!word || !w.folders.length) return false;
  // `*` and `?` are read only for a path a program expands itself (a test file pattern), and never as `.*` (it can match `..`)
  const wild = glob && !/(^|[\\/])\.[*?]/.test(word) ? word.replace(/[*?]/g, 'x') : word;
  if (/[*?[\]{}%$`]/.test(wild) || /^[a-z]:(?![\\/])/i.test(word)) return false;
  let p = word;
  if (p.startsWith('~')) {
    if (!/^~([\\/]|$)/.test(p) || !w.home) return false;
    p = w.home + p.slice(1);
  }
  if (absolute(p) !== null) return insideFolders(p, w.folders) === true;
  return w.cwdOk && !p.replace(/\\/g, '/').split('/').includes('..');
}

/** `npm|pnpm|yarn test` with nothing after it (or only --silent/--quiet): a flag such as --prefix, --dir or --cwd would run another folder's script. */
const bareTest = (args: string[]): Consequence | undefined => (args.some((a) => a !== '--silent' && a !== '--quiet') ? unknownConsequence() : undefined);
/**
 * A local build or test run whose path words must stay in the project: every plain word, and the value of each of `pathFlags` (they write a file
 * wherever they point). One that is outside or unreadable makes the call unknown. Words after `--` go to the program that is run, not to this one.
 */
const localRun = (pathFlags: readonly string[] = []) => (args: string[], w: Where): Consequence | undefined => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flag = (eq < 0 ? a : a.slice(0, eq)).replace(/^--/, '-');
      if (pathFlags.includes(flag)) { const v = eq < 0 ? args[++i] : a.slice(eq + 1); if (v === undefined || !insideWord(v, w)) return unknownConsequence(); }
      continue;
    }
    if (!insideWord(a, w, true)) return unknownConsequence();
  }
  return undefined;
};

/** The only `node --test` options a run may carry; each takes a value (`=v` or the next word) that must have this shape. A reporter is a built-in one: any other name loads a file. */
const NODE_TEST_FLAGS: Record<string, RegExp> = { '--test-name-pattern': /^/, '--test-reporter': /^(spec|tap|dot|junit|lcov)$/, '--test-concurrency': /^\d+$/, '--test-timeout': /^\d+$/ };
/** `node --test` runs test files: level 1 only with plain paths inside the project and the options above. -r, --import, --loader, --env-file, --inspect and every other flag run something else. */
const nodeTest = (args: string[], w: Where): Consequence | undefined => {
  if (args[0] !== '--test') return undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--test-only') continue;
    if (!a.startsWith('-')) { if (!insideWord(a, w, true)) return unknownConsequence(); continue; }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    const shape = Object.prototype.hasOwnProperty.call(NODE_TEST_FLAGS, name) ? NODE_TEST_FLAGS[name] : undefined;
    const v = eq < 0 ? args[++i] : a.slice(eq + 1);
    if (!shape || v === undefined || !shape.test(v)) return unknownConsequence();
  }
  return LOCAL();
};
/**
 * `npx tsc --noEmit`, a type check that writes nothing: the only other words are `--skipLibCheck`, `--pretty [true|false]` and `-p|--project <config in the
 * project>`. Anything else (a build, `-b`, an output option, another package) is unknown.
 */
const npxTsc = (args: string[], w: Where): Consequence | undefined => {
  if (args[0] !== 'tsc') return undefined;
  let noEmit = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--noEmit') noEmit = true;
    else if (a === '--skipLibCheck') continue;
    else if (a === '--pretty') { if (args[i + 1] === 'true' || args[i + 1] === 'false') i++; }
    else if (a === '-p' || a === '--project') { const v = args[++i]; if (v === undefined || !insideWord(v, w)) return unknownConsequence(); }
    else return unknownConsequence();
  }
  return noEmit ? LOCAL() : unknownConsequence();
};
const pkgManager = (): ProgramRule => ({ level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--script-shell', '--node-options'], subs: {
  publish: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Publishing' },
  test: { ...LOCALSUB, inspect: bareTest },
  run: { level: 3, tags: [], chip: UNKNOWN_CHIP, inspect: runScript },
} });

/** Flags that write a file wherever they point: the value must stay inside the project (dashes are folded, `--x` is `-x`). */
const PYTEST_PATH_FLAGS = ['-junitxml', '-junit-xml', '-basetemp', '-log-file', '-cache-dir', '-result-log', '-resultlog', '-report-log'];
const CARGO_RUN: Sub = { ...LOCALSUB, inspect: localRun(['-target-dir', '-out-dir']) };
const GO_RUN: Sub = { ...LOCALSUB, inspect: localRun(['-o', '-coverprofile', '-cpuprofile', '-memprofile', '-blockprofile', '-mutexprofile', '-trace', '-outputdir']) };
/** go flags that load another module file, build overlay or toolchain step: both dash spellings. */
const GO_UNKNOWN_FLAGS = ['exec', 'toolexec', 'vettool', 'overlay', 'modfile', 'ldflags', 'gcflags', 'asmflags'].flatMap((f) => [`-${f}`, `--${f}`]);

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

/** The words that are not flags (a word after `--` is one too). */
const positional = (args: readonly string[]): string[] => {
  const end = args.indexOf('--');
  return end < 0 ? args.filter((a) => !a.startsWith('-')) : [...args.slice(0, end).filter((a) => !a.startsWith('-')), ...args.slice(end + 1)];
};
const WRITES = (): Consequence => rule(2, ['edits'], C.writesFile);

/**
 * Is this sed script only commands that print, select, number or rewrite text? Allowed: addresses (line numbers, `$`, `first~step`, `/re/` and
 * `\cREc` with the I/M flags, `a,b`, `a,+n`, `a,~n`), `!`, blocks, and the commands p d q Q = l n s y. Not allowed, so unknown: r R w W e f F z a i c
 * (they read or write a file, run a program or take free text), labels, branches, hold space, a comment, and the s flags e and w. A regex or text
 * part ends at the first unescaped delimiter; a part that has a delimiter inside a bracket expression is refused, because GNU and BSD sed end it in
 * different places there (so what this reads could differ from what runs).
 */
function sedScriptOk(src: string): boolean {
  const n = src.length;
  if (n > 2000) return false;
  let i = 0;
  const ws = (): void => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; };
  const delimiterOk = (d: string | undefined): d is string => d !== undefined && /[/|#,:@%!~+=.^-]/.test(d);
  // the bracket expression at i (a `[`), as BSD sed reads it: false when it holds the delimiter or never ends
  const bracket = (d: string): boolean => {
    i++;
    if (src[i] === '^') i++;
    if (src[i] === ']') i++;
    while (i < n && src[i] !== ']') {
      if (src[i] === d || src[i] === '\n') return false;
      if (src[i] === '[' && /[.:=]/.test(src[i + 1] ?? '')) {
        const kind = src[i + 1]!;
        i += 2;
        while (i < n && !(src[i] === kind && src[i + 1] === ']')) { if (src[i] === d || src[i] === '\n') return false; i++; }
        if (i >= n) return false;
        i += 2;
        continue;
      }
      i++;
    }
    if (i >= n) return false;
    i++;
    return true;
  };
  // text up to the next unescaped delimiter (consumed); a raw line break is only allowed after a backslash
  const part = (d: string, brackets: boolean): boolean => {
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') { if (i + 1 >= n) return false; i += 2; continue; }
      if (c === d) { i++; return true; }
      if (c === '\n') return false;
      if (c === '[' && brackets) { if (!bracket(d)) return false; continue; }
      i++;
    }
    return false;
  };
  // true when an address was read; false (nothing consumed) when there is none; a malformed one sets `bad`
  let bad = false;
  const address = (): boolean => {
    if (src[i] === '$') { i++; return true; }
    if (/\d/.test(src[i] ?? '')) {
      while (/\d/.test(src[i] ?? '')) i++;
      if (src[i] === '~') { i++; if (!/\d/.test(src[i] ?? '')) bad = true; while (/\d/.test(src[i] ?? '')) i++; }
      return true;
    }
    let d = src[i];
    if (d === '\\') { i++; d = src[i]; if (!delimiterOk(d)) { bad = true; return true; } } else if (d !== '/') return false;
    i++;
    if (!part(d!, true)) bad = true;
    while (src[i] === 'I' || src[i] === 'M') i++;
    return true;
  };
  const end = (): boolean => {
    ws();
    return i >= n || src[i] === ';' || src[i] === '\n' || src[i] === '}';
  };
  let depth = 0;
  while (true) {
    while (i < n && /[\s;]/.test(src[i]!)) i++;
    if (i >= n) return depth === 0;
    if (src[i] === '}') { if (depth === 0) return false; depth--; i++; if (!end()) return false; continue; }
    if (address()) {
      ws();
      if (src[i] === ',') {
        i++; ws();
        if (src[i] === '+' || src[i] === '~') { i++; if (!/\d/.test(src[i] ?? '')) return false; while (/\d/.test(src[i] ?? '')) i++; } else if (!address()) return false;
      }
      if (bad) return false;
      ws();
    }
    while (src[i] === '!') { i++; ws(); }
    const cmd = src[i++];
    if (cmd === '{') { depth++; if (depth > 8) return false; continue; }
    if (cmd === 'p' || cmd === 'd' || cmd === '=' || cmd === 'n') { if (!end()) return false; continue; }
    if (cmd === 'q' || cmd === 'Q' || cmd === 'l') { while (/\d/.test(src[i] ?? '')) i++; if (!end()) return false; continue; }
    if (cmd === 's' || cmd === 'y') {
      const d = src[i];
      if (!delimiterOk(d)) return false;
      i++;
      if (!part(d, true) || !part(d, true)) return false;
      if (cmd === 's') while (/[gpiImM\d]/.test(src[i] ?? '')) i++;
      if (!end()) return false;
      continue;
    }
    return false;
  }
}

/** sed's options that change nothing about what it reads or writes. Anything else (-i, -f, --in-place, --file, -l, a value-taking option) is unknown. */
const SED_PLAIN = /^(-[nErszu]+|--(quiet|silent|regexp-extended|separate|null-data|unbuffered|posix|sandbox|debug))$/;
/** `sed` as a filter or viewer: the script (the first plain word, or each -e) must pass sedScriptOk. Files after it are read; none are written. */
const sedRule = (args: string[]): Consequence | undefined => {
  const scripts: string[] = [];
  let hadScriptFlag = false;
  let rest = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (rest || a === '-') { words.push(a); continue; }
    if (a === '--') { rest = true; continue; }
    if (a === '-e' || a === '--expression') { const s = args[++i]; if (s === undefined) return unknownConsequence(); scripts.push(s); hadScriptFlag = true; continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); hadScriptFlag = true; continue; }
    if (SED_PLAIN.test(a)) continue;
    if (a.startsWith('-')) return unknownConsequence();
    words.push(a);
  }
  if (!hadScriptFlag) { const s = words.shift(); if (s === undefined) return unknownConsequence(); scripts.push(s); }
  return scripts.every(sedScriptOk) ? undefined : unknownConsequence();
};

/** jq's options that only change how it prints or reads its input; `--arg` and `--argjson` take a name and a value, `--indent` a number. */
const JQ_PLAIN = /^(-[rcsneSCMajRh]+|--(raw-output|raw-output0|compact-output|slurp|null-input|exit-status|sort-keys|color-output|monochrome-output|ascii-output|join-output|raw-input|tab|seq|stream|unbuffered))$/;
/** A jq filter that reads the environment, loads a module or names the file it is reading. */
const JQ_REACH = /\benv\b|\$ENV|\bimport\b|\binclude\b|input_filename|modulemeta|get_search_list|\$__/;
/**
 * `jq` with a filter that only reshapes JSON. The files after the filter are read (the reader check sees them). --rawfile, --slurpfile, --argfile,
 * -f, -L, --args, --jsonargs and every other option, and a filter that reads the environment or loads a module, are unknown.
 */
const jqRule = (args: string[]): Consequence | undefined => {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { words.push(...args.slice(i + 1)); break; }
    if (a === '--arg' || a === '--argjson') { if (args[i + 2] === undefined) return unknownConsequence(); i += 2; continue; }
    if (a === '--indent') { if (!/^\d$/.test(args[i + 1] ?? '')) return unknownConsequence(); i++; continue; }
    if (JQ_PLAIN.test(a)) continue;
    if (a.startsWith('-') && a !== '-') return unknownConsequence();
    words.push(a);
  }
  const filter = words[0];
  return filter === undefined || JQ_REACH.test(filter) ? unknownConsequence() : undefined;
};

/** `sleep` takes only a length of time; `infinity` waits for good, which is harmless. */
const sleepRule = (args: string[]): Consequence | undefined => (args.length && args.every((a) => /^(\d+(\.\d+)?[smhd]?|infinity)$/.test(a)) ? undefined : unknownConsequence());
/** PowerShell's Start-Sleep: a number of seconds or milliseconds, with the parameter names written out or shortened. */
const startSleepRule = (args: string[]): Consequence | undefined => (args.some((x) => /^\d+$/.test(x)) && args.every((a) => /^(\d+|-(s|se|sec|seco|secon|second|seconds|m|mi|mil|mill|milli|millis|millise|millisec|millisecon|millisecond|milliseconds))$/i.test(a)) ? undefined : unknownConsequence());

/** A git command with no side effect that takes only these flags (and, if `listing`, plain words after one of them). Anything else is unknown. */
const gitListing = (flags: RegExp, listing: RegExp): Sub => ({ ...R1, inspect: (args) => {
  let listed = false;
  const plain: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) { if (!flags.test(a)) return unknownConsequence(); if (listing.test(a)) listed = true; } else plain.push(a);
  }
  return plain.length && !listed ? unknownConsequence() : undefined;
} });
/** git commands that print what is stored, and cannot write or run a program (the flags that can are unknownFlags). */
const GITSAFE: Sub = { ...R1, unknownFlags: ['--ext-diff', '--textconv', '--output'] };
/** `git grep -O` / `--open-files-in-pager` runs a program on the matches; git also accepts any unambiguous start of a long option. */
const gitGrep: Sub = { ...R1, unknownFlags: ['--ext-diff', '--textconv'], inspect: (args) => (args.some((a) => /^-O/.test(a) || (a.startsWith('--') && a.length > 2 && '--open-files-in-pager'.startsWith(a.split('=')[0]!.toLowerCase()))) ? unknownConsequence() : undefined) };

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
  // filters and viewers: the files they are given are read (secret-paths.ts READERS), none is written
  nl: R1, column: R1, cmp: R1, readlink: R1, tr: R1, true: R1, false: R1, tac: R1, rev: R1, od: R1, hexdump: R1, strings: R1, sha256sum: R1, md5sum: R1,
  ps: R1, netstat: R1,
  diff: { ...R1, unknownFlags: ['--output'] },
  sed: { ...R1, inspect: sedRule },
  jq: { ...R1, inspect: jqRule },
  sleep: { ...R1, inspect: sleepRule },
  'start-sleep': { ...R1, inspect: startSleepRule },
  'get-item': R1, gi: R1, 'resolve-path': R1, 'select-object': R1, 'sort-object': R1, 'format-table': R1, 'format-list': R1, 'get-process': R1, 'get-nettcpconnection': R1, 'get-date': R1,
  // reversible local changes
  sd: R2,
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
      'rev-list': GITSAFE, 'ls-tree': GITSAFE, 'for-each-ref': GITSAFE, 'merge-base': GITSAFE, 'show-ref': GITSAFE, 'diff-tree': GITREAD, 'name-rev': GITSAFE, 'count-objects': GITSAFE,
      'cat-file': { ...GITSAFE, unknownFlags: ['--ext-diff', '--textconv', '--output', '--filters'] }, grep: gitGrep, 'ls-remote': NETSUB,
      branch: gitListing(/^(-a|-r|-v|-vv|-l|--all|--remotes|--verbose|--list|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=[\w:-]+|--format=[^\s]*|--no-color|--color)$/, /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/),
      tag: gitListing(/^(-l|-n\d*|--list|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=[\w:-]+|--format=[^\s]*)$/, /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/),
      remote: { ...R1, inspect: (a) => (a.every((x) => x === '-v' || x === '--verbose') ? undefined : unknownConsequence()) },
      worktree: { ...R1, inspect: (a) => (a[0] === 'list' && a.slice(1).every((x) => /^(--porcelain|-v|--verbose|-z)$/.test(x)) ? undefined : unknownConsequence()) },
      stash: { ...GITREAD, inspect: (a) => (a[0] === 'list' || a[0] === 'show' ? undefined : unknownConsequence()) },
      reflog: { ...R1, inspect: (a) => (a[0] === 'expire' || a[0] === 'delete' ? unknownConsequence() : undefined) },
      add: R2, commit: R2, merge: R2, pull: { ...R2, tags: ['edits', 'net'] }, fetch: NETSUB, clone: NETSUB,
      push: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Pushing' },
      clean: { level: 3, tags: ['deletes', 'irreversible'], chip: C.deletes, ing: 'Deleting' },
      reset: { ...R2, flagRules: [{ flags: ['--hard'], to: DELETES() }] },
    },
  },
  npm: pkgManager(), yarn: pkgManager(), pnpm: pkgManager(),
  npx: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--node-options'], inspect: npxTsc },
  node: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--node-options'], inspect: nodeTest },
  pytest: { level: 1, tags: ['runs-code'], chip: C.localRun, unknownFlags: ['-p', '--pyargs', '-o', '--override-ini', '-c', '--rootdir', '--confcutdir'], inspect: localRun(PYTEST_PATH_FLAGS) },
  cargo: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: ['--config', '-z', '--manifest-path'], exactFlags: ['-C'], subs: { publish: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Publishing' }, test: CARGO_RUN, build: CARGO_RUN, check: CARGO_RUN } },
  go: { level: 3, tags: [], chip: UNKNOWN_CHIP, unknownFlags: GO_UNKNOWN_FLAGS, exactFlags: ['-C', '--C'], subs: { test: GO_RUN, build: GO_RUN, vet: GO_RUN } },
  gh: { level: 3, tags: [], chip: UNKNOWN_CHIP, subs: { release: { level: 3, tags: ['leaves', 'irreversible'], chip: C.leaves, ing: 'Publishing' } } },
};

/** The shell tools: their input.command is read as a shell command. */
const SHELL_TOOL_KIND: Record<string, 'sh' | 'pwsh' | 'either'> = { Bash: 'sh', PowerShell: 'pwsh', Monitor: 'sh', mcp__host__shell: 'either' };

/** `targets` are the files the redirects write (unquoted), each with the index of the segment it sits in; null sinks and stream redirects are not in it. */
interface Parsed { segments: string[][]; redirects: boolean; targets: Array<{ word: string; seg: number }> }

/** Splits a command into segments of words. Null when it cannot be read with certainty (substitutions, groups, open quotes, ...). */
function parseShell(cmd: string): Parsed | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let inWord = false;
  const targets: Array<{ word: string; seg: number }> = [];
  let pendingRedirect = false;
  const endWord = (): boolean => {
    if (!inWord) return true;
    if (cur.startsWith('#')) return false;
    if (pendingRedirect) {
      pendingRedirect = false;
      if (/^(\/dev\/(null|stdout|stderr)|nul|&\d)$/i.test(cur)) { cur = ''; inWord = false; return true; }
      targets.push({ word: cur, seg: segments.length }); cur = ''; inWord = false; return true;
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
      // "2>file": the digit names the stream, it is not a word of the command
      if (inWord && /^\d$/.test(cur) && !pendingRedirect) { cur = ''; inWord = false; } else if (!endWord()) return null;
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
  return { segments, redirects: targets.length > 0, targets };
}

const lc = (s: string): string => s.toLowerCase();

function withTags(base: Sub, certain = true): Consequence {
  return { level: base.level, tags: [...base.tags], chip: base.chip, certain, ...(base.ing ? { ing: base.ing } : {}) };
}

const exactFlag = (r: Sub, args: readonly string[]): boolean => r.exactFlags?.some((f) => args.some((a) => a === f || a.startsWith(`${f}=`))) === true;

/** One segment's consequence. */
function classifySegment(words: string[], w: Where): Consequence {
  const c = classifyWords(words, w);
  // a build or test run in a folder the command moved to is not a run in the project
  return !w.cwdOk && c.level === 1 && c.tags.includes('runs-code') ? unknownConsequence() : c;
}

function classifyWords(words: string[], w: Where, depth = 0): Consequence {
  const first = words[0]!;
  // a program named by a path, or an assignment before it, could be anything
  if (/[\\/]/.test(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return unknownConsequence();
  // timeout, nice and time run the command after them: that command is what gets judged (a wrapper whose options are not understood is unknown)
  const wrapped = unwrapCommand(words);
  if (wrapped) return depth >= 8 ? unknownConsequence() : classifyWords(wrapped, w, depth + 1);
  const name = lc(first).replace(/\.exe$/, '');
  if (!Object.prototype.hasOwnProperty.call(PROGRAM_RULES, name)) return unknownConsequence();
  // PowerShell reads the environment, variables, functions and the registry through drive-like names (Env:, Variable:, HKLM:): values the check cannot see
  if (!TEXT_ARGS.has(name) && readsProvider(name, words.slice(1))) return unknownConsequence();
  const pr = PROGRAM_RULES[name]!;
  let args = words.slice(1);
  const lowered = args.map(lc);
  if (pr.unknownFlags?.some((f) => hasFlag(lowered, f))) return unknownConsequence();
  if (exactFlag(pr, args)) return unknownConsequence();
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
  if (base.unknownFlags?.some((f) => hasFlag(subLowered, f)) || exactFlag(base, args)) return unknownConsequence();
  const flagged = base.flagRules?.find((r) => r.flags.some((f) => hasFlag(subLowered, f)));
  if (flagged) return { ...flagged.to, tags: [...flagged.to.tags] };
  const inspected = base.inspect?.(args, w) ?? pr.inspect?.(args, w);
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
const TEXT_ARGS: ReadonlySet<string> = new Set(['echo', 'printf', 'write-output', 'write-host', 'pwd', 'whoami', 'hostname', 'uname', 'date', 'tr', 'sleep', 'start-sleep', 'true', 'false']);
/** A PowerShell provider path: `Env:`, `Variable:`, `Function:`, `Alias:`, `Cert:` or a registry hive, also behind `-Path:` or `=`. */
const PROVIDER_PATH = /^(-[a-z]+:)?(env|variable|function|alias|cert|hkcu|hklm|hkcr|hku|wsman):/i;
/** Programs whose first plain argument is a pattern, not a path (sed's and jq's is the script or filter). */
const PATTERN_FIRST: ReadonlySet<string> = new Set(['grep', 'rg', 'fd', 'select-string', 'sls', 'sed', 'jq']);
/** Places that hold secrets: reading them is never "read only, inside this project", wherever they are. */
const SECRET_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.config[\\/]gcloud|\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|credentials?|secrets?(\.[^\\/]*)?|[^\\/]*\.(pem|key|pfx|p12|kdbx))$/i;
const PATH_LIKE = /^([\\/~.]|[A-Za-z]:)|[\\/]/;

/** Does a word of this program (not counting the pattern or script a search program starts with) name a provider path? */
function readsProvider(name: string, args: readonly string[]): boolean {
  let pattern = PATTERN_FIRST.has(name);
  return args.some((x) => {
    if (pattern && !x.startsWith('-')) { pattern = false; return false; }
    return PROVIDER_PATH.test(x);
  });
}

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

/** The value of an option: short (`-o f`, `-of`, clustered `-ro f`) or long (`--name=f`, `--name f`, any start of the name); null when the option is not there. */
function optionValue(args: readonly string[], short: string, long: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      if (long && name && long.startsWith(name)) return eq >= 0 ? a.slice(eq + 1) : args[i + 1] ?? '';
    } else if (short && /^-[^-]/.test(a)) {
      const at = a.indexOf(short, 1);
      if (at > 0) return a.slice(at + 1) || (args[i + 1] ?? '');
    }
  }
  return null;
}

/** PowerShell parameters given as `-Name:value`. */
const colonValues = (args: readonly string[]): string[] => args.flatMap((a) => { const m = /^-[A-Za-z]+:(.+)$/.exec(a); return m ? [m[1]!] : []; });

/** Programs whose every file word is something they change (or, for a rename or move, take away from where it was). */
const WRITES_EVERY_WORD: ReadonlySet<string> = new Set(['tee', 'mkdir', 'md', 'touch', 'chmod', 'new-item', 'ren', 'rename', 'rename-item', 'set-content', 'add-content', 'out-file', 'mv', 'move', 'move-item']);

/**
 * The files a shell program writes, from its own words (a redirect is handled apart), or an empty list when it writes none. `cp` writes its last
 * word or the `-t` folder; PowerShell's copy takes its parameters in any order, so there every file word counts. A rule only ever adds a target.
 */
function writeTargets(name: string, args: readonly string[], kind: 'sh' | 'pwsh' | 'either'): string[] {
  if (WRITES_EVERY_WORD.has(name)) return [...positional(args), ...colonValues(args)];
  if (name === 'cp' || name === 'copy' || name === 'copy-item') {
    if (kind !== 'sh') return [...positional(args), ...colonValues(args)];
    const dir = optionValue(args, 't', 'target-directory');
    const last = positional(args).slice(-1);
    return dir !== null ? [dir] : last;
  }
  if (name === 'sort') { const v = optionValue(args, 'o', 'output'); return v === null ? [] : [v]; }
  if (name === 'tree') { const v = optionValue(args, 'o', ''); return v === null ? [] : [v]; }
  if (name === 'git') { const v = optionValue(args, '', 'output'); return v === null ? [] : [v]; }
  if (name === 'uniq') return positional(args).slice(1, 2);
  // sd rewrites the files after its find and replace words (a flag value among them only adds a word to check)
  if (name === 'sd') return positional(args).slice(2);
  if (name === 'find') return args.flatMap((a, i) => (/^-(fprint0?|fprintf|fls)$/.test(a) ? [args[i + 1] ?? ''] : []));
  return [];
}

/** Programs that change the folder the next words mean. */
const MOVES: ReadonlySet<string> = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl']);

function classifyShell(toolName: string, input: unknown, folders: readonly string[] = [], home?: string): Consequence {
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
  const kind = SHELL_TOOL_KIND[toolName] ?? 'sh';
  const where: Where = { folders, ...(home ? { home } : {}), cwdOk: true };
  const parts: Consequence[] = [];
  const written: string[][] = parsed.segments.map(() => []);
  for (const t of parsed.targets) written[Math.min(t.seg, parsed.segments.length - 1)]!.push(t.word);
  let outside = false;
  parsed.segments.forEach((w, i) => {
    const name = lc(w[0]!).replace(/\.exe$/, '');
    // timeout, nice and time run the command after them: its name and words decide what is read and written
    const run = unwrapAll(w) ?? w;
    parts.push(checkShellReads(classifySegment(w, where), run, folders));
    // a write is judged by its target, like the Write tool: outside the project, or a place the check cannot read, is level 3
    if ([...writeTargets(lc(run[0]!).replace(/\.exe$/, ''), run.slice(1), kind), ...written[i]!].some((t) => !insideWord(t, where))) outside = true;
    if (MOVES.has(name)) { const to = positional(w.slice(1)).pop(); where.cwdOk = where.cwdOk && to !== undefined && insideWord(to, where); }
  });
  if (parsed.redirects) parts.push(rule(2, ['edits'], C.writesFile));
  if (outside) parts.push({ level: 3, tags: ['edits'], chip: C.editsOutside, certain: false });
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
  // the owner's web search and page read providers leave the computer the same way
  mcp__legion__web_read: { level: 3, tags: ['leaves'], chip: C.leaves },
  mcp__legion__web_search: { level: 3, tags: ['leaves'], chip: C.leaves },
};

function classifyTool(call: ConsequenceCall): Consequence {
  const name = call.toolName;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(TOOL_RULES, name)) return unknownConsequence();
  const tr = TOOL_RULES[name]!;
  const folders = (call.projectFolders ?? []).filter((f) => typeof f === 'string' && f);
  if (tr.shell) return classifyShell(name, call.input, folders, call.home);
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
