/**
 * The safety floor for every shell command an agent runs (Legion's host shell, Claude Code's Bash and PowerShell, Monitor).
 *
 * Two questions, answered by reading the command text:
 *  - refuseCatastrophic: would it destroy a whole drive, a system folder or a home folder, or run hidden (decoded or
 *    encoded) text? Then it is refused for every agent, in every approval mode. A full-access tier forgives the approval
 *    card, not the machine (the Wipe Lesson).
 *  - unjudgeableCommand: can the text be judged at all? A command whose program is only known when it runs, that runs
 *    another command's output as a script, or that deletes a folder named only by a variable could be anything, so it
 *    gets the owner's approval card in every approval mode. Fail closed: what cannot be read is asked about.
 *
 * Design (two adversarial reviews, 2026-10-13): the refusal looks for a delete verb ANYWHERE among a segment's unquoted
 * words with a protected target after it, not only at the start of a command. The shell offers endless ways to put
 * something else first (subshells, groups, assignments, wrappers with options, script blocks); a verb anywhere closes
 * them as one family. Text in quotes on a line that runs no text is data (a commit message, a grep pattern), as before.
 * The card rules follow the shell the tool runs: PowerShell, POSIX sh, or cmd (with bash -c and powershell -c inside).
 *
 * Known limits, stated rather than hidden: a script written to a file and then run, `python -c` or `node -e` calling a
 * delete, a target that arrives on stdin (`echo /c | xargs rm -rf`), and relative deletes from an unknown folder are not
 * seen by reading. Only a sandboxed backend closes those.
 */

export type ShellKind = 'sh' | 'pwsh' | 'cmd';

/** Longer than this, a command is not read: it gets a card (Claude Code prompts for commands over 10,000 characters too). */
export const MAX_READABLE = 10_000;

/* ---------- reading a command ---------- */

