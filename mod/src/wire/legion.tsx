/**
 * The runtime: every hook that needs `$`, in one file (the validator lets `$` reach only functions declared in the same
 * file). It reads events, asks the pure modules what they mean (src/wire/core.ts, src/engine/*), and writes the result to
 * the stores (durable), to `$.state` (what the UI draws) and to legion-mod-runner's queue (agent lifecycle).
 *
 * Two rules shape it (plan §1b):
 * - This plugin never spawns, resumes or stops an agent itself: Claude Code hides an agent's tool calls from the plugin
 *   whose hook caused it. Requests go into `runQueue`; legion-mod-runner acts on them from its own timer.
 * - Hooks observe every run (turn.step, tool.call, session.append, turn.complete) and act only on runs that belong to a
 *   Legion task (`ctx.byRun`), or adopt a run of a `legion-mod:` agent type that Claude Code's model or another agent started.
 */
import type { EngineInterface, Register } from 'claude-code'

import type { AgentView, BandItem, ModSettings, Mood, RunRequest, RunResult, TaskOrigin, TaskView, ThreadRow, ViewId } from '../../types/index.d.ts'
import { answerTaintsCaller, checkAsk, parseLegionAgentType, tellReply, truncateResult } from '../engine/bridge.ts'
import { CONTINUE_PROMPT, inferTurnLimit } from '../engine/continue.ts'
import { tokensFromUsage } from '../engine/cost.ts'
import { nextMood } from '../engine/mood.ts'
import { buildAgentSpec } from '../engine/prompt.ts'
import { seedAgents } from '../engine/roster.ts'
import { pickModel } from '../engine/router.ts'
import { moodFor, reduceTask, reduceThread, type RunEvent } from '../engine/runs.ts'
import { isLegionModTool } from '../engine/tool-names.ts'
import { extraAsk, needsApproval, stricterMode, summarizeToolInput } from '../engine/approvals.ts'
import { taintsRun } from '../engine/taint.ts'
import { agentsList } from '../engine/bridge.ts'
import { dataRoot, fsPort } from '../store/fs-port.ts'
import { newId } from '../store/ids.ts'
import { createAgentStore, createSettingsStore, createTaskStore, createThreadStore, DEFAULT_SETTINGS, type AgentStore, type SettingsStore, type TaskStore, type ThreadStore } from '../store/stores.ts'
import { themeFromClaude } from '../theme.ts'
import { assistantText, latestTaskOf, makeTask, newCtx, notificationRunId, parseTo, pushBand, resolveAgent, resumeRequest, spawnRequest, stopRequest, taskList, type Ctx } from './core.ts'

// ---- State the UI draws (one reference each; literals, as the validator requires) ----
const AGENTS = { plugin: 'legion-mod', key: 'agents' } as const
const TASKS = { plugin: 'legion-mod', key: 'tasks' } as const
const THREADS = { plugin: 'legion-mod', key: 'threads' } as const
const LIVE = { plugin: 'legion-mod', key: 'live' } as const
const CARDS = { plugin: 'legion-mod', key: 'cards' } as const
const UI = { plugin: 'legion-mod', key: 'ui' } as const
const MOODS = { plugin: 'legion-mod', key: 'moods' } as const
const BAND = { plugin: 'legion-mod', key: 'band' } as const
const SETTINGS = { plugin: 'legion-mod', key: 'settings' } as const
const THEME = { plugin: 'legion-mod', key: 'theme' } as const
const QUEUE = { plugin: 'legion-mod', key: 'runQueue' } as const
/** legion-mod-runner's state is outside this plugin's contract (validate lists it under "state of other plugins"), hence the casts. */
const RESULTS = { plugin: 'legion-mod-runner', key: 'results' } as const
/** The same value as a hook matcher. The validator refuses one const used both as a state reference and as a matcher. */
const RESULTS_MATCH = { plugin: 'legion-mod-runner', key: 'results' } as const

/** How often other windows' changes are picked up (tasks, settings, agents), and the heartbeat with them. */
const REFRESH_MS = 2000
/** A live reply is published at most this often (the shown pane redraws at up to 30/s; 8/s reads as live and costs little). */
const LIVE_MS = 125

