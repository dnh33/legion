/**
 * The board's prioritization: one explainable score per item, so `priority` actually orders work.
 *
 * score = priority band + due urgency + trust + dependency blocking. The gap between two priority
 * bands (PRIORITY_STEP) is wider than the other factors can span together (due 400 + trust 10 +
 * blocking 100 = 510 at the extremes), so priority decides every comparison first: a high item never
 * lands below a low one, whatever its dates say. Each factor carries the number it contributed and
 * one line saying why, so a rank can be explained and not just obeyed.
 *
 * Pure and deterministic: `now` (epoch milliseconds) is passed in; nothing here reads a clock or a store.
 */
import type { BoardPriority, WorkItem } from '../../../shared/board.js';

/**
 * What the scorer reads. `deps` — the ids of items this one waits for — is not on the board's own
 * `WorkItem` yet, so it is read as an optional extra: an item that carries one can be held back by it.
 */
export type ScoredItem = Pick<WorkItem, 'priority' | 'due' | 'trust'> & { deps?: readonly string[] };

/** The four things a rank is made of, in the order a tie between them is settled. */
export type PriorityFactor = 'priority' | 'due' | 'trust' | 'blocked';
const FACTORS: readonly PriorityFactor[] = ['priority', 'due', 'trust', 'blocked'];

/** One factor's part of the score: what it added to the score, and the line a human reads to see why. */
export interface FactorScore { value: number; reason: string }
export type ScoreFactors = Record<PriorityFactor, FactorScore>;
export interface WorkItemScore { score: number; factors: ScoreFactors }

/** The distance between two priority bands: what `low` must make up to reach `normal`, `normal` to reach `high`. */
const PRIORITY_STEP = 1000;
const PRIORITY_VALUE: Record<BoardPriority, number> = { low: 0, normal: PRIORITY_STEP, high: 2 * PRIORITY_STEP };

/** Due urgency on or before the due date, falling with the days left to 0 (what no urgency gets) at the window. */
const DUE_MAX = 400;
/** A due date this far ahead is no more urgent than having no due date at all. */
const DUE_WINDOW_DAYS = 30;
/** Reviewed text over an agent's unreviewed text: the nudge that settles a tie, never a rank on its own. */
const TRUST_HUMAN = 10;
/** How far an item that still waits on unfinished work sinks. */
const BLOCKED = 100;
const DAY_MS = 86_400_000;

/** What each factor contributes for a plain item: normal priority, no due date, reviewed, waiting on nothing. */
const NEUTRAL: Record<PriorityFactor, number> = { priority: PRIORITY_STEP, due: 0, trust: TRUST_HUMAN, blocked: 0 };

const priorityFactor = (priority: BoardPriority): FactorScore => ({
  value: PRIORITY_VALUE[priority],
  reason: priority === 'high'
    ? 'High priority: ahead of every normal and low item, whatever the dates say.'
    : priority === 'low'
      ? 'Low priority: behind every normal and high item.'
      : 'Normal priority: the middle band, between high and low.',
});

/** Whole calendar days, in UTC, from today to the due date: 0 = due today, -3 = three days overdue. */
const daysTo = (dueMs: number, now: number): number => Math.round((dueMs - Math.floor(now / DAY_MS) * DAY_MS) / DAY_MS);

const dueFactor = (due: string | undefined, now: number): FactorScore => {
  if (!due) return { value: 0, reason: 'No due date: no urgency either way.' };
  const dueMs = Date.parse(`${due}T00:00:00Z`);
  if (!Number.isFinite(dueMs)) return { value: 0, reason: `Due "${due}" is not a real date: no urgency.` };
  const days = daysTo(dueMs, now);
  if (days < 0) {
    const late = -days;
    return { value: DUE_MAX, reason: `Due ${due}: ${late} day${late === 1 ? '' : 's'} overdue.` };
  }
  if (days === 0) return { value: DUE_MAX, reason: `Due ${due}: due today.` };
  if (days >= DUE_WINDOW_DAYS) return { value: 0, reason: `Due ${due}: ${days} days away, past the ${DUE_WINDOW_DAYS}-day window: no urgency yet.` };
  return { value: Math.round(DUE_MAX * (1 - days / DUE_WINDOW_DAYS)), reason: `Due ${due}: ${days} day${days === 1 ? '' : 's'} away.` };
};

const trustFactor = (trust: WorkItem['trust']): FactorScore => trust === 'human'
  ? { value: TRUST_HUMAN, reason: 'The owner has read this text: the trusted side of a tie.' }
  : { value: 0, reason: 'Written by an agent and not read by the owner yet: a step down from reviewed text in a tie.' };

/**
 * Dependency blocking: an item that waits on items this board has not finished is pushed down until
 * they are done. `isDepDone` is how the caller (which can see the other items) answers; without one,
 * a dependency nobody has confirmed done counts as not done.
 */
const blockedFactor = (item: ScoredItem, isDepDone: (id: string) => boolean): FactorScore => {
  const deps = Array.isArray(item.deps) ? item.deps.filter((d): d is string => typeof d === 'string') : [];
  if (!deps.length) return { value: 0, reason: 'Waiting on nothing: nothing holds it back.' };
  const open = deps.filter((d) => !isDepDone(d));
  if (!open.length) return { value: 0, reason: `The ${deps.length} item${deps.length === 1 ? '' : 's'} it waits ${deps.length === 1 ? 'on is' : 'on are'} done: nothing holds it back.` };
  const shown = open.length === 1 ? open[0]! : `${open[0]} and ${open.length - 1} more`;
  return { value: -BLOCKED, reason: `Waiting on ${shown} to be done first: pushed down until then.` };
};

/**
 * One item's rank: the score the board sorts by, and every factor that made it, with its own
 * contribution and one line of reason. `now` is the caller's clock, so two calls with the same
 * arguments always return the same numbers.
 */
export function scoreWorkItem(item: ScoredItem, now: number, isDepDone: (id: string) => boolean = () => false): WorkItemScore {
  // a missing or broken clock must not leak NaN into the score and scramble the order
  const t = Number.isFinite(now) ? now : 0;
  const factors: ScoreFactors = {
    priority: priorityFactor(item.priority),
    due: dueFactor(item.due, t),
    trust: trustFactor(item.trust),
    blocked: blockedFactor(item, isDepDone),
  };
  const score = FACTORS.reduce((sum, f) => sum + factors[f].value, 0);
  return { score, factors };
}

/**
 * The factor that explains a rank most: the one furthest from what a plain item gets. Priority wins
 * when it is not the plain band, and a plain item falls back to its band, so the line shown is never
 * a factor that had nothing to do with the ranking. Ties go in FACTORS order.
 */
export function topFactor(factors: ScoreFactors): PriorityFactor {
  let best: PriorityFactor = 'priority';
  let gap = Math.abs(factors.priority.value - NEUTRAL.priority);
  for (const f of FACTORS) {
    const g = Math.abs(factors[f].value - NEUTRAL[f]);
    if (g > gap) { best = f; gap = g; }
  }
  return best;
}
