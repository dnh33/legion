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
 *  - The child environment is cleaned exactly like a Claude agent's (`scrubSecretEnv`: key, token and password names and values stripped,
 *    the owner's signed `envKeep` list passes named variables). Legion's control variables (LEGION_*), Legion's own provider keys
 *    and any value that holds a Legion secret are removed from the inherited environment, also when the keep list names them.
 *    `entry.env` and `extraEnv` are owner-set values applied after that filter and are not scrubbed. The HERMES_* skip flags follow `stripSkipFlags`.
 *  - Stopping closes stdin, waits, then kills the one PID. It never kills the tree: the agent's background service must outlive this client.
 *  - Every started PID is written to <dataDir>/acp-pids.json and swept at the next start, with an identity check against PID reuse.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { type AcpEntry, containedArgs } from '../../shared/acp-view.js';
import { scrubHostSessionEnv } from '../../shared/config.js';
import { ENV_NEVER_PASSED } from '../../shared/gates-registry.js';
import { redact, registerSecret, unregisterSecret } from '../log/redact.js';
import { scrubSecretEnv } from '../env-scrub.js';
import { type RenameRetryDeps, renameWithRetry } from '../../shared/rename-retry.js';
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
export const SKIP_FLAGS = ['HERMES_YOLO_MODE', 'HERMES_IGNORE_RULES', 'HERMES_SAFE_MODE', 'HERMES_IGNORE_USER_CONFIG', 'HERMES_ACCEPT_HOOKS'] as const;

// ---------------------------------------------------------------- environment

/** Legion's own provider keys (the same list `buildHostShellEnv` drops). Never passed, also when a keep entry such as `ANT*` reaches them. */
const NEVER_PASSED: ReadonlySet<string> = new Set(ENV_NEVER_PASSED);

let legionSecrets: string[] = [];
let secretsRegistered = false;
/**
 * The core calls this once at start with the values that must never reach an agent: the bearer token and the admin secrets.
 * Until it has been called nothing is started (fail closed), so a caller that forgets it cannot leak by accident.
 */
export function registerLegionSecrets(values: ReadonlyArray<string | undefined>): void {
  legionSecrets = values.filter((v): v is string => typeof v === 'string' && v.length >= 8).map((v) => v.toLowerCase());
  secretsRegistered = true;
  for (const v of values) registerSecret(v);
}
/** A secret that appears later, such as a per-run tool token: call it when the value is issued. */
export function addLegionSecret(value: string): void {
  if (value.length >= 8) legionSecrets.push(value.toLowerCase());
  registerSecret(value);
}
/** The token has expired (a run ended, a token was revoked): stop filtering it and let the log redactor forget it. One call undoes one `addLegionSecret`. */
export function removeLegionSecret(value: string): void {
  const i = legionSecrets.indexOf(value.toLowerCase());
  if (i !== -1) legionSecrets.splice(i, 1);
  if (!legionSecrets.includes(value.toLowerCase())) unregisterSecret(value);
}
/** For tests: back to "no secrets registered". */
export function forgetLegionSecrets(): void { legionSecrets = []; secretsRegistered = false; }
function requireSecrets(): void {
  if (!secretsRegistered) throw new AgentLaunchError('refused', 'the core has not registered its secrets yet, so no agent program is started');
}

function setEnv(out: Record<string, string>, name: string, value: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') for (const k of Object.keys(out)) if (k.toUpperCase() === name.toUpperCase()) delete out[k];
  out[name] = value;
}

/**
 * host env (without Claude host-session plumbing) -> the same cleaning as a Claude agent's (`scrubSecretEnv`: key, token and password
 * names and values, code-loading variables; the owner's signed `envKeep` list passes named variables) -> drop LEGION_*, Legion's own
 * provider keys and values holding a Legion secret, also for a kept name (inherited variables only) -> entry env -> extra env (owner-set,
 * applied after the filter, not scrubbed) -> (switch on) drop the skip flags.
 */