type Stores = { tasks: TaskStore; threads: ThreadStore; settings: SettingsStore; agents: AgentStore }

let ctx: Ctx = newCtx({ ...DEFAULT_SETTINGS })
let stores: Stores | undefined
let liveAt = 0

const now = (): number => Date.now()
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300)

// ---- Publishing ------------------------------------------------------------------------------------------------------

async function publishTasks($: EngineInterface): Promise<void> {
  await $.state.set(TASKS, taskList(ctx))
}

async function publishThread($: EngineInterface, taskId: string): Promise<void> {
  await $.state.set({ ...THREADS, id: taskId }, ctx.threads.get(taskId) ?? [])
}

async function publishQueue($: EngineInterface): Promise<void> {
  await $.state.set(QUEUE, [...ctx.pending.values()])
}

async function say($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text)
}

// ---- Events through the pure reducers ----------------------------------------------------------------------------------

/** Applies one run event to its task and thread, persists what changed and publishes it. */
async function apply($: EngineInterface, taskId: string, ev: RunEvent, opts: { persistRows?: boolean } = { persistRows: true }): Promise<TaskView | undefined> {
  const at = now()
  const before = ctx.tasks.get(taskId)
  const after = reduceTask(before, ev, at, ctx.settings)
  if (after && after !== before) {
    ctx.tasks.set(taskId, after)
    if (!before || before.status !== after.status || ev.type === 'finished' || ev.type === 'started' || ev.type === 'queued') await stores?.tasks.put(after)
    await publishTasks($)
  }
  const rows = ctx.threads.get(taskId) ?? []
  const nextRows = reduceThread(rows, ev, at, ctx.settings)
  if (nextRows !== rows) {
    ctx.threads.set(taskId, nextRows)
    if (opts.persistRows) {
      const changed = nextRows.filter(r => !rows.includes(r))
      if (changed.length) await stores?.threads.append(taskId, changed)
    }
    await publishThread($, taskId)
  }
  const wanted = moodFor(ev)
  const agentId = (after ?? before)?.agentId
  if (wanted && agentId) await setMood($, agentId, wanted)
  return after
}

async function setMood($: EngineInterface, agentId: string, wanted: Mood): Promise<void> {
  const step = nextMood(ctx.moods[agentId], wanted, now())
  if (step.state !== ctx.moods[agentId]) {
    ctx.moods = { ...ctx.moods, [agentId]: step.state }
    await $.state.set(MOODS, ctx.moods)
  }
  if (step.recheckAt !== undefined) $.clock.after(Math.max(0, step.recheckAt - now()), () => void setMood($, agentId, wanted))
}

async function addBand($: EngineInterface, item: BandItem): Promise<void> {
  ctx.band = pushBand(ctx.band, item)
  await $.state.set(BAND, ctx.band)
}

// ---- Lifecycle requests (legion-mod-runner acts on them) -----------------------------------------------------------------

async function enqueue($: EngineInterface, req: RunRequest): Promise<void> {
  ctx.pending.set(req.id, req)
  await publishQueue($)
}

/** Starts a new task for `agent` with `text`. Returns the task. */
async function startTask($: EngineInterface, agent: AgentView, text: string, origin: TaskOrigin = { kind: 'person' }): Promise<TaskView> {
  const task = makeTask({ id: newId('t'), agentId: agent.id, text, sessionId: ctx.sessionId, origin, now: now() })
  ctx.tasks.set(task.id, task)
  await apply($, task.id, { type: 'queued', task, prompt: text })
  const pick = pickModel({ agentModel: agent.model, prompt: text, fromBot: origin.kind !== 'person' })
  await enqueue($, spawnRequest({ id: newId('rq'), task, agent, prompt: pick.prompt, model: pick.model, now: now() }))
  ctx.ui = { ...ctx.ui, agentId: agent.id, taskId: task.id }
  await $.state.set(UI, ctx.ui)
  return task
}

/** Sends `text` into an existing task: resumes its stopped run, or starts it again when it never ran. */
async function continueTask($: EngineInterface, task: TaskView, text: string = CONTINUE_PROMPT): Promise<string> {
  if (task.sessionId !== ctx.sessionId) return `${task.title} is running in another window. Continue it there.`
  if (task.status === 'running' || task.status === 'queued') return `${task.title} is still working. Wait for it to finish, or stop it first.`
  if (!task.runId) return `${task.title} has no run to continue yet.`
  await enqueue($, resumeRequest({ id: newId('rq'), task, text, now: now() }))
  return ''
}

