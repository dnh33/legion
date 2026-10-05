/**
 * The agent bridge's guards and wording: ask (wait for the answer), tell (the answer arrives later), `agents` (who is there).
 * Ported from desktop src/core/bridge.ts; pure. In the mod, ask and tell are Claude Code's own Agent tool with
 * `subagent_type: "legion-mod:<agent>"` (run_in_background false = ask, true = tell; plan §1). The lead's hook judges each such
 * call with checkAsk; the queueing, waiting and reply delivery live in the lead's wiring.
 */
import type { AgentId, AgentView, TaskView } from '../../types/index.d.ts'
import { agentTypeName } from './prompt.ts'
import { AGENT_TYPE_PREFIX } from './tool-names.ts'

/** Desktop src/core/bridge.ts:9-13, unchanged. */
export const MAX_DEPTH = 3
export const MAX_HOP = 6
export const RESULT_MAX_CHARS = 4000
export const RATE_LIMIT = 30
export const RATE_WINDOW_MS = 10 * 60 * 1000
/** Desktop bridge.ts:16: `timeout_seconds` default 600, clamped to 1-3600. */
export const TIMEOUT_DEFAULT_S = 600
export const TIMEOUT_MIN_S = 1
export const TIMEOUT_MAX_S = 3600

/** Desktop bridge.ts:16, clampTimeout. Seconds. */
export function clampTimeout(v: unknown, def = TIMEOUT_DEFAULT_S): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(TIMEOUT_MAX_S, Math.max(TIMEOUT_MIN_S, v)) : def
}

