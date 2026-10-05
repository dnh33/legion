/**
 * What a run is sent when it picks up a stopped run in the same session (the app's Continue button, and the Sonnet -> Opus
 * escalation). The session already holds the original request; sending that again makes the model start the task over.
 */
/** How a turn-limit stop's error text starts; the app keys its "Paused" card on it. */
export const TURN_LIMIT_PREFIX = 'Paused at the turn limit';

/** A task stopped at the turn limit: a pause with the work kept, shown amber rather than as a failure. */
export const isTurnLimitPause = (t: { status: string; error?: string } | undefined): boolean =>
  !!t && t.status === 'error' && (t.error ?? '').startsWith(TURN_LIMIT_PREFIX);

/** The status-dot class for a task: a turn-limit pause gets its own colour. */
export const statusDot = (t: { status: string; error?: string }): string => (isTurnLimitPause(t) ? 'paused' : t.status);

export const CONTINUE_PROMPT = 'Continue from where you stopped. Do not start over: check what is already done, then finish the rest.';
