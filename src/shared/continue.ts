/** How a turn-limit stop's error text starts; the app keys its "Paused" card on it. */
export const TURN_LIMIT_PREFIX = 'Paused at the turn limit';

/** How a spend-limit stop's error text starts; the app keys its "Paused" card on it too. */
export const BUDGET_LIMIT_PREFIX = 'Paused at the spend limit';

type TaskLike = { status: string; error?: string } | undefined;

/** A task stopped at the turn limit: a pause with the work kept, shown amber rather than as a failure. */
export const isTurnLimitPause = (t: TaskLike): boolean =>
  !!t && t.status === 'error' && (t.error ?? '').startsWith(TURN_LIMIT_PREFIX);

/** A task stopped at the spend limit (claude.maxBudgetUsd): the same kind of pause as the turn limit. */
export const isBudgetPause = (t: TaskLike): boolean =>
  !!t && t.status === 'error' && (t.error ?? '').startsWith(BUDGET_LIMIT_PREFIX);

/** Either kind of limit pause: stored as an error, but the work is kept and Continue picks it up. */
export const isLimitPause = (t: TaskLike): boolean => isTurnLimitPause(t) || isBudgetPause(t);

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
