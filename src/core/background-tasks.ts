/**
 * The background agents a Claude run has going, read from the Agent SDK's own system messages (sdk.d.ts, SDKMessage union):
 *
 *  - `background_tasks_changed` { tasks: [{ task_id, task_type, description, ambient? }] }: the full live set, REPLACE semantics. The SDK
 *    calls it a level signal and says a consumer that only needs "is background work running" should swap its set for each payload.
 *  - `task_started` { task_id, task_type?, subagent_type?, is_backgrounded?, ambient? } and `task_notification` { task_id, status } are the
 *    edge bookends; `task_updated` { patch: { is_backgrounded?, status? } } moves a foreground task to the background or ends one.
 *
 * Until the first level message of a run arrives the edges are used; after it only the level is, so a missed bookend cannot pin a run.
 * Pure state, no I/O: the engine feeds it every message of a run.
 *
 * What counts: agents and workflows (`local_agent`, `local_workflow`), the kinds the SDK says are held back and killed when the input
 * closes (see `perTaskStopAffordance` in sdk.d.ts). A background shell (`local_bash`, a dev server) never has to finish and is not waited on;
 * `mcp_task` and ambient (housekeeping, watcher) entries are not activity either.
 */
interface Known { description: string; type?: string; backgrounded: boolean }

const COUNTED = new Set(['local_agent', 'local_workflow']);

const counted = (type: unknown, subagentType: unknown, ambient: unknown): boolean => {
  if (ambient === true) return false;
  if (typeof type === 'string') return COUNTED.has(type);
  // an edge message from an older producer may omit task_type: a task with a subagent type is an agent
  return typeof subagentType === 'string' && subagentType !== '';
};

export class BackgroundTasks {
  private levelSeen = false;
  private readonly live = new Map<string, string>();
  private readonly known = new Map<string, Known>();

  get count(): number { return this.live.size; }
  /** Ids of the running background tasks (to stop them). */
  ids(): string[] { return [...this.live.keys()]; }
  /** One line per running background task (descriptions come from the model: show them only as data). */
  descriptions(): string[] { return [...this.live.values()]; }

  /** Feed one SDK message. Returns true when the number of running background tasks changed. */
  note(msg: any): boolean {
    if (msg?.type !== 'system') return false;
    const before = this.live.size;
    switch (msg.subtype) {
      case 'background_tasks_changed': {
        this.levelSeen = true;
        this.live.clear();
        for (const t of Array.isArray(msg.tasks) ? msg.tasks : []) {
          if (typeof t?.task_id === 'string' && counted(t.task_type, undefined, t.ambient)) this.live.set(t.task_id, String(t.description ?? ''));
        }
        break;
      }
      case 'task_started': {
        if (typeof msg.task_id !== 'string') break;
        const k: Known = { description: String(msg.description ?? ''), type: typeof msg.task_type === 'string' ? msg.task_type : undefined, backgrounded: msg.is_backgrounded === true };
        if (!counted(msg.task_type, msg.subagent_type, msg.ambient)) break;
        this.known.set(msg.task_id, k);
        if (!this.levelSeen && k.backgrounded) this.live.set(msg.task_id, k.description);
        break;
      }
      case 'task_updated': {
        if (this.levelSeen || typeof msg.task_id !== 'string') break;
        const k = this.known.get(msg.task_id);
        const patch = msg.patch ?? {};
        if (k && patch.is_backgrounded === true) { k.backgrounded = true; if (!this.live.has(msg.task_id)) this.live.set(msg.task_id, k.description); }
        if (typeof patch.status === 'string' && ['completed', 'failed', 'killed'].includes(patch.status)) { this.live.delete(msg.task_id); this.known.delete(msg.task_id); }
        break;
      }
      case 'task_notification': {
        if (this.levelSeen || typeof msg.task_id !== 'string') break;
        this.live.delete(msg.task_id);
        this.known.delete(msg.task_id);
        break;
      }
      default: break;
    }
    return this.live.size !== before;
  }
}
