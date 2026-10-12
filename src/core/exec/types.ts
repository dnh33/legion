/**
 * The execution-backend seam. Our shell TOOL is how an agent asks to run something; an ExecutionBackend is WHERE it
 * runs. `direct-host` runs it on this machine (the default, behind the approval gate). An optional sandbox backend
 * can slot in later behind the same interface (per-agent backend selection = the trust/autonomy dial), so the tool
 * layer never has to change.
 *
 * Semantics every backend must honour:
 *  - `cmd` is a shell string; `cwd` is per-call and ERRORS (does not crash) when it is not usable.
 *  - ABSENT timeout = unlimited; expiry = group-kill + partial output + exit 124 + timedOut.
 *  - cancel (signal) = exit 130; a command killed by a signal reports 128+signum.
 *  - an exit code that cannot be known THROWS; it is never reported as 0.
 */

export interface ExecRequest {
  /** The shell command line. */
  cmd: string;
  /** Working directory for this one call. Errors (throws) if missing or unusable; never silently runs elsewhere. */
  cwd?: string;
  /** Milliseconds. Absent/undefined = unlimited. On expiry the process group is killed and the result is exit 124 + timedOut. */
  timeoutMs?: number;
  /** Extra environment for this call (validated: keys ^[A-Za-z_][A-Za-z0-9_]*$, no NUL, capped length). */
  env?: Record<string, string>;
  /** Read a login shell's profile (backends that can). Default false. */
  login?: boolean;
  /** Data written to the process's stdin then closed. */
  stdin?: string;
  /** Bound the captured output (head+tail, spill to file) instead of buffering it all. Default true. */
  boundedCapture?: boolean;
  /** Correlates streamed events with this call. */
  requestId?: string;
  /** Cancels the run (exit 130). */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Captured output (stdout+stderr interleaved, or head/tail when bounded). */
  output: string;
  /** 0 on success; 124 on timeout; 130 on cancel; 128+signum when killed by a signal. */
  exit_code: number;
  /** True only when a timeoutMs expiry killed the command. */
  timedOut?: boolean;
}

/** A running command: streamed events plus a way to wait for or kill it. */
export interface RunningExec {
  /** Chunks of output, then a terminal exit event. */
  events: AsyncIterable<{ type: 'stdout' | 'stderr'; data: string } | { type: 'exit'; exit_code: number }>;
  /** Resolves with the final result (idempotent). */
  waitForExit(): Promise<ExecResult>;
  /** Group-kill (TERM -> grace -> KILL). Idempotent. */
  kill(): Promise<void>;
}

export interface BackendCaps {
  /** Can run a shell command at all. */
  shell: boolean;
  /** Honours `cwd`. */
  perCallCwd: boolean;
  /** Can stream output while the command runs. */
  streaming: boolean;
  /** True when commands run off this machine (e.g. a sandbox gateway); approval/teardown may differ. */
  remote: boolean;
}

export interface ExecutionBackend {
  readonly name: string;
  capabilities(): BackendCaps;
  /** One-shot: start, capture, wait. Implementations normally implement this over `start()`. */
  execute(req: ExecRequest): Promise<ExecResult>;
  /** Start a command and stream it. */
  start(req: ExecRequest): RunningExec;
  /** Release any resources (kill live work). */
  cleanup(): Promise<void>;
}

/** Env keys are limited to shell-identifier shape; a NUL is never allowed and length is capped. */
export function validateEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!KEY.test(k)) throw new Error(`Invalid environment key "${k}" (expected ^[A-Za-z_][A-Za-z0-9_]*$)`);
    if (v.includes('\0')) throw new Error(`Environment value for "${k}" contains a NUL`);
    if (k.length + v.length > 32_768) throw new Error(`Environment entry "${k}" is too long`);
    out[k] = v;
  }
  return out;
}