/** Desktop bridge.ts:65, truncate: the answer an `ask` returns, at most RESULT_MAX_CHARS plus a note of what was cut. */
export function truncateResult(s: string, n = RESULT_MAX_CHARS): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n[truncated: ${s.length - n} more chars]`
}

/** Delivery times per `from>to` pair, for the rate limit. Plain JSON, so it can live in `$.state`. */
export type RateLog = Readonly<Record<string, readonly number[]>>

export type AskCheck =
  | {
    ok: true
    /** The calling task (found by its current run id). */
    caller: TaskView
    target: AgentView
    /** The new task's depth: how many tasks stand above it in the delegation chain (1 for a task the person's task asked). */
    depth: number
    /** The new run's bridge hop: the caller's hop + 1. */
    hop: number
    /** The rate log with this delivery recorded. Store it; the check never mutates its input. */
    rateLog: RateLog
  }
  | { ok: false; reason: string; rateLog: RateLog }

/** A task the person or Claude Code's own model started is hop 0; bridge and room runs carry theirs. */
const hopOf = (t: TaskView): number => (t.origin.kind === 'bridge' || t.origin.kind === 'room' ? t.origin.hop : 0)
const parentOf = (t: TaskView): string | undefined => (t.origin.kind === 'bridge' ? t.origin.fromTaskId : undefined)

/**
 * The Legion agent an Agent tool call names: `legion-mod:<name>` gives `<name>`; any other agent type (`Explore`,
 * `general-purpose`, another plugin's) is not a Legion call and gives null. Trims, never lowercases: agent types are exact.
 */
export function parseLegionAgentType(subagentType: unknown): string | null {
  if (typeof subagentType !== 'string') return null
  const t = subagentType.trim()
  if (!t.startsWith(AGENT_TYPE_PREFIX)) return null
  const name = t.slice(AGENT_TYPE_PREFIX.length)
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : null
}

/**
 * Whether a Legion agent's Agent tool call to another Legion agent may go ahead: ask is `isBlocking` (run_in_background false),
 * tell is not. The desktop's guards and messages, in the desktop's order (bridge.ts:234-267): unknown caller task, empty message,
 * unknown agent, self, depth, deadlock (blocking calls only), hop, rate.
 *
 * - `callerRunId`: the subagent id the call came from (the `agentId` of the tool.call). It finds the caller task by its current
 *   `runId`. A call from the person's own main loop has no caller task and is not a bridge call: do not judge it here.
 * - `target`: the name parseLegionAgentType returned. Matched against the agent type names first, then (as on the desktop,
 *   bridge.ts:238-240) by id or name, case-insensitively, among visible agents only (hidden agents, such as the Assayer, cannot be
 *   reached).
 * - The chain is walked through `origin.fromTaskId`, the mod's counterpart of the desktop's `parentTaskId`.
 * - `waiting`: task ids currently blocked inside an ask (desktop `Bridge.waiting`).
 * - On a pass the delivery is recorded in the returned rate log; on a rate refusal the log comes back pruned (bridge.ts:258-266).
 */
export function checkAsk(o: {
  callerRunId: string | undefined
  target: string
  isBlocking: boolean
  message: string
  agents: readonly AgentView[]
  tasks: readonly TaskView[]
  waiting: ReadonlySet<string>
  rateLog: RateLog
  now: number
}): AskCheck {
  const fail = (reason: string, rateLog: RateLog = o.rateLog): AskCheck => ({ ok: false, reason, rateLog })
  const byId = new Map(o.tasks.map((t) => [t.id, t] as const))
  const caller = o.callerRunId === undefined ? undefined : o.tasks.find((t) => t.runId === o.callerRunId)
  if (!caller) return fail('Unknown caller task')
  if (!o.message?.trim()) return fail('message is empty')
  const ref = String(o.target ?? '').trim()
  const low = ref.toLowerCase()
  const agents = o.agents.filter((a) => !a.isHidden)
  const target = agents.find((a) => agentTypeName(a.id) === ref) ?? agents.find((a) => a.id.toLowerCase() === low) ?? agents.find((a) => a.name.toLowerCase() === low)
  if (!target) return fail(`Unknown agent "${o.target}". Available: ${agents.filter((a) => a.id !== caller.agentId).map((a) => a.id).join(', ') || 'none'}`)
  if (target.id === caller.agentId) return fail('You cannot message yourself')

  // Ancestors of the caller, nearest first (bridge.ts:244-251).
  const chain: TaskView[] = []
  const seen = new Set<string>([caller.id])
  for (let p = parentOf(caller); p && !seen.has(p) && chain.length < 16;) {
    const t = byId.get(p)
    if (!t) break
    seen.add(p); chain.push(t); p = parentOf(t)
  }
  if (chain.length + 1 > MAX_DEPTH) return fail(`delegation too deep (max ${MAX_DEPTH})`)
  if (o.isBlocking && chain.some((t) => t.agentId === target.id && o.waiting.has(t.id))) {
    return fail(`would deadlock: ${target.name} is waiting on this chain. Use tell instead.`)
  }
  const hop = hopOf(caller) + 1
  if (hop > MAX_HOP) return fail(`Bridge hop limit reached (${MAX_HOP}). Finish the work yourself or ask the user.`)
  const key = `${caller.agentId}>${target.id}`
  const recent = (o.rateLog[key] ?? []).filter((x) => o.now - x < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    return fail(`Rate limit: more than ${RATE_LIMIT} messages from ${caller.agentId} to ${target.id} in 10 minutes. Finish the work yourself or ask the user.`, { ...o.rateLog, [key]: recent })
  }
  return { ok: true, caller, target, depth: chain.length + 1, hop, rateLog: { ...o.rateLog, [key]: [...recent, o.now] } }
}

/** The header a bridged message starts with. Desktop bridge.ts:309-310, word for word. */
export function bridgeHeader(fromName: string): string {
  return `[From ${fromName} (Legion agent) via the bridge. Reply with just what they need; your final message is returned to them.]`
}

/** A `tell` reply as it lands in the caller's task. Desktop bridge.ts:366: `[Reply from X · task id] body`. */
export function tellReply(fromName: string, fromTaskId: string, body: string): string {
  return `[Reply from ${fromName} · task ${fromTaskId}] ${body}`
}

/** The body of a `tell` reply from the target task's outcome. Desktop bridge.ts:210 (status words as the mod names them). */
export function tellBody(t: Pick<TaskView, 'status' | 'error'> | undefined, result: string | undefined, failure?: string): string {
  if (failure !== undefined) return truncateResult(`(failed) ${failure}`)
  if (t?.status === 'done') return truncateResult(result ?? '')
  return truncateResult(`(${t?.status ?? 'gone'}) ${t?.error ?? ''}`.trim())
}

/** One line per other visible agent, for the `agents` tool. Desktop bridge.ts:102-112 (`id | name | description | status | thread`). */
export function agentsList(callerAgentId: AgentId, agents: readonly AgentView[], tasks: readonly TaskView[]): string {
  const lines: string[] = []
  for (const a of agents) {
    if (a.isHidden || a.id === callerAgentId) continue
    const own = tasks.filter((t) => t.agentId === a.id)
    const status = own.some((t) => t.status === 'running') ? 'working' : own.some((t) => t.status === 'queued') ? 'queued' : 'idle'
    const thread = own.some((t) => t.origin.kind === 'bridge' && t.origin.fromAgentId === callerAgentId) ? 'thread' : 'no-thread'
    lines.push(`${a.id} | ${a.name} | ${a.description.slice(0, 80)} | ${status} | ${thread}`)
  }
  return lines.length ? lines.join('\n') : 'No other agents.'
}

/** An `ask`'s answer comes back into the caller's context: a tainted answer taints the caller (desktop bridge.ts:190-191). */
export function answerTaintsCaller(target: Pick<TaskView, 'isTainted'> | undefined): boolean {
  return target?.isTainted === true
}
