/**
 * Picks the model for one spawn and decides the one escalation per task. Wraps the vendored desktop router
 * (vendor/legion/src/core/router.ts routeModel, shouldEscalate) and model cap (vendor/.../model-cap.ts), applied the way desktop
 * src/core/engine.ts `execute` applies them (engine.ts:513-548). Pure.
 */
import { routeModel, shouldEscalate } from '../../vendor/legion/src/core/router.ts'
import { modelRank, rankModel } from '../../vendor/legion/src/core/model-cap.ts'
import { familyOf } from './cost.ts'

export type ModelPick = {
  /** An alias (`sonnet`, `opus`, ...) or a model id, for `$.agent.spawn({ model })`. */
  model: string
  /** The prompt with a leading `/opus`, `/sonnet` or `/model <x>` stripped. */
  prompt: string
  /** Why, in the router's words (for the thread's system row and the doctor). */
  reason: string
}

/**
 * The model for this run.
 * - `agentModel`: the agent's own setting (`auto`, an alias, or an id).
 * - `prior`: the model the task's previous run used (a task that went to opus stays there, router.ts:35).
 * - `override`: a model another agent chose for this one task (ask/tell `model`), already checked by the bridge.
 * - `fromBot`: the run was started by another agent or a room, so a `/opus` prefix in its message is a bot's pick too.
 * A bot's pick (override or prefix) never goes above the agent's own setting (desktop engine.ts:514-527, model-cap.ts).
 * The desktop's provider branches (engine.ts:518-522) have no counterpart: the mod is Claude-only.
 */
export function pickModel(o: { agentModel: string; prompt: string; prior?: string; override?: string; fromBot?: boolean }): ModelPick {
  const choice = o.override ?? o.agentModel
  const prior = o.prior !== undefined && familyOf(o.prior) === 'opus' ? 'opus' : o.prior
  const d = routeModel(o.prompt, choice, prior !== undefined ? { priorModel: prior } : undefined)
  const picked = o.override !== undefined || (o.fromBot === true && d.reason.startsWith('prefix'))
  if (picked && modelRank(d.model) > modelRank(o.agentModel)) {
    const capped = rankModel(modelRank(o.agentModel))
    // Desktop wording, engine.ts:525. The agent's name is not known here; the caller may add it.
    return { model: capped, prompt: d.prompt, reason: `${d.reason}, capped at ${capped} (the agent's own setting)` }
  }
  return { model: d.model, prompt: d.prompt, reason: d.reason }
}

export type RunEnd = {
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  /** True when the run stopped at the turn limit (the task pauses; it never escalates). */
  isTurnLimit?: boolean
  errorText?: string
}

/**
 * Whether this run's failure earns the task its one escalation from Sonnet to Opus (desktop engine.ts:538-548).
 *
 * - `requestedModel`: the model this run was asked to use (pickModel's `model`). A resolved id of the Sonnet family counts as
 *   Sonnet only when the agent's own setting is `auto` or `sonnet` (the router picked it); an agent the person fixed to a Sonnet
 *   id is left on it, as on the desktop, where only the alias `sonnet` escalates (router.ts:47).
 * - A turn-limit stop never escalates: the task pauses and continues on the same model. This follows the desktop branch
 *   fix/long-task-turn-limit (router.ts NEVER_ESCALATE_SUBTYPES); the vendored router predates it and would escalate
 *   `error_max_turns`, so the mod refuses it here before asking the router.
 * - A refusal does not escalate (it is not Sonnet failing; Claude Code handles its own fallback model). Only `reason: 'error'`
 *   is passed to the router, as subtype `error_during_execution`.
 * - No escalation when another agent chose this task's model and the agent's own setting is below Opus (engine.ts:539).
 */
export function canEscalate(
  task: { isEscalated: boolean; agentModel: string; hasOverride?: boolean },
  requestedModel: string,
  end: RunEnd,
): boolean {
  if (task.isEscalated) return false
  if (end.isTurnLimit === true || end.reason !== 'error') return false
  if (task.hasOverride === true && modelRank(task.agentModel) < 3) return false
  const req = requestedModel.trim().toLowerCase()
  const own = task.agentModel.trim().toLowerCase()
  const isSonnet = req === 'sonnet' || (familyOf(req) === 'sonnet' && (own === 'auto' || own === 'sonnet'))
  if (!isSonnet) return false
  return shouldEscalate({ model: 'sonnet', subtype: 'error_during_execution', isError: true, ...(end.errorText !== undefined ? { errorText: end.errorText } : {}) })
}

/** The thread's line for an escalation. Desktop engine.ts:545, `Escalated to Opus: <subtype>: <error, 160 chars>`. */
export function escalationText(errorText: string | undefined): string {
  return errorText ? `Escalated to Opus: error_during_execution: ${errorText.slice(0, 160)}` : 'Escalated to Opus: error_during_execution'
}