export function buildAgentEnv(o: { entryEnv?: Record<string, string> | undefined; extraEnv?: Record<string, string> | undefined; stripSkipFlags: boolean; envKeep?: readonly string[] | undefined; /** false: the owner switched the key-scrub gate off for this run, so key-like variable names pass. LEGION_*, Legion's own keys and values holding a Legion secret are still dropped. */ scrub?: boolean; base?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): Record<string, string> {
  const platform = o.platform ?? process.platform;
  const out: Record<string, string> = {};
  const host = scrubHostSessionEnv({ ...(o.base ?? process.env) });
  for (const [k, v] of Object.entries(o.scrub === false ? host : scrubSecretEnv(host, { keep: o.envKeep ?? [] }))) {
    if (v === undefined || /^LEGION_/i.test(k) || NEVER_PASSED.has(k.toUpperCase())) continue;
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

export interface LaunchSpec { file: string; /** The program the user's entry names, resolved: `file` itself, or the .cmd/.bat that cmd.exe runs. It shows in the command line of the started process. */ target: string; args: string[]; windowsVerbatimArguments?: boolean; /** Added to the child's environment. */ env?: Record<string, string> }

/** What the OS shows as the program of a process we started from this file: the full path on Windows, the file name elsewhere. */
export function imageOf(file: string): string { return process.platform === 'win32' ? file : basename(file); }

const sysRoot = () => process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
const sys32 = (name: string) => join(sysRoot(), 'System32', name);
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const WIN_RUNNABLE = new Set(['.com', '.exe', '.bat', '.cmd']);

/**
 * Characters allowed in a path or argument that goes through cmd.exe. Everything else is refused, never escaped.
 * Letters are cased letters, other letters (CJK and the like), marks and digits. Modifier letters (category Lm, such as U+02BA and U+02C6)
 * are left out on purpose: Windows can map those to a quote or a caret for programs that read the ANSI form of the command line.
 */
const CMD_SAFE = /^[\p{Lu}\p{Ll}\p{Lo}\p{M}\p{N} _.,:;=+@/\\()[\]{}~#'-]*$/u;

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
    // NoDefaultCurrentDirectoryInExePath: a command inside the shim is never looked up in the current (project) folder
    return { file: sys32('cmd.exe'), target: file, args: ['/d', '/v:off', '/s', '/c', `"${cmdLine(file, args)}"`], windowsVerbatimArguments: true, env: { NoDefaultCurrentDirectoryInExePath: '1' } };
  }
  return { file, target: file, args: [...args] };
}

function spawnOptions(spec: LaunchSpec, cwd: string | undefined, env: Record<string, string>): SpawnOptions {
  return { ...(cwd ? { cwd } : {}), env: spec.env ? { ...env, ...spec.env } : env, shell: false, windowsHide: true, detached: false, ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) };
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

/** Test seam: the helper run and the direct kill. */
export interface KillSyncDeps { platform?: NodeJS.Platform; run?: typeof spawnSync; kill?: (pid: number) => void }

/** With no time left (`timeoutMs` 0) the process is ended directly (TerminateProcess on Windows), without starting taskkill. */
export function killPidSync(child: Killable, timeoutMs = 5000, deps: KillSyncDeps = {}): void {
  if (!isLive(child)) return;
  const direct = deps.kill ?? ((pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  if ((deps.platform ?? process.platform) !== 'win32' || timeoutMs <= 0) { direct(child.pid); return; }
  const r = (deps.run ?? spawnSync)(sys32('taskkill.exe'), ['/PID', String(child.pid), '/F'], { stdio: 'ignore', windowsHide: true, shell: false, timeout: timeoutMs });
  // Only when the helper did not run to its end (it could not start, or the time limit cut it short, a busy computer) the process is ended
  // directly: the agent must not outlive the core. Any answer from a finished helper, "not found" included, stands: the process is gone
  // and its PID may belong to another program by now.
  if (r.error) direct(child.pid);
}

// ---------------------------------------------------------------- pid file and sweep

interface PidRecord {
  pid: number;
  startedAt: number;
  /** The program of the process, as the OS shows it (see imageOf). */
  image: string;
  /** The program file the entry resolved to (LaunchSpec.target): the sweep looks for it in the command line. */
  command: string;
}
const MAX_PID_RECORDS = 32;
const SWEEP_BUDGET_MS = 10_000;
const TMP_NAME = /^acp-pids\.json\.\d+\.tmp$/;

const validRecord = (a: unknown): a is PidRecord => {
  const r = a as Partial<PidRecord> | null;
  return !!r && typeof r === 'object' && Number.isInteger(r.pid) && r.pid! > 0 && r.pid! <= 2 ** 31 - 1 && Number.isFinite(r.startedAt)
    && typeof r.image === 'string' && r.image.length > 0 && r.image.length <= 1024
    && typeof r.command === 'string' && r.command.length > 0 && r.command.length <= 1024;
};

/** The valid records, at most 32: the file is in the data folder and is read as untrusted (a malformed or oversized file cannot stall the start). */
function readPids(dataDir: string): PidRecord[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, PID_FILE), 'utf8')) as { agents?: unknown };
    return Array.isArray(raw.agents) ? raw.agents.filter(validRecord).slice(0, MAX_PID_RECORDS) : [];
  } catch { return []; }
}
const sleepMs = (ms: number): void => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/**
 * Temp file, then rename over the old one: a crash never leaves a torn file. With `until` (a time in ms since the epoch) the rename retries
 * on a locked file stop at that time: shutdown has a budget and a locked list must not use it up.
 */
