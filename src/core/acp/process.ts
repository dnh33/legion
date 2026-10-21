/**
 * The process owner for an agent that speaks ACP over stdio (the agent host): starts it, gives the RPC layer its lines, stops it.
 * It is the only file in src/core/acp/ that starts a program. `runAgentCli` runs one-shot commands of the same program (a version
 * check, a config read) through the same launch path.
 *
 * Rules this file keeps:
 *  - The command is resolved to an absolute file before any spawn: PATH only (never the agent's working folder), so a project
 *    folder cannot plant its own `hermes.exe`. A relative path is refused. Windows tools (cmd, taskkill, powershell) start by full path.
 *  - `shell: false`, `windowsHide: true`, not detached. A `.cmd` or `.bat` file cannot be spawned directly (Node answers EINVAL since
 *    the 2024 security fix), so it runs as `cmd.exe /d /v:off /s /c "<one quoted line>"`, the documented way:
 *    https://nodejs.org/api/child_process.html ("Spawning .bat and .cmd files on Windows": spawn cmd.exe with the file as an argument,
 *    quote a name with spaces). Nothing is escaped: a path or argument with a character cmd.exe could read as syntax is refused.
 *  - The child environment is the user's own (pass-through: the agent may read its provider keys), minus Legion's control variables and
 *    any value that holds a Legion secret.
 *  - Stopping closes stdin, waits, then kills the one PID. It never kills the tree: the agent's background service must outlive this client.
 *  - Every started PID is written to <dataDir>/acp-pids.json and swept at the next start, with an identity check against PID reuse.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { type AcpEntry, containedArgs } from '../../shared/acp-view.js';
import { scrubHostSessionEnv } from '../../shared/config.js';
import { redact, registerSecret } from '../log/redact.js';
import { type RpcIo, lineSplitter } from './rpc.js';

export interface AgentProcess {
  /** Lines in and out, for `new RpcPeer(p.io)`. Stdout is read from the first `onLine` call on. */
  io: RpcIo;
  /** The PID Legion started. For a `.cmd` launch this is cmd.exe's. */
  pid: number;
  /** The last 8 KB of what the agent wrote to stderr (plus notes from this file), each line redacted. */
  stderrTail(): string;
  /** Close stdin, wait `graceMs` (default 3000) for the agent to leave, then kill its PID (not its tree). */
  stop(graceMs?: number): Promise<void>;
  /** Kill the PID now. */
  killNow(): void;
  /** Always settles, also when the agent crashed. */
  exited: Promise<{ code: number | null; signal: string | null }>;
}

export class AgentLaunchError extends Error {
  /** not-found: no such program on PATH. refused: the command or an argument cannot be started safely. spawn-failed: the OS refused. */
  constructor(readonly code: 'not-found' | 'refused' | 'spawn-failed', message: string) {
    super(message);
    this.name = 'AgentLaunchError';
  }
}

const RING_CHARS = 8 * 1024;
const LINE_DROPPED_NOTE = '[line over 16 MiB dropped]';
const CLOSE_AFTER_EXIT_MS = 250; // a grandchild that inherited the pipes must not keep the RPC peer waiting
const CLI_OUTPUT_CAP = 1024 * 1024;
const PID_FILE = 'acp-pids.json';
/** The flags that make the agent skip its own safety rules. Removed from its environment when the switch is on. */
const SKIP_FLAGS = ['HERMES_YOLO_MODE', 'HERMES_IGNORE_RULES', 'HERMES_SAFE_MODE', 'HERMES_IGNORE_USER_CONFIG', 'HERMES_ACCEPT_HOOKS'] as const;

// ---------------------------------------------------------------- environment

let legionSecrets: string[] = [];
/** The core calls this once at start with the values that must never reach an agent: the bearer token and the admin secret. */
export function registerLegionSecrets(values: ReadonlyArray<string | undefined>): void {
  legionSecrets = values.filter((v): v is string => typeof v === 'string' && v.length >= 8).map((v) => v.toLowerCase());
  for (const v of values) registerSecret(v);
}

function setEnv(out: Record<string, string>, name: string, value: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') for (const k of Object.keys(out)) if (k.toUpperCase() === name.toUpperCase()) delete out[k];
  out[name] = value;
}

/**
 * host env (without Claude host-session plumbing) -> drop LEGION_* and values holding a Legion secret -> entry env -> extra env ->
 * (switch on) drop the skip flags. Not the generic *_KEY / *_TOKEN scrub: the agent is the user's own program and reads its provider keys.
 */