async function stopTask($: EngineInterface, task: TaskView): Promise<string> {
  if (task.sessionId !== ctx.sessionId) return `${task.title} is running in another window. Stop it there.`
  if (task.status !== 'running' && task.status !== 'queued') return `${task.title} is not running.`
  if (!task.runId) {
    // Not started yet: drop the queued spawn so the runner never starts it.
    for (const [id, req] of ctx.pending) if (req.taskId === task.id) ctx.pending.delete(id)
    await publishQueue($)
  } else {
    await enqueue($, stopRequest({ id: newId('rq'), task, now: now() }))
  }
  await apply($, task.id, { type: 'stopped', taskId: task.id })
  return ''
}

/** One runner result: link a new run to its task, or say what failed. Applied once per request. */
async function onResult($: EngineInterface, r: RunResult): Promise<void> {
  if (ctx.applied.has(r.requestId)) return
  const req = ctx.pending.get(r.requestId)
  if (!req) return
  ctx.applied.add(r.requestId)
  ctx.pending.delete(r.requestId)
  await publishQueue($)
  const task = ctx.tasks.get(req.taskId)
  if (!task) return
  if (!r.ok) {
    if (req.kind === 'stop') return // it had already stopped: the task is cancelled either way
    await apply($, task.id, { type: 'finished', runId: task.runId ?? '', reason: 'error', answer: '', errorText: r.error ?? 'Legion could not reach the agent.' })
    await addBand($, { id: newId('b'), kind: 'error', taskId: task.id, agentId: task.agentId, text: r.error ?? 'The agent could not start.', at: now() })
    return
  }
  if (req.kind === 'spawn' && r.runId) {
    ctx.byRun.set(r.runId, task.id)
    await apply($, task.id, { type: 'started', taskId: task.id, runId: r.runId, model: r.model ?? req.model ?? '' })
  } else if (req.kind === 'resume' && r.runId) {
    ctx.byRun.set(r.runId, task.id)
    await apply($, task.id, { type: 'continued', taskId: task.id, runId: r.runId })
  }
}

// ---- Adoption: runs of Legion agents that this plugin did not queue ----------------------------------------------------

/** A run of a `legion-mod:` agent type that Claude Code's model or another agent started: make it a Legion task. */
async function adopt($: EngineInterface, runId: string): Promise<string | undefined> {
  const known = ctx.byRun.get(runId)
  if (known) return known
  const info = (await $.agent.list()).find(a => a.id === runId)
  const agentId = info ? parseLegionAgentType(info.type) : null
  const agent = agentId ? ctx.agents.find(a => a.id === agentId) : undefined
  if (!info || !agent) return undefined
  const parentTask = info.parentId ? ctx.byRun.get(info.parentId) : undefined
  const parent = parentTask ? ctx.tasks.get(parentTask) : undefined
  const origin: TaskOrigin = parent
    ? { kind: 'bridge', fromAgentId: parent.agentId, fromTaskId: parent.id, hop: (parent.origin.kind === 'person' || parent.origin.kind === 'claude-code' ? 0 : parent.origin.hop) + 1, depth: (parent.origin.kind === 'bridge' ? parent.origin.depth : 0) + 1 }
    : { kind: 'claude-code' }
  const task = makeTask({ id: newId('t'), agentId: agent.id, text: info.description || `${agent.name}`, sessionId: ctx.sessionId, origin, now: now() })
  ctx.tasks.set(task.id, task)
  ctx.byRun.set(runId, task.id)
  await apply($, task.id, { type: 'queued', task, ...(parent ? { fromAgentId: parent.agentId } : {}) })
  await apply($, task.id, { type: 'started', taskId: task.id, runId, model: '' })
  return task.id
}

// ---- Boot and refresh ----------------------------------------------------------------------------------------------------

