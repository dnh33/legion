/**
 * The turn limit and Continue, worded as on the desktop.
 *
 * These strings mirror the desktop branch `fix/long-task-turn-limit` (src/shared/continue.ts:6 and :15, and the turn-limit text
 * in src/core/engine.ts `execute`). That branch is NOT on main yet, so the file is not vendored: once it lands, the lead should
 * vendor src/shared/continue.ts and import TURN_LIMIT_PREFIX and CONTINUE_PROMPT from there instead.
 * The spec pins every string literally.
 */

/** How a turn-limit stop's text starts. The UI keys its Paused card on it. */
export const TURN_LIMIT_PREFIX = 'Paused at the turn limit'

/** What a run is sent to pick up a stopped run in the same session: sending the original request again makes the model start over. */
export const CONTINUE_PROMPT = 'Continue from where you stopped. Do not start over: check what is already done, then finish the rest.'

/** The task's error text for a turn-limit pause. Names no button: other agents read it too (desktop engine.ts, same branch). */
export function turnLimitText(maxTurns: number): string {
  return `${TURN_LIMIT_PREFIX} (${maxTurns} turns this run) before finishing. The work so far is kept: continue the task to pick up where it stopped.`
}

/** The short line the thread keeps; the full text is the task's error (desktop engine.ts, same branch). */
export function turnLimitRow(maxTurns: number): string {
  return `${TURN_LIMIT_PREFIX} (${maxTurns} turns this run).`
}

/**
 * ASSUMPTION, to be confirmed by a spike: Claude Code's `turn.complete` has no turn-limit reason (TurnCompleteReason is
 * answer | aborted | refusal | error, claude-code.d.ts:12339; TurnStopReason has no max-turns value, d.ts:12608), so a run that hit
 * `AgentSpec.maxTurns` must be inferred. This guess: the run ended without an interrupt, refusal or error, it took at least
 * `maxTurns` model requests, and its last request stopped to call a tool (it wanted to go on). Use it only until the spike shows
 * what the engine really reports.
 * `runTurns` is TaskView.runTurns: THIS run's count of model requests. Never pass `TaskView.turns`, which adds up every run of
 * the task: after one Continue that total is already at the limit, and every later run would read as paused.
 */
export function inferTurnLimit(r: { reason: 'answer' | 'aborted' | 'refusal' | 'error'; runTurns: number; maxTurns: number; lastStopReason?: string | null }): boolean {
  if (r.reason !== 'answer') return false
  if (r.runTurns < r.maxTurns) return false
  return r.lastStopReason === undefined || r.lastStopReason === 'tool_use'
}