function writePids(dataDir: string, agents: PidRecord[], opts: { until?: number; rename?: (from: string, to: string) => void } = {}): void {
  const file = join(dataDir, PID_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const { until } = opts;
  const rename = opts.rename ?? renameSync;
  const retry: RenameRetryDeps = until === undefined
    ? { rename }
    : { rename: (from, to) => { if (Date.now() >= until) throw new Error('out of time'); rename(from, to); }, sleep: (ms) => sleepMs(Math.min(ms, until - Date.now())) };
  try {
    mkdirSync(dataDir, { recursive: true });
    try { unlinkSync(tmp); } catch { /* none left over */ }
    writeFileSync(tmp, JSON.stringify({ version: 1, agents: agents.slice(-MAX_PID_RECORDS) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameWithRetry(tmp, file, retry);
  } catch { try { unlinkSync(tmp); } catch { /* nothing to remove */ } /* the file only helps a later cleanup */ }
}
/** A core that died between the temp write and the rename leaves its temp file behind, under a name with a pid that no later core has. */
function removeLeftoverTemps(dataDir: string): void {
  try {
    for (const name of readdirSync(dataDir)) {
      if (!TMP_NAME.test(name)) continue;
      const f = join(dataDir, name);
      try { if (lstatSync(f).isFile()) unlinkSync(f); } catch { /* in use or gone */ }
    }
  } catch { /* no data folder yet */ }
}

/** What the sweep reads off a live process. */
interface ProcessInfo { startedAt: number; image: string; commandLine: string; /** No live process is its parent any more (the core that started it is gone). */ parentGone: boolean }

/** Windows: one PowerShell run reads the start time, the program, the command line and whether the parent PID is a live process. */
function windowsInfoScript(pid: number): string {
  return [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    `$w = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop`,
    '$up = if ($w.ParentProcessId -gt 0) { Get-Process -Id $w.ParentProcessId -ErrorAction SilentlyContinue }',
    '[pscustomobject]@{ t = [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds(); image = $p.Path; cmd = $w.CommandLine; parentAlive = [bool]$up } | ConvertTo-Json -Compress',
  ].join('; ');
}

/** When the process with this PID started (ms since the epoch), its program, its command line and whether its parent is gone; undefined when that cannot be read. */
function processInfoOf(pid: number, timeoutMs: number): ProcessInfo | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'win32') {
    const ps = join(sysRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', windowsInfoScript(pid)], { encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs });
    if (r.status !== 0) return undefined;
    try {
      const j = JSON.parse((r.stdout ?? '').replace(/^\uFEFF/, '').trim()) as { t?: unknown; image?: unknown; cmd?: unknown; parentAlive?: unknown };
      if (typeof j.t !== 'number' || typeof j.image !== 'string' || typeof j.cmd !== 'string' || typeof j.parentAlive !== 'boolean') return undefined;
      return { startedAt: j.t, image: j.image, commandLine: j.cmd, parentGone: !j.parentAlive };
    } catch { return undefined; }
  }
  const run = (args: string[]): string | undefined => {
    for (const ps of ['/bin/ps', '/usr/bin/ps']) {
      const r = spawnSync(ps, args, { encoding: 'utf8', shell: false, timeout: timeoutMs, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
      if (r.error) continue;
      return r.status === 0 ? (r.stdout ?? '').trim() : undefined;
    }
    return undefined;
  };
  const times = run(['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)]);
  const m = times ? /^(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(times) : null;
  const t = m ? Date.parse(m[1]!) : NaN;
  const lineage = run(['-o', 'ppid=,args=', '-p', String(pid)]);
  const l = lineage ? /^(\d+)\s+(.*)$/s.exec(lineage) : null;
  if (!m || !Number.isFinite(t) || !l) return undefined;
  const ppid = Number(l[1]);
  return { startedAt: t, image: basename(m[2]!.trim()), commandLine: l[2]!, parentGone: ppid === 1 || !exists(ppid) };
}

/** The recorded program is the program running under that PID. On Linux `comm` is cut at 15 characters. */
function sameImage(recorded: string, actual: string): boolean {
  if (process.platform === 'win32') return recorded.toLowerCase() === actual.toLowerCase();
  return recorded === actual || (actual.length >= 15 && recorded.startsWith(actual));
}

/** The command line holds the recorded program file and `acp` as a word of its own (the file name acp-fake-agent.js does not count). */
function startedLikeAnAgent(commandLine: string, command: string): boolean {
  const win = process.platform === 'win32';
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  return norm(commandLine).includes(norm(command)) && /(?:^|[\s"'])acp(?:$|[\s"'])/.test(norm(commandLine));
}

const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const START_TOLERANCE_MS = 5000;

/**
 * Core start: clean up agents a core that died without cleaning left behind. The file is data an agent could have written, and everything
 * a record says about a process (its PID, start time, program) any same-user process can read off that process and copy. So it is trusted
 * for nothing but a list of candidates, and a live candidate is killed only when it also looks like what the sweep exists to end, an
 * orphaned agent: its start time matches the record (within 5 s), its program is the recorded one, its command line holds the recorded
 * program file and the word `acp`, AND its parent is gone. A forger cannot change another process's command line or parent, so the best a
 * forged record can hit is an orphaned agent. Any check that fails or cannot be read, or a used-up time budget, drops the record and leaves
 * the process alone. Also removes the temp file of a write a crash cut short.
 */
export function sweepStaleAgents(dataDir: string, opts: { budgetMs?: number } = {}): { killed: number[]; dropped: number[] } {
  const killed: number[] = [];
  const dropped: number[] = [];
  const keep: PidRecord[] = [];
  const deadline = Date.now() + (opts.budgetMs ?? SWEEP_BUDGET_MS);
  const mine = new Set([...live.keys()].map((c) => c.pid));
  removeLeftoverTemps(dataDir);
  for (const rec of readPids(dataDir)) {
    if (rec.pid === process.pid || mine.has(rec.pid)) { keep.push(rec); continue; }
    if (!exists(rec.pid)) { dropped.push(rec.pid); continue; }
    const left = deadline - Date.now();
    const info = left > 0 ? processInfoOf(rec.pid, Math.min(15_000, Math.max(1000, left))) : undefined;
    if (info && Math.abs(info.startedAt - rec.startedAt) <= START_TOLERANCE_MS && sameImage(rec.image, info.image)
      && info.parentGone && startedLikeAnAgent(info.commandLine, rec.command)) {
      killPidSync({ pid: rec.pid, exitCode: null, signalCode: null });
      killed.push(rec.pid);
    } else dropped.push(rec.pid);
  }
  // only a list that changed is written: a user who never runs an agent host never gets the file
  if (killed.length || dropped.length) writePids(dataDir, keep);
  return { killed, dropped };
}

// ---------------------------------------------------------------- registry

const live = new Map<ChildProcess, string>();
/** One-shot commands (`profile create`, `--check`, `config get`) that are running: ended with the core, so a stop in the middle of one leaves nothing behind. */
const oneShots = new Set<ChildProcess>();
let hooked = false;
function hookExit(): void {
  if (!hooked) { hooked = true; process.on('exit', () => killAllAgentsSync()); } // not the bare function: Node passes the exit code, which would become the budget
}

/**
 * Kill every agent this core started, now (about `budgetMs` in all, 5 s by default; an agent left after that is ended without a helper
 * process). The pid files are cleaned afterwards, once per data folder and only while time is left; a locked file never uses up the budget.
 */
export function killAllAgentsSync(budgetMs = 5000, deps: { rename?: (from: string, to: string) => void } = {}): void {
  const deadline = Date.now() + budgetMs;
  const ended = new Map<string, Set<number>>();
  for (const child of [...oneShots]) { killPidSync(child, Math.max(0, deadline - Date.now())); oneShots.delete(child); }
  for (const [child, dataDir] of [...live]) {
    killPidSync(child, Math.max(0, deadline - Date.now()));
    live.delete(child);
    if (child.pid !== undefined) ended.set(dataDir, (ended.get(dataDir) ?? new Set<number>()).add(child.pid));
  }
  for (const [dataDir, pids] of ended) {
    if (Date.now() >= deadline) break; // a record left behind is dropped by the next sweep
    writePids(dataDir, readPids(dataDir).filter((r) => !pids.has(r.pid)), { until: deadline, ...(deps.rename ? { rename: deps.rename } : {}) });
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
  opts: { cwd: string; extraEnv?: Record<string, string>; stripSkipFlags: boolean; dataDir: string; /** The owner's signed keep list (`envKeep`, as the Claude child gets it). The caller reads it; this file reads no config. */ envKeep?: readonly string[]; /** false: the env-scrub gate is off for this run (the caller reads the gate). */ scrub?: boolean },
  deps: { spawn?: SpawnFn } = {},
): AgentProcess {
  requireSecrets();
  const env = buildAgentEnv({ entryEnv: entry.env, extraEnv: opts.extraEnv, stripSkipFlags: opts.stripSkipFlags, envKeep: opts.envKeep, ...(opts.scrub === false ? { scrub: false } : {}) });
  const spec = launchSpec(entry.command, containedArgs(entry), env);
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? (spawn as SpawnFn))(spec.file, spec.args, { ...spawnOptions(spec, opts.cwd, env), stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    // spawn can throw at once (a NUL in the environment, a bad option); the message can quote a value, so only its code is kept
    throw new AgentLaunchError('spawn-failed', `${entry.command}: the system refused to start it (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
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
  hookExit();
  writePids(opts.dataDir, [...readPids(opts.dataDir).filter((r) => r.pid !== pid), { pid, startedAt: Date.now(), image: imageOf(spec.file), command: spec.target }]);

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

/**
 * Run `command args` once and collect its output (each stream capped at 1 MiB). A start failure is a result, not a throw.
 * It settles when the program exits (a short grace for the last output), or about 1.5 s after a timeout kill: something the program
 * started can keep the pipes open for good, and the Doctor must not wait for it. The pipes are then closed from this side.
 */
export async function runAgentCli(
  command: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string; /** The owner's signed keep list, as for `startAgentProcess`. */ envKeep?: readonly string[]; /** The entry's own `env`, applied after the filter as `startAgentProcess` applies it, so a check sees the same home as a run. */ entryEnv?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const failed = (message: string) => ({ code: null, stdout: '', stderr: redact(message), timedOut: false });
  let env: Record<string, string>;
  let spec: LaunchSpec;
  try {
    requireSecrets();
    env = buildAgentEnv({ base: opts.env ?? process.env, stripSkipFlags: false, envKeep: opts.envKeep, entryEnv: opts.entryEnv }); // a caller's env passes the same filter as an agent's
    spec = launchSpec(command, args, env);
  } catch (e) { return failed(e instanceof Error ? e.message : String(e)); }
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try { child = spawn(spec.file, spec.args, { ...spawnOptions(spec, opts.cwd, env), stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      resolve(failed(`${command}: the system refused to start it (${(e as NodeJS.ErrnoException).code ?? 'error'})`));
      return;
    }
    oneShots.add(child);
    hookExit();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      oneShots.delete(child);
      for (const t of timers) clearTimeout(t);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, stdout, stderr: redact(stderr), timedOut });
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      void killPid(child);
      timers.push(setTimeout(() => finish(null), 1500));
    }, opts.timeoutMs));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { if (stdout.length < CLI_OUTPUT_CAP) stdout += d.slice(0, CLI_OUTPUT_CAP - stdout.length); });
    child.stderr?.on('data', (d: string) => { if (stderr.length < CLI_OUTPUT_CAP) stderr += d.slice(0, CLI_OUTPUT_CAP - stderr.length); });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.once('error', (e) => { stderr += `${stderr ? '\n' : ''}${e.message}`; finish(null); });
    child.once('exit', (code) => { timers.push(setTimeout(() => finish(code), CLOSE_AFTER_EXIT_MS)); });
    child.once('close', (code) => finish(code));
  });
}
