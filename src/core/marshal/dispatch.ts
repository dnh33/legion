/**
 * The dispatch loop's pick-next (C2): which item the Marshal works next, and what its run is told.
 *
 * `dispatchable` is pure over the board's own ranked view (C1): score order decides, the column order only
 * breaks a tie, and every candidate carries the score and the line that explains its place — so "why is this
 * next?" is always one read away. Doing, review, done, blocked, Inbox proposals and the owner's own items
 * are never candidates, and an item still waiting on unfinished work is held back until it is done.
 */
import type { WorkItem } from '../../shared/board.js';
import { GOAL_MAX, renderBrief } from '../brief.js';
import { runPrompt } from '../projects/board/prompt.js';
import type { RankedBoardView } from '../projects/board/store.js';

/** One item the loop may dispatch, in the order it should be taken, with the board's explanation of that place. */
export interface DispatchCandidate {
  item: WorkItem;
  score: number;
  why: string;
  /** The member agent the owner assigned this item to: the loop routes to it (through every guard), never around it. */
  assignedTo?: string;
}

/** The two board answers pick-next needs that the view itself does not carry. */
export interface DispatchContext {
  /** The ids an item waits on (the board sidecar's `deps`). */
  depsOf(id: string): readonly string[];
  /** Whether a dependency is done, by the board's own columns. */
  isDone(id: string): boolean;
}

/** Every item the loop may dispatch right now, in score order (the board's rank decides; column order only breaks a tie). */
export function dispatchable(view: RankedBoardView, ctx: DispatchContext): DispatchCandidate[] {
  return view.items
    .filter((i) => !i.proposal && i.status === 'backlog' && !i.activeRun)
    .filter((i) => i.assignee?.kind !== 'owner')
    .filter((i) => ctx.depsOf(i.id).every((d) => ctx.isDone(d)))
    .sort((x, y) => (view.rank[y.id]?.score ?? 0) - (view.rank[x.id]?.score ?? 0) || x.order - y.order || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
    .map((item) => ({ item, score: view.rank[item.id]?.score ?? 0, why: view.rank[item.id]?.why ?? '', ...(item.assignee?.kind === 'agent' ? { assignedTo: item.assignee.id } : {}) }));
}

/** What a dispatched run is told: the contract first (goal + the done-when checks), then the item as data. */
export function dispatchPrompt(item: WorkItem, doneWhen: readonly string[]): string {
  return renderBrief(
    { goal: item.title.slice(0, GOAL_MAX), done_when: [...doneWhen], context: [`work item ${item.id} on this project's board`], returns: 'what you did, what proves it, and what is left' },
    runPrompt(item),
  );
}
