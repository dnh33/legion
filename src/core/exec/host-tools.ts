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

/** Whether a command line names a secrets file (for 'block': the command is refused rather than guessed at). */
export function mentionsEnvFile(cmd: string): boolean {
  for (const m of cmd.matchAll(/(?:^|[\s'"=/\\(<>|;&])(\.env(?:\.[\w.-]+)?)(?=$|[\s'"/\\)<>|;&])/gi)) if (isEnvFile(m[1]!)) return true;
  return false;
}

const ENV_LINE = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*)(.*)$/;

/** A .env text with every value replaced: names, comments and blank lines stay, so the agent still sees what is configured. */
export function maskEnvText(text: string): string {
  return text.split('\n').map((line) => { const m = ENV_LINE.exec(line); return m && m[2]!.trim() ? `${m[1]}[masked]` : line; }).join('\n');
}

/** Every value in the secrets files under `root` (two levels deep, without node_modules and .git), for exact redaction. */
function envValues(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      if (isEnvFile(n)) {
        try {
          for (const line of readFileSync(p, 'utf8').split('\n')) {
            const v = ENV_LINE.exec(line)?.[2]?.trim().replace(/^(['"])(.*)\1$/, '$2');
            if (v) out.push(v);
          }
        } catch { /* unreadable: nothing to hide */ }
      } else if (depth < 2 && n !== 'node_modules' && n !== '.git') {
        try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* skip */ }
      }
    }
  };
  walk(root, 0);
  return out;
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
  const t = resolve(r, target);
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
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/\bmkfs(?:\.\w+)?\b/i, 'formatting a filesystem'],
  [/\bdd\b[^|&;\n]*\bof\s*=\s*['"]?\/dev\//i, 'raw write to a device'],
  [/\bformat(?:\.com)?\s+['"]?[A-Za-z]:/i, 'formatting a drive'],
  [/\bdiskpart\b/i, 'disk partitioning'],
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

/** Delete commands of sh, cmd and PowerShell (with its aliases). */
const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri']);
/** PowerShell's listers: `gci C:\ | Remove-Item` deletes what they list. */
const LIST_VERBS = new Set(['get-childitem', 'gci', 'dir', 'ls']);

/** A command line as words: quotes keep a word together and are then dropped; cmd's ^ escape is removed. Lower case. */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/["'^]/g, '').toLowerCase()).filter(Boolean);
}

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
  const w = collapseDots(word.replace(/[\\/]+\*(?:\.\*)?$/, '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/');
  if (w === '/' || w === '/*') return true;
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
  return false;
}

/** Programs that run the rest of the line as the command (`sudo rm …` is an rm); their own options are skipped. */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time', 'xargs']);
const WRAPPER_OPTS_WITH_ARG = new Set(['-u', '-g', '-p', '-h', '-n']);
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
      while (i < ws.length && (ws[i]!.startsWith('-') || /^[a-z_][a-z0-9_]*=/.test(ws[i]!))) { if (WRAPPER_OPTS_WITH_ARG.has(ws[i++]!)) i++; }
      continue;
    }
    const flag = SHELLS.has(p) ? ws.findIndex((w, j) => j > i && SHELL_COMMAND_FLAGS.has(w)) : -1;
    if (flag > i) { i = flag + 1; continue; }
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
  const targetsAfter = (ws: readonly string[], i: number): boolean => ws.slice(i + 1).some(isProtectedTarget);
  for (const ws of stages) {
    if (runs(ws, DELETE_VERBS).some((i) => targetsAfter(ws, i))) return 'a recursive delete of a drive, a system folder or a home folder';
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
export function refuseCatastrophic(cmd: string, depth = 0): string | undefined {
  const say = (what: string): string => `Refused: this command looks like ${what}, which can destroy the machine or its data. It is blocked for every agent, even full access.`;
  for (const [re, what] of CATASTROPHIC) {
    if (re.test(cmd)) return say(what);
  }
  const plain = cmd.replace(/[\^"']/g, '').toLowerCase();
  for (const [re, what] of CATASTROPHIC_WINDOWS) {
    if (re.test(plain)) return say(what);
  }
  for (const segment of cmd.split(/&&|\|\||[;&\n\r]/)) {
    const why = refuseSegment(segment);
    if (why) return say(why);
  }
  // A quoted string keeps a path with spaces together, but it can also carry a whole command to a wrapper
  // (`powershell -c "Remove-Item …"`, `bash -c '…'`): each such string is judged as a command of its own.
  if (depth < 2) {
    // a command substitution runs its text as a command: `echo $(rm -rf /)`, backticks the same
    for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
      const inner = refuseCatastrophic(m[1] ?? m[2] ?? '', depth + 1);
      if (inner) return inner;
    }
    // one plain scan per quote (a pattern that also demands whitespace inside backtracks quadratically on an open quote)
    for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'/g)) {
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
    return envMode === 'allow' ? t : redactValues(t, envValues(ctx.rootDir));
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
      if (envMode === 'block' && mentionsEnvFile(a.command)) throw envRefusal('name');
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
