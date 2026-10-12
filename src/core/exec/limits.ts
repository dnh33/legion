/**
 * The tunable limits for host execution. They are config, not magic numbers: each has a default and is clamped so a
 * bad value cannot switch off a safety rail, and they are the Settings surface for the agent shell.
 *
 * Grounding for the defaults (from the agent harnesses Legion already mirrors):
 *  - `timeoutSeconds` 120: a two-minute command timeout is the house default (Blender local exec uses 120 too); a
 *    host build/test command needs more than a cloud probe's 30s, and 3600 is the hard ceiling.
 *  - `maxOutputChars` 12_000: matches vm_exec's output window (truncateTail), so a host call and a VM call hand the
 *    agent the same amount of text.
 *  - `maxWriteChars` / `maxCaptureChars`: safety bounds, not harness-derived — generous, configurable, there to stop a
 *    runaway write or an unbounded buffer, not to match any particular tool.
 */

export interface ExecLimits {
  /** Default shell command timeout, in seconds (a call may still pass its own timeoutMs). */
  timeoutSeconds: number;
  /** The output window returned to the agent for one call. */
  maxOutputChars: number;
  /** The largest single file write accepted. */
  maxWriteChars: number;
  /** The most the backend buffers from a command before it drops the middle (head+tail kept). */
  maxCaptureChars: number;
}

export const DEFAULT_EXEC_LIMITS: ExecLimits = {
  timeoutSeconds: 120,
  maxOutputChars: 12_000,
  maxWriteChars: 1_000_000,
  maxCaptureChars: 1_000_000,
};

function clamp(v: unknown, d: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
}

/** Fill in defaults and clamp every value. A partial or hostile shape cannot disable a bound. */
export function clampExecLimits(p: Partial<ExecLimits> | undefined): ExecLimits {
  return {
    timeoutSeconds: clamp(p?.timeoutSeconds, DEFAULT_EXEC_LIMITS.timeoutSeconds, 1, 3600),
    maxOutputChars: clamp(p?.maxOutputChars, DEFAULT_EXEC_LIMITS.maxOutputChars, 256, 2_000_000),
    maxWriteChars: clamp(p?.maxWriteChars, DEFAULT_EXEC_LIMITS.maxWriteChars, 1024, 20_000_000),
    maxCaptureChars: clamp(p?.maxCaptureChars, DEFAULT_EXEC_LIMITS.maxCaptureChars, 1024, 20_000_000),
  };
}