async function boot($: EngineInterface): Promise<void> {
  const sessionId = await $.session.id()
  const root = dataRoot({ LEGION_MOD_HOME: await $.env.get('LEGION_MOD_HOME'), USERPROFILE: await $.env.get('USERPROFILE'), HOME: await $.env.get('HOME') })
  const port = fsPort({
    read: p => $.fs.read(p),
    write: (p, t) => $.fs.write(p, t),
    list: p => $.fs.list(p),
    stat: p => $.fs.stat(p),
    exists: p => $.fs.exists(p),
  }, root)
  stores = {
    tasks: createTaskStore(port, sessionId),
    threads: createThreadStore(port, sessionId),
    settings: createSettingsStore(port, sessionId),
    agents: createAgentStore(port, sessionId),
  }
  const settings = await stores.settings.load()
  const previousUi = (await $.state.get({ plugin: 'legion-mod', key: 'ui' } as const)).value
  ctx = newCtx(settings)
  ctx.sessionId = sessionId
  ctx.agents = await stores.agents.load(seedAgents())
  for (const t of await stores.tasks.load()) {
    ctx.tasks.set(t.id, t)
    if (t.runId) ctx.byRun.set(t.runId, t.id)
  }
  // A hot reload keeps $.state: the queue and answered results carry over, so nothing is spawned twice.
  for (const req of (await $.state.get(QUEUE)).value ?? []) ctx.pending.set(req.id, req)
  for (const r of ((await $.state.get(RESULTS as any)).value as unknown as RunResult[] | undefined) ?? []) await onResult($, r)
  if (previousUi) ctx.ui = previousUi
  const claudeTheme = (await $.settings.read()) as { theme?: unknown }
  await $.state.set(THEME, settings.theme === 'auto' ? themeFromClaude(claudeTheme.theme) : settings.theme)
  await $.state.set(SETTINGS, settings)
  await $.state.set(AGENTS, ctx.agents)
  await $.state.set(UI, ctx.ui)
  await $.state.set(MOODS, ctx.moods)
  await $.state.set(BAND, ctx.band)
  await $.state.set(CARDS, ctx.cards)
  await publishTasks($)
  await publishQueue($)
  for (const a of ctx.agents) if (!a.isHidden) await $.agent.register(buildAgentSpec(a, settings))
  ctx.isReady = true
}

async function refresh($: EngineInterface): Promise<void> {
  if (!stores || !ctx.isReady) return
  try {
    const changes = await stores.tasks.refresh()
    if (changes.changed.length || changes.removed.length) {
      for (const t of changes.changed) if (t.sessionId !== ctx.sessionId) ctx.tasks.set(t.id, t)
      for (const id of changes.removed) ctx.tasks.delete(id)
      await publishTasks($)
    }
    const s = await stores.settings.refresh()
    if (s) { ctx.settings = s; await $.state.set(SETTINGS, s) }
    const shown = ctx.ui.taskId ? ctx.tasks.get(ctx.ui.taskId) : undefined
    if (shown && shown.sessionId !== ctx.sessionId) {
      const rows = await stores.threads.refresh(shown.id)
      if (rows) { ctx.threads.set(shown.id, rows); await publishThread($, shown.id) }
    }
  } catch (err) {
    $.ui.log(`legion-mod: refresh failed: ${message(err)}`, { to: 'debug' })
  }
}

// ---- Commands ------------------------------------------------------------------------------------------------------------

