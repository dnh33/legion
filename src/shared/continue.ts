/**
 * What a run is sent when it picks up a stopped run in the same session (the app's Continue button, and the Sonnet -> Opus
 * escalation). The session already holds the original request; sending that again makes the model start the task over.
 */
/** How a turn-limit stop's error text starts; the app keys its "Paused" card on it. */
export const TURN_LIMIT_PREFIX = 'Paused at the turn limit';

export const CONTINUE_PROMPT = 'Continue from where you stopped. Do not start over: check what is already done, then finish the rest.';
