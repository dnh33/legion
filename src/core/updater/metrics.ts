/**
 * Update metrics — tracks every update attempt so failures are diagnosable.
 *
 * One JSONL line per attempt at <installDir>/.update/history.jsonl.
 * Append-only; a crash mid-write loses at most one line. Reads are lazy —
 * no reader loads history except when the panel or a doctor command asks.
 */

export interface UpdateAttempt {
  /** Wall-clock ms when the attempt started. */
  at: number
  from: string
  to: string
  result: 'ok' | 'rolled-back' | 'failed' | 're-exec'
  /** Milliseconds from attempt start to result. */
  durationMs: number
  /** Optional per-stage timings for diagnosis. */
  stages?: Record<string, number>
  reason?: string
}

export interface MetricsDeps {
  historyPath: string
  now(): number
  appendLine(path: string, line: string): void
  readLines(path: string): string[]
  log(msg: string): void
}

/**
 * Record one update attempt. Best-effort — a metrics failure never blocks
 * or fails the update itself; it logs and moves on.
 */
export function recordAttempt(deps: MetricsDeps, attempt: UpdateAttempt): void {
  try {
    deps.appendLine(deps.historyPath, JSON.stringify(attempt))
    deps.log(`[updater] metrics: ${attempt.from} -> ${attempt.to} ${attempt.result} in ${attempt.durationMs}ms`)
  } catch (error) {
    deps.log(`[updater] metrics write failed (non-fatal): ${String(error)}`)
  }
}

/** Read all recorded attempts, skipping malformed lines (a torn write is not fatal). */
export function readHistory(deps: MetricsDeps): UpdateAttempt[] {
  try {
    return deps
      .readLines(deps.historyPath)
      .map((line) => {
        try {
          return JSON.parse(line) as UpdateAttempt
        } catch {
          return null
        }
      })
      .filter((entry): entry is UpdateAttempt => entry !== null)
  } catch {
    return []
  }
}

export interface MetricsSummary {
  total: number
  ok: number
  failed: number
  rolledBack: number
  /** 0..1, or null when there are no attempts. */
  successRate: number | null
  averageDurationMs: number | null
  /** The most recent failure's reason, for the doctor panel. */
  lastFailure?: string
}

/** Summarize history for the doctor / status panel. */
export function summarizeHistory(attempts: UpdateAttempt[]): MetricsSummary {
  const total = attempts.length
  const ok = attempts.filter((a) => a.result === 'ok').length
  const rolledBack = attempts.filter((a) => a.result === 'rolled-back').length
  const failed = attempts.filter((a) => a.result === 'failed').length
  const durations = attempts.map((a) => a.durationMs).filter((d) => typeof d === 'number' && d >= 0)
  const lastFailureEntry = [...attempts].reverse().find((a) => a.result === 'failed' || a.result === 'rolled-back')

  return {
    total,
    ok,
    failed,
    rolledBack,
    successRate: total > 0 ? ok / total : null,
    averageDurationMs: durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : null,
    ...(lastFailureEntry?.reason ? { lastFailure: lastFailureEntry.reason } : {})
  }
}