async function runCommand($: EngineInterface, command: string, args: string): Promise<{ text: string }> {
  if (!ctx.isReady) return { text: 'Legion is still starting. Try again in a moment.' }
  if (command === 'to') {
    const parsed = parseTo(args, ctx.agents)
    if ('error' in parsed) return { text: parsed.error }
    const task = await startTask($, parsed.agent, parsed.text)
    return { text: `Sent to ${parsed.agent.name} as task ${task.id}.` }
  }
  const shownAgent = ctx.agents.find(a => a.id === ctx.ui.agentId) ?? ctx.agents[0]
  const shownTask = ctx.ui.taskId ? ctx.tasks.get(ctx.ui.taskId) : shownAgent ? latestTaskOf(ctx, shownAgent.id) : undefined
  if (command === 'say') {
    const text = args.trim()
    if (!text) return { text: 'Usage: /say <message>. It goes to the agent the Legion pane shows.' }
    if (!shownAgent) return { text: 'No agent to talk to.' }
    if (shownTask && shownTask.agentId === shownAgent.id && shownTask.runId && shownTask.status !== 'running' && shownTask.status !== 'queued') {
      const why = await continueTask($, shownTask, text)
      return { text: why || `Sent to ${shownAgent.name} in task ${shownTask.id}.` }
    }
    const task = await startTask($, shownAgent, text)
    return { text: `Sent to ${shownAgent.name} as task ${task.id}.` }
  }
  if (command === 'continue') {
    if (!shownTask) return { text: 'No task to continue. Open one in the Legion pane first.' }
    const why = await continueTask($, shownTask)
    return { text: why || `Continuing ${shownTask.id}.` }
  }
  if (command === 'stop') {
    if (!shownTask) return { text: 'No task to stop.' }
    const why = await stopTask($, shownTask)
    return { text: why || `Stopping ${shownTask.id}.` }
  }
  // /legion [view | talk <agent> | talk off | motion on|off | 2d on|off]
  const [sub = '', rest = ''] = [args.trim().split(/\s+/)[0] ?? '', args.trim().split(/\s+/).slice(1).join(' ')]
  const views: Record<string, ViewId> = { chat: 'chat', order: 'order' }
  if (views[sub]) { ctx.ui = { ...ctx.ui, view: views[sub] }; await $.state.set(UI, ctx.ui) }
  if (sub === 'talk') {
    if (rest === 'off' || rest === '') {
      ctx.ui = { ...ctx.ui, channel: null }
      await $.state.set(UI, ctx.ui)
      return { text: 'Channel closed. Prompts go to Claude Code again.' }
    }
    const agent = resolveAgent(rest, ctx.agents)
    if (!agent) return { text: `No agent called "${rest}".` }
    ctx.ui = { ...ctx.ui, channel: agent.id, agentId: agent.id }
    await $.state.set(UI, ctx.ui)
    return { text: `Speaking to ${agent.glyph} ${agent.name}. Every prompt goes to ${agent.name} until /legion talk off.` }
  }
  if (sub === 'motion' || sub === '2d') {
    const on = rest === 'on'
    if (rest !== 'on' && rest !== 'off') return { text: `Usage: /legion ${sub} on|off` }
    const patch: Partial<ModSettings> = sub === 'motion' ? { motion: on } : { twoD: on }
    if (stores) ctx.settings = await stores.settings.patch(patch)
    await $.state.set(SETTINGS, ctx.settings)
    return { text: sub === 'motion' ? `Motion ${on ? 'on' : 'off'}.` : `2D Order ${on ? 'on' : 'off'}.` }
  }
  await $.ui.open({ id: 'legion', title: 'Legion' })
  return { text: 'Legion opened.' }
}

async function commandHook($: EngineInterface, command: string, args: string | undefined): Promise<{ text: string }> {
  try {
    return await runCommand($, command, args ?? '')
  } catch (err) {
    return { text: `Legion: ${message(err)}` }
  }
}

// ---- Registration --------------------------------------------------------------------------------------------------------

export const COMMANDS = [
  { name: 'legion', description: 'Open Legion: your order of agents, their threads and the shared Library', argumentHint: '[chat|order|talk <agent>|talk off|motion on|off|2d on|off]' },
  { name: 'to', description: 'Send a message to one of Legion\'s agents as a new task', argumentHint: '<agent> <message>' },
  { name: 'say', description: 'Send a message to the agent the Legion pane shows', argumentHint: '<message>' },
  { name: 'continue', description: 'Continue the task the Legion pane shows, from where it stopped' },
  { name: 'stop', description: 'Stop the task the Legion pane shows' },
] as const

