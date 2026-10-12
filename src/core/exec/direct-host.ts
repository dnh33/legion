/**
 * The direct-host execution backend: runs a shell command on this machine via node:child_process.
 *
 * This is the one place that starts a process for the shell tool. It lives OUTSIDE src/core/providers/ on purpose:
 * test/providers-tripwire.test.ts bans child_process there, and test/bsv-scan.ts allowlists THIS file's child_process
 * use. The kill/timeout/exit semantics match the ExecutionBackend contract (types.ts): timeout expiry -> group-kill +
 * partial output + exit 124 + timedOut; cancel -> 130; a command killed by a signal reports 128+signum; an exit code
 * that cannot be known THROWS, never 0. A process-tree kill is used (taskkill /T on Windows, process-group kill on
 * POSIX) so a shelled-out child cannot outlive the call.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants as osConstants, platform } from 'node:os';
import type { BackendCaps, ExecRequest, ExecResult, ExecutionBackend, RunningExec } from './types.js';
import { validateEnv } from './types.js';
import { clampExecLimits, DEFAULT_EXEC_LIMITS, type ExecLimits } from './limits.js';

type StreamEvent = { type: 'stdout' | 'stderr'; data: string } | { type: 'exit'; exit_code: number };

function signalNum(sig: string | null | undefined): number | undefined {
  if (!sig) return undefined;
  const table = (osConstants.signals ?? {}) as Record<string, number>;
  const n = table[sig];
  return typeof n === 'number' ? n : undefined;
}

/** Kill a process AND its descendants. Guarded: only while our child is still live, so a recycled PID is never hit. */
function killTree(proc: ChildProcess, sig: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return; // already gone; a recycled PID is not ours
  const pid = proc.pid;
  if (pid === undefined) return;
  if (platform() === 'win32') {
    // /T kills the whole tree; /F forces. Safe here because the top PID is our still-running child.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    // spawned detached => the child is its own process-group leader; -pid kills the group.
    try { process.kill(-pid, sig); } catch { try { proc.kill(sig); } catch { /* already gone */ } }
  }
}

class DirectRun implements RunningExec {
  private proc: ChildProcess;
  private readonly result: Promise<ExecResult>;
  private resolveResult!: (r: ExecResult) => void;
  private rejectResult!: (e: Error) => void;
  private timedOut = false;
  private cancelled = false;
  private closed = false;
  private exitCode: number | undefined;
  private killedBySignal: string | null = null;

  // bounded capture
  private head = '';
  private tail = '';
  private total = 0;

  // event stream
  private queue: StreamEvent[] = [];
  private pending: ((v: IteratorResult<StreamEvent>) => void)[] = [];
  private finished = false;

  constructor(private readonly req: ExecRequest, private readonly limits: ExecLimits) {
    this.result = new Promise<ExecResult>((res, rej) => { this.resolveResult = res; this.rejectResult = rej; });

    const env = validateEnv(req.env);
    const cwd = req.cwd;
    this.proc = spawn(req.cmd, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      detached: platform() !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (req.stdin !== undefined) {
      this.proc.stdin?.on('error', () => { /* EPIPE when the child exits early */ });
      this.proc.stdin?.end(req.stdin);
    } else {
      this.proc.stdin?.end();
    }

    this.proc.stdout?.on('data', (d: Buffer) => this.onData('stdout', d.toString('utf8')));
    this.proc.stderr?.on('data', (d: Buffer) => this.onData('stderr', d.toString('utf8')));

    this.proc.on('error', (err) => {
      if (this.closed) return;
      this.closed = true;
      this.finished = true;
      this.push({ type: 'exit', exit_code: 127 });
      this.rejectResult(new Error(`Command failed to run: ${err.message}`));
    });

    this.proc.on('close', (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.exitCode = code ?? undefined;
      this.killedBySignal = signal ?? null;
      this.finish();
    });

    // timeout: group-kill + report 124
    if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
      const t = setTimeout(() => {
        if (this.closed) return;
        this.timedOut = true;
        killTree(this.proc, 'SIGKILL');
      }, req.timeoutMs);
      t.unref?.();
      this.proc.on('close', () => clearTimeout(t));
    }

    // cancel: group-kill + report 130
    if (req.signal) {
      const onAbort = (): void => {
        if (this.closed) return;
        this.cancelled = true;
        killTree(this.proc, 'SIGTERM');
        setTimeout(() => { if (!this.closed) killTree(this.proc, 'SIGKILL'); }, 1000).unref?.();
      };
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  private onData(type: 'stdout' | 'stderr', data: string): void {
    const cap = this.limits.maxCaptureChars;
    this.total += data.length;
    if (this.head.length < cap / 2) {
      this.head += data;
      if (this.head.length > cap / 2) { this.tail += this.head.slice(cap / 2); this.head = this.head.slice(0, cap / 2); }
    } else if (this.tail.length < cap / 2) {
      this.tail += data;
    } else {
      this.tail = this.tail.slice(data.length) + data; // sliding tail
    }
    this.push({ type, data });
  }

  private output(): string {
    const cap = this.limits.maxCaptureChars;
    if (this.total <= cap) return this.head + this.tail;
    return `${this.head}\n…[truncated ${this.total - cap} chars]…\n${this.tail}`;
  }

  private finish(): void {
    const output = this.output();
    let exit_code: number | undefined;
    if (this.timedOut) exit_code = 124;
    else if (this.cancelled) exit_code = 130;
    else if (this.killedBySignal) { const n = signalNum(this.killedBySignal); exit_code = n === undefined ? undefined : 128 + n; }
    else exit_code = this.exitCode;

    if (exit_code === undefined) {
      // Unknowable exit: throw, never 0.
      this.finished = true;
      this.push({ type: 'exit', exit_code: -1 });
      this.rejectResult(new Error('Command ended without a knowable exit code'));
      return;
    }
    this.finished = true;
    this.push({ type: 'exit', exit_code });
    this.resolveResult({ output, exit_code, ...(this.timedOut ? { timedOut: true } : {}) });
  }

  private push(e: StreamEvent): void {
    const w = this.pending.shift();
    if (w) w({ value: e, done: false });
    else this.queue.push(e);
    if (e.type === 'exit') {
      for (const p of this.pending.splice(0)) p({ value: undefined as never, done: true });
    }
  }

  events: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
      next: (): Promise<IteratorResult<StreamEvent>> => {
        const q = this.queue.shift();
        if (q) return Promise.resolve({ value: q, done: false });
        if (this.finished) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.pending.push(res));
      },
    }),
  };

  waitForExit(): Promise<ExecResult> { return this.result; }

  async kill(): Promise<void> {
    if (this.closed) return;
    this.cancelled = true;
    killTree(this.proc, 'SIGTERM');
    setTimeout(() => { if (!this.closed) killTree(this.proc, 'SIGKILL'); }, 1000).unref?.();
    await this.result.catch(() => undefined);
  }
}

export class DirectHostBackend implements ExecutionBackend {
  readonly name = 'direct-host';
  private readonly limits: ExecLimits;
  constructor(options?: { limits?: ExecLimits }) {
    this.limits = clampExecLimits(options?.limits ?? DEFAULT_EXEC_LIMITS);
  }
  capabilities(): BackendCaps { return { shell: true, perCallCwd: true, streaming: true, remote: false }; }
  execute(req: ExecRequest): Promise<ExecResult> { return new DirectRun(req, this.limits).waitForExit(); }
  start(req: ExecRequest): RunningExec { return new DirectRun(req, this.limits); }
  async cleanup(): Promise<void> { /* each run is killed through its own handle; nothing global to release */ }
}