export function buildAgentEnv(o: { entryEnv?: Record<string, string> | undefined; extraEnv?: Record<string, string> | undefined; stripSkipFlags: boolean; base?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): Record<string, string> {
  const platform = o.platform ?? process.platform;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubHostSessionEnv({ ...(o.base ?? process.env) }))) {
    if (v === undefined || /^LEGION_/i.test(k)) continue;
    const lower = v.toLowerCase();
    if (legionSecrets.some((s) => lower.includes(s))) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(o.entryEnv ?? {})) setEnv(out, k, v, platform);
  for (const [k, v] of Object.entries(o.extraEnv ?? {})) setEnv(out, k, v, platform);
  if (o.stripSkipFlags) for (const k of Object.keys(out)) if ((SKIP_FLAGS as readonly string[]).includes(k.toUpperCase())) delete out[k];
  return out;
}

// ---------------------------------------------------------------- launch

export interface LaunchSpec { file: string; args: string[]; windowsVerbatimArguments?: boolean }

const sysRoot = () => process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
const sys32 = (name: string) => join(sysRoot(), 'System32', name);
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const WIN_RUNNABLE = new Set(['.com', '.exe', '.bat', '.cmd']);

/** Characters allowed in a path or argument that goes through cmd.exe. Everything else is refused, never escaped. */
const CMD_SAFE = /^[\p{L}\p{M}\p{N} _.,:;=+@/\\()[\]{}~#'-]*$/u;

/** The one line cmd.exe runs: every part in double quotes, trailing backslashes doubled so they cannot swallow the closing quote. */
export function cmdLine(file: string, args: readonly string[]): string {
  const q = (s: string) => {
    if (!CMD_SAFE.test(s)) throw new AgentLaunchError('refused', `cannot pass "${s.replace(/[\r\n]/g, ' ').slice(0, 60)}" through cmd.exe safely (it holds a character cmd.exe reads as syntax)`);
    return `"${s.replace(/(\\+)$/, '$1$1')}"`;
  };
  return [q(file), ...args.map(q)].join(' ');
}

function winExts(env: Record<string, string | undefined>): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT');
  const listed = (key ? env[key] : undefined)?.split(';').map((e) => e.trim().toLowerCase()).filter((e) => WIN_RUNNABLE.has(e)) ?? [];
  return listed.length ? listed : ['.com', '.exe', '.bat', '.cmd'];
}

/** The absolute file for `command`, looked up on the child's PATH only (absolute entries; the working folder is never searched). */
export function resolveCommand(command: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  const hasSep = /[\\/]/.test(command) || (platform === 'win32' && /^[A-Za-z]:/.test(command));
  if (hasSep && !isAbsolute(command)) throw new AgentLaunchError('refused', `"${command}" is a relative path; use a full path or a bare program name`);
  const win = platform === 'win32';
  const names: string[] = [];
  const base = hasSep ? basename(command) : command;
  const ext = extname(base).toLowerCase();
  if (!win) names.push(base);
  else if (WIN_RUNNABLE.has(ext)) names.push(base);
  else if (ext !== '' && !/^\.\d+$/.test(ext)) throw new AgentLaunchError('refused', `"${command}" is not a program Windows can start directly (use a .exe, .cmd or .bat file)`);
  else for (const e of winExts(env)) names.push(base + e);
  const dirs: string[] = [];
  if (hasSep) dirs.push(dirname(command));
  else {
    const key = Object.keys(env).find((k) => (win ? k.toUpperCase() === 'PATH' : k === 'PATH'));
    for (const d of (key ? env[key] : undefined)?.split(delimiter) ?? []) if (d !== '' && isAbsolute(d)) dirs.push(d);
  }
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      if (!isFile(p)) continue;
      if (!win) { try { accessSync(p, constants.X_OK); } catch { continue; } }
      return p;
    }
  }
  throw new AgentLaunchError('not-found', `${command}: no such program on PATH`);
}

/** What to spawn for `command args`. Throws AgentLaunchError when the command is missing or cannot be started safely. */
export function launchSpec(command: string, args: readonly string[], env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): LaunchSpec {
  const file = resolveCommand(command, env, platform);
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: sys32('cmd.exe'), args: ['/d', '/v:off', '/s', '/c', `"${cmdLine(file, args)}"`], windowsVerbatimArguments: true };
  }
  return { file, args: [...args] };
}

function spawnOptions(spec: LaunchSpec, cwd: string | undefined, env: Record<string, string>): SpawnOptions {
  return { ...(cwd ? { cwd } : {}), env, shell: false, windowsHide: true, detached: false, ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) };
}

// ---------------------------------------------------------------- killing

