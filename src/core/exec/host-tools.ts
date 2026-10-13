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
import { MAX_READABLE, refuseCatastrophic } from './shell-floor.js';
// the safety floor lives in its own module; these names stay importable from here
export { refuseCatastrophic, unjudgeableCommand } from './shell-floor.js';

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
      // the floor again, in this shell's own reading (cmd.exe on Windows); a command over the reading limit was carded by the engine
      const bad = a.command.length <= MAX_READABLE ? refuseCatastrophic(a.command, process.platform === 'win32' ? 'cmd' : 'sh') : undefined;
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
