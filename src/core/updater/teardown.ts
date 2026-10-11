/**
 * Pre-swap teardown and the single recovery decision.
 *
 * Why this file exists: runApply used to swap the code-set entries while a Legion core could still be answering — a rename under a live
 * core is what produced the blank renderer (the old core kept serving while half its files were replaced). gracefulTeardown is the one
 * gate that must pass before swapIn: it asks the core to stop and refuses to proceed unless it is gone (fail-closed).
 *
 * judgeRecovery is the one decision point for recovery, consolidating the state decisions that were split between rollback() and
 * recoverInterrupted() in apply.ts: given only the journal state and the running version it says what must happen (swap-back / complete /
 * clean). It is pure — no I/O, no clock — so every caller gets the same verdict for the same disk state. The mechanics of swapping back
 * stay in apply.ts's rollback(); the freshness of a still-running apply helper is the caller's concern (see note on judgeRecovery).
 *
 * Self-contained like apply.ts (no runtime imports) so it can live next to .update/run/apply.mjs and run standalone.
 */
import type { Journal } from './apply.js';

export interface TeardownDeps {
  /** Asks the Legion core to shut down. May resolve before the process is actually gone. */
  stopCore(): Promise<void>;
  /** True while the core process is still present. */
  isCoreRunning(): boolean;
  /** Resolves true when the core is gone within timeoutMs, false when it is not. */
  waitExit(timeoutMs: number): Promise<boolean>;
  log(msg: string): void;
  sleep(ms: number): Promise<void>;
}

/** Grace window between the stop request and exit polling, so waitExit does not race the shutdown request. */
const SETTLE_MS = 100;

/**
 * Stops the Legion core and waits for it to be gone. Must run BEFORE swapIn: never rename code-set entries under a running core.
 * Returns ok immediately when no core is running; ok:false when the core did not exit in time or the stop failed (nothing may be swapped).
 */
export async function gracefulTeardown(deps: TeardownDeps, timeoutMs = 5000): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!deps.isCoreRunning()) return { ok: true };
    deps.log(`stopping the Legion core before the swap (waiting up to ${timeoutMs} ms)`);
    await deps.stopCore();
    await deps.sleep(SETTLE_MS);
    if (!(await deps.waitExit(timeoutMs))) {
      deps.log(`the Legion core is still running after ${timeoutMs} ms: refusing to swap`);
      return { ok: false, error: `the Legion core did not exit within ${timeoutMs} ms; nothing was changed` };
    }
    deps.log('the Legion core is down');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log(`teardown failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export type RecoveryVerdict = { action: 'swap-back' | 'complete' | 'clean'; reason: string };

/**
 * The one recovery decision: what must happen to the install folder, given the journal and the version actually running.
 * Pure; the caller performs the work — rollback() in apply.ts for 'swap-back', markCommitted() for 'complete', nothing for 'clean'.
 *
 * - swap-back: the new build is not resolved as live — put the previous build back (rollback() repairs from what is on disk, so it is
 *   correct however the swap was cut off). A 'rolled-back' journal whose versions do not match the running build re-runs the same
 *   idempotent repair rather than trusting the record.
 * - complete: 'awaiting-health' with the new build running — the swap landed and finished (the journal reached awaiting-health only after
 *   every entry was installed); the caller confirms it with markCommitted().
 * - clean: nothing to do — no journal, a resolved 'committed' record, or a 'rolled-back' record that matches the running build.
 *
 * Note: a fresh-heartbeat deferral for 'awaiting-health' (a live apply helper may still be deciding) is deliberately NOT here — this
 * function has no clock. A caller that must not race a live helper checks the heartbeat before calling.
 */
export function judgeRecovery(journal: Journal | null, runningVersion: string): RecoveryVerdict {
  if (!journal) return { action: 'clean', reason: 'no journal: nothing was in flight' };
  const match = runningVersion === journal.to;
  switch (journal.state) {
    case 'swapping':
      // The journal never left 'swapping', so the entry loop may be half-done (a full-package swap installs node_modules and runtime AFTER
      // package.json, so even a matching version can hide a partial tree): restore the previous build — fail closed.
      return { action: 'swap-back', reason: `interrupted during the swap to ${journal.to}: restoring ${journal.from}` };
    case 'awaiting-health':
      return match
        ? { action: 'complete', reason: `the swap to ${journal.to} landed and that build is running: confirm it` }
        : { action: 'swap-back', reason: `the swap to ${journal.to} never went live (running ${runningVersion}): restoring ${journal.from}` };
    case 'committed':
      return { action: 'clean', reason: `the update to ${journal.to} was already committed` };
    case 'rolled-back':
      // Recovery already happened — idempotent: never re-run repair on a second call.
      return { action: 'clean', reason: `a rollback is already on record: nothing to recover` };
    default:
      return { action: 'clean', reason: `unrecognised journal state ${String((journal as { state?: unknown }).state)}: nothing to act on` };
  }
}
