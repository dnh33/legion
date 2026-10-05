/**
 * How a task and its thread change as its runs report in. Pure reducers: the lead turns engine events (agent.spawn,
 * turn.step, tool.call, turn.complete, ...) into RunEvents and stores what these return in `$.state`.
 *
 * Status rules mirror the desktop (src/core/engine.ts `execute`, and the turn-limit branch fix/long-task-turn-limit):
 * - a run that stops at the turn limit pauses the task (`paused`, the turn-limit text as its error); Continue picks it up;
 * - an error or a refusal is `error`, with a plain message; the task can be continued (`isResumable`);
 * - a run the person stopped is `cancelled`;
 * - cost accumulates from each run's usage through cost.ts; `turns` counts model requests (`step`) across all of the task's runs,
 *   like its tokens and cost; `runTurns` counts them in the current run only (0 on started / continued), for the turn-limit check.
 * - cancelled is final: a run that reports after the person stopped it leaves the task cancelled and adds no error or pause row.
 * Row ids are deterministic, with no random ids. Tool rows use the tool_use_id and the finish, continue and escalation rows use
 * the run id, so replaying those events never duplicates a row. User, reply and stop rows have no natural id (their id is the
 * row's position), so the caller feeds each of those once.
 */
import type { ApprovalCard, AgentId, Mood, ModSettings, TaskView, ThreadRow, TokenCount } from '../../types/index.d.ts'
import { TURN_LIMIT_PREFIX, turnLimitRow, turnLimitText } from './continue.ts'
import { addTokens, estimateUsd } from './cost.ts'
import { escalationText } from './router.ts'
import { taintsRun } from './taint.ts'

export type FinishReason = 'answer' | 'aborted' | 'refusal' | 'error'

export type RunEvent =
  /** A task was created or re-queued. `prompt` (optional) adds the user row; `fromAgentId` marks a bridged message. */
  | { type: 'queued'; task: TaskView; prompt?: string; fromAgentId?: AgentId }
  | { type: 'started'; taskId: string; runId: string; model: string }
  /** One model request of the run (turn.step). */
  | { type: 'step'; runId: string }
  | { type: 'tool'; runId: string; toolUseId: string; tool: string; summary: string }
  | { type: 'toolDone'; runId: string; toolUseId: string; isError: boolean }
  | { type: 'card'; card: ApprovalCard }
  | { type: 'cardDone'; toolUseId: string; allowed: boolean }
  /** An assistant text row (a reply landed). */
  | { type: 'reply'; runId: string; text: string }
  | { type: 'finished'; runId: string; reason: FinishReason; answer: string; usage?: TokenCount; model?: string; isTurnLimit?: boolean; errorText?: string }
  /** The person stopped the task. */
  | { type: 'stopped'; taskId: string }
  /** The task's stopped run was resumed (Continue, a queued message, a bridge reply). */
  | { type: 'continued'; taskId: string; runId: string }
  /** The task took its one escalation from Sonnet to Opus (router.ts canEscalate). */
  | { type: 'escalated'; taskId: string; runId: string; errorText?: string }

/** What a refusal leaves on the task. Plain words, and the next step. */
export const REFUSAL_TEXT = 'Claude declined this request. Rephrase it, or continue the task with more context.'
/** What an error with no text of its own leaves on the task. */
export const ERROR_TEXT = 'The run stopped on an error before it finished. Continue the task to try again.'
/** The thread's line when a stopped task picks up again. */
export const CONTINUED_TEXT = 'Continued where it stopped.'
/** The thread's line when the person stops a task. */
export const STOPPED_TEXT = 'Stopped by you.'

const isLive = (t: TaskView) => t.status === 'queued' || t.status === 'running'

/** Whether Continue can pick the task up: it has a run to resume and is not running. The contract has no separate flag. */
export function isResumable(t: Pick<TaskView, 'status' | 'runId'>): boolean {
  return t.runId !== undefined && (t.status === 'paused' || t.status === 'error' || t.status === 'cancelled' || t.status === 'done')
}

/** True for a task paused at the turn limit, by status or by its error text (desktop isTurnLimitPause, same branch). */
export function isTurnLimitPause(t: Pick<TaskView, 'status' | 'error'>): boolean {
  return t.status === 'paused' || (t.status === 'error' && (t.error ?? '').startsWith(TURN_LIMIT_PREFIX))
}

function without<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const { [k]: _gone, ...rest } = o
  return rest
}

/**
 * The task after one event. `task` is undefined only before `queued`. Events for another task, or for a run that is not the
 * task's current run, return the task unchanged (the same object).
 */
export function reduceTask(task: TaskView | undefined, ev: RunEvent, now: number, settings: Pick<ModSettings, 'maxTurns'>): TaskView | undefined {
  if (ev.type === 'queued') {
    if (!task) return { ...without(ev.task, 'error'), status: 'queued', updatedAt: now }
    if (task.id !== ev.task.id) return task
    // Re-queued (a follow-up): keep what the task has gathered, as the desktop's re-queue spreads the previous task
    // (src/core/engine.ts:228-239). Taint and the escalation only ever turn on ("taints this task for good").
    return {
      ...without(ev.task, 'error'),
      isTainted: task.isTainted || ev.task.isTainted,
      isEscalated: task.isEscalated || ev.task.isEscalated,
      tokens: task.tokens, costUsd: task.costUsd, turns: task.turns,
      status: 'queued', updatedAt: now,
    }
  }
  if (!task) return task
  switch (ev.type) {
    case 'started':
      if (ev.taskId !== task.id) return task
      return { ...without(task, 'error'), status: 'running', runId: ev.runId, model: ev.model, runTurns: 0, updatedAt: now }
    case 'continued':
      if (ev.taskId !== task.id) return task
      return { ...without(task, 'error'), status: 'running', runId: ev.runId, runTurns: 0, updatedAt: now }
    case 'step':
      if (ev.runId !== task.runId) return task
      return { ...task, turns: task.turns + 1, runTurns: task.runTurns + 1, updatedAt: now }
    case 'tool':
      if (ev.runId !== task.runId) return task
      return taintsRun(ev.tool) && !task.isTainted ? { ...task, isTainted: true, updatedAt: now } : task
    case 'escalated':
      if (ev.taskId !== task.id || ev.runId !== task.runId) return task
      return { ...task, isEscalated: true, model: 'opus', updatedAt: now }
    case 'stopped':
      if (ev.taskId !== task.id || !isLive(task)) return task
      return { ...without(task, 'error'), status: 'cancelled', updatedAt: now }
    case 'finished': {
      if (ev.runId !== task.runId) return task
      const model = ev.model ?? task.model
      const usage = ev.usage
      const spent = usage ? { tokens: addTokens(task.tokens, usage), costUsd: task.costUsd + estimateUsd(model, usage).usd } : {}
      const base = { ...without(task, 'error'), ...spent, ...(model !== undefined ? { model } : {}), updatedAt: now }
      // A task the person stopped stays cancelled, whatever the run reports after the stop.
      if (task.status === 'cancelled' || ev.reason === 'aborted') return { ...base, status: 'cancelled' }
      if (ev.reason === 'answer' && ev.isTurnLimit === true) return { ...base, status: 'paused', error: turnLimitText(settings.maxTurns) }
      if (ev.reason === 'answer') return { ...base, status: 'done' }
      if (ev.reason === 'refusal') return { ...base, status: 'error', error: REFUSAL_TEXT }
      return { ...base, status: 'error', error: ev.errorText?.trim() || ERROR_TEXT }
    }
    default:
      return task
  }
}

/** The thread's stop row ids are `<task>:stopped:<n>`, its Continue rows `<run>:continued`. */
function isStoppedSinceLastRun(rows: readonly ThreadRow[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.role === 'system' && r.id.includes(':stopped:')) return true
    if (r.role === 'user' || r.id.endsWith(':continued')) return false
  }
  return false
}

function upsertTool(rows: readonly ThreadRow[], id: string, make: () => ThreadRow, patch: (r: ThreadRow) => ThreadRow): ThreadRow[] {
  const i = rows.findIndex((r) => r.id === id)
  if (i < 0) return [...rows, make()]
  const next = patch(rows[i]!)
  if (next === rows[i]) return rows as ThreadRow[]
  const out = rows.slice()
  out[i] = next
  return out
}

/**
 * One task's thread after one event. Tool rows are updated in place: running → ok / error, running → awaiting (a card) →
 * running / denied. A denied call's later error result keeps it `denied`. A card that arrives before its tool row creates the row.
 */
export function reduceThread(rows: readonly ThreadRow[], ev: RunEvent, now: number, settings?: Pick<ModSettings, 'maxTurns'>): ThreadRow[] {
  const sys = (id: string, text: string): ThreadRow[] => (rows.some((r) => r.id === id) ? (rows as ThreadRow[]) : [...rows, { id, role: 'system', text, at: now }])
  switch (ev.type) {
    case 'queued': {
      if (ev.prompt === undefined) return rows as ThreadRow[]
      const id = `${ev.task.id}:u${now.toString(36)}-${rows.length}`
      return [...rows, { id, role: 'user', text: ev.prompt, ...(ev.fromAgentId !== undefined ? { fromAgentId: ev.fromAgentId } : {}), at: now }]
    }
    case 'tool':
      return upsertTool(rows, ev.toolUseId,
        () => ({ id: ev.toolUseId, role: 'tool', text: '', tool: { name: ev.tool, summary: ev.summary, state: 'running' }, at: now }),
        (r) => (r.tool && r.tool.name === '' ? { ...r, tool: { ...r.tool, name: ev.tool, summary: ev.summary } } : r))
    case 'card':
      return upsertTool(rows, ev.card.id,
        () => ({ id: ev.card.id, role: 'tool', text: '', tool: { name: ev.card.tool, summary: ev.card.summary, state: 'awaiting' }, at: now }),
        (r) => (r.tool && r.tool.state === 'running' ? { ...r, tool: { ...r.tool, state: 'awaiting' } } : r))
    case 'cardDone':
      return upsertTool(rows, ev.toolUseId, () => ({ id: ev.toolUseId, role: 'tool', text: '', tool: { name: '', summary: '', state: ev.allowed ? 'running' : 'denied' }, at: now }),
        (r) => (r.tool && r.tool.state === 'awaiting' ? { ...r, tool: { ...r.tool, state: ev.allowed ? 'running' : 'denied' } } : r))
    case 'toolDone':
      return upsertTool(rows, ev.toolUseId, () => ({ id: ev.toolUseId, role: 'tool', text: '', tool: { name: '', summary: '', state: ev.isError ? 'error' : 'ok' }, at: now }),
        (r) => (r.tool && (r.tool.state === 'running' || r.tool.state === 'awaiting') ? { ...r, tool: { ...r.tool, state: ev.isError ? 'error' : 'ok' } } : r))
    case 'reply': {
      if (!ev.text.trim()) return rows as ThreadRow[]
      const id = `${ev.runId}:a${now.toString(36)}-${rows.length}`
      return [...rows, { id, role: 'assistant', text: ev.text, at: now }]
    }
    case 'finished': {
      let out = rows as ThreadRow[]
      // Cancelled is final: when the person's stop is the latest thing in the thread (no new prompt or Continue since), a late
      // error or pause from the stopped run adds no row.
      const cancelled = isStoppedSinceLastRun(out)
      const last = [...out].reverse().find((r) => r.role === 'assistant')
      if (ev.answer.trim() && last?.text !== ev.answer && !out.some((r) => r.id === `${ev.runId}:answer`)) out = [...out, { id: `${ev.runId}:answer`, role: 'assistant', text: ev.answer, at: now }]
      const add = (id: string, text: string) => (out.some((r) => r.id === id) ? out : [...out, { id, role: 'system' as const, text, at: now }])
      if (cancelled) return out
      if (ev.reason === 'answer' && ev.isTurnLimit === true) return add(`${ev.runId}:paused`, settings ? turnLimitRow(settings.maxTurns) : `${TURN_LIMIT_PREFIX}.`)
      if (ev.reason === 'refusal') return add(`${ev.runId}:error`, `Error: ${REFUSAL_TEXT}`)
      if (ev.reason === 'error') return add(`${ev.runId}:error`, `Error: ${ev.errorText?.trim() || ERROR_TEXT}`)
      return out
    }
    case 'stopped':
      return sys(`${ev.taskId}:stopped:${rows.length}`, STOPPED_TEXT)
    case 'continued':
      return sys(`${ev.runId}:continued`, CONTINUED_TEXT)
    case 'escalated':
      return sys(`${ev.runId}:escalated`, escalationText(ev.errorText))
    default:
      return rows as ThreadRow[]
  }
}

/** The mood an event asks for (mood.ts decides whether it shows yet). Undefined: no change. */
export function moodFor(ev: RunEvent): Mood | undefined {
  switch (ev.type) {
    case 'queued': return 'listening'
    case 'started': case 'step': case 'reply': case 'continued': case 'escalated': return 'thinking'
    case 'tool': return 'hacking'
    case 'card': return 'awaiting'
    case 'cardDone': return ev.allowed ? 'hacking' : 'thinking'
    case 'toolDone': return undefined
    case 'stopped': return 'idle'
    case 'finished':
      if (ev.reason === 'aborted') return 'idle'
      if (ev.reason === 'answer') return ev.isTurnLimit === true ? 'awaiting' : 'victory'
      return 'error'
    default: return undefined
  }
}
