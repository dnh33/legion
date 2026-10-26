/**
 * Event lines from the bus (plan-logging.md, "What is recorded"). Only what the app did, as fixed fields taken from
 * values that are already on the event: never message text, deltas, room text, prompts, tool input or a run's result.
 *
 *   task.updated      -> run.started / run.finished {agent, provider, model, ms, turns, outcome}
 *   approval.*        -> approval.asked {agent, tool} / approval.answered {allowed}
 *   blender.status    -> blender.state {light}, when the light changes
 *
 * There are no updater or connector events on the bus yet; when they are added, log digests and transaction ids with
 * shortHash(), never whole.
 */
import type { EventBus } from '../bus.js';
import type { Task } from '../../shared/types.js';
import type { LogSink } from './logger.js';
import { providerPrefix } from '../providers/runtime.js';
import { acpLabel, runtimeOf } from '../../shared/runtime.js';

/**
 * The provider of the run that is starting or ending: read from the model it runs on (`openrouter:…`). The task's own
 * `provider` field is written when a provider run ENDS, so at the start it is missing or names an older run.
 */
const providerOfRun = (t: Task): string => (runtimeOf(t.model) === 'acp' ? acpLabel(t.model) ?? 'acp' : providerPrefix(t.model) ?? 'claude');

const TERMINAL = new Set<Task['status']>(['done', 'error', 'cancelled']);
const OUTCOME: Record<string, string> = { done: 'ok', error: 'error', cancelled: 'cancelled' };
const MAX_TRACKED = 2000;

/** Subscribes to the bus and writes event lines to the sink. Returns the unsubscribe function. */
export function attachLogEvents(bus: EventBus, sink: LogSink, now: () => number = Date.now): () => void {
  const agents = sink.logger('agents');
  const blender = sink.logger('blender');
  /** Per task: its last status, when its current run started, and the conversation's turn count then (a run logs its own turns). */
  const status = new Map<string, { status: Task['status']; startedAt: number; turnsAtStart?: number }>();
  let light: string | undefined;

  return bus.on((ev) => {
    try {
      if (ev.type === 'task.updated') {
        const t = ev.task;
        const prev = status.get(t.id);
        if (prev?.status === t.status) return;
        if (t.status === 'running') {
          status.set(t.id, { status: 'running', startedAt: now(), turnsAtStart: t.turns ?? 0 });
          agents.info('run.started', { agent: t.agentId, provider: providerOfRun(t), model: t.model ?? '', project: t.projectId ?? '' });
        } else if (TERMINAL.has(t.status)) {
          // Log a finish only for a run seen starting: a later edit of a finished task (archive, cost) is not one.
          if (prev && !TERMINAL.has(prev.status)) {
            const outcome = OUTCOME[t.status] ?? t.status;
            // `turns` on the task counts the whole conversation; the log line is about this run
            const turns = Math.max(0, (t.turns ?? 0) - (prev.turnsAtStart ?? 0));
            const f = { agent: t.agentId, provider: providerOfRun(t), model: t.model ?? '', ms: Math.max(0, now() - prev.startedAt), turns, outcome, project: t.projectId ?? '' };
            if (t.status === 'error') agents.warn('run.finished', f); else agents.info('run.finished', f);
          }
          status.set(t.id, { status: t.status, startedAt: prev?.startedAt ?? now() });
        } else status.set(t.id, { ...prev, status: t.status, startedAt: prev?.startedAt ?? now() });
        if (status.size > MAX_TRACKED) for (const k of status.keys()) { status.delete(k); if (status.size <= MAX_TRACKED * 0.9) break; }
      } else if (ev.type === 'approval.requested') {
        agents.info('approval.asked', { agent: ev.approval.agentId, tool: ev.approval.toolName });
      } else if (ev.type === 'approval.resolved') {
        agents.info('approval.answered', { allowed: ev.allowed });
      } else if (ev.type === 'blender.status') {
        if (ev.status.light !== light) { light = ev.status.light; blender.info('blender.state', { light: ev.status.light }); }
      }
    } catch { /* logging never throws into the bus */ }
  });
}
