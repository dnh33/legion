/**
 * The attention tracker: how many asks wait on the owner, by project, and how many runs are working. Counts only.
 *
 * It listens to the bus (approvals, questions, tasks, the board, the away policy) and sends `attention.updated` when the numbers
 * change. The app does not need this event (it derives the same numbers from its own store with the same pure function); it is for
 * the Electron main process (taskbar overlay, notifications). Nothing here carries the text of an ask: no command, no summary,
 * nothing an agent wrote (spec 5.8).
 */
import { countAsks, deriveAsks } from '../../shared/attention.js';
import type { AskSources } from '../../shared/attention.js';
import type { AttentionView, LegionEvent, PendingQuestion, ApprovalRequest, ParkedAsk, Task } from '../../shared/types.js';
import type { EventBus } from '../bus.js';

export interface AttentionDeps {
  bus: EventBus;
  approvals: { pending(): ApprovalRequest[] };
  questions?: { pending(): PendingQuestion[] };
  store: { getTask(id: string): Task | undefined };
  /** Runs working right now. */
  working: () => number;
  /** Proposals waiting in project Inboxes. */
  inbox?: () => NonNullable<AskSources['proposals']>;
  parked?: () => ParkedAsk[];
  /** Hides asks of agents the caller may not see (BSV mode). */
  agentOk?: (agentId: string) => boolean;
}

const WATCHED: ReadonlySet<LegionEvent['type']> = new Set(['approval.requested', 'approval.resolved', 'question.requested', 'question.resolved', 'task.updated', 'board.updated', 'away.updated']);

export class AttentionTracker {
  private view: AttentionView = { total: 0, working: 0, byProject: {} };
  private json = JSON.stringify(this.view);
  private off: () => void;

  constructor(private readonly d: AttentionDeps) {
    this.view = this.compute();
    this.json = JSON.stringify(this.view);
    this.off = d.bus.on((e) => { if (WATCHED.has(e.type)) this.refresh(); });
  }

  get(): AttentionView { return { total: this.view.total, working: this.view.working, byProject: { ...this.view.byProject } }; }

  /** Recomputes; sends `attention.updated` only when something changed. */
  refresh(): void {
    let next: AttentionView;
    try { next = this.compute(); } catch { return; }
    const json = JSON.stringify(next);
    if (json === this.json) return;
    this.view = next; this.json = json;
    this.d.bus.emit({ type: 'attention.updated', attention: this.get() });
  }

  dispose(): void { this.off(); }

  private compute(): AttentionView {
    const ok = this.d.agentOk ?? (() => true);
    const approvals = this.d.approvals.pending().filter((a) => ok(a.agentId));
    const questions = (this.d.questions?.pending() ?? []).filter((q) => ok(q.agentId));
    const tasks: Array<Pick<Task, 'id' | 'projectId'>> = [];
    for (const a of [...approvals, ...questions]) {
      if (a.projectId) continue;
      const t = this.d.store.getTask(a.taskId);
      if (t) tasks.push({ id: t.id, projectId: t.projectId });
    }
    const asks = deriveAsks({ approvals, questions, tasks, parked: this.d.parked?.() ?? [], proposals: this.d.inbox?.() ?? [] });
    const c = countAsks(asks);
    return { total: c.total, working: this.d.working(), byProject: c.byProject };
  }
}
