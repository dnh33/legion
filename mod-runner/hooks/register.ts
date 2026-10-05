/**
 * legion-mod-runner: starts, resumes and stops Legion's agents on Legion Mod's behalf.
 *
 * Why a second plugin: Claude Code hides an agent's tool calls and model steps from the plugin whose hook caused the
 * spawn (spike 2026-10-05, claude/plan-legion-mod.md §1b). Legion Mod must see every tool call to show threads, ask
 * for approvals and track taint, so it never spawns itself. It queues requests in its own state (`runQueue`); this plugin
 * reads that queue from its OWN timer, so nothing Legion Mod did is the cause of the spawn, and acts on each request once.
 *
 * It only acts on requests from Legion Mod's state (only Legion Mod can write that), and only for `legion-mod:` agent
 * types. Without Legion Mod installed, the queue reads empty and the runner idles on a one-second timer.
 */
import type { EngineInterface, Register } from 'claude-code'

import type { RunRequest, RunResult } from '../types/index.d.ts'

const RESULTS = { plugin: 'legion-mod-runner', key: 'results' } as const
/** Polling period while requests are in flight, and while idle (milliseconds). A state read is an in-process call. */
export const FAST_MS = 200
export const IDLE_MS = 1000
/** Results kept in state; Legion Mod clears answered requests from its queue long before this many pile up. */
export const RESULTS_KEPT = 200
/** A request older than this is not acted on: it belongs to an earlier session state, not to the person's current intent. */
export const STALE_MS = 10 * 60 * 1000
const AGENT_TYPE = /^legion-mod:[A-Za-z0-9_-]{1,64}$/

/** Legion Mod's queue, read as plain data. Another plugin's key is outside this plugin's contract, hence the cast. */
async function readQueue($: EngineInterface): Promise<RunRequest[]> {
  const got = await $.state.get({ plugin: 'legion-mod', key: 'runQueue' } as any)
  return Array.isArray(got?.value) ? (got.value as unknown as RunRequest[]) : []
}

async function readResults($: EngineInterface): Promise<RunResult[]> {
  const got = await $.state.get(RESULTS)
  return Array.isArray(got?.value) ? got.value : []
}

async function record($: EngineInterface, result: RunResult): Promise<void> {
  const got = await $.state.get(RESULTS)
  const list: RunResult[] = Array.isArray(got?.value) ? got.value : []
  await $.state.set(RESULTS, [...list, result].slice(-RESULTS_KEPT))
}

/** Writes the results list once at start (empty when nothing ran yet), so Legion Mod's doctor can see the runner is here. */
async function announce($: EngineInterface): Promise<void> {
  const got = await $.state.get(RESULTS)
  if (got.version === 0) await $.state.set(RESULTS, [])
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300)

/** Carries out one request. Never throws: a failure comes back as `ok: false` with a plain sentence. */
async function perform($: EngineInterface, req: RunRequest, now: number): Promise<RunResult> {
  const base = { requestId: req.id, kind: req.kind, taskId: req.taskId, at: now }
  try {
    if (req.kind === 'spawn') {
      if (!req.agentType || !AGENT_TYPE.test(req.agentType)) return { ...base, ok: false, error: `Not a Legion agent type: ${String(req.agentType)}` }
      if (!req.prompt) return { ...base, ok: false, error: 'Nothing to send: the request has no prompt.' }
      const spawned = await $.agent.spawn({
        prompt: req.prompt,
        subagentType: req.agentType,
        ...(req.name ? { name: req.name } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.description ? { description: req.description } : {}),
      })
      if ('deny' in spawned) return { ...base, ok: false, error: `Claude Code refused to start the agent: ${String(spawned.deny)}` }
      if (!spawned.agentId) return { ...base, ok: false, error: 'Claude Code started no agent for this request.' }
      return { ...base, ok: true, runId: spawned.agentId, model: spawned.model }
    }
    if (!req.runId) return { ...base, ok: false, error: 'No run to act on: the request has no run id.' }
    if (req.kind === 'resume') {
      if (!req.prompt) return { ...base, ok: false, error: 'Nothing to send: the request has no prompt.' }
      const sent = await $.session.send({ to: { agentId: req.runId }, text: req.prompt })
      return sent.isDelivered ? { ...base, ok: true, runId: req.runId } : { ...base, ok: false, runId: req.runId, error: `The agent could not be reached: ${String(sent.reason ?? 'no reason given')}` }
    }
    const stopped = await $.tool.call({ tool: 'TaskStop', task_id: req.runId })
    if (stopped && 'deny' in stopped) return { ...base, ok: false, runId: req.runId, error: `Claude Code refused to stop it: ${String(stopped.deny)}` }
    return { ...base, ok: !(stopped as any)?.isError, runId: req.runId, ...((stopped as any)?.isError ? { error: 'The agent had already stopped.' } : {}) }
  } catch (err) {
    return { ...base, ok: false, error: message(err) }
  }
}

/** One pass: act on every request not answered yet, then schedule the next pass. */
async function tick($: EngineInterface): Promise<void> {
  let delay = IDLE_MS
  try {
    const queue = await readQueue($)
    if (queue.length > 0) {
      delay = FAST_MS
      const answered = new Set((await readResults($)).map(r => r.requestId))
      const now = await $.clock.now()
      for (const req of queue) {
        if (answered.has(req.id)) continue
        if (now - req.at > STALE_MS) {
          // Too old to act on, but answered, so Legion Mod stops waiting and drops it from its queue.
          await record($, { requestId: req.id, kind: req.kind, taskId: req.taskId, ok: false, error: 'This request waited more than ten minutes, so it was not carried out. Send it again.', at: now })
          continue
        }
        await record($, await perform($, req, now))
      }
    }
  } catch (err) {
    $.ui.log(`legion-mod-runner: ${message(err)}`, { to: 'debug' })
  }
  $.clock.after(delay, () => void tick($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await announce($)
    $.clock.after(IDLE_MS, () => void tick($))
    return started
  })
}