export function registerLegion(on: Parameters<Register>[0]): void {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await boot($)
    } catch (err) {
      $.ui.log(`legion-mod: Legion could not start: ${message(err)}`, { to: 'transcript' })
    }
    for (const c of COMMANDS) await $.command.register(c)
    await $.tool.register({
      name: 'agents',
      description: 'List the agents of Legion\'s order (id, name, what each is for) and which are busy. Ask one with the Agent tool: subagent_type legion-mod:<id>, run_in_background false to wait for its answer, true to hand work off.',
    })
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  // One registration per command, with literal matchers, so validate lists each.
  on('command.run', { command: 'legion' }, ($, e) => commandHook($, 'legion', e.args))
  on('command.run', { command: 'to' }, ($, e) => commandHook($, 'to', e.args))
  on('command.run', { command: 'say' }, ($, e) => commandHook($, 'say', e.args))
  on('command.run', { command: 'continue' }, ($, e) => commandHook($, 'continue', e.args))
  on('command.run', { command: 'stop' }, ($, e) => commandHook($, 'stop', e.args))

  // Runner results: applied once each. This hook is caused by the runner's write, so it never makes this plugin a spawn's cause.
  on('state.set', RESULTS_MATCH as any, async ($, e, next) => {
    const done = await next(e)
    for (const r of ((e as unknown as { value?: RunResult[] }).value) ?? []) await onResult($, r)
    return done
  })

  on('tool.call', { tool: 'mcp__legion-mod__agents' as any }, async () => {
    const text = agentsList('', ctx.agents, taskList(ctx))
    return { result: text }
  })

  on('tool.call', async ($, e, next) => {
    const runId = e.agentId
    const taskId = runId ? ctx.byRun.get(runId) ?? (await adopt($, runId)) : undefined
    const task = taskId ? ctx.tasks.get(taskId) : undefined
    if (!task || !runId) return next(e)
    ctx.toolRun.set(e.tool_use_id, runId)
    // A Legion ask or tell: the desktop bridge's guards decide (bridge.ts), with the desktop's messages.
    if (e.tool === 'Agent') {
      const input = e as unknown as { subagent_type?: string; prompt?: string; run_in_background?: boolean }
      const target = parseLegionAgentType(input.subagent_type)
      if (target) {
        const check = checkAsk({ callerRunId: runId, target, isBlocking: input.run_in_background === false, message: input.prompt ?? '', agents: ctx.agents, tasks: taskList(ctx), waiting: ctx.waiting, rateLog: ctx.rateLog, now: now() })
        ctx.rateLog = check.rateLog
        if (!check.ok) return { deny: check.reason }
        if (input.run_in_background === false) ctx.waiting.add(runId)
      }
    }
    if (taintsRun(e.tool) && !task.isTainted) {
      const tainted = { ...task, isTainted: true, updatedAt: now() }
      ctx.tasks.set(task.id, tainted)
      await stores?.tasks.put(tainted)
      await publishTasks($)
    }
    await apply($, task.id, { type: 'tool', runId, toolUseId: e.tool_use_id, tool: e.tool, summary: summarizeToolInput(e.tool, e as unknown as Record<string, unknown>) })
    const ran = await next(e)
    ctx.waiting.delete(runId)
    const failed = ran.deny !== undefined || ran.isError === true
    await apply($, task.id, { type: 'toolDone', runId, toolUseId: e.tool_use_id, isError: failed })
    return ran
  })

  // Legion's own tools never ask; a run under a stricter ceiling asks where its agent's mode would not (approvals.ts extraAsk).
  on('tool.check', async ($, e, next) => {
    const runId = e.tool_use_id ? ctx.toolRun.get(e.tool_use_id) : undefined
    const task = runId ? ctx.tasks.get(ctx.byRun.get(runId) ?? '') : undefined
    if (!task) return next(e)
    if (isLegionModTool(e.tool)) return { decision: 'allow', reason: 'Legion\'s own tool' }
    const agent = ctx.agents.find(a => a.id === task.agentId)
    if (!agent) return next(e)
    const ceiling = task.origin.kind === 'bridge' || task.origin.kind === 'room' ? 'ask' : agent.approval
    const effective = stricterMode(agent.approval, ceiling)
    if (needsApproval(effective, e.tool) && extraAsk(effective, agent.approval, e.tool, ctx.settings.fullMode)) {
      return { decision: 'ask', reason: `${agent.glyph} ${agent.name} asks · ${e.tool} · ${task.title}` }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const taskId = e.agentId ? ctx.byRun.get(e.agentId) : undefined
    if (!taskId || !e.agentId) return yield* next(e)
    const runId = e.agentId
    await apply($, taskId, { type: 'step', runId }, { persistRows: false })
    let text = ''
    const stream = next(e)
    while (true) {
      const item = await stream.next()
      if (item.done) {
        ctx.lastStop.set(runId, item.value?.stopReason ?? null)
        ctx.live.delete(taskId)
        await $.state.set({ ...LIVE, id: taskId }, '')
        return item.value
      }
      const chunk = item.value
      if (chunk.kind === 'text') {
        text += chunk.text
        const at = now()
        if (at - liveAt >= LIVE_MS) {
          liveAt = at
          ctx.live.set(taskId, text)
          await $.state.set({ ...LIVE, id: taskId }, text)
        }
      }
      yield chunk
    }
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const runId = e.agentId
    const taskId = runId ? ctx.byRun.get(runId) : undefined
    if (taskId && runId && e.door === 'response' && e.message.role === 'assistant') {
      const text = assistantText(e.message.content)
      if (text) await apply($, taskId, { type: 'reply', runId, text })
    }
    return stored
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const runId = e.agentId
    const taskId = runId ? ctx.byRun.get(runId) : undefined
    const task = taskId ? ctx.tasks.get(taskId) : undefined
    if (!task || !runId || !taskId) return done
    const isTurnLimit = inferTurnLimit({ reason: e.reason, runTurns: task.runTurns, maxTurns: ctx.settings.maxTurns, lastStopReason: ctx.lastStop.get(runId) })
    const usage = 'usage' in e && e.usage ? tokensFromUsage(e.usage) : undefined
    const model = 'usage' in e && e.usage && typeof e.usage.model === 'string' ? e.usage.model : undefined
    const after = await apply($, taskId, { type: 'finished', runId, reason: e.reason, answer: e.answer, isTurnLimit, ...(usage ? { usage } : {}), ...(model ? { model } : {}) })
    if (!after) return done
    const agent = ctx.agents.find(a => a.id === after.agentId)
    const who = agent ? `${agent.glyph} ${agent.name}` : after.agentId
    const kind = after.status === 'paused' ? 'paused' : after.status === 'error' ? 'error' : 'done'
    const line = kind === 'paused' ? `${who} paused at the turn limit · /continue` : kind === 'error' ? `${who} stopped on an error` : `${who} finished · ${after.title}`
    await addBand($, { id: newId('b'), kind, taskId, agentId: after.agentId, text: line, at: now() })
    if (ctx.ui.taskId !== taskId) $.ui.toast(line)
    // A tell: the answer goes back to the caller, appended into its running loop, or resuming it when it already stopped.
    if (after.origin.kind === 'bridge') {
      const caller = ctx.tasks.get(after.origin.fromTaskId)
      if (caller && answerTaintsCaller(after) && !caller.isTainted) {
        const tainted = { ...caller, isTainted: true, updatedAt: now() }
        ctx.tasks.set(caller.id, tainted)
        await stores?.tasks.put(tainted)
      }
      if (caller?.runId && !ctx.waiting.has(caller.runId)) {
        const reply = tellReply(agent?.name ?? after.agentId, after.id, truncateResult(e.answer || after.error || ''))
        if (caller.status === 'running') {
          await $.session.append({ agentId: caller.runId, message: { type: 'user', content: [{ type: 'text', text: reply }] } })
        } else if (caller.sessionId === ctx.sessionId) {
          await enqueue($, resumeRequest({ id: newId('rq'), task: caller, text: reply, now: now() }))
        }
      }
    }
    return done
  })

  // Legion's own finished runs do not wake the main conversation; the band and the pane carry them. Channel mode routes prompts.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const runId = notificationRunId(e.text)
      if (runId && ctx.byRun.has(runId)) return { drop: 'Legion task finished; shown in the Legion pane.' }
    }
    if (e.origin?.kind === 'composer' && ctx.ui.channel && ctx.isReady && !e.text.trimStart().startsWith('/')) {
      const agent = ctx.agents.find(a => a.id === ctx.ui.channel)
      if (agent) {
        const task = latestTaskOf(ctx, agent.id)
        const why = task && task.runId && task.status !== 'running' && task.status !== 'queued' ? await continueTask($, task, e.text) : (await startTask($, agent, e.text), '')
        if (why) $.ui.toast(why)
        return { drop: `Sent to ${agent.name} (Legion channel).` }
      }
    }
    return next(e)
  })
}
