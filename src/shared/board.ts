/**
 * Legion — project board contract (see claude/plan-project-board.md). Work items inside a Project. Experimental: only served when
 * config.json says experimental.projectBoard = true. The board stores and shows; it never executes anything by itself.
 */
export const BOARD_STATUSES = ['backlog', 'doing', 'review', 'done', 'blocked'] as const;
export type BoardStatus = typeof BOARD_STATUSES[number];
export const BOARD_PRIORITIES = ['low', 'normal', 'high'] as const;
export type BoardPriority = typeof BOARD_PRIORITIES[number];
/** What a bot may set on an item assigned to it. Never `done` (only the owner closes work), never `backlog`. */
export const BOT_STATUSES = ['doing', 'review', 'blocked'] as const;

export type BoardActor =
  | { kind: 'owner' }
  | { kind: 'agent'; id: string; tainted?: boolean }
  | { kind: 'system' };

export type BoardAssignee = { kind: 'owner' } | { kind: 'agent'; id: string };

export interface ActivityEntry { at: string; by: BoardActor; kind: string; text: string }

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: BoardStatus;
  assignee: BoardAssignee | null;
  /** YYYY-MM-DD */
  due?: string;
  priority: BoardPriority;
  labels: string[];
  /** Position inside its status column (0-based, dense). */
  order: number;
  createdBy: BoardActor;
  updatedBy: BoardActor;
  createdAt: string;
  updatedAt: string;
  /** `untrusted`: the text was written by a bot (or a tainted run) and the owner has not marked it reviewed. */
  trust: 'human' | 'untrusted';
  /** Present only while the item waits in the Inbox. */
  proposal?: { suggestedAssignee?: string };
  taskIds: string[];
  roomIds: string[];
  /** Task id of a "Run this item" run that has not ended yet. */
  activeRun?: string;
  lastRun?: { taskId: string; status: string; endedAt: string; tainted: boolean; preview: string };
  activity: ActivityEntry[];
}

export const BOARD_LIMITS = {
  itemsPerProject: 200, inboxPerProject: 30, inboxPerAgent: 8,
  titleChars: 120, descriptionChars: 2_000, noteChars: 500, activityEntries: 20,
  labels: 5, labelChars: 24, taskLinks: 20, roomLinks: 10, previewChars: 1_000,
  /** Bot proposals: this many per agent and project in the window. */
  proposalsPerWindow: 5, proposalWindowMs: 10 * 60_000,
  /** Every bot write (propose + update_own) per agent. */
  botWritesPerWindow: 40,
  fileBytes: 4 * 1024 * 1024,
} as const;

export const WORK_ITEM_ID_RE = /^wi_[a-f0-9]{12}$/;
export const COLUMN_LABEL: Record<BoardStatus, string> = { backlog: 'Backlog', doing: 'Doing', review: 'Review', done: 'Done', blocked: 'Blocked' };

export interface BoardView { items: WorkItem[]; inbox: WorkItem[]; archived: boolean }
