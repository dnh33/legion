/**
 * The ONE file under src/core/providers that may start a process (listed on the tripwire with this reason). Two users:
 *   - spawnStdio: a stdio MCP server the owner opted in for provider runs (see stdio-transport.ts, external-mcp.ts);
 *   - spawnManaged: a CLI agent (Codex, OpenCode) the owner enabled for one agent (see cli.ts).
 * Rules for both: an argument list and shell:false (a Windows .cmd/.bat launcher goes through cmd.exe with strictly checked
 * arguments, see resolveLaunch), the COMPLETE environment is given and never merged with process.env, windowsHide, a process group on
 * POSIX, and the whole tree is stopped by PID (taskkill /T on Windows, a group SIGKILL on POSIX), never by a name pattern.
 */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export type Platform = NodeJS.Platform;

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Stops a process and everything it started, by PID. Resolves true when the PID is gone. */
export async function killTree(pid: number, platform: Platform = process.platform): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve()); } catch { resolve(); }
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !pidAlive(pid);
}

// ----------------------------------------------------------------------------------------------------------------------------
// Launch resolution (Windows .cmd / .bat) and the scrubbed environment
// ----------------------------------------------------------------------------------------------------------------------------

/** Characters cmd.exe treats specially (or that expand variables). A launcher argument holding one is refused, not escaped. */
const CMD_UNSAFE = /[&|<>^"%!()\r\n\0`]/;

export interface Launch { file: string; args: string[]; windowsVerbatimArguments?: boolean }

/**
 * What to hand to spawn. POSIX, and a Windows .exe: the command and arguments unchanged. A Windows .cmd or .bat launcher cannot be run
 * without a shell since Node's 2024 security fix, so it runs as `cmd.exe /d /s /c "<command> <args>"` with the line built here: every
 * piece must be free of cmd metacharacters (refused otherwise, never escaped), a piece with a space is double-quoted, and a quoted piece
 * may not end in a backslash. `.ps1` and other script types are refused.
 */
export function resolveLaunch(command: string, args: string[], opts: { platform?: Platform; comspec?: string } = {}): Launch {
  const platform = opts.platform ?? process.platform;
  if (!command || /[\r\n\0]/.test(command)) throw new Error('the command is not valid');
  if (platform !== 'win32') return { file: command, args };
  if (/\.(?:ps1|vbs|js|wsf)$/i.test(command)) throw new Error('only .exe, .cmd and .bat programs can be started on Windows');
  if (!/\.(?:cmd|bat)$/i.test(command)) return { file: command, args };
  const piece = (s: string): string => {
    if (CMD_UNSAFE.test(s)) throw new Error('a .cmd launcher cannot take arguments with & | < > ^ " % ! ( ) or line breaks; use the .exe, or put the value in a file');
    if (s === '' || /[ \t]/.test(s)) {
      if (/\\$/.test(s)) throw new Error('a quoted argument may not end in a backslash');
      return `"${s}"`;
    }
    return s;
  };
  const line = [command, ...args].map(piece).join(' ');
  const comspec = opts.comspec && /cmd\.exe$/i.test(opts.comspec) ? opts.comspec : 'cmd.exe';
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * A new environment object from `source`, keeping only the names in `allow` (case-insensitive on Windows, where `Path` and `PATH` are
 * one variable), then the `extra` entries (the owner's own, which win over the allowed ones). A value starting with "()" (an exported
 * shell function) is dropped. The result never holds a name twice under different case.
 */
export function scrubbedEnv(source: Record<string, string | undefined>, allow: readonly string[], extra: Record<string, string> = {}, platform: Platform = process.platform): Record<string, string> {
  const win = platform === 'win32';
  const norm = (k: string): string => (win ? k.toUpperCase() : k);
  const wanted = new Set(allow.map(norm));
  const out: Record<string, string> = {};
  const seen = new Map<string, string>();
  const put = (k: string, v: string): void => {
    const n = norm(k);
    const prev = seen.get(n);
    if (prev !== undefined && prev !== k) delete out[prev];
    seen.set(n, k); out[k] = v;
  };
  for (const [k, v] of Object.entries(source)) if (typeof v === 'string' && wanted.has(norm(k)) && !v.startsWith('()')) put(k, v);
  for (const [k, v] of Object.entries(extra)) put(k, v);
  return out;
}

export const STDIO_MCP_ENV_ALLOW_POSIX = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'] as const;
export const STDIO_MCP_ENV_ALLOW_WIN = ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES'] as const;
export const stdioMcpEnvAllow = (platform: Platform = process.platform): readonly string[] => (platform === 'win32' ? STDIO_MCP_ENV_ALLOW_WIN : STDIO_MCP_ENV_ALLOW_POSIX);

// ----------------------------------------------------------------------------------------------------------------------------
// Long-lived process with pipes (a stdio MCP server)
// ----------------------------------------------------------------------------------------------------------------------------

export interface StdioProc {
  pid: number | undefined;
  stdin: Writable;
  stdout: Readable;
  exited: Promise<{ code: number | null; signal: string | null; error?: string }>;
  /** Stops the process tree by PID. Safe to call twice. */
  kill(): Promise<boolean>;
}

export function spawnStdio(file: string, args: string[], opts: { cwd?: string; env: Record<string, string>; platform?: Platform; comspec?: string }): StdioProc {
  const platform = opts.platform ?? process.platform;
  const launch = resolveLaunch(file, args, { platform, ...(opts.comspec ? { comspec: opts.comspec } : {}) });
  const child = spawn(launch.file, launch.args, {
    cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, detached: platform !== 'win32',
    stdio: ['pipe', 'pipe', 'ignore'], ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return wrap(child, platform);
}

function wrap(child: ChildProcess, platform: Platform): StdioProc {
  const exited = new Promise<{ code: number | null; signal: string | null; error?: string }>((resolve) => {
    let done = false;
    const fin = (code: number | null, signal: string | null, error?: string) => { if (!done) { done = true; resolve({ code, signal, ...(error ? { error } : {}) }); } };
    child.on('error', (e) => fin(null, null, e.message));
    child.on('exit', (code, signal) => fin(code, signal));
  });
  let killed: Promise<boolean> | undefined;
  return {
    pid: child.pid, stdin: child.stdin!, stdout: child.stdout!, exited,
    kill() { return (killed ??= child.pid ? killTree(child.pid, platform) : Promise.resolve(true)); },
  };
}

// ----------------------------------------------------------------------------------------------------------------------------
// One run with output caps (a CLI agent)
// ----------------------------------------------------------------------------------------------------------------------------

export interface SpawnRequest {
  /** Test seam only: arguments put before `args` (a fake CLI run as `node fake.mjs ...`). No production caller sets it. */
  prefixArgs?: string[];
  args: string[];
  cwd: string;
  /** The COMPLETE environment. */
  env: Record<string, string>;
  maxOutputBytes: number;
  timeoutMs: number;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  signal?: AbortSignal;
}
export interface SpawnResult {
  code: number | null; signal: string | null; stdout: string; stderr: string;
  /** Why Legion ended it: the output cap, the time limit, or a cancel. Absent when the process ended by itself. */
  stoppedBy?: 'output limit' | 'timeout' | 'cancelled';
  error?: string;
  pid: number | undefined;
  /** True when the PID tree was confirmed gone after a stop. */
  treeGone?: boolean;
}

/** Runs one program to the end (or to a limit, a time-out or a cancel, each of which kills the whole tree by PID). */
export async function spawnManaged(file: string, req: SpawnRequest, platform: Platform = process.platform): Promise<SpawnResult> {
  let launch: Launch;
  try { launch = resolveLaunch(file, [...(req.prefixArgs ?? []), ...req.args], { platform }); } catch (e) { return { code: null, signal: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e), pid: undefined }; }
  let child: ChildProcess;
  try {
    child = spawn(launch.file, launch.args, {
      cwd: req.cwd, env: req.env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: [req.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (e) { return { code: null, signal: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e), pid: undefined }; }
  const pid = child.pid;
  const out: Buffer[] = []; const err: Buffer[] = [];
  let total = 0; let stopped: SpawnResult['stoppedBy']; let treeGone: boolean | undefined;
  const stop = (why: NonNullable<SpawnResult['stoppedBy']>): void => {
    if (stopped) return;
    stopped = why;
    if (pid) void killTree(pid, platform).then((g) => { treeGone = g; });
  };
  const take = (into: Buffer[]) => (chunk: Buffer) => {
    if (stopped === 'output limit') return;
    const room = req.maxOutputBytes - total;
    if (chunk.length > room) { if (room > 0) into.push(chunk.subarray(0, room)); total = req.maxOutputBytes; stop('output limit'); return; }
    total += chunk.length; into.push(chunk);
  };
  child.stdout?.on('data', take(out));
  child.stderr?.on('data', take(err));
  if (req.stdin !== undefined && child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(req.stdin); }
  const timer = setTimeout(() => stop('timeout'), req.timeoutMs);
  const onAbort = (): void => stop('cancelled');
  if (req.signal) { if (req.signal.aborted) onAbort(); else req.signal.addEventListener('abort', onAbort, { once: true }); }
  const ended = await new Promise<{ code: number | null; signal: string | null; error?: string }>((resolve) => {
    let done = false;
    const fin = (code: number | null, signal: string | null, error?: string) => { if (!done) { done = true; resolve({ code, signal, ...(error ? { error } : {}) }); } };
    child.on('error', (e) => fin(null, null, e.message));
    // a grandchild that keeps the pipes open must not hold the result back
    child.on('exit', (code, signal) => { const t = setTimeout(() => fin(code, signal), 300); t.unref?.(); child.once('close', () => { clearTimeout(t); fin(code, signal); }); });
  });
  clearTimeout(timer);
  req.signal?.removeEventListener('abort', onAbort);
  // whatever the process left behind (a grandchild) goes too, on every path
  if (pid && !stopped) void killTree(pid, platform);
  if (stopped && pid && treeGone === undefined) treeGone = await killTree(pid, platform);
  return {
    ...ended, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), pid,
    ...(stopped ? { stoppedBy: stopped } : {}), ...(treeGone !== undefined ? { treeGone } : {}),
  };
}

/** The port a CLI run uses; tests give it a prefix so a fake CLI (a node script) runs in place of the real one. */
export interface ProcessPort { run(file: string, req: SpawnRequest): Promise<SpawnResult> }
export function createProcessPort(opts: { prefixArgs?: string[]; platform?: Platform } = {}): ProcessPort {
  return { run: (file, req) => spawnManaged(file, { ...req, ...(opts.prefixArgs ? { prefixArgs: opts.prefixArgs } : {}) }, opts.platform) };
}