/** A line continuation (sh's backslash-newline, PowerShell's backtick-newline) joins two lines into one command. */
const joinLines = (cmd: string): string => cmd.replace(/[\\`]\r?\n/g, '');
/** cmd lets a switch touch its command (`rd/s/q`, `cmd/c`): read them apart. */
const unglue = (s: string): string => s.replace(/(^|[\s(@&|;])(rd|rmdir|del|erase|cmd|dir|start|call|robocopy|icacls|takeown|format|move|ren|rename)(?=\/)/gi, '$1$2 ');
/** ANSI-C quoting (`$'/'`) names the same text as a plain single quote, for the refusal (the card treats `$` as built). */
const ansiC = (s: string): string => s.replace(/\$'/g, "'");
/** A backslash-escaped space (`Program\ Files`) keeps a word together in sh: marked so the target check can read it. */
const ESCAPED_SPACE = '\u0001';

/** The text with everything inside quotes masked (same length), so a separator in a quoted string is not seen as one. */
function maskQuotes(s: string): string {
  let out = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < s.length) { out += '__'; i++; continue; }
      if (ch === q) { q = null; out += ch; } else out += '_';
    } else {
      if (ch === '"' || ch === "'") q = ch;
      out += ch;
    }
  }
  return out;
}

/** Splits at `re` where it matches OUTSIDE quotes, as the shell reads a line (`node -e "a; b"` is one command). */
function splitOutside(s: string, re: RegExp): string[] {
  const masked = maskQuotes(s);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const parts: string[] = [];
  let last = 0;
  for (const m of masked.matchAll(g)) { parts.push(s.slice(last, m.index)); last = m.index! + m[0].length; }
  parts.push(s.slice(last));
  return parts;
}
const PIPE = /\|/;

/**
 * A command line as words, the way a shell joins them: quoted and unquoted parts that touch are ONE word (`"r"m` is `rm`),
 * quotes keep spaces inside a word, and are then dropped; cmd's ^ escape is removed. Lower case.
 */
function words(segment: string): string[] {
  return (segment.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map((w) => w.replace(/["'^]/g, '').toLowerCase()).filter(Boolean);
}

/**
 * The program a word names: `/bin/rm` and `C:\Windows\System32\cmd.exe` are `rm` and `cmd`. A backslash in a word with
 * no drive or slash is sh's escape, not a folder separator: `r\m` runs `rm`.
 */
const program = (w: string): string => (/^[a-z]:|\//.test(w) ? w : w.replace(/\\/g, '')).replace(/^.*[\\/]/, '').replace(/\.(?:exe|com|cmd|bat)$/, '');

/**
 * A word as a verb or a target: no group or subshell brackets, no cmd `@`, no redirect glued on (`C:\>nul`). A closing
 * bracket is taken off only when the word did not open it (`${HOME}` keeps its brace, `(rd` and `C:\)` lose theirs).
 */
function clean(w: string): string {
  let s = w.replace(/^[(@{]+/, '').replace(/(?<=.)\d?>{1,2}.*$/, '');
  for (;;) {
    const last = s.at(-1);
    const open = last === ')' ? '(' : last === '}' ? '{' : undefined;
    if (last === ';') { s = s.slice(0, -1); continue; }
    if (!open || s.split(open).length > s.split(last!).length - 1) break;
    s = s.slice(0, -1);
  }
  return s;
}

/** A word of a stage: as written (lower case, quotes dropped) and cleaned of brackets and redirects. */
interface Arg { raw: string; w: string }

/** The words of a stage without redirects (`> out`, `2>&1`, `>>log`): what a redirect writes to is not an argument. */
function argWords(stage: string): Arg[] {
  const tokens = stage.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? [];
  const out: Arg[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d?>{1,2}&?\d?$/.test(t)) { i++; continue; }
    if (/^\d?>/.test(t)) continue;
    const raw = t.replace(/["'^]/g, '').toLowerCase();
    if (raw) out.push({ raw, w: clean(raw) });
  }
  return out;
}

/** A word that opens a group, a subshell or a script block: the command inside starts with it (`(rd`, `{ rm`, `(( `). */
const opensGroup = (raw: string): boolean => /^[({]/.test(raw);
/** cmd's `if` conditions before its command: `if exist x`, `if not defined v`, `if errorlevel 1`, `if /i "a"=="b"`. */
const CMD_IF_TESTS = new Set(['exist', 'defined', 'errorlevel', 'cmdextversion']);

/**
 * Where a command really starts in a stage, read liberally: the start; after a group, subshell or script-block opener;
 * past keywords, conditions and assignments (sh `FOO=1`, PowerShell `$x =`, cmd `if exist x`); then the wrapper-aware
 * positions of commandPositions. A verb counts only here: elsewhere it is an argument (`rg -n del ~`, `git rm`, `echo rm`).
 */
function liberalPositions(args: readonly Arg[]): Set<number> {
  const out = new Set<number>();
  const run = (from: number, to: number) => {
    let k = from;
    let afterIf = false;
    while (k < to) {
      const w = args[k]!.w;
      if (!w || SH_KEYWORDS.has(w) || PS_KEYWORDS.has(w) || /^[a-z_][a-z0-9_]*=/.test(w) || /^\$[\w:{}]+=/.test(w)) { afterIf = w === 'if'; k++; continue; }
      if (w.startsWith('$') && args[k + 1]?.w === '=') { k += 2; continue; }
      if (afterIf && (w === '/i' || w === 'not')) { k++; continue; }
      if (afterIf && CMD_IF_TESTS.has(w)) { k += 2; afterIf = false; continue; }
      if (afterIf && w.includes('==')) { k++; afterIf = false; continue; }
      break;
    }
    for (const p of commandPositions(args.slice(k, to).map((a) => a.w))) out.add(k + p);
  };
  let start = 0;
  for (let i = 1; i < args.length; i++) if (opensGroup(args[i]!.raw)) { run(start, i); start = i; }
  run(start, args.length);
  return out;
}

/* ---------- what is protected ---------- */

/**
 * `.` and `..` folded away, never above the first segment, which stays as written (`/`, `c:`, `~`, `$home`,
 * `%userprofile%`): `/home/x/..` is `/home`, `c:/.` is `c:`, `./a/../b` is `b`. Forward slashes only.
 */
function collapseDots(p: string): string {
  const abs = p.startsWith('/');
  const segs = p.split('/').filter((s, i) => !(abs && i === 0 && s === ''));
  const out: string[] = [];
  const anchored = abs || /^(?:[a-z]:|~|\$home|\$\{home\}|%[a-z]+%|\$env:[a-z]+)$/.test(segs[0] ?? '');
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (out.length > (anchored && !abs ? 1 : 0)) out.pop(); continue; }
    out.push(s);
  }
  return abs ? `/${out.join('/')}` : out.join('/') || '.';
}

const WIN_VARS = 'userprofile|systemroot|windir|systemdrive|programfiles|programdata|homedrive';

/**
 * A path whose recursive deletion destroys the machine or a person's data: a drive or file-system root, a system
 * folder, a home folder (or its root), each optionally followed by a separator and a wildcard. A folder INSIDE a
 * home or a project is not one of these: deleting `~/proj/build` or `C:\proj\build` is ordinary work.
 */
export function isProtectedTarget(word: string): boolean {
  // PowerShell's -Path:C:\ form, the \\?\ and \\.\ device prefixes, and sh's escaped spaces name the same folder
  // a target names a root, a drive, a home or a variable: a plain word (most of a command) is none of these, so it is skipped at once
  if (!/[\\/~$%:*?[]/.test(word)) return false;
  const bare = word.split(ESCAPED_SPACE).join(' ').replace(/^-(?:literal)?path:/, '').replace(/^[\\/]{2}[?.][\\/]/, '');
  if (!bare) return false;
  // a whole drive through an admin share (\\localhost\c$)
  if (/^[\\/]{2}[^\\/]+[\\/][a-z]\$[\\/]?\*?$/.test(bare)) return true;
  // every dot-file of a home (~/.*): the configuration of every program the person uses
  if (/^(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)[\\/]\.\*$/.test(bare)) return true;
  // the home drive and path written as two variables
  if (/^(?:%homedrive%%homepath%|\$env:homedrive\$env:homepath|\$homedrive\$homepath|\$\{homedrive\}\$\{homepath\})[\\/]?\*?$/.test(bare)) return true;
  const w = collapseDots(bare.replace(/[\\/]+\*(?:\.\*)?$/, '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/');
  if (w === '/' || w === '/*') return true;
  // a wildcard in the first folder below the root (/[c], /?, /c*) reaches a drive or a system folder
  if (/^\/[^/]*[?*[][^/]*$/.test(w)) return true;
  // Git for Windows' tools (rm.exe is on PATH, so cmd.exe reaches it too), Cygwin and WSL name a drive /c, /cygdrive/c or
  // /mnt/c: judged as the drive itself. On a POSIX machine a one-letter top-level folder is refused as well, which costs nothing.
  const drive = /^\/(?:cygdrive\/|mnt\/)?([a-z])(\/.*)?$/.exec(w);
  if (drive) return isProtectedTarget(`${drive[1]}:${drive[2] ?? ''}`);
  if (/^\/users(?:\/[^/]+)?$/.test(w)) return true;
  if (/^[a-z]:\/windows\/system32$/.test(w)) return true;
  if (/^\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)$/.test(w)) return true;
  if (/^\/home\/[^/]+$/.test(w)) return true;
  if (/^(?:~|\$home|\$\{home(?::[-?=+][^}]*)?\})$/.test(w)) return true;
  if (/^[a-z]:(?:\*(?:\.\*)?)?$/.test(w)) return true;
  if (/^[a-z]:\/(?:windows|users|program files|program files \(x86\)|programdata|progra~\d|docume~\d)$/.test(w)) return true;
  if (/^[a-z]:\/users\/[^/]+$/.test(w)) return true;
  if (new RegExp(`^%(?:${WIN_VARS}|homedrive%%homepath)%$`).test(w)) return true;
  if (new RegExp(`^\\$env:(?:${WIN_VARS})$`).test(w)) return true;
  // the same variables as sh writes them (Git Bash inherits the Windows environment)
  if (new RegExp(`^\\$(?:\\{(?:${WIN_VARS})\\}|(?:${WIN_VARS}))$`).test(w)) return true;
  return false;
}

/* ---------- command positions ---------- */

/** Programs that run the rest of the line as the command (`sudo rm …` is an rm); their own options are skipped. */
const WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time', 'xargs',
  'timeout', 'stdbuf', 'setsid', 'ionice', 'chroot', 'flock', 'strace', 'ltrace', 'busybox', 'taskset', 'chrt', 'unbuffer', 'caffeinate',
  // cmd's call and start, and wsl, run the command that follows them; eval and PowerShell's iex run their words as a command
  'call', 'start', 'wsl', 'eval', 'iex', 'invoke-expression',
  // ssh-agent runs the command after its options as its child
  'ssh-agent',
]);
const WRAPPER_OPTS_WITH_ARG = new Set(['-u', '-g', '-p', '-h', '-n', '-s', '-k', '-o', '-e', '-c', '-w', '-t', '-d', '--distribution', '--user', '--cd', '--signal', '--kill-after']);
/** Wrappers whose first plain word is their own argument, not the command (`timeout 5 rm`, `chroot / rm`, `flock lockfile rm`). */
const WRAPPER_TAKES_ONE = new Set(['timeout', 'chroot', 'flock', 'taskset', 'chrt']);
/** cmd's call and start take /x switches (`start /b`). */
const SLASH_OPTION_WRAPPERS = new Set(['call', 'start']);
/** PowerShell options that take a value. */
const PS_OPTS_WITH_ARG = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-outputformat', '-of', '-inputformat', '-if', '-configurationname', '-workingdirectory', '-wd', '-settingsfile', '-version', '-v']);
/** Shells that run the command line after their command flag (`bash -c`, `cmd /c`, `powershell -Command`). */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'csh', 'tcsh', 'mksh', 'cmd', 'powershell', 'pwsh']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command']);

/** Delete commands of sh, cmd and PowerShell (with its aliases), and the ones that overwrite before they delete. */
const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'shred', 'srm']);
/** PowerShell's and sh's listers: `gci C:\ | Remove-Item` deletes what they list. */
const LIST_VERBS = new Set(['get-childitem', 'gci', 'dir', 'ls']);
const MOVE_VERBS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
const CD_VERBS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
/** cmd's commands, whose options are written /s, /q: after them a /x word is a switch, not Git Bash's /x drive. */
const CMD_SWITCH_VERBS = new Set(['rd', 'rmdir', 'del', 'erase', 'dir', 'icacls', 'takeown', 'robocopy', 'move', 'ren', 'rename', 'cd', 'chdir', 'pushd']);
/** A word that names a program Legion recognises: when a wrapper option might take an argument, such a word is the command. */
const KNOWN_PROGRAMS = new Set([...DELETE_VERBS, ...SHELLS, ...WRAPPERS, 'python', 'python3', 'node', 'perl', 'ruby', 'robocopy', 'rsync', 'chmod', 'chown', 'find', 'git', 'mv', 'dd']);

/**
 * The words of a stage that are in command position, i.e. that RUN: the first word, the word after a wrapper and its
 * options, the word after a shell's command flag, and the word after find's -exec.
 */
function commandPositions(ws: readonly string[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < ws.length) {
    out.push(i);
    const p = program(ws[i]!);
    if (WRAPPERS.has(p)) {
      i++;
      const opt = (w: string) => w.startsWith('-') || /^[a-z_][a-z0-9_]*=/.test(w) || (SLASH_OPTION_WRAPPERS.has(p) && /^\/[a-z]/.test(w));
      // an option that may take an argument does not swallow a word that names a program (`sudo -E rm` reads as `sudo -e rm`)
      while (i < ws.length && opt(ws[i]!)) { if (WRAPPER_OPTS_WITH_ARG.has(ws[i++]!) && !KNOWN_PROGRAMS.has(program(ws[i] ?? ''))) i++; }
      if (WRAPPER_TAKES_ONE.has(p) && i < ws.length && !KNOWN_PROGRAMS.has(program(ws[i]!))) { i++; while (i < ws.length && ws[i]!.startsWith('-')) i++; }
      continue;
    }
    // `direnv exec DIR command` runs the command
    if (p === 'direnv' && ws[i + 1] === 'exec') { i += 3; continue; }
    const flag = SHELLS.has(p) ? ws.findIndex((w, j) => j > i && SHELL_COMMAND_FLAGS.has(w)) : -1;
    if (flag > i) { i = flag + 1; continue; }
    // PowerShell runs its first plain argument as a command even without -Command (`powershell Format-Volume …`);
    // its options that take a value (-ExecutionPolicy Bypass) are stepped over, and -File runs a script, not a command
    if (p === 'powershell' || p === 'pwsh') {
      let j = i + 1;
      while (j < ws.length && ws[j]!.startsWith('-')) { if (ws[j] === '-file' || ws[j] === '-f') { j = ws.length; break; } j += PS_OPTS_WITH_ARG.has(ws[j]!) ? 2 : 1; }
      if (j < ws.length) { i = j; continue; }
    }
    break;
  }
  ws.forEach((w, j) => { if ((w === '-exec' || w === '-execdir') && j + 1 < ws.length) out.push(j + 1); });
  return out;
}

/** Programs that run TEXT as a command (besides the shells): only for these is a quoted string judged as a command of its own. */
const TEXT_RUNNERS = new Set(['eval', 'iex', 'invoke-expression', 'ssh', 'su', 'wsl', 'xargs', 'start', 'watch', 'source', '.', 'runas', 'call', 'invoke-command', 'start-process']);

/** Where one command ends and the next begins: ; & && || newlines, and the body after do, then or else (at any position). */
const SEGMENTS = /&&|\|\||[;&\n\r]|\b(?:do|then|else)\b(?=\s)/;
/** PowerShell: & is its call operator, not a separator. */
const PS_SEGMENTS = /&&|\|\||[;\n\r]|\b(?:do|then|else)\b(?=\s)/;

/** Whether some command position on the line is a shell or another program that runs text as a command. */
function runsText(cmd: string): boolean {
  for (const seg of splitOutside(cmd, /&&|\|\||[;&|\n\r]/)) {
    const ws = words(seg);
    if (commandPositions(ws).some((i) => { const p = program(ws[i]!); return SHELLS.has(p) || TEXT_RUNNERS.has(p); })) return true;
  }
  return false;
}

/* ---------- standard input run as a script ---------- */

/** Programs that read a script from standard input when no command flag or script file is given (`curl … | bash`). */
const STDIN_RUNNERS = new Set([...SHELLS, 'iex', 'invoke-expression', 'python', 'python3', 'node', 'perl', 'ruby']);

/** Whether this pipeline stage hands its standard input to a shell or interpreter as a script. */
function runsStdin(ws: readonly string[]): boolean {
  const pos = commandPositions(ws);
  const last = pos[pos.length - 1];
  if (last === undefined) return false;
  // `… | xargs sh -c`: xargs hands the text to the shell's -c as the command (the -c has nothing after it on the line)
  if (pos.some((i, n) => n > 0 && SHELLS.has(program(ws[i]!)) && program(ws[pos[n - 1]!]!) === 'xargs') && SHELL_COMMAND_FLAGS.has(ws[ws.length - 1]!)) return true;
  // the shell itself is the last command position only when its -c took the rest; read the runner as the program BEFORE that
  const at = pos.length > 1 && SHELL_COMMAND_FLAGS.has(ws[last - 1] ?? '') ? pos[pos.length - 2]! : last;
  const p = program(ws[at]!);
  if (!STDIN_RUNNERS.has(p)) return false;
  const after = ws.slice(at + 1);
  const posixShell = SHELLS.has(p) && p !== 'cmd' && p !== 'powershell' && p !== 'pwsh';
  // `bash -n` only checks the syntax; it runs nothing
  if (posixShell && after.includes('-n')) return false;
  const inline = posixShell ? new Set(['-c']) : p === 'cmd' ? new Set(['/c', '/k']) : (p === 'powershell' || p === 'pwsh') ? new Set(['-c', '-command', '-file', '-f']) : new Set(['-e', '--eval', '-p', '--print', '-c']);
  for (let i = 0; i < after.length; i++) {
    const w = after[i]!;
    // `powershell -c -` reads the command from standard input
    if (inline.has(w)) return after[i + 1] === '-';
    if (!w.startsWith('-') && !w.startsWith('/')) return false; // a script file
  }
  return true;
}

/** The text an echo or printf stage writes, when it is written out on the line (no variable, substitution or escape). */
function literalOutput(stage: string): string | undefined {
  const ws = words(stage);
  if (!['echo', 'printf'].includes(program(ws[0] ?? ''))) return undefined;
  if (/[$`]|\\[0-7xuUe]/.test(stage)) return undefined;
  return ws.slice(1).filter((w) => !/^-[a-z]+$/.test(w)).join(' ');
}

/* ---------- refusal ---------- */

/** Commands that are catastrophic by themselves: judged on the normalised text, so a note or a grep pattern naming one in quotes passes. */
const CATASTROPHIC_COMMANDS: Array<[RegExp, string]> = [
  [/\bmkfs(?:\.\w+)?\b/i, 'formatting a filesystem'],
  [/\bdd\b[^|&;\n]*\bof\s*=\s*['"]?\/dev\//i, 'raw write to a device'],
  [/(?:^|[\s&|;(@])format(?:\.com)?\s+(?:\/\S+\s+)*['"]?[a-z]:/i, 'formatting a drive'],
  [/\bdiskpart\b/i, 'disk partitioning'],
  [/\b(?:shred|wipefs|blkdiscard)\b[^|&;\n]*\/dev\//i, 'wiping a disk device'],
];
/** Shapes that are not words (a fork bomb, a redirect onto a disk): matched anywhere on the line. */
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'a fork bomb'],
  [/>\s*['"]?\/dev\/(?:sd|hd|nvme|mmcblk|vd)[a-z0-9]*['"]?\s*$/i, 'overwriting a block device'],
  [/(?:of\s*=|>)\s*['"]?\\\\\.\\physicaldrive\d/i, 'raw write to a disk'],
];
/** Whole-machine Windows tools: no target is needed for these to be catastrophic. Matched on the normalised text. */
const CATASTROPHIC_WINDOWS: Array<[RegExp, string]> = [
  [/\bvssadmin(?:\.exe)?\s+delete\s+shadows\b/, 'deleting the system restore copies'],
  [/\bwmic(?:\.exe)?\s+shadowcopy\s+delete\b/, 'deleting the system restore copies'],
  [/\bwbadmin(?:\.exe)?\s+delete\b/, 'deleting the backups'],
  [/\bbcdedit(?:\.exe)?\s+\/delete\b/, 'deleting a boot entry'],
  [/\breg(?:\.exe)?\s+delete\s+(?:hklm|hkey_local_machine)\\(?:system|software|sam|security)\b/, 'deleting a core part of the registry'],
  [/\bcipher(?:\.exe)?\s+\/w\b/, 'wiping a drive\'s free space'],
  [/\b(?:format-volume|clear-disk|initialize-disk|remove-partition)\b/, 'formatting or wiping a disk'],
];

/** Decoders that turn hidden text into readable text: their output piped into a shell is a command nobody could read first. */
const DECODES = (ws: readonly string[]): boolean => {
  const p = ws.map(program);
  return (p.includes('base64') && ws.some((w) => w === '-d' || w === '--decode'))
    || (p.includes('xxd') && ws.some((w) => w === '-r' || /^-r/.test(w)))
    || (p.includes('openssl') && ws.includes('-d') && ws.some((w) => w === 'base64' || w === 'enc'));
};
/** PowerShell's -EncodedCommand and every prefix PowerShell accepts for it (-e, -ec, -enc, …). */
const PS_ENCODED = /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/;

/** Why the command runs hidden (decoded or encoded) text as a command, else undefined. Hard refusal: a card could not show it. */
function hiddenPayload(cmd: string): string | undefined {
  if (/frombase64string/i.test(cmd) && /\b(?:iex|invoke-expression)\b/i.test(cmd)) return 'running decoded text as a command';
  for (const segment of splitOutside(cmd, SEGMENTS)) {
    const stages = splitOutside(segment, PIPE).map(words);
    for (const ws of stages) {
      if (ws.some((w, i) => { const p = program(clean(w)); return (p === 'powershell' || p === 'pwsh') && ws.slice(i + 1).some((x) => PS_ENCODED.test(x)); })) return 'running a hidden (encoded) PowerShell command';
    }
    for (let s = 1; s < stages.length; s++) if (runsStdin(stages[s]!) && stages.slice(0, s).some(DECODES)) return 'running decoded text as a command';
  }
  return undefined;
}

/** A cmd switch (`/s`, `/q`, `/a:h`): after cmd's own commands it is an option, not Git Bash's `/s` drive. */
const CMD_SWITCH = /^\/[a-z?]+(?::\S*)?$/;
/** A target meaning "everything here": `*`, `./*`, `*.*`, `.`. */
const EVERYTHING_HERE = /^(?:\.[\\/])?\*(?:\.\*)?$|^\.$/;

/**
 * One stage, read for verbs and targets in one pass (linear: a command of 100,000 words is read once, not once per verb).
 * A verb counts where a command starts, read liberally (liberalPositions): behind a group, a subshell, a script block,
 * an assignment, a condition or a wrapper with options, quoted (`"rm" -rf /`) or not; anywhere else it is data.
 */
class Stage {
  readonly ws: string[];
  /** For each word: the index of the last protected target at or after it (-1: none), counting cmd switches or not. */
  private readonly protAfter: Int32Array;
  private readonly protAfterNoSwitch: Int32Array;
  private readonly verbOk: boolean[];
  constructor(args: Arg[]) {
    this.ws = args.map((a) => a.w);
    const n = this.ws.length;
    this.protAfter = new Int32Array(n + 1).fill(-1);
    this.protAfterNoSwitch = new Int32Array(n + 1).fill(-1);
    for (let i = n - 1; i >= 0; i--) {
      const w = this.ws[i]!;
      const prot = isProtectedTarget(w);
      this.protAfter[i] = prot ? i : this.protAfter[i + 1]!;
      this.protAfterNoSwitch[i] = prot && !CMD_SWITCH.test(w) ? i : this.protAfterNoSwitch[i + 1]!;
    }
    const runs = liberalPositions(args);
    this.verbOk = args.map((_a, i) => runs.has(i));
  }
  /** The indexes of the words whose program is one of `verbs`. */
  at(verbs: ReadonlySet<string>): number[] { return this.ws.flatMap((w, i) => (this.verbOk[i] && verbs.has(program(w)) ? [i] : [])); }
  /** Whether a protected target follows word i (for cmd's own commands, a /x switch is not one). */
  protectedAfter(i: number): boolean {
    const table = CMD_SWITCH_VERBS.has(program(this.ws[i]!)) ? this.protAfterNoSwitch : this.protAfter;
    return table[i + 1]! >= 0;
  }
  /** The plain words after word i (no options), for commands where one position is the target. */
  plainAfter(i: number, slashOptions: boolean): string[] {
    const out: string[] = [];
    for (let j = i + 1; j < this.ws.length && out.length < 4; j++) { const w = this.ws[j]!; if (!w.startsWith('-') && !(slashOptions && /^\/[a-z]/.test(w))) out.push(w); }
    return out;
  }
  has(pred: (w: string) => boolean, from = 0): boolean { for (let j = from; j < this.ws.length; j++) if (pred(this.ws[j]!)) return true; return false; }
}

/** Why one command segment (no ; & && || or newline in it) is catastrophic, else undefined. */
function refuseSegment(segment: string): string | undefined {
  const stages = splitOutside(segment, PIPE).map((s) => new Stage(argWords(s)));
  const deleteMsg = 'a recursive delete of a drive, a system folder or a home folder';
  const mirrorMsg = 'mirroring over a drive, a system folder or a home folder (it deletes what is not in the source)';
  const permMsg = 'changing the permissions of a whole drive, system folder or home folder';
  for (const st of stages) {
    const ws = st.ws;
    if (st.at(DELETE_VERBS).some((i) => st.protectedAfter(i))) return deleteMsg;
    // robocopy /MIR or /PURGE: the destination (the second path) loses what the source does not have
    if (st.has((w) => w === '/mir' || w === '/purge') && st.at(new Set(['robocopy'])).some((i) => isProtectedTarget(st.plainAfter(i, true)[1] ?? ''))) return mirrorMsg;
    if (st.has((w) => w.startsWith('--delete')) && st.at(new Set(['rsync'])).some((i) => isProtectedTarget(ws.slice(i + 1).filter((w) => !w.startsWith('-')).at(-1) ?? ''))) return mirrorMsg;
    // taking away every permission or owner of a drive or a home locks the person out of it
    if (st.has((w) => /^-[a-z]*r/.test(w) || w === '--recursive') && st.at(new Set(['chmod', 'chown', 'chgrp', 'setfacl'])).some((i) => st.protectedAfter(i))) return permMsg;
    if (st.has((w) => w === '/t' || w === '/r') && st.at(new Set(['icacls', 'takeown'])).some((i) => st.protectedAfter(i))) return permMsg;
    // moving or renaming a drive, a system folder or a home away (mv ~ /dev/null) is a delete too: the first path is what moves
    if (st.at(MOVE_VERBS).some((i) => isProtectedTarget(st.plainAfter(i, CMD_SWITCH_VERBS.has(program(ws[i]!)))[0] ?? ''))) return 'moving a drive, a system folder or a home folder away';
    // git clean -fdx in a drive root deletes every file git does not track there
    if (st.has((w) => w === 'clean') && st.at(new Set(['git'])).some((i) => ws.some((w, j) => w === '-c' && j > i && isProtectedTarget(ws[j + 1] ?? '')))) return 'cleaning a drive, a system folder or a home folder with git';
    const deletes = st.has((w) => w === '-delete') || ws.some((w, i) => (w === '-exec' || w === '-execdir') && DELETE_VERBS.has(program(ws[i + 1] ?? '')));
    if (deletes && st.at(new Set(['find'])).some((i) => st.protectedAfter(i))) return 'deleting everything under a drive, a system folder or a home folder';
  }
  // a lister in one stage, a delete RUNNING in a later one (at a command position, or inside a script block or xargs)
  if (stages.length > 1) {
    const lists = stages.slice(0, -1).some((st) => st.at(LIST_VERBS).some((i) => st.protectedAfter(i)));
    const deletes = stages.slice(1).some((st) => commandPositions(st.ws).some((i) => DELETE_VERBS.has(program(st.ws[i]!)))
      || st.at(DELETE_VERBS).some((i) => st.ws.slice(0, i).some((x) => x === '{' || x.startsWith('{') || x === 'xargs' || x === '%' || x === 'foreach-object')));
    if (lists && deletes) return deleteMsg;
  }
  return undefined;
}

/**
 * The refusal reason when a command is catastrophic (or runs hidden text), else undefined. Read on the whole line,
 * a segment at a time; the text of a shell's -c, of a substitution, and of an echo piped into a shell is read too.
 */
export function refuseCatastrophic(raw: string, depth = 0): string | undefined {
  const cmd = unglue(ansiC(joinLines(raw)));
  const say = (what: string): string => `Refused: this command looks like ${what}, which can destroy the machine or its data. It is blocked for every agent, even full access.`;
  for (const [re, what] of CATASTROPHIC) if (re.test(cmd)) return say(what);
  const hidden = hiddenPayload(cmd);
  if (hidden) return `Refused: this command is ${hidden}. Text that is decoded or encoded cannot be read before it runs, so it is blocked for every agent, even full access. Run the command itself, written out plainly.`;
  // Quoted text of several words on a line that runs no text is data (a commit message, a grep pattern): read it as a
  // space. A one-word quote (`format "c:"`) is kept, unquoted, so quoting a target cannot hide it.
  const text = runsText(cmd) ? cmd : cmd.replace(/"([^"]*)"|'([^']*)'/g, (_m, a?: string, b?: string) => (/\s/.test(a ?? b ?? '') ? ' ' : (a ?? b ?? '')));
  const scan = text.replace(/[\^"']/g, '').toLowerCase();
  for (const [re, what] of [...CATASTROPHIC_COMMANDS, ...CATASTROPHIC_WINDOWS]) if (re.test(scan)) return say(what);
  // Each segment: a verb anywhere with a protected target after it. Quoted text stays one word (the shell's own reading),
  // so a commit message or grep pattern never splits into verbs. Then `cd /` (or a drive, or a home) and a delete of
  // everything there. An sh line with an escaped space (`Program\ Files`) is also read with that space kept in the word.
  for (const variant of /\\ /.test(cmd) ? [cmd, cmd.replace(/\\ /g, ESCAPED_SPACE)] : [cmd]) {
    let inRoot = false;
    for (const segment of splitOutside(variant, SEGMENTS)) {
      const why = refuseSegment(segment);
      if (why) return say(why);
      const st = new Stage(argWords(segment));
      const c = st.at(CD_VERBS)[0];
      if (c !== undefined) { const t = st.plainAfter(c, CMD_SWITCH_VERBS.has(program(st.ws[c]!)))[0]; inRoot = t !== undefined && isProtectedTarget(t); }
      else if (inRoot && st.at(DELETE_VERBS).some((i) => st.ws.slice(i + 1).some((w) => EVERYTHING_HERE.test(w)))) return say('deleting everything in a drive, a system folder or a home folder');
    }
  }
  if (depth < 2) {
    for (const segment of splitOutside(cmd, SEGMENTS)) {
      const stages = splitOutside(segment, PIPE);
      for (let s = 0; s < stages.length; s++) {
        const ws = words(stages[s]!);
        // a shell's -c text, joined as the shell joins it (`bash -c 'r''m -rf /c'`), is a command of its own
        for (const i of commandPositions(ws)) if (/\s/.test(ws[i]!)) { const inner = refuseCatastrophic(ws[i]!, depth + 1); if (inner) return inner; }
        // `echo rm -rf /c | sh` runs the echoed text
        const echoed = s > 0 && runsStdin(ws) ? literalOutput(stages[s - 1]!) : undefined;
        if (echoed) { const inner = refuseCatastrophic(echoed, depth + 1); if (inner) return inner; }
      }
    }
    // a command substitution runs its text as a command: `echo $(rm -rf /)`, backticks the same
    for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
      const inner = refuseCatastrophic(m[1] ?? m[2] ?? '', depth + 1);
      if (inner) return inner;
    }
    // one plain scan per quote; only when something on the line runs text (a shell's -c, eval, ssh, a pipe into sh)
    if (runsText(cmd)) for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const t = m[1] ?? m[2] ?? '';
      if (!/\s/.test(t)) continue;
      const inner = refuseCatastrophic(t, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

/* ---------- commands that cannot be read ---------- */

/** Words that open a compound command or a test rather than name a program (`do rm …` runs rm; `[ -f x ]` is a test). */
const SH_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'for', 'case', '!', '{', '}', '(', ')', '((', '))', '[', '[[', ']', ']]', 'time']);
const PS_KEYWORDS = new Set(['do', 'else', 'elseif', 'if', 'while', 'until', 'switch', 'foreach', 'for', 'try', 'catch', 'finally', '{', '}', '(', ')']);
/** Keywords followed by a condition in parentheses (PowerShell `if ($x) { … }`): the condition is not the program. */
const CONDITION_KEYWORDS = new Set(['if', 'elseif', 'while', 'switch', 'foreach', 'for']);
/** A program word only known when the command runs: a variable or substitution ($, backtick), cmd's %VAR% and !VAR!, or a brace expansion. */
const BUILT_AT_RUN = /[$`]|%[^%\s]+%|![^!\s]+!|^\{[^}]*,[^}]*\}$/;
/** Environment variables that name a folder the system or a tool sets up, so `$HOME/.local/bin/tool` names a written-out program. */
const KNOWN_FOLDERS = 'home|pwd|oldpwd|userprofile|localappdata|appdata|programfiles|programfiles\\(x86\\)|programdata|systemroot|windir|temp|tmp|tmpdir|xdg_[a-z_]+|nvm_dir|cargo_home|rustup_home|gopath|goroot|java_home|android_home|android_sdk_root|virtual_env|conda_prefix|pyenv_root|rbenv_root|volta_home|pnpm_home|bun_install|deno_install|github_workspace|runner_temp|runner_tool_cache';
const PATH_FROM_KNOWN = new RegExp(`^(?:\\$(?:env:)?\\{?(${KNOWN_FOLDERS})\\}?|%(${KNOWN_FOLDERS})%)[\\\\/][^$%\`!]*[^\\\\/$%\`!]$`);
/** Tools whose whole purpose is to print shell setup for `eval "$(tool …)"`. */
const INIT_TOOLS = new RegExp('^\\$\\((?:[\\w./\\\\-]*[\\\\/])?(?:'
  + 'ssh-agent(?:\\s+-[a-z])*'
  + '|direnv\\s+hook\\s+\\w+'
  + '|fnm\\s+env(?:\\s+--?[\\w=-]+)*'
  + '|(?:pyenv|rbenv|nodenv)\\s+init(?:\\s+-)?(?:\\s+--?[\\w-]+)*'
  + '|brew\\s+shellenv'
  + '|(?:zoxide|starship)\\s+init\\s+\\w+(?:\\s+--?[\\w-]+)*'
  + '|(?:mise|rtx)\\s+activate\\s+\\w+'
  + '|conda\\s+shell\\.\\w+\\s+hook'
  + '|opam\\s+env(?:\\s+--?[\\w=-]+)*'
  + '|(?:gh|kubectl|helm|rustup|poetry|pnpm|npm|bun|deno)\\s+completion(?:\\s+--?[\\w-]+)*(?:\\s+\\w+)?'
  + ')\\)$');
/** PowerShell programs that run a script block given to them. */
const BLOCK_RUNNERS = new Set(['invoke-command', 'icm', 'start-job', 'start-threadjob']);
/** A delete target that is nothing but a variable or a substitution: if it is empty or unexpected, the delete reaches a root. */
const TARGET_FROM_VARIABLE = /^(?:\$\{?[\w:]+\}?|\$\(.*\)|`.*`|%[\w~:]+%|%%?\w|![\w]+!)[\\/]?\*?$/;
/** A recursive delete flag in sh, cmd and PowerShell. */
const RECURSIVE = (w: string): boolean => /^-[a-z]*r/.test(w) || w === '--recursive' || w === '/s' || /^-rec/.test(w);

const BUILT = 'the program it runs is only known when it runs (it is built from a variable or another command)';
const PIPED = 'it runs the output of another command as a script, which cannot be read before it runs';
const VAR_DELETE = 'what it deletes is only known when it runs (the folder comes from a variable)';

/** Whether `name` is assigned in the command itself (then `$name/…` is the agent's own text, not the system's folder). */
const assigned = (cmd: string, name: string): boolean => new RegExp(`(?:^|[\\s;&|])(?:export\\s+|set\\s+)?(?:\\$env:)?${name}\\s*=`, 'i').test(cmd);

/** The program a word names when it is a known folder variable in front of a written-out file, else undefined. */
function fromKnownFolder(w: string, cmd: string): string | undefined {
  const m = PATH_FROM_KNOWN.exec(w);
  if (!m) return undefined;
  return assigned(cmd, (m[1] ?? m[2] ?? '').replace(/\\/g, '')) ? undefined : program(w);
}

/**
 * Why the floor cannot judge this command by reading it, else undefined. `shell` is the shell that runs it: PowerShell
 * builds programs only through its call operators, iex and script blocks (`$i++` and `[math]::Round(1)` are expressions);
 * sh and cmd run a program word made from a variable. Variables and substitutions in ARGUMENTS are ordinary and pass.
 */
export function unjudgeableCommand(cmd: string, shell: ShellKind = 'sh', depth = 0): string | undefined {
  if (cmd.length > MAX_READABLE) return `it is too long to read safely (${cmd.length.toLocaleString('en-US')} characters)`;
  if (depth > 3) return 'it nests commands too deeply to read';
  // `iex(irm …)` is `iex (irm …)`
  const text = unglue(joinLines(cmd)).replace(/\b(iex|invoke-expression)\(/gi, '$1 (');
  // a substitution is judged on its own below; while the words are read it is one word ($S), so `$(git describe)` stays
  // whole; the setup printed by an init tool (`eval "$(ssh-agent -s)"`) is a plain word
  const flat = text.replace(new RegExp(INIT_TOOLS.source.slice(1, -1), 'gi'), 'init-setup').replace(/\$\([^()]*\)|`[^`]*`/g, '$S');
  for (const segment of splitOutside(flat, shell === 'pwsh' ? PS_SEGMENTS : SEGMENTS)) {
    const stages = splitOutside(segment, PIPE);
    for (let s = 0; s < stages.length; s++) {
      const why = shell === 'pwsh' ? psStage(stages[s]!, text, depth) : shStage(stages[s]!, text, shell, depth);
      if (why) return why;
      const ws = words(stages[s]!);
      // `printf "ls\n" | bash` runs text that is on the line (refuseCatastrophic reads it); anything else is unseen
      if (s > 0 && runsStdin(ws) && literalOutput(stages[s - 1]!) === undefined) return PIPED;
    }
  }
  // a substitution's own text is a command too
  for (const m of text.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = unjudgeableCommand(m[1] ?? m[2] ?? '', shell === 'pwsh' && m[1] !== undefined ? 'pwsh' : 'sh', depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

/** The kind of shell a word in command position starts, for the text after its command flag. */
const shellOf = (p: string, fallback: ShellKind): ShellKind => (p === 'powershell' || p === 'pwsh' ? 'pwsh' : p === 'cmd' ? 'cmd' : SHELLS.has(p) ? 'sh' : fallback);

/** One pipeline stage of a POSIX sh or cmd command. */
function shStage(stage: string, all: string, shell: ShellKind, depth: number): string | undefined {
  let ws = words(stage).map((w) => w.replace(/^@/, ''));
  // leading assignments (`VERSION=$(git describe) npm run build`), compound keywords and tests are not the program
  let k = 0;
  while (k < ws.length && (SH_KEYWORDS.has(ws[k]!) || /^[a-z_][a-z0-9_]*=/.test(ws[k]!) || /^\[\[?$|^\(\(/.test(ws[k]!))) k++;
  ws = ws.slice(k);
  if (!ws.length || /^\[/.test(ws[0]!)) return undefined; // a test: `[ -f x ]`, `[[ … ]]`
  const pos = commandPositions(ws);
  for (const [n, i] of pos.entries()) {
    const w = ws[i]!;
    const prev = n > 0 ? program(ws[pos[n - 1]!]!) : '';
    // after eval or iex, a parenthesised expression is the text that runs (`iex (irm https://…)`), not a subshell
    if (n > 0 && w.startsWith('(') && ['eval', 'iex', 'invoke-expression'].includes(prev)) return BUILT;
    if (INIT_TOOLS.test(w)) continue;
    // a shell's -c text is a command line of its own, in that shell's rules
    if (/\s/.test(w)) { const inner = unjudgeableCommand(w, shellOf(prev, shell), depth + 1); if (inner) return inner; continue; }
    // a subshell `(cd ui` names a plain program after its parenthesis
    const bare = w.replace(/^\(+/, '');
    if (!bare) continue;
    const known = fromKnownFolder(bare, all);
    const prog = known ?? program(bare);
    if (!known && BUILT_AT_RUN.test(bare)) return BUILT;
    if (!known && !/^[\w./\\:+~-]+$/.test(bare)) return BUILT;
    if (DELETE_VERBS.has(prog) && ws.slice(i + 1).some(RECURSIVE) && ws.slice(i + 1).some((x) => !/^-|^\/[a-z?]$/.test(x) && TARGET_FROM_VARIABLE.test(x))) return VAR_DELETE;
  }
  // `bash <(curl …)`, `source <(…)`: a script made by another command
  const last = pos[pos.length - 1];
  const runner = last === undefined ? '' : program(ws[last]!);
  if ((STDIN_RUNNERS.has(runner) || runner === 'source' || runner === '.') && ws.some((x) => x.startsWith('<('))) return PIPED;
  return undefined;
}

/** One pipeline stage of a PowerShell command. */
function psStage(stage: string, all: string, depth: number): string | undefined {
  let ws = words(stage);
  // keywords, conditions in parentheses and assignments (`$x = …`, `$env:X='y'`) come before the statement itself
  let k = 0;
  for (;;) {
    const w = ws[k];
    if (w === undefined) break;
    if (PS_KEYWORDS.has(w) || /^\$[\w:{}]+=/.test(w)) { k++; continue; }
    if (w.startsWith('$') && ws[k + 1] === '=') { k += 2; continue; }
    if (w.startsWith('(') && k > 0 && CONDITION_KEYWORDS.has(ws[k - 1]!)) { k++; continue; }
    break;
  }
  ws = ws.slice(k);
  if (!ws.length) return undefined;
  const raw = stage.toLowerCase();
  // a script built from text and run: [scriptblock]::Create(…), [powershell]::Create(), .Invoke()
  if (/\[(?:system\.management\.automation\.)?(?:scriptblock|powershell)\]::create\b/.test(raw)) return 'it builds a script from text and runs it';
  const head = ws[0]!;
  // the call operators run what follows them: & $cmd, & ('r'+'m'), . { … } (a written-out path is readable)
  if (head === '&' || head === '.') {
    const target = ws[1] ?? '';
    if (fromKnownFolder(target, all)) return undefined;
    if (/^[$({[]/.test(target) || BUILT_AT_RUN.test(target)) return BUILT;
    return undefined;
  }
  // an expression statement ($x + 1, $i++, [math]::Round(1), (Get-Date).Year, "text") runs no program
  if (/^[$([\d"']/.test(head)) return undefined;
  const prog = program(head);
  if (['iex', 'invoke-expression'].includes(prog)) {
    const arg = ws.slice(1).filter((w) => !w.startsWith('-'))[0];
    if (arg === undefined) return undefined; // `… | iex`: the stdin check reads it
    if (/^[$(]/.test(arg) || arg.includes('(')) return BUILT;
    return unjudgeableCommand(arg, 'pwsh', depth + 1);
  }
  if (BLOCK_RUNNERS.has(prog) && ws.slice(1).some((x) => x.startsWith('{') || x === '-scriptblock')) return 'it runs a PowerShell script block, which is only known when it runs';
  if (DELETE_VERBS.has(prog) && ws.slice(1).some(RECURSIVE)) {
    // Remove-Item -Recurse (Get-PSDrive C).Root, or $target: the folder is only known when it runs
    const targets = ws.slice(1).filter((w) => !w.startsWith('-'));
    if (targets.some((w) => w.startsWith('(') || (TARGET_FROM_VARIABLE.test(w) && !fromKnownFolder(w, all)))) return VAR_DELETE;
  }
  // powershell -c "…", bash -c "…": the inner text in its own shell's rules
  for (const [n, w] of ws.entries()) if (n > 0 && /\s/.test(w) && SHELL_COMMAND_FLAGS.has(ws[n - 1]!)) {
    const inner = unjudgeableCommand(w, shellOf(program(ws[n - 2] ?? ''), 'pwsh'), depth + 1);
    if (inner) return inner;
  }
  return undefined;
}
