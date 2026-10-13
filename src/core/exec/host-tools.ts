/**
 * The host shell/file tools ("host" MCP server): let an agent run a command and read/write files on THIS machine, so
 * it can work here the way a coding agent does. Everything runs behind the engine's approval gate: the tool names are
 * deliberately NOT Legion's own (`mcp__legion__*` would pass for Legion's and skip the card), so `needsApproval`
 * raises a card before a call and `taintsRun` marks the run. `read_file`/`write_file`/`shell` are confined to a scope
 * root; the approval card is the human's check on what the command actually does.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ExecutionBackend } from './types.js';
import { clampExecLimits, type ExecLimits } from './limits.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

export interface HostToolsCtx {
  agentId: string;
  taskId: string;
  /** Where commands run and file paths must stay: the task workspace / repo root. */
  rootDir: string;
  backend: ExecutionBackend;
  /** Tunable limits (timeout, output window, write cap). Clamped to defaults when omitted. */
  limits?: ExecLimits;
  /** Takes every secret Legion holds out of text before the model sees it (output, file text, spills, errors). Omitted: text is returned as is. */
  redact?: (text: string) => string;
  /** .env files: 'allow' reads them as written; 'masked' (default) hides their values everywhere and refuses writes; 'block' refuses them outright. */
  envFiles?: 'allow' | 'masked' | 'block';
}

/** A secrets file: `.env`, `.env.local`, `.env.production`… but not a shared template (`.env.example`, `.sample`, `.template`, `.dist`). */
export function isEnvFile(p: string): boolean {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? '';
  return /^\.env(?:\.[^/]+)?$/i.test(base) && !/\.(?:example|sample|template|dist)$/i.test(base);
}

/**
 * Whether a command line names a secrets file — or a wildcard that can reach one (`.env*`, `.env.?`). For 'masked' and
 * 'block' such a command is refused rather than guessed at: a rename or a copy would otherwise take the values out.
 */
export function mentionsEnvFile(cmd: string): boolean {
  for (const m of cmd.matchAll(/(?:^|[\s'"=/\\(<>|;&])(\.env[\w.*?[\]-]*)(?=$|[\s'"/\\)<>|;&])/gi)) {
    const t = m[1]!;
    if (/[*?[\]]/.test(t) || isEnvFile(t)) return true;
  }
  return false;
}

const ENV_LINE = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*)(.*)$/;

/**
 * The entries of a .env text: each assignment's prefix (`KEY=`), its value, and how many lines it spans. A quoted value may
 * run over several lines (a PEM key) and keeps its inner text; an unquoted value ends at an inline ` # comment`.
 */
function envEntries(text: string): Array<{ line: number; prefix: string; value: string; lines: number }> {
  const lines = text.split('\n');
  const out: Array<{ line: number; prefix: string; value: string; lines: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ENV_LINE.exec(lines[i]!);
    if (!m) continue;
    const raw = m[2]!.trim();
    const q = raw[0] === '"' || raw[0] === "'" ? raw[0] : undefined;
    if (q) {
      const close = raw.indexOf(q, 1);
      if (close > 0) { out.push({ line: i, prefix: m[1]!, value: raw.slice(1, close), lines: 1 }); continue; }
      // the value goes on until a line holding the closing quote
      const parts = [raw.slice(1)];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const at = lines[j]!.indexOf(q);
        if (at >= 0) { parts.push(lines[j]!.slice(0, at)); break; }
        parts.push(lines[j]!);
      }
      out.push({ line: i, prefix: m[1]!, value: parts.join('\n'), lines: Math.min(j, lines.length - 1) - i + 1 });
      i = j;
      continue;
    }
    out.push({ line: i, prefix: m[1]!, value: raw.replace(/\s+#.*$/, ''), lines: 1 });
  }
  return out;
}

/** A .env text with every value replaced: names, comments and blank lines stay, so the agent still sees what is configured. */
export function maskEnvText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const at = new Map(envEntries(text).map((e) => [e.line, e]));
  for (let i = 0; i < lines.length; i++) {
    const e = at.get(i);
    if (!e) { out.push(lines[i]!); continue; }
    out.push(e.value.trim() ? `${e.prefix}[masked]` : lines[i]!);
    i += e.lines - 1; // the lines of a multi-line value are not shown at all
  }
  return out.join('\n');
}

/** The values of one root's secrets files: `values` for exact redaction (8+ chars), `short` for whole-word redaction. */
interface EnvSecrets { values: string[]; short: string[] }
const envCache = new Map<string, { at: number; secrets: EnvSecrets }>();

/** A key that names a secret. A short value under any other key (PORT=3000, MODE=dev) is ordinary text and stays readable. */
const SECRET_KEY = /(?:secret|token|pass(?:word|wd|phrase)?|pwd|pin|key|auth|credential|private|salt|otp|cookie|session)/i;
/** Below this a value is too likely to be a common word or number to hide anywhere. */
const SHORT_MIN = 4;

/**
 * Every value in the secrets files under `root` (two levels deep, without node_modules and .git), for redaction.
 * Read again at most every 2 s per root: one tool call redacts several texts, and a broad root must not stall the core.
 */
function envValues(root: string): EnvSecrets {
  const hit = envCache.get(root);
  if (hit && Date.now() - hit.at < 2000) return hit.secrets;
  const secrets = scanEnvValues(root);
  envCache.set(root, { at: Date.now(), secrets });
  return secrets;
}

/** Replaces each short secret where it stands as a whole word (not inside a longer word or number). */
export function redactShortValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    if (!out.includes(v)) continue;
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'g'), '[redacted-secret]');
  }
  return out;
}

