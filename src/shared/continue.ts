/** How a turn-limit stop's error text starts; the app keys its "Paused" card on it. */
export const TURN_LIMIT_PREFIX = 'Paused at the turn limit';

/** How a spend-limit stop's error text starts; the app keys its "Paused" card on it too. */
export const BUDGET_LIMIT_PREFIX = 'Paused at the spend limit';

/** How a Hermes token-limit stop's error text starts. Not the spend limit: Hermes reports tokens, never money, and the tokens already used stay counted, so Continue needs a higher limit first. */
export const TOKEN_LIMIT_PREFIX = 'Paused at the token limit';

/**
 * A token count as Legion writes it. Every place that writes a token count, and every place that reads one back, takes
 * its format from here, so the two can never disagree about the separator.
 */
export const tokenCount = (n: number): string => n.toLocaleString('en-US');

/** How a run says it reached its token limit. The reader below builds its pattern from this same string, not from a copy of it. */
export const TOKEN_STOP_PREFIX = 'Stopped after ';

/** The error text of a run stopped at its token limit, e.g. `Stopped after 1,200 tokens`. Written and read through this one rule. */
export const tokenStopText = (tokens: number): string => `${TOKEN_STOP_PREFIX}${tokenCount(tokens)} tokens`;

/** The count a token-limit stop names, as written in that text, or undefined when the text is not one. */
export const tokenStopFromError = (error: string | undefined): string | undefined =>
  new RegExp(`^${TOKEN_STOP_PREFIX}([\\d,]+) tokens`).exec(error ?? '')?.[1];

type TaskLike = { status: string; error?: string } | undefined;

/** A task stopped at the turn limit: a pause with the work kept, shown amber rather than as a failure. */
export const isTurnLimitPause = (t: TaskLike): boolean =>
  !!t && t.status === 'error' && (t.error ?? '').startsWith(TURN_LIMIT_PREFIX);

/** A task stopped at the spend limit (claude.maxBudgetUsd): the same kind of pause as the turn limit. */
export const isBudgetPause = (t: TaskLike): boolean =>
  !!t && t.status === 'error' && (t.error ?? '').startsWith(BUDGET_LIMIT_PREFIX);

/** A Hermes task stopped at the token limit set for it: a pause with the work kept. */
export const isTokenPause = (t: TaskLike): boolean =>
  !!t && t.status === 'error' && (t.error ?? '').startsWith(TOKEN_LIMIT_PREFIX);

/** Any kind of limit pause: stored as an error, but the work is kept and Continue picks it up. */
export const isLimitPause = (t: TaskLike): boolean => isTurnLimitPause(t) || isBudgetPause(t) || isTokenPause(t);

/** The status-dot class for a task: a limit pause gets its own colour. */
export const statusDot = (t: { status: string; error?: string }): string => (isLimitPause(t) ? 'paused' : t.status);

/** The spend cap in config, or undefined when there is none. A hand-edited bad value counts as no cap. */
export const budgetCap = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** "$5" or "$0.25": a dollar amount for the pause text, without a needless ".00". */
export const formatUsdLimit = (n: number): string => `$${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;

/** The amount named in a spend-limit pause's error text, as written there ("$5"), or undefined. */
export const budgetLimitFromError = (error: string | undefined): string | undefined => /\((\$[\d.]+) this run\)/.exec(error ?? '')?.[1];

/**
 * What a run is sent when it picks up a stopped run in the same session (the app's Continue button, and the Sonnet -> Opus
 * escalation). The session already holds the original request; sending that again makes the model start the task over.
 */
export const CONTINUE_PROMPT = 'Continue from where you stopped. Do not start over: check what is already done, then finish the rest.';

/** How a parked run's error text starts (a run stopped on purpose while an ask waits for the owner; the work is kept). */
export const PARKED_PREFIX = 'Parked, waiting for your answer';

/** A task parked while an ask waits: stored as an error like a limit pause, shown as a waiting ask, never as a failure. */
export const isParkPause = (t: TaskLike): boolean => !!t && t.status === 'error' && (t.error ?? '').startsWith(PARKED_PREFIX);