type Killable = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;
/** Only while the child we started is still live: after it exited its PID may belong to another program. */
const isLive = (c: Killable): c is Killable & { pid: number } => c.pid !== undefined && c.exitCode === null && c.signalCode === null;

/** Kill one process, not its tree (no /T on Windows). */
export async function killPid(child: Killable): Promise<void> {
  if (!isLive(child)) return;
  if (process.platform !== 'win32') { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } return; }
  await new Promise<void>((resolve) => {
    const k = spawn(sys32('taskkill.exe'), ['/PID', String(child.pid), '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
    k.once('error', () => resolve());
    k.once('close', () => resolve());
  });
}

export function killPidSync(child: Killable): void {
  if (!isLive(child)) return;
  if (process.platform !== 'win32') { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } return; }
  spawnSync(sys32('taskkill.exe'), ['/PID', String(child.pid), '/F'], { stdio: 'ignore', windowsHide: true, shell: false, timeout: 5000 });
}

// ---------------------------------------------------------------- pid file and sweep

interface PidRecord { pid: number; startedAt: number }

function readPids(dataDir: string): PidRecord[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, PID_FILE), 'utf8')) as { agents?: unknown };
    if (!Array.isArray(raw.agents)) return [];
    return raw.agents.filter((a): a is PidRecord => !!a && Number.isInteger((a as PidRecord).pid) && (a as PidRecord).pid > 0 && Number.isFinite((a as PidRecord).startedAt));
  } catch { return []; }
}
function writePids(dataDir: string, agents: PidRecord[]): void {
  try { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, PID_FILE), JSON.stringify({ version: 1, agents })); } catch { /* the file only helps a later cleanup */ }
}

