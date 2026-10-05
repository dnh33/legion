/**
 * legion-mod-runner's contract. RunRequest and RunResult are declared identically in mod/types/index.d.ts; a spec in
 * mod/test/node keeps the two copies equal, because the plugins read each other's state and must agree on the shape.
 */

/** A lifecycle request Legion Mod queues for the runner (legion-mod's `runQueue`). */
export type RunRequest = {
  /** Request id (`rq_` + 12 hex). The runner answers each id once. */
  id: string
  kind: 'spawn' | 'resume' | 'stop'
  /** Legion's task id the request belongs to. */
  taskId: string
  /** spawn: the agent type, always `legion-mod:<agent id>`. */
  agentType?: string
  /** spawn: the name the run is addressable by. */
  name?: string
  /** spawn and resume: the text the agent receives. */
  prompt?: string
  /** spawn: an alias (`sonnet`, `opus`, `haiku`) or a model id. Absent: the agent type's own model. */
  model?: string
  /** spawn: the one-line description shown in Claude Code's agent list. */
  description?: string
  /** resume and stop: the Claude Code agent id of the run. */
  runId?: string
  at: number
}

/** What the runner did with one request (legion-mod-runner's `results`). */
export type RunResult = {
  requestId: string
  kind: RunRequest['kind']
  taskId: string
  ok: boolean
  /** spawn: the new run's agent id. resume and stop: the run acted on. */
  runId?: string
  model?: string
  /** A plain sentence when ok is false. */
  error?: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'legion-mod-runner': {
      /** The last results, newest last, at most RESULTS_KEPT. */
      results: RunResult[]
    }
  }
}
