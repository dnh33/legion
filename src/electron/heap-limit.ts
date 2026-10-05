/**
 * V8 heap limits for the core child.
 *
 * The core is a long-lived service (it listens on the loopback port until it is signalled), so its heap ceiling is a
 * real operational setting, not a guess. Node sizes the default old-space from total RAM, which on a big machine can be
 * far more than this process needs, and on a small one can be too little for a long session's context + KG caches.
 *
 * The rule: only a core that is NOT already running under an explicit --max-old-space-size gets one. An operator who set
 * NODE_OPTIONS or passed the flag themselves keeps their value; nothing here overrides a decision the owner made.
 */

import os from 'node:os';

/** Below this the setting is ignored: a too-small ceiling makes the core OOM where it would otherwise have survived. */
export const MIN_HEAP_MB = 512;

/** The default when the machine's RAM says nothing useful (containers, cgroup limits Node cannot see). */
export const DEFAULT_HEAP_MB = 2048;

/** Node's own default for old space on a machine with at least this much RAM is higher than DEFAULT_HEAP_MB. */

export function hasExplicitHeapLimit(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.execArgv): boolean {
  if (argv.some((a) => a.startsWith('--max-old-space-size'))) return true;
  const opts = env.NODE_OPTIONS ?? '';
  return opts.includes('--max-old-space-size');
}

/**
 * The `--max-old-space-size` value to give a core child, or undefined when the owner already chose one.
 *
 * `totalMemMb` is injectable so the decision is testable without a specific machine.
 */
export function resolveHeapMb(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.execArgv,
  totalMemMb: number = Math.round(osTotalMemMb()),
): number | undefined {
  if (hasExplicitHeapLimit(env, argv)) return undefined;
  if (!Number.isFinite(totalMemMb) || totalMemMb <= 0) return DEFAULT_HEAP_MB;
  // A quarter of RAM, floored: big enough for a long session's caches, small enough that the core does not sit on a
  // multi-gigabyte ceiling it will never approach.
  const quarter = Math.floor(totalMemMb / 4);
  const mb = Math.min(quarter, DEFAULT_HEAP_MB);
  return Math.max(mb, MIN_HEAP_MB);
}

/** The argv to prepend to a core child. Empty when the owner already set the ceiling. */
export function heapArgv(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.execArgv, totalMemMb?: number): string[] {
  const mb = resolveHeapMb(env, argv, totalMemMb);
  return mb === undefined ? [] : [`--max-old-space-size=${mb}`];
}

function osTotalMemMb(): number {
  try {
    return os.totalmem() / 1024 / 1024;
  } catch {
    return 0;
  }
}