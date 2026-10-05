/**
 * The wiring's pure half: the runtime's memory (Ctx) and every decision the hooks make that needs no `$`.
 *
 * src/wire/legion.tsx holds the hooks; anything here is plain logic over plain data, tested in mod/test/node/wire. Keeping
 * the decisions here keeps the hooks file to "read the event, ask core, write the result".
 */
import type { AgentId, AgentView, ApprovalCard, BandItem, ModSettings, MoodState, RunRequest, TaskOrigin, TaskView, ThreadRow, UiState } from '../../types/index.d.ts'
import type { RateLog } from '../engine/bridge.ts'
import { agentTypeName } from '../engine/prompt.ts'
import { AGENT_TYPE_PREFIX } from '../engine/tool-names.ts'
import { ZERO_TOKENS } from '../engine/cost.ts'

/** The runtime's memory for one session. Module variables reset on a hot reload; boot restores this from the stores. */
export type Ctx = {
  isReady: boolean
  sessionId: string
  settings: ModSettings
  agents: AgentView[]
  tasks: Map<string, TaskView>
  /** Thread rows of the tasks this session has touched, by task id. */
  threads: Map<string, ThreadRow[]>
  /** Claude Code agent id of a run → Legion task id. */
  byRun: Map<string, string>
  /** Requests queued for legion-mod-runner, by request id, until it answers. */
  pending: Map<string, RunRequest>
  /** Results already applied (request ids), so a result is applied once. */
  applied: Set<string>
  /** Stop reason of each run's last model request (turn-limit inference). */
  lastStop: Map<string, string | null>
  /** tool_use_id → run id, so tool.check (which carries no agent id) knows the run. */
  toolRun: Map<string, string>
  /** Runs blocked inside a Legion ask (the bridge's deadlock guard). */
  waiting: Set<string>
  rateLog: RateLog
  moods: Record<AgentId, MoodState>
  ui: UiState
  band: BandItem[]
  cards: ApprovalCard[]
  /** Streaming text of a running reply, by task id. */
  live: Map<string, string>
}

export const DEFAULT_UI: UiState = { view: 'chat', agentId: 'zealot', taskId: null, channel: null }

export function newCtx(settings: ModSettings): Ctx {
  return {
    isReady: false, sessionId: '', settings, agents: [], tasks: new Map(), threads: new Map(), byRun: new Map(), pending: new Map(),
    applied: new Set(), lastStop: new Map(), toolRun: new Map(), waiting: new Set(), rateLog: {}, moods: {}, ui: { ...DEFAULT_UI },
    band: [], cards: [], live: new Map(),
  }
}

/** A task's title: the first non-empty line of the message, at most 80 characters, cut on a word where it can be. */
export function titleFrom(text: string): string {
  const first = text.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? ''
  if (first.length <= 80) return first || 'Untitled task'
  const cut = first.slice(0, 79)
  const space = cut.lastIndexOf(' ')
  return `${space > 50 ? cut.slice(0, space) : cut}…`
}

export function makeTask(o: { id: string; agentId: AgentId; text: string; sessionId: string; origin: TaskOrigin; now: number; projectId?: string }): TaskView {
  return {
    id: o.id, agentId: o.agentId, title: titleFrom(o.text), status: 'queued', sessionId: o.sessionId, isEscalated: false, isTainted: false,
    turns: 0, runTurns: 0, tokens: { ...ZERO_TOKENS }, costUsd: 0, origin: o.origin, createdAt: o.now, updatedAt: o.now,
    ...(o.projectId ? { projectId: o.projectId } : {}),
  }
}

/** The one-line description Claude Code shows in its own agent list. */
export const runDescription = (agent: AgentView, task: TaskView): string => `${agent.name} · ${task.title}`.slice(0, 120)

export function spawnRequest(o: { id: string; task: TaskView; agent: AgentView; prompt: string; model?: string; now: number }): RunRequest {
  return {
    id: o.id, kind: 'spawn', taskId: o.task.id, agentType: `${AGENT_TYPE_PREFIX}${agentTypeName(o.agent.id)}`, name: `${o.agent.id}-${o.task.id}`, prompt: o.prompt,
    description: runDescription(o.agent, o.task), at: o.now, ...(o.model ? { model: o.model } : {}),
  }
}

export const resumeRequest = (o: { id: string; task: TaskView; text: string; now: number }): RunRequest =>
  ({ id: o.id, kind: 'resume', taskId: o.task.id, runId: o.task.runId, prompt: o.text, at: o.now })

export const stopRequest = (o: { id: string; task: TaskView; now: number }): RunRequest =>
  ({ id: o.id, kind: 'stop', taskId: o.task.id, runId: o.task.runId, at: o.now })

/** The run id a background-task notification names (`<task-id>…</task-id>`), or null. */
export function notificationRunId(text: string): string | null {
  const m = /<task-id>\s*([A-Za-z0-9_-]{4,80})\s*<\/task-id>/.exec(text)
  return m?.[1] ?? null
}

/** The text of an assistant row's content blocks (text blocks only), joined; '' when there is none. */
export function assistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** An agent by id, name or glyph, among the agents a person may address (hidden ones are not). Case-insensitive. */
export function resolveAgent(ref: string, agents: readonly AgentView[]): AgentView | undefined {
  const r = ref.trim().replace(/^@/, '').toLowerCase()
  if (!r) return undefined
  const shown = agents.filter(a => !a.isHidden)
  return shown.find(a => a.id.toLowerCase() === r) ?? shown.find(a => a.name.toLowerCase() === r) ?? shown.find(a => a.glyph === ref.trim())
}

/** `/to <agent> <text>`: the agent and the message, or what is missing, in plain words. */
export function parseTo(args: string, agents: readonly AgentView[]): { agent: AgentView; text: string } | { error: string } {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const ref = space === -1 ? trimmed : trimmed.slice(0, space)
  const text = space === -1 ? '' : trimmed.slice(space).trim()
  if (!ref) return { error: 'Usage: /to <agent> <message>, for example /to builder fix the failing test.' }
  const agent = resolveAgent(ref, agents)
  if (!agent) return { error: `No agent called "${ref}". The order: ${agents.filter(a => !a.isHidden).map(a => a.id).join(', ')}.` }
  if (!text) return { error: `What should ${agent.name} do? Usage: /to ${agent.id} <message>.` }
  return { agent, text }
}

/** Tasks newest first, as the state publishes them. */
export const taskList = (ctx: Ctx): TaskView[] => [...ctx.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)

/** The newest task of an agent that this session may act on (its own), or none. */
export function latestTaskOf(ctx: Ctx, agentId: AgentId): TaskView | undefined {
  return taskList(ctx).find(t => t.agentId === agentId && t.sessionId === ctx.sessionId)
}

/** Why a Legion agent's Agent call to a non-Legion type is refused, and how to do it right. */
export function orderOnlyMessage(subagentType: unknown, agents: readonly AgentView[]): string {
  const who = agents.filter(a => !a.isHidden).map(a => a.id).join(', ')
  return `Delegate inside the Order: use subagent_type legion-mod:<agent id>, not ${String(subagentType ?? 'none')}. The Order: ${who}. mcp__legion-mod__agents says who is busy.`
}

/** Band rows are capped: at most 20 kept, newest last; a newer row for the same task replaces the older one. */
export function pushBand(band: readonly BandItem[], item: BandItem): BandItem[] {
  const rest = band.filter(b => !(item.taskId && b.taskId === item.taskId && b.kind !== 'card') && b.id !== item.id)
  return [...rest, item].slice(-20)
}
