/**
 * Blender local-first: interfaces only (no runner, no spawn code here). The runner (local.ts) implements LocalPort; the guard talks to it through
 * this file so tests can fake it. See claude/plan-blender-local-first.md sections 2.2-2.4.
 */
import type { AgentProfile } from '../../shared/types.js';
import type { BackendResult } from './backend.js';

/** Where one run goes. `sandbox` stays the internal name of the VM mode (shown as "Cloud VM"). */
export type RunMode = 'live' | 'sandbox' | 'local';

export interface LocalRunResult {
  ok: boolean;
  text: string;
  /** Exports copied into the task workspace. A .blend is set aside (`quarantined`) because it can carry runnable code. */
  files: Array<{ name: string; path: string; bytes: number; quarantined?: boolean }>;
  timedOut?: boolean;
  /** Path of the scene backup made before this run. */
  backup?: string;
}

/** What the guard needs from the local runner. `hash` is the sha256 the user approved; the runner refuses a script whose bytes differ. */
export interface LocalPort {
  /** Blender >= 3.0 found on this computer. */
  readiness(agent: AgentProfile): { ready: boolean; note: string };
  run(req: { agent: AgentProfile; taskId: string; script: string; hash: string; timeoutMs: number }): Promise<LocalRunResult>;
  inspect(req: { agent: AgentProfile; taskId: string; object?: string }): Promise<BackendResult>;
  preview(req: { agent: AgentProfile; taskId: string; maxSize?: number }): Promise<BackendResult>;
}

export interface SpawnRequest {
  /** Arguments after the executable. Never joined into a shell line. */
  args: string[];
  cwd: string;
  /** The complete child environment (built from an allowlist, never a copy of process.env). */
  env: Record<string, string>;
  /** Stop the child when this many bytes of stdout+stderr have been read. */
  maxOutputBytes: number;
}

export interface SpawnedProcess {
  pid: number | undefined;
  /** Resolves when the process has exited (or could not start). */
  exited: Promise<{ code: number | null; signal: string | null; error?: string }>;
  stdout(): string;
  stderr(): string;
}

/**
 * The only way local code starts or stops a process. Production spawns nothing but the detected blender executable (shell:false, windowsHide);
 * `file` and `prefixArgs` exist ONLY as a test seam (a fake blender run as `node fake.mjs ...`) and production never sets them.
 */
export interface ProcessPort {
  spawn(req: SpawnRequest & { file?: string; prefixArgs?: string[] }): SpawnedProcess;
  /** Stops the process and its children; resolves true when it is gone. */
  kill(pid: number): Promise<boolean>;
}