/** When the process with this PID started (ms since the epoch), or undefined when that cannot be read. */
function startTimeOf(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'win32') {
    const ps = join(sysRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000 });
    const n = Number((r.stdout ?? '').trim());
    return r.status === 0 && Number.isFinite(n) && n > 0 ? n : undefined;
  }
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    const r = spawnSync(ps, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', shell: false, timeout: 5000, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
    if (r.error) continue;
    const t = Date.parse((r.stdout ?? '').trim());
    return r.status === 0 && Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const START_TOLERANCE_MS = 5000;

/**
 * Core start: clean up agents a core that died without cleaning left behind. An entry whose process is gone is dropped. A live one
 * is killed only when its start time matches the time recorded at spawn (a PID reused by another program starts at another time);
 * when the start time cannot be read the entry is dropped and the process left alone.
 */
export function sweepStaleAgents(dataDir: string): { killed: number[]; dropped: number[] } {
  const killed: number[] = [];
  const dropped: number[] = [];
  const keep: PidRecord[] = [];
  const mine = new Set([...live.keys()].map((c) => c.pid));
  for (const rec of readPids(dataDir)) {
    if (rec.pid === process.pid || mine.has(rec.pid)) { keep.push(rec); continue; }
    if (!exists(rec.pid)) { dropped.push(rec.pid); continue; }
    const started = startTimeOf(rec.pid);
    if (started !== undefined && Math.abs(started - rec.startedAt) <= START_TOLERANCE_MS) {
      killPidSync({ pid: rec.pid, exitCode: null, signalCode: null });
      killed.push(rec.pid);
    } else dropped.push(rec.pid);
  }
  writePids(dataDir, keep);
  return { killed, dropped };
}

// ---------------------------------------------------------------- registry

const live = new Map<ChildProcess, string>();
let hooked = false;

/** Kill every agent this core started, now. Called on shutdown and on process exit; kills the PIDs only. */
export function killAllAgentsSync(): void {
  for (const [child, dataDir] of [...live]) {
    killPidSync(child);
    live.delete(child);
    writePids(dataDir, readPids(dataDir).filter((r) => r.pid !== child.pid));
  }
}

// ---------------------------------------------------------------- stderr ring

class Ring {
  private text = '';
  private partial = '';
  add(chunk: string): void {
    this.partial += chunk;
    const parts = this.partial.split('\n');
    this.partial = parts.pop() ?? '';
    for (const l of parts) this.line(l.replace(/\r$/, ''));
    if (this.partial.length > RING_CHARS) { this.line(this.partial); this.partial = ''; }
  }
  /** A whole line from this file (a note), not from the agent. */
  line(l: string): void {
    this.text += `${redact(l)}\n`;
    while (this.text.length > RING_CHARS) {
      const i = this.text.indexOf('\n');
      this.text = i === -1 || i === this.text.length - 1 ? this.text.slice(-RING_CHARS) : this.text.slice(i + 1);
    }
  }
  flush(): void { if (this.partial) { this.line(this.partial.replace(/\r$/, '')); this.partial = ''; } }
  tail(): string { return (this.text + (this.partial ? redact(this.partial) : '')).slice(-RING_CHARS); }
}

// ---------------------------------------------------------------- start

type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export function startAgentProcess(
  entry: AcpEntry,
  opts: { cwd: string; extraEnv?: Record<string, string>; stripSkipFlags: boolean; dataDir: string },
  deps: { spawn?: SpawnFn } = {},
): AgentProcess {
  const env = buildAgentEnv({ entryEnv: entry.env, extraEnv: opts.extraEnv, stripSkipFlags: opts.stripSkipFlags });
  const spec = launchSpec(entry.command, containedArgs(entry), env);
  const child = (deps.spawn ?? (spawn as SpawnFn))(spec.file, spec.args, { ...spawnOptions(spec, opts.cwd, env), stdio: ['pipe', 'pipe', 'pipe'] });
  child.once('error', () => undefined); // a failed start or kill is reported through exit and the ring, never as an uncaught event
  const stdin = child.stdin;
  stdin?.on('error', () => undefined); // EPIPE after the agent left
  if (child.pid === undefined || !stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new AgentLaunchError('spawn-failed', `${entry.command}: the system could not start it`);
  }
  const pid = child.pid;
  const ring = new Ring();
  const lineCbs: Array<(line: string) => void> = [];
  const closeCbs: Array<() => void> = [];
  let closed = false;
  let stdoutHooked = false;

  live.set(child, opts.dataDir);
  if (!hooked) { hooked = true; process.on('exit', killAllAgentsSync); }
  writePids(opts.dataDir, [...readPids(opts.dataDir).filter((r) => r.pid !== pid), { pid, startedAt: Date.now() }]);

  const fireClose = () => {
    if (closed) return;
    closed = true;
    ring.flush();
    for (const cb of closeCbs) { try { cb(); } catch { /* a callback must not break the others */ } }
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => ring.add(d));
  child.stderr.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  child.once('close', fireClose);

  let done = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      done = true;
      live.delete(child);
      writePids(opts.dataDir, readPids(opts.dataDir).filter((r) => r.pid !== pid));
      setTimeout(fireClose, CLOSE_AFTER_EXIT_MS).unref();
      resolve({ code, signal });
    });
  });

  const io: RpcIo = {
    write(line) {
      if (line.includes('\n')) throw new Error('a message must be one line');
      if (stdin.destroyed || stdin.writableEnded) throw new Error('the agent is not reading (its input is closed)');
      stdin.write(`${line}\n`);
    },
    onLine(cb) {
      lineCbs.push(cb);
      if (stdoutHooked) return;
      stdoutHooked = true;
      const feed = lineSplitter((l) => { for (const f of lineCbs) f(l); }, { onOverflow: () => ring.line(LINE_DROPPED_NOTE) });
      child.stdout!.on('data', (d: Buffer) => feed(d));
    },
    onClose(cb) {
      closeCbs.push(cb);
      if (closed) queueMicrotask(cb);
    },
  };

  const delay = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref(); });
  return {
    io,
    pid,
    stderrTail: () => ring.tail(),
    async stop(graceMs = 3000) {
      if (done) return;
      try { stdin.end(); } catch { /* already closed */ }
      await Promise.race([exited, delay(graceMs)]);
      if (done) return;
      await killPid(child);
      await Promise.race([exited, delay(2000)]);
    },
    killNow() { killPidSync(child); },
    exited,
  };
}

// ---------------------------------------------------------------- one-shot commands

/** Run `command args` once and collect its output (each stream capped at 1 MiB). A start failure is a result, not a throw. */
export async function runAgentCli(
  command: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const env = (opts.env ?? buildAgentEnv({ stripSkipFlags: false })) as Record<string, string>;
  let spec: LaunchSpec;
  try { spec = launchSpec(command, args, env); } catch (e) {
    return { code: null, stdout: '', stderr: redact(e instanceof Error ? e.message : String(e)), timedOut: false };
  }
  return await new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, { ...spawnOptions(spec, opts.cwd, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: redact(stderr), timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; void killPid(child); }, opts.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { if (stdout.length < CLI_OUTPUT_CAP) stdout += d.slice(0, CLI_OUTPUT_CAP - stdout.length); });
    child.stderr?.on('data', (d: string) => { if (stderr.length < CLI_OUTPUT_CAP) stderr += d.slice(0, CLI_OUTPUT_CAP - stderr.length); });
    child.once('error', (e) => { stderr += `${stderr ? '\n' : ''}${e.message}`; finish(null); });
    child.once('close', (code) => finish(code));
  });
}