function scanEnvValues(root: string): EnvSecrets {
  const out: string[] = [];
  const short: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      if (isEnvFile(n)) {
        try {
          for (const e of envEntries(readFileSync(p, 'utf8'))) {
            // the whole value, and each of its lines (a program may print a multi-line value one line at a time)
            if (e.value) out.push(e.value, ...e.value.split('\n').map((l) => l.trim()));
            const v = e.value.trim();
            const key = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(e.prefix)?.[1] ?? '';
            if (v.length >= SHORT_MIN && v.length < 8 && SECRET_KEY.test(key)) short.push(v);
          }
        } catch { /* unreadable: nothing to hide */ }
      } else if (depth < 2 && n !== 'node_modules' && n !== '.git') {
        try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* skip */ }
      }
    }
  };
  walk(root, 0);
  return { values: out, short };
}

/**
 * On Windows the agent shell's own tools print paths the Git Bash way (`pwd` gives `/d/work/site`, or `/tmp/x` for the
 * temp folder). Those name the same files as `D:\work\site` and `%TEMP%\x`, so the file tools read them that way rather
 * than as a folder `\d\work` on the current drive. Elsewhere a path is taken as written.
 */
export function nativePath(p: string): string {
  if (process.platform !== 'win32') return p;
  const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (drive) return `${drive[1]!.toUpperCase()}:${drive[2] ?? '/'}`;
  if (p === '/tmp' || p.startsWith('/tmp/')) return join(tmpdir(), p.slice(4));
  return p;
}

const isInside = (r: string, t: string): boolean => {
  // Windows paths compare without case (C:\Work and c:\work are one folder)
  const [a, b] = process.platform === 'win32' ? [r.toLowerCase(), t.toLowerCase()] : [r, t];
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
};

/** The real path of `p`, or of its nearest existing ancestor with the rest appended; undefined when nothing on the way exists. */
function realOf(p: string): string | undefined {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(cur), ...rest.reverse()); } catch { /* not there yet: try the parent */ }
    const up = dirname(cur);
    if (up === cur) return undefined;
    rest.push(cur.slice(up.length).replace(/^[\\/]+/, ''));
    cur = up;
  }
}

/**
 * Resolve `target` against `root`, and refuse anything that escapes it: first by the path as written (`..`, another
 * drive, UNC), then by the REAL path, so a symlink or junction inside the root that points outside it is refused too.
 * The real check uses the nearest existing ancestor, so a file about to be created under a link is caught as well.
 */
export function resolveWithin(root: string, target: string): string {
  const r = resolve(root);
  const t = resolve(r, nativePath(target));
  if (!isInside(r, t)) throw new Error(`Path "${target}" is outside the allowed root`);
  const realRoot = realOf(r);
  const realTarget = realOf(t);
  if (realRoot && realTarget && !isInside(realRoot, realTarget)) throw new Error(`Path "${target}" leads outside the allowed root through a link`);
  return t;
}

const tail = (s: string, max: number): string =>
  (s.length <= max ? s : `[truncated: last ${max} of ${s.length} chars]\n` + s.slice(-max));

let spillN = 0;
/** Most spill files kept: the oldest are dropped so a long session cannot grow without bound. */
const SPILL_KEEP_FILES = 50;

/**
 * A hard safety floor (the Wipe Lesson): command shapes that can destroy the machine or its data irrecoverably. They
 * are refused for EVERY agent — a full-access tier forgives the approval card, not the machine. This is the one check
 * an approval cannot override. Matched conservatively: it must never block ordinary work (rm of a project folder, git,
 * builds all pass through).
 */
/** Commands that are catastrophic by themselves: judged where a command runs, so a note or a grep pattern naming one passes. */
const CATASTROPHIC_COMMANDS: Array<[RegExp, string]> = [
  [/\bmkfs(?:\.\w+)?\b/i, 'formatting a filesystem'],
  [/\bdd\b[^|&;\n]*\bof\s*=\s*['"]?\/dev\//i, 'raw write to a device'],
  [/\bformat(?:\.com)?\s+['"]?[A-Za-z]:/i, 'formatting a drive'],
  [/\bdiskpart\b/i, 'disk partitioning'],
  [/\b(?:shred|wipefs|blkdiscard)\b[^|&;\n]*\/dev\//i, 'wiping a disk device'],
];
/** Shapes that are not words (a fork bomb, a redirect onto a disk): matched anywhere on the line. */
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'a fork bomb'],
  [/>\s*['"]?\/dev\/(?:sd|hd|nvme|mmcblk|vd)[a-z0-9]*['"]?\s*$/i, 'overwriting a block device'],
];

/**
 * Whole-machine Windows tools (the shell tool runs cmd.exe there): no target is needed for these to be catastrophic.
 * Matched on the normalised text (lower case, cmd's ^ escapes and quotes removed).
 */
const CATASTROPHIC_WINDOWS: Array<[RegExp, string]> = [
  [/\bvssadmin\s+delete\s+shadows\b/, 'deleting the system restore copies'],
  [/\bwmic\s+shadowcopy\s+delete\b/, 'deleting the system restore copies'],
  [/\bwbadmin\s+delete\b/, 'deleting the backups'],
  [/\bbcdedit\s+\/delete\b/, 'deleting a boot entry'],
  [/\breg(?:\.exe)?\s+delete\s+(?:hklm|hkey_local_machine)\\(?:system|software|sam|security)\b/, 'deleting a core part of the registry'],
  [/\bcipher(?:\.exe)?\s+\/w\b/, 'wiping a drive\'s free space'],
  [/\b(?:format-volume|clear-disk|initialize-disk|remove-partition)\b/, 'formatting or wiping a disk'],
];

/** Programs that run TEXT as a command (besides the shells): only for these is a quoted string judged as a command of its own. */
const TEXT_RUNNERS = new Set(['eval', 'iex', 'invoke-expression', 'ssh', 'su', 'wsl', 'xargs', 'start', 'watch', 'source', '.', 'runas', 'call', 'invoke-command', 'start-process']);

/** Delete commands of sh, cmd and PowerShell (with its aliases). */
const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri']);
/** PowerShell's listers: `gci C:\ | Remove-Item` deletes what they list. */
const LIST_VERBS = new Set(['get-childitem', 'gci', 'dir', 'ls']);
/** cmd's commands among them, whose options are written /s, /q: a one-letter /x word after them is a switch. */
const CMD_SWITCH_VERBS = new Set(['rd', 'rmdir', 'del', 'erase', 'dir']);

/**
 * A command line as words, the way a shell joins them: quoted and unquoted parts that touch are ONE word (`"r"m` is `rm`),
 * quotes keep spaces inside a word, and are then dropped; cmd's ^ escape is removed. Lower case.
 */
function words(segment: string): string[] {
  return (segment.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map((w) => w.replace(/["'^]/g, '').toLowerCase()).filter(Boolean);
}

/** A line continuation (sh's backslash-newline, PowerShell's backtick-newline) joins two lines into one command: read it joined. */
const joinLines = (cmd: string): string => cmd.replace(/[\\`]\r?\n/g, '');

/**
 * The program a word names: `/bin/rm` and `C:\Windows\System32\cmd.exe` are `rm` and `cmd`. A backslash in a word with
 * no drive or slash is sh's escape, not a folder separator: `r\m` runs `rm`.
 */
const program = (w: string): string => (/^[a-z]:|\//.test(w) ? w : w.replace(/\\/g, '')).replace(/^.*[\\/]/, '').replace(/\.exe$/, '');

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

/**
 * A path whose recursive deletion destroys the machine or a person's data: a drive or file-system root, a system
 * folder, a home folder (or its root), each optionally followed by a separator and a wildcard. A folder INSIDE a
 * home or a project is not one of these: deleting `~/proj/build` or `C:\proj\build` is ordinary work.
 */
function isProtectedTarget(word: string): boolean {
  // PowerShell's -Path:C:\ form, and the \\?\ and \\.\ device prefixes, name the same folder
  const bare = word.replace(/^-(?:literal)?path:/, '').replace(/^[\\/]{2}[?.][\\/]/, '');
  // a whole drive through an admin share (\\localhost\c$)
  if (/^[\\/]{2}[^\\/]+[\\/][a-z]\$[\\/]?\*?$/.test(bare)) return true;
  // every dot-file of a home (~/.*): the configuration of every program the person uses
  if (/^(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)[\\/]\.\*$/.test(bare)) return true;
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
  if (/^(?:~|\$home|\$\{home\})$/.test(w)) return true;
  if (/^[a-z]:(?:\*(?:\.\*)?)?$/.test(w)) return true;
  if (/^[a-z]:\/(?:windows|users|program files|program files \(x86\)|programdata)$/.test(w)) return true;
  if (/^[a-z]:\/users\/[^/]+$/.test(w)) return true;
  if (/^%(?:userprofile|systemroot|windir|systemdrive|programfiles|programdata|homedrive%%homepath)%$/.test(w)) return true;
  if (/^\$env:(?:userprofile|systemroot|windir|systemdrive|programfiles|programdata|homedrive)$/.test(w)) return true;
  // the same variables as sh writes them (Git Bash inherits the Windows environment)
  if (/^\$(?:\{(?:userprofile|systemroot|windir|systemdrive|programfiles|programdata|homedrive)\}|(?:userprofile|systemroot|windir|systemdrive|programfiles|programdata|homedrive))$/.test(w)) return true;
  return false;
}

/** Programs that run the rest of the line as the command (`sudo rm …` is an rm); their own options are skipped. */
const WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time', 'xargs',
  'timeout', 'stdbuf', 'setsid', 'ionice', 'chroot', 'flock', 'strace', 'ltrace', 'busybox', 'taskset', 'chrt', 'unbuffer', 'caffeinate',
  // cmd's call and start, and wsl, run the command that follows them; eval and PowerShell's iex run their words as a command
  'call', 'start', 'wsl', 'eval', 'iex', 'invoke-expression',
]);
const WRAPPER_OPTS_WITH_ARG = new Set(['-u', '-g', '-p', '-h', '-n', '-s', '-k', '-o', '-e', '-c', '-w', '-t', '-d', '--distribution', '--user', '--cd', '--signal', '--kill-after']);
/** Wrappers whose first plain word is their own argument, not the command (`timeout 5 rm`, `chroot / rm`, `flock lockfile rm`). */
const WRAPPER_TAKES_ONE = new Set(['timeout', 'chroot', 'flock', 'taskset', 'chrt']);
/** cmd's call and start take /x switches (`start /b`). */
const SLASH_OPTION_WRAPPERS = new Set(['call', 'start']);
/** PowerShell options that take a value. */
const PS_OPTS_WITH_ARG = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-outputformat', '-of', '-inputformat', '-if', '-configurationname', '-workingdirectory', '-wd', '-settingsfile', '-version', '-v']);
/** Shells that run the command line after their command flag (`bash -c`, `cmd /c`, `powershell -Command`). */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command']);
const FIND_VERB = new Set(['find']);

/**
 * The words of a stage that are in command position, i.e. that RUN: the first word, the word after a wrapper and its
 * options, the word after a shell's command flag, and the word after find's -exec. A delete word anywhere else is data
 * (`grep rm /etc`, `findstr del`, a commit message) and never makes a command catastrophic.
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
      while (i < ws.length && opt(ws[i]!)) { if (WRAPPER_OPTS_WITH_ARG.has(ws[i++]!)) i++; }
      if (WRAPPER_TAKES_ONE.has(p) && i < ws.length) { i++; while (i < ws.length && ws[i]!.startsWith('-')) i++; }
      continue;
    }
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

/** Why one command segment (no ; & && || or newline in it) is catastrophic, else undefined. */
function refuseSegment(segment: string): string | undefined {
  // a pipeline is judged whole: PowerShell's `gci C:\ | Remove-Item` lists in one stage and deletes in the next
  const stages = segment.split('|').map(words);
  const runs = (ws: readonly string[], verbs: ReadonlySet<string>): number[] => commandPositions(ws).filter((i) => verbs.has(program(ws[i]!)));
  // cmd's own commands take /s, /q, /a:h switches: there such a word is an option, not Git Bash's /s drive
  const targetsAfter = (ws: readonly string[], i: number): boolean => {
    const switches = CMD_SWITCH_VERBS.has(program(ws[i]!));
    return ws.slice(i + 1).some((w) => !(switches && /^\/[a-z?](?::\S*)?$/.test(w)) && isProtectedTarget(w));
  };
  // the plain words after position i (no options), for commands where only one of them is the target
  const plain = (ws: readonly string[], i: number): string[] => ws.slice(i + 1).filter((w) => !w.startsWith('-') && !/^\/[a-z]+(?::\S*)?$/.test(w));
  for (const ws of stages) {
    if (runs(ws, DELETE_VERBS).some((i) => targetsAfter(ws, i))) return 'a recursive delete of a drive, a system folder or a home folder';
    // mirroring an empty folder onto a drive or a home deletes everything in it (robocopy /MIR or /PURGE: the destination is the second path)
    if (runs(ws, new Set(['robocopy'])).some((i) => ws.some((w) => w === '/mir' || w === '/purge') && isProtectedTarget(plain(ws, i)[1] ?? ''))) return 'mirroring over a drive, a system folder or a home folder (it deletes what is not in the source)';
    if (runs(ws, new Set(['rsync'])).some((i) => ws.some((w) => w.startsWith('--delete')) && isProtectedTarget(plain(ws, i).at(-1) ?? ''))) return 'mirroring over a drive, a system folder or a home folder (it deletes what is not in the source)';
    // taking away every permission or owner of a drive or a home locks the person out of it
    if (runs(ws, new Set(['chmod', 'chown', 'chgrp', 'setfacl'])).some((i) => ws.some((w) => /^-[a-z]*r/.test(w) || w === '--recursive') && targetsAfter(ws, i))) return 'changing the permissions of a whole drive, system folder or home folder';
    if (runs(ws, new Set(['icacls', 'takeown'])).some((i) => ws.some((w) => w === '/t' || w === '/r') && targetsAfter(ws, i))) return 'changing the permissions of a whole drive, system folder or home folder';
    // moving a drive, a system folder or a home away (mv ~ /dev/null) is a delete too: the first path is what moves
    if (runs(ws, new Set(['mv', 'move', 'move-item', 'mi'])).some((i) => isProtectedTarget(plain(ws, i)[0] ?? ''))) return 'moving a drive, a system folder or a home folder away';
    // git clean -fdx in a drive root deletes every file git does not track there
    if (runs(ws, new Set(['git'])).some((i) => ws.includes('clean') && ws.some((w, j) => w === '-c' && j > i && isProtectedTarget(ws[j + 1] ?? '')))) return 'cleaning a drive, a system folder or a home folder with git';
    const deletes = ws.includes('-delete') || ws.some((w, i) => (w === '-exec' || w === '-execdir') && DELETE_VERBS.has(program(ws[i + 1] ?? '')));
    if (deletes && runs(ws, FIND_VERB).some((i) => targetsAfter(ws, i))) return 'deleting everything under a drive, a system folder or a home folder';
  }
  if (stages.length > 1) {
    const lists = stages.slice(0, -1).some((ws) => runs(ws, LIST_VERBS).some((i) => targetsAfter(ws, i)));
    const deletes = stages.slice(1).some((ws) => runs(ws, DELETE_VERBS).length > 0);
    if (lists && deletes) return 'a recursive delete of a drive, a system folder or a home folder';
  }
  return undefined;
}

/**
 * The refusal reason when a command is catastrophic, else undefined.
 *
 * Known limit, stated rather than hidden: this is a list of shapes, so a command that builds its payload at run time
 * (`echo <base64> | base64 -d | sh`, a script file it wrote first) is not seen. Only a sandboxed backend closes that;
 * until one exists, a full-access agent with the host shell can do anything the user can.
 */
/** Whether some command position on the line is a shell or another program that runs text as a command. */
function runsText(cmd: string): boolean {
  for (const seg of cmd.split(/&&|\|\||[;&|\n\r]/)) {
    const ws = words(seg);
    if (commandPositions(ws).some((i) => { const p = program(ws[i]!); return SHELLS.has(p) || TEXT_RUNNERS.has(p); })) return true;
  }
  return false;
}

/** Programs that read a script from standard input when no command flag or script file is given (`curl … | bash`). */
const STDIN_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'python', 'python3', 'node', 'perl', 'ruby']);
/** Flags after which such a program runs the next word, not standard input. */
const INLINE_FLAGS = new Set([...SHELL_COMMAND_FLAGS, '-e', '--eval', '-p', '--print', '-file', '-f']);

/** Whether this pipeline stage hands its standard input to a shell or interpreter as a script. */
function runsStdin(ws: readonly string[]): boolean {
  const pos = commandPositions(ws);
  const last = pos[pos.length - 1];
  if (last === undefined) return false;
  const p = program(ws[last]!);
  // `… | xargs sh -c`: xargs hands the text to the shell's -c as the command (the -c has nothing after it on the line)
  if (pos.some((i, n) => n > 0 && SHELLS.has(program(ws[i]!)) && program(ws[pos[n - 1]!]!) === 'xargs') && SHELL_COMMAND_FLAGS.has(ws[ws.length - 1]!)) return true;
  if (!STDIN_RUNNERS.has(p)) return false;
  const after = ws.slice(last + 1);
  // `bash -n` only checks the syntax; it runs nothing
  if (after.includes('-n') && SHELLS.has(p)) return false;
  // `bash -s`, `python -` and option-only forms read the script from stdin; a script file or an inline command does not
  return after.every((w) => w.startsWith('-') && !INLINE_FLAGS.has(w));
}

/** Where one command ends and the next begins: ; & && || newlines, and the body after do, then or else. */
const SEGMENTS = /&&|\|\||[;&\n\r]|\s(?:do|then|else)\s/;

/** The text an echo or printf stage writes, when it is written out on the line (no variable, substitution or escape). */
function literalOutput(stage: string): string | undefined {
  const ws = words(stage);
  if (!['echo', 'printf'].includes(program(ws[0] ?? ''))) return undefined;
  if (/[$`]|\\[0-7xuUe]/.test(stage)) return undefined;
  return ws.slice(1).filter((w) => !/^-[a-z]+$/.test(w)).join(' ');
}

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
  for (const segment of joinLines(cmd).split(SEGMENTS)) {
    const stages = segment.split('|').map(words);
    for (const ws of stages) {
      if (commandPositions(ws).some((i) => { const p = program(ws[i]!); return (p === 'powershell' || p === 'pwsh') && ws.slice(i + 1).some((w) => PS_ENCODED.test(w)); })) return 'running a hidden (encoded) PowerShell command';
    }
    for (let s = 1; s < stages.length; s++) if (runsStdin(stages[s]!) && stages.slice(0, s).some(DECODES)) return 'running decoded text as a command';
  }
  return undefined;
}

/** Words that open a compound command rather than name a program (`do rm …` runs rm). */
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'elseif', 'if', 'while', 'until', 'switch', 'foreach', 'for', '!', '{', '}', '(', 'time']);
/** Keywords followed by a condition in parentheses (PowerShell `if ($x) { … }`): the condition is not the program. */
const CONDITION_KEYWORDS = new Set(['if', 'elseif', 'while', 'switch', 'foreach', 'for']);
/** A program word only known when the command runs: a variable or substitution ($, backtick), cmd's %VAR% and !VAR!, or a brace expansion. */
const BUILT_AT_RUN = /[$`]|%[^%\s]+%|![^!\s]+!|^\{[^}]*,[^}]*\}$/;
/** A program named by a variable that is only the folder in front of a written-out file name (`$HOME/.local/bin/tool`, `"%ProgramFiles%\Git\bin\git.exe"`). */
const PATH_FROM_VARIABLE = /^(?:\$\{?[a-z_][\w:]*\}?|%[a-z_][\w()]*%)[\\/][^$%`!]*[^\\/$%`!]$/;
/** Tools whose whole purpose is to print shell setup for `eval "$(tool …)"`: the usual way to start an agent or a version manager. */
const INIT_TOOLS = /^\$\((?:ssh-agent|direnv|fnm|pyenv|rbenv|nodenv|brew|zoxide|starship|mise|rtx|conda|opam)\b[^()]*\)$/;
/** Programs that run the rest of their line as a command of its own. */
const EVAL_RUNNERS = new Set(['eval', 'iex', 'invoke-expression', 'source', '.']);
/** PowerShell programs that run a script block given to them. */
const BLOCK_RUNNERS = new Set(['invoke-command', 'icm', 'start-job', 'start-threadjob']);
/** A delete target that is nothing but a variable or a substitution: if it is empty or unexpected, the delete reaches a root. */
const TARGET_FROM_VARIABLE = /^(?:\$\{?[\w:]+\}?|\$\(.*\)|`.*`|%[\w~:]+%|%%?\w|![\w]+!)[\\/]?\*?$/;

/**
 * Why the guard cannot judge this command by reading it, else undefined. The safety floor reads commands; a command
 * whose PROGRAM is built when it runs (`$(echo rm) -rf /c`, `x=rm; $x`, `{rm,-rf,/c}`, `%X%`) or that runs another
 * command's output as a script (`curl … | bash`) could be anything, so it needs the owner's approval card in every
 * approval mode (Full included). Fail closed: an unreadable command is asked about, never assumed safe. Variables and
 * substitutions in ARGUMENTS (`echo $HOME`, `git commit -m "$(date)"`) are ordinary and pass.
 */
export function unjudgeableCommand(cmd: string, depth = 0): string | undefined {
  if (depth > 3) return 'it nests commands too deeply to read';
  const built = 'the program it runs is only known when it runs (it is built from a variable or another command)';
  const piped = 'it runs the output of another command as a script, which cannot be read before it runs';
  for (const segment of joinLines(cmd).split(SEGMENTS)) {
    const stages = segment.split('|');
    for (let s = 0; s < stages.length; s++) {
      let ws = words(stages[s]!);
      // leading assignments (`VERSION=$(git describe) npm run build`, PowerShell `$env:X='y'` and `$r = …`), compound
      // keywords and a condition in parentheses (`if ($x) {`) are not the program
      let k = 0;
      for (;;) {
        const w = ws[k];
        if (w === undefined) break;
        if (SHELL_KEYWORDS.has(w) || /^[a-z_][a-z0-9_]*=/.test(w) || /^\$[\w:{}]+=/.test(w)) { k++; continue; }
        if (w.startsWith('$') && ws[k + 1] === '=') { k += 2; continue; }
        if (w.startsWith('(') && k > 0 && CONDITION_KEYWORDS.has(ws[k - 1]!)) { k++; continue; }
        break;
      }
      ws = ws.slice(k);
      if (!ws.length) continue;
      const pos = commandPositions(ws);
      for (const [n, i] of pos.entries()) {
        const w = ws[i]!;
        // after eval or iex, a parenthesised expression is the text that runs (`iex (irm https://…)`), not a subshell
        if (n > 0 && w.startsWith('(') && ['eval', 'iex', 'invoke-expression'].includes(program(ws[pos[n - 1]!]!))) return built;
        if (INIT_TOOLS.test(w)) continue;
        // a shell's -c text is a command line of its own: read it, rather than calling every $ in it a program
        if (/\s/.test(w)) { const inner = unjudgeableCommand(w, depth + 1); if (inner) return inner; continue; }
        if (PATH_FROM_VARIABLE.test(w)) continue;
        if (BUILT_AT_RUN.test(w)) return built;
        // PowerShell builds a program from an expression: & ('r'+'m'), [scriptblock]::Create(…), iex (irm …). A subshell
        // `(cd ui` stays readable: what follows the parenthesis is a plain program name.
        if (/^[([]/.test(w) && !/^\(+[\w./\\:-]+$/.test(w)) return built;
        if (BLOCK_RUNNERS.has(program(w)) && ws.slice(i + 1).some((x) => x.startsWith('{') || x === '-scriptblock')) return 'it runs a PowerShell script block, which is only known when it runs';
        if (DELETE_VERBS.has(program(w)) && ws.slice(i + 1).some((x) => !/^-|^\/[a-z?]$/.test(x) && TARGET_FROM_VARIABLE.test(x))) return 'what it deletes is only known when it runs (the folder comes from a variable)';
      }
      // `bash <(curl …)`, `source <(…)`: a script made by another command
      const last = pos[pos.length - 1];
      const runner = last === undefined ? '' : program(ws[last]!);
      if ((STDIN_RUNNERS.has(runner) || runner === 'source' || runner === '.') && ws.some((x) => x.startsWith('<('))) return piped;
      // `printf "ls\n" | bash` runs text that is on the line (refuseCatastrophic reads it); anything else is unseen
      if (s > 0 && runsStdin(ws) && literalOutput(stages[s - 1]!) === undefined) return piped;
    }
  }
  // a substitution's own text is a command too
  for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = unjudgeableCommand(m[1] ?? m[2] ?? '', depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

export function refuseCatastrophic(raw: string, depth = 0): string | undefined {
  const cmd = joinLines(raw);
  const say = (what: string): string => `Refused: this command looks like ${what}, which can destroy the machine or its data. It is blocked for every agent, even full access.`;
  for (const [re, what] of CATASTROPHIC) {
    if (re.test(cmd)) return say(what);
  }
  const hidden = hiddenPayload(cmd);
  if (hidden) return `Refused: this command is ${hidden}. Text that is decoded or encoded cannot be read before it runs, so it is blocked for every agent, even full access. Run the command itself, written out plainly.`;
  // The whole-machine commands count anywhere on the line (behind `start ""`, `call`, `&`, a group, `timeout`…), except
  // inside quoted text of several words on a line that runs no text: a commit message or a grep pattern naming one is data.
  // A one-word quote (`format "c:"`) is kept, unquoted, so quoting a target cannot hide it.
  const scan = (runsText(cmd) ? cmd : cmd.replace(/"([^"]*)"|'([^']*)'/g, (_m, a?: string, b?: string) => (/\s/.test(a ?? b ?? '') ? ' ' : (a ?? b ?? ''))))
    .replace(/[\^"']/g, '').toLowerCase();
  for (const [re, what] of [...CATASTROPHIC_COMMANDS, ...CATASTROPHIC_WINDOWS]) {
    if (re.test(scan)) return say(what);
  }
  for (const segment of cmd.split(SEGMENTS)) {
    const why = refuseSegment(segment);
    if (why) return say(why);
  }
  // A quoted string keeps a path with spaces together, but it can also carry a whole command to a wrapper
  // (`powershell -c "Remove-Item …"`, `bash -c '…'`): each such string is judged as a command of its own.
  if (depth < 2) {
    for (const segment of cmd.split(SEGMENTS)) {
      const stages = segment.split('|');
      for (let s = 0; s < stages.length; s++) {
        const ws = words(stages[s]!);
        // a shell's -c text, joined as the shell joins it (`bash -c 'r''m -rf /c'`), is a command of its own
        for (const i of commandPositions(ws)) if (/\s/.test(ws[i]!)) { const inner = refuseCatastrophic(ws[i]!, depth + 1); if (inner) return inner; }
        // `echo rm -rf /c | sh` runs the echoed text
        const text = s > 0 && runsStdin(ws) ? literalOutput(stages[s - 1]!) : undefined;
        if (text) { const inner = refuseCatastrophic(text, depth + 1); if (inner) return inner; }
      }
    }
    // a command substitution runs its text as a command: `echo $(rm -rf /)`, backticks the same
    for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
      const inner = refuseCatastrophic(m[1] ?? m[2] ?? '', depth + 1);
      if (inner) return inner;
    }
    // one plain scan per quote (a pattern that also demands whitespace inside backtracks quadratically on an open quote);
    // only when something on the line runs text (a shell's -c, eval, ssh, a pipe into sh): a commit message is data
    if (runsText(cmd)) for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const text = m[1] ?? m[2] ?? '';
      if (!/\s/.test(text)) continue;
      const inner = refuseCatastrophic(text, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

async function pruneSpill(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.txt'));
    if (names.length <= SPILL_KEEP_FILES) return;
    const mtime = new Map<string, number>();
    for (const n of names) { try { mtime.set(n, (await stat(join(dir, n))).mtimeMs); } catch { /* skip */ } }
    const drop = [...mtime.entries()].sort((a, b) => a[1] - b[1]).slice(0, mtime.size - SPILL_KEEP_FILES);
    for (const [n] of drop) { try { await rm(join(dir, n), { force: true }); } catch { /* best effort */ } }
  } catch { /* cleanup is best-effort and must never fail the tool */ }
}

/**
 * The tool's text window. When the text is longer than `max`, the FULL text is spilled to a file inside the scope
 * root and the window carries a pointer to it — so nothing is silently lost (the agent can read_file the whole thing).
 * A cap that drops content without a pointer would lose work; this keeps every character retrievable.
 */
export async function windowOrSpill(text: string, rootDir: string, taskId: string, max: number): Promise<string> {
  if (text.length <= max) return text;
  const dir = join(rootDir, '.legion-output');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${taskId.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}-${++spillN}.txt`);
  await writeFile(file, text, 'utf8');
  await pruneSpill(dir);
  return `${tail(text, max)}\n[Legion kept the last ${max} of ${text.length} characters here; the full output is in ${file}]`;
}

/**
 * Takes the exact secret values out of a text (longest first, so a value that contains another goes whole). Exact
 * values only, never credential SHAPES: the shell reads and rewrites project files, and a shape rule would turn a
 * fixture's `token: '…'` or a checksum into a placeholder that a read-then-write puts back into the code.
 */
export function redactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...new Set(values)].filter((x) => typeof x === 'string' && x.length >= 8).sort((a, b) => b.length - a.length)) {
    if (out.includes(v)) out = out.split(v).join('[redacted-secret]');
  }
  return out;
}

export function buildHostToolsServer(ctx: HostToolsCtx): McpSdkServerConfigWithInstance {
  const limits = clampExecLimits(ctx.limits);
  const envMode = ctx.envFiles ?? 'masked';
  // the secrets Legion holds, and (unless the owner allowed .env files) every value in this root's .env files
  const redact = (s: string): string => {
    const t = ctx.redact ? ctx.redact(s) : s;
    if (envMode === 'allow') return t;
    const env = envValues(ctx.rootDir);
    return redactShortValues(redactValues(t, env.values), env.short);
  };
  const envRefusal = (what: string): Error => new Error(`This agent's setting for .env files is "${envMode}": it may not ${what} them. Change it in the agent's Shell settings, or do it yourself.`);
  // redacted on the way out, errors included; output and file text are redacted BEFORE the spill too, so the full
  // copy on disk (which read_file can bring back) never holds a secret either
  const run = async (fn: () => Promise<string>): Promise<ToolResult> => {
    try { return ok(redact(await fn())); } catch (e) { return fail(new Error(redact(e instanceof Error ? e.message : String(e)))); }
  };

  const shell = tool(
    'shell',
    'Run a shell command on this machine and return its exit code and output. A short timeout is enforced; the command is killed with its process tree if it overruns.',
    {
      command: z.string().min(1).describe('The shell command line'),
      cwd: z.string().optional().describe('Working directory (must stay inside the allowed root)'),
      timeoutSeconds: z.number().positive().max(3600).optional().describe(`Kill the command after this many seconds (default ${limits.timeoutSeconds})`),
    },
    (a) => run(async () => {
      // masked too: a command can rename, copy or print the file; read_file is the masked way to see it
      if (envMode !== 'allow' && mentionsEnvFile(a.command)) throw envMode === 'masked' ? new Error('This agent\'s setting for .env files is "masked": a command may not name one (it could copy, move or print it). Use read_file for a view with the values hidden, or change the setting in the agent\'s Shell settings.') : envRefusal('name');
      const bad = refuseCatastrophic(a.command);
      if (bad) throw new Error(bad);
      const cwd = a.cwd === undefined ? ctx.rootDir : resolveWithin(ctx.rootDir, a.cwd);
      const r = await ctx.backend.execute({ cmd: a.command, cwd, timeoutMs: (a.timeoutSeconds ?? limits.timeoutSeconds) * 1000 });
      const body = await windowOrSpill(redact(r.output), ctx.rootDir, ctx.taskId, limits.maxOutputChars);
      return `exit code: ${r.exit_code}${r.timedOut ? ' (timed out)' : ''}\n${body}`;
    }),
  );

  const readFileTool = tool(
    'read_file',
    'Read a UTF-8 text file on this machine (within the allowed root). A long file is returned in a window with a pointer to the full text, so nothing is lost.',
    { path: z.string().describe('File path (must stay inside the allowed root)') },
    (a) => run(async () => {
      const p = resolveWithin(ctx.rootDir, a.path);
      const env = isEnvFile(p);
      if (env && envMode === 'block') throw envRefusal('read');
      const text = await readFile(p, 'utf8');
      return windowOrSpill(redact(env && envMode === 'masked' ? maskEnvText(text) : text), ctx.rootDir, ctx.taskId, limits.maxOutputChars);
    }),
  );

  const writeFileTool = tool(
    'write_file',
    'Write a UTF-8 text file on this machine (within the allowed root). Overwrites the file.',
    {
      path: z.string().describe('File path (must stay inside the allowed root)'),
      content: z.string().describe('File content'),
    },
    (a) => run(async () => {
      if (a.content.length > limits.maxWriteChars) throw new Error(`Content is too large (${a.content.length} > ${limits.maxWriteChars} chars)`);
      const p = resolveWithin(ctx.rootDir, a.path);
      if (isEnvFile(p) && envMode !== 'allow') throw envRefusal('write');
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, a.content, 'utf8');
      return `Wrote ${a.content.length} chars to ${p}`;
    }),
  );

  return createSdkMcpServer({
    name: 'host',
    version: '0.1.0',
    alwaysLoad: true, // never deferred behind ToolSearch: agents call these directly
    tools: [shell, readFileTool, writeFileTool],
  });
}
