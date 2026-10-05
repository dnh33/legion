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

import type { AgentView, BandItem, DoctorLine, ModSettings, Mood, RunRequest, RunResult, TaskOrigin, TaskView, ThreadRow, ViewId } from '../../types/index.d.ts'
import { answerTaintsCaller, checkAsk, parseLegionAgentType, tellReply, truncateResult } from '../engine/bridge.ts'
import { CONTINUE_PROMPT, inferTurnLimit } from '../engine/continue.ts'
import { PRICES_AS_OF, tokensFromUsage } from '../engine/cost.ts'
import { nextMood } from '../engine/mood.ts'
import { buildAgentSpec } from '../engine/prompt.ts'
import { seedAgents } from '../engine/roster.ts'
import { pickModel } from '../engine/router.ts'
import { moodFor, reduceTask, reduceThread, type RunEvent } from '../engine/runs.ts'
import { isLegionModTool } from '../engine/tool-names.ts'
import { needsApproval, stricterMode, summarizeToolInput } from '../engine/approvals.ts'
import { taintsRun } from '../engine/taint.ts'
import { agentsList } from '../engine/bridge.ts'
import { dataRoot, fsPort } from '../store/fs-port.ts'
import { newId } from '../store/ids.ts'
import { createAgentStore, createSettingsStore, createTaskStore, createThreadStore, DEFAULT_SETTINGS, type AgentStore, type SettingsStore, type TaskStore, type ThreadStore } from '../store/stores.ts'
import { palette, themeFromClaude } from '../theme.ts'
import { decodeArt, type Art } from '../art/art.ts'
import { createStage, invalidateStage, musterCells, stepStage, type StageRuntime } from '../art/driver.ts'
import { bandItemAt, decodeAction, type DecodedAction } from '../ui/actions.ts'
import { FLUSH_MS, newTrace, record, traceFile, traceText, type TraceLine } from './trace.ts'
import { assistantText, latestTaskOf, orderOnlyMessage, toolInput, toolLine, makeTask, newCtx, notificationRunId, parseTo, pushBand, resolveAgent, resumeRequest, spawnRequest, stopRequest, taskList, type Ctx } from './core.ts'

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
const SESSION = { plugin: 'legion-mod', key: 'sessionId' } as const
const DOCTOR = { plugin: 'legion-mod', key: 'doctor' } as const
const STAGE = { plugin: 'legion-mod', key: 'stage' } as const
const MUSTER = { plugin: 'legion-mod', key: 'muster' } as const
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
let dataRootPath = ''
let trace = newTrace(false)
let traceFlushPending = false
let liveAt = 0

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300)

// ---- Development trace (src/wire/trace.ts): off by default; one boolean check when off ----

async function tr($: EngineInterface, line: Omit<TraceLine, 't'>): Promise<void> {
  if (!trace.isOn) return
  record(trace, { t: await $.clock.now(), ...line } as TraceLine)
  if (traceFlushPending) return
  traceFlushPending = true
  $.clock.after(FLUSH_MS, () => void flushTrace($))
}

async function flushTrace($: EngineInterface): Promise<void> {
  traceFlushPending = false
  if (!trace.isDirty || !dataRootPath || !ctx.sessionId) return
  trace.isDirty = false
  try {
    await $.fs.write(`${dataRootPath}/${traceFile(ctx.sessionId)}`, traceText(trace))
  } catch (err) {
    $.ui.log(`legion-mod: trace not written: ${message(err)}`, { to: 'debug' })
  }
}

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
  const at = (await $.clock.now())
  // After a hot reload the thread is not in memory yet: load it first, so new rows follow the stored ones.
  if (!ctx.threads.has(taskId) && stores && ev.type !== 'queued') ctx.threads.set(taskId, await stores.threads.load(taskId))
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
  if (agentId) lastEventAt.set(agentId, at)
  if (wanted && agentId) await setMood($, agentId, wanted)
  return after
}

/** The latest mood each agent's events asked for, and whether a deferred check is already waiting (one per agent). */
const wantedMood = new Map<string, Mood>()
const moodCheckPending = new Set<string>()

/** Shows `wanted` now, or once the current mood has had its minimum time; the latest wanted mood always wins (mood.ts). */
async function setMood($: EngineInterface, agentId: string, wanted: Mood): Promise<void> {
  wantedMood.set(agentId, wanted)
  await settleMood($, agentId)
}

async function settleMood($: EngineInterface, agentId: string): Promise<void> {
  const wanted = wantedMood.get(agentId)
  if (!wanted) return
  const at = await $.clock.now()
  const step = nextMood(ctx.moods[agentId], wanted, at)
  if (step.state !== ctx.moods[agentId]) {
    ctx.moods = { ...ctx.moods, [agentId]: step.state }
    await $.state.set(MOODS, ctx.moods)
    await tr($, { k: 'mood', agent: agentId, mood: step.state.mood })
    if (ctx.settings.twoD) { await driveStage($); await publishMuster($) }
  }
  if (step.recheckAt !== undefined && !moodCheckPending.has(agentId)) {
    moodCheckPending.add(agentId)
    $.clock.after(Math.max(0, step.recheckAt - at), () => {
      moodCheckPending.delete(agentId)
      void settleMood($, agentId)
    })
  }
}

async function addBand($: EngineInterface, item: BandItem): Promise<void> {
  ctx.band = pushBand(ctx.band, item)
  await $.state.set(BAND, ctx.band)
}

// ---- Lifecycle requests (legion-mod-runner acts on them) -----------------------------------------------------------------

async function enqueue($: EngineInterface, req: RunRequest): Promise<void> {
  await tr($, { k: 'queue', task: req.taskId, run: req.runId, kind: req.kind, agentType: req.agentType, model: req.model, prompt: req.prompt })
  ctx.pending.set(req.id, req)
  await publishQueue($)
}

/** Starts a new task for `agent` with `text`. Returns the task. */
async function startTask($: EngineInterface, agent: AgentView, text: string, origin: TaskOrigin = { kind: 'person' }): Promise<TaskView> {
  // The router reads and strips a leading /opus, /sonnet or /model; the title and the thread show the message without it.
  const pick = pickModel({ agentModel: agent.model, prompt: text, fromBot: origin.kind !== 'person' })
  const task = makeTask({ id: newId('t'), agentId: agent.id, text: pick.prompt, sessionId: ctx.sessionId, origin, now: (await $.clock.now()) })
  ctx.tasks.set(task.id, task)
  await apply($, task.id, { type: 'queued', task, prompt: pick.prompt })
  await enqueue($, spawnRequest({ id: newId('rq'), task, agent, prompt: pick.prompt, model: pick.model, now: (await $.clock.now()) }))
  ctx.ui = { ...ctx.ui, agentId: agent.id, taskId: task.id }
  await $.state.set(UI, ctx.ui)
  return task
}

/** Sends `text` into an existing task: resumes its stopped run, or starts it again when it never ran. */
async function continueTask($: EngineInterface, task: TaskView, text: string = CONTINUE_PROMPT): Promise<string> {
  if (task.sessionId !== ctx.sessionId) return `${task.title} is running in another window. Continue it there.`
  if (task.status === 'running' || task.status === 'queued') return `${task.title} is still working. Wait for it to finish, or stop it first.`
  if (!task.runId) return `${task.title} has no run to continue yet.`
  await enqueue($, resumeRequest({ id: newId('rq'), task, text, now: (await $.clock.now()) }))
  return ''
}

async function stopTask($: EngineInterface, task: TaskView): Promise<string> {
  if (task.sessionId !== ctx.sessionId) return `${task.title} is running in another window. Stop it there.`
  if (task.status !== 'running' && task.status !== 'queued') return `${task.title} is not running.`
  if (!task.runId) {
    // Not started yet: take the spawn out of the queue. The runner may already be starting it; remember the request, so a
    // run that arrives anyway is stopped at once (onResult, adopt) instead of running on unseen.
    for (const [id, req] of ctx.pending) if (req.taskId === task.id && req.kind === 'spawn') { ctx.pending.delete(id); cancelledSpawns.set(id, req) }
    cancelledTasks.add(task.id)
    await publishQueue($)
  } else {
    await enqueue($, stopRequest({ id: newId('rq'), task, now: (await $.clock.now()) }))
  }
  await apply($, task.id, { type: 'stopped', taskId: task.id })
  return ''
}

/** Spawn requests withdrawn by a stop, and tasks stopped before their run started: a run that arrives for them is stopped. */
const cancelledSpawns = new Map<string, RunRequest>()
const cancelledTasks = new Set<string>()

/** Stops a run that started for a task the person had already stopped. */
async function stopLateRun($: EngineInterface, taskId: string, runId: string): Promise<void> {
  const task = ctx.tasks.get(taskId)
  if (!task) return
  ctx.byRun.set(runId, taskId)
  await tr($, { k: 'deny', task: taskId, run: runId, tool: 'spawn', reason: 'stopped before it started: stopping the run that arrived' })
  await enqueue($, stopRequest({ id: newId('rq'), task: { ...task, runId }, now: await $.clock.now() }))
}

/** One runner result: link a new run to its task, or say what failed. Applied once per request. */
async function onResult($: EngineInterface, r: RunResult): Promise<void> {
  if (ctx.applied.has(r.requestId)) return
  if (cancelledSpawns.has(r.requestId)) {
    ctx.applied.add(r.requestId)
    cancelledSpawns.delete(r.requestId)
    if (r.ok && r.runId) await stopLateRun($, r.taskId, r.runId)
    return
  }
  const req = ctx.pending.get(r.requestId)
  if (!req) return
  ctx.applied.add(r.requestId)
  ctx.pending.delete(r.requestId)
  await tr($, { k: 'result', task: req.taskId, run: r.runId, kind: req.kind, ok: r.ok, error: r.error, model: r.model })
  await publishQueue($)
  const task = ctx.tasks.get(req.taskId)
  if (!task) return
  if (!r.ok) {
    const at = await $.clock.now()
    if (req.kind === 'stop') {
      if (/already stopped/i.test(r.error ?? '')) return // it had stopped on its own: cancelled either way
      if (/waited more than ten minutes/i.test(r.error ?? '')) {
        // The runner never acted on the stop; whether the run is still going is unknown. Say exactly that.
        await addBand($, { id: newId('b'), kind: 'error', taskId: task.id, agentId: task.agentId, text: `The stop for ${task.title} was never carried out: legion-mod-runner did not answer for ten minutes. Check /legion doctor; the run may still be going.`, at })
        return
      }
      // The stop did not land: the run is still going. Say so, and show it as running again.
      const back = { ...task, status: 'running' as const, updatedAt: at }
      ctx.tasks.set(task.id, back)
      await stores?.tasks.put(back)
      await publishTasks($)
      await addBand($, { id: newId('b'), kind: 'error', taskId: task.id, agentId: task.agentId, text: `Could not stop ${task.title}: ${r.error ?? 'no reason given'}. It is still running.`, at })
      return
    }
    // A start or resume that failed: the task says why, and the thread shows it, whether or not a run ever existed.
    const failed = { ...task, status: 'error' as const, error: r.error ?? 'Legion could not reach the agent.', updatedAt: at }
    ctx.tasks.set(task.id, failed)
    await stores?.tasks.put(failed)
    await publishTasks($)
    if (!ctx.threads.has(task.id) && stores) ctx.threads.set(task.id, await stores.threads.load(task.id))
    const row: ThreadRow = { id: `${task.id}:fail:${r.requestId}`, role: 'system', text: `Error: ${failed.error}`, at }
    ctx.threads.set(task.id, [...(ctx.threads.get(task.id) ?? []), row])
    await stores?.threads.append(task.id, [row])
    await publishThread($, task.id)
    await addBand($, { id: newId('b'), kind: 'error', taskId: task.id, agentId: task.agentId, text: r.error ?? 'The agent could not start.', at })
    return
  }
  if (req.kind === 'spawn' && r.runId) {
    // The run may have been linked already, by name, when its first step beat this result (adopt): do not restart its count.
    if (ctx.byRun.get(r.runId) === task.id) return
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
  if (!ctx.isReady) return undefined // boot is still loading the tasks: the next event links it, against the full list
  const info = (await $.agent.list()).find(a => a.id === runId)
  const agentId = info ? parseLegionAgentType(info.type) : null
  const agent = agentId ? ctx.agents.find(a => a.id === agentId) : undefined
  if (!info || !agent) return undefined
  // A run Legion queued carries its task in its name (`<agent>-t_<12 hex>`, core.ts spawnRequest). Its first step can beat the
  // runner's result: link it to that task instead of adopting a twin.
  // Only a run the runner started, for a spawn Legion queued under exactly that name: a model can pick any name with
  // Agent({ name }), so a name alone must never claim a task (G3 re-review R1: it would drop the bridge's approval ceiling).
  const openSpawn = info.spawnedBy === 'legion-mod-runner' && info.name
    ? [...ctx.pending.values(), ...cancelledSpawns.values()].find(r => r.kind === 'spawn' && r.name === info.name)
    : undefined
  const queued = openSpawn ? ctx.tasks.get(openSpawn.taskId) : undefined
  if (queued && openSpawn) {
    if (cancelledSpawns.has(openSpawn.id) || cancelledTasks.has(queued.id) || queued.status === 'cancelled') { await stopLateRun($, queued.id, runId); return queued.id }
    ctx.byRun.set(runId, queued.id)
    await tr($, { k: 'adopt', task: queued.id, agent: agent.id, run: runId, origin: 'queued', via: 'name' })
    await apply($, queued.id, { type: 'started', taskId: queued.id, runId, model: '' })
    return queued.id
  }
  const parentTask = info.parentId ? ctx.byRun.get(info.parentId) : undefined
  const parent = parentTask ? ctx.tasks.get(parentTask) : undefined
  const origin: TaskOrigin = parent
    ? { kind: 'bridge', fromAgentId: parent.agentId, fromTaskId: parent.id, hop: (parent.origin.kind === 'person' || parent.origin.kind === 'claude-code' ? 0 : parent.origin.hop) + 1, depth: (parent.origin.kind === 'bridge' ? parent.origin.depth : 0) + 1 }
    : { kind: 'claude-code' }
  // The run's opening message is the request: it titles the task and opens its thread, as a /to message would.
  const read = await $.session.messages({ agentId: runId })
  const opening = Array.isArray(read) ? (read.find(m => m.role === 'user')?.text?.trim() ?? '') : ''
  const task = makeTask({ id: newId('t'), agentId: agent.id, text: opening || info.description || agent.name, sessionId: ctx.sessionId, origin, now: (await $.clock.now()) })
  ctx.tasks.set(task.id, task)
  ctx.byRun.set(runId, task.id)
  await tr($, { k: 'adopt', task: task.id, agent: agent.id, run: runId, origin: origin.kind, parentTask: parent?.id, title: task.title })
  await apply($, task.id, { type: 'queued', task, ...(opening ? { prompt: opening } : {}), ...(parent ? { fromAgentId: parent.agentId } : {}) })
  await apply($, task.id, { type: 'started', taskId: task.id, runId, model: '' })
  return task.id
}

// ---- The 2D Order (plan §5): off by default; off loads no frame and schedules nothing ------------------------------------

/** Art by agent id, loaded on first use while the 2D Order is on. */
const artCache = new Map<string, Art | null>()
/** When each agent last had an event: the Dormant clock counts from here (art/animator.ts). */
const lastEventAt = new Map<string, number>()
let stageRt: StageRuntime | undefined
let stageAgent = ''
let stageTimer: { cancel(): void } | undefined
/** The surface colour the frames blend over, as 0xRRGGBB. */
const panelColour = (theme: 'dark' | 'light'): number => Number.parseInt(palette(theme).surface.slice(1), 16)

async function loadArt($: EngineInterface, agentId: string): Promise<Art | null> {
  if (artCache.has(agentId)) return artCache.get(agentId) ?? null
  let art: Art | null = null
  try {
    art = decodeArt(JSON.parse(await $.fs.read(`${$.plugin.root}/art/${agentId}.json`)))
  } catch (err) {
    $.ui.log(`legion-mod: no 2D art for ${agentId}: ${message(err)}`, { to: 'debug' })
  }
  artCache.set(agentId, art)
  return art
}

function stopStage(): void {
  stageTimer?.cancel()
  stageTimer = undefined
  stageRt = undefined
  stageAgent = ''
}

/** Brings the stage in line with the settings and the view: starts, retargets, wakes or stops it. Cheap to call often. */
async function stageVisible($: EngineInterface): Promise<boolean> {
  if (!ctx.settings.twoD || ctx.ui.view !== 'order') return false
  try {
    return (await $.ui.panes()).some(p => p.id === 'legion' && p.isShown)
  } catch {
    return false // no surface to draw on (a headless session): the stage stays off
  }
}

async function driveStage($: EngineInterface): Promise<void> {
  if (!(await stageVisible($))) {
    if (stageRt || stageTimer) stopStage()
    return
  }
  const agentId = ctx.ui.agentId
  const theme = ((await $.state.get(THEME)).value ?? 'dark') as 'dark' | 'light'
  const opts = { panel: panelColour(theme), transparent: 'terminal' as const }
  if (!stageRt || stageAgent !== agentId) {
    stopStage()
    const art = await loadArt($, agentId)
    if (!art) { await $.state.set(STAGE, null); return }
    const at = await $.clock.now()
    // An agent with no events yet counts its quiet time from now; it must never read as "just active" on every frame.
    if (!lastEventAt.has(agentId)) lastEventAt.set(agentId, at)
    stageRt = createStage(art, at, ctx.moods[agentId]?.mood ?? 'idle', opts)
    stageAgent = agentId
    const first = stepStage(stageRt, at, { mood: ctx.moods[agentId]?.mood ?? 'idle', motion: ctx.settings.motion, lastEventAt: lastEventAt.get(agentId) ?? 0 })
    await $.state.set(STAGE, { agentId, cells: first.cells ?? '', cols: art.stage.cols, rows: art.stage.rows })
    scheduleStage($, first.nextAtMs, at)
    return
  }
  // Already showing: an event may have woken a Dormant stage, so step now if nothing is scheduled.
  if (!stageTimer) await frame($)
}

function scheduleStage($: EngineInterface, nextAtMs: number | null, at: number): void {
  stageTimer?.cancel()
  stageTimer = nextAtMs === null ? undefined : $.clock.after(Math.max(0, nextAtMs - at), () => { stageTimer = undefined; void frame($) })
}

/** One frame: blit it when it changed, then ask the animator when to come back (never, once Dormant). */
async function frame($: EngineInterface): Promise<void> {
  if (!stageRt) return
  if (!(await stageVisible($))) { stopStage(); return } // the pane closed or moved on: nothing runs for a stage nobody sees
  const at = await $.clock.now()
  const agentId = stageAgent
  const step = stepStage(stageRt, at, { mood: ctx.moods[agentId]?.mood ?? 'idle', motion: ctx.settings.motion, lastEventAt: lastEventAt.get(agentId) ?? 0 })
  if (step.cells) {
    const blitted = await $.ui.blit({ requestId: 'legion', key: 'stage', cells: step.cells })
    if (blitted.deny) invalidateStage(stageRt) // the Raster is not mounted (view changed): redraw in full next time
  }
  scheduleStage($, step.nextAtMs, at)
}

/** The muster row's still frames: computed once per mood change, never animated (as the desktop's rail busts). */
async function publishMuster($: EngineInterface): Promise<void> {
  if (!ctx.settings.twoD) { await $.state.set(MUSTER, {}); return }
  const theme = ((await $.state.get(THEME)).value ?? 'dark') as 'dark' | 'light'
  const out: Record<string, string> = {}
  for (const a of ctx.agents) {
    if (a.isHidden) continue
    const art = await loadArt($, a.id)
    if (art) out[a.id] = musterCells(art, ctx.moods[a.id]?.mood ?? 'idle', { panel: panelColour(theme), transparent: 'terminal' })
  }
  await $.state.set(MUSTER, out)
}

// ---- Boot and refresh ----------------------------------------------------------------------------------------------------

async function boot($: EngineInterface): Promise<void> {
  const sessionId = await $.session.id()
  const root = dataRoot({ LEGION_MOD_HOME: await $.env.get('LEGION_MOD_HOME'), USERPROFILE: await $.env.get('USERPROFILE'), HOME: await $.env.get('HOME') })
  dataRootPath = root
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
  trace = newTrace((await $.env.get('LEGION_MOD_TRACE')) === '1' || trace.isOn)
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
  await $.state.set(SESSION, sessionId)
  await $.state.set(AGENTS, ctx.agents)
  await $.state.set(UI, ctx.ui)
  await $.state.set(MOODS, ctx.moods)
  await $.state.set(BAND, ctx.band)
  await $.state.set(CARDS, ctx.cards)
  await publishTasks($)
  await publishQueue($)
  for (const a of ctx.agents) if (!a.isHidden) await $.agent.register(buildAgentSpec(a, settings))
  ctx.isReady = true
  await tr($, { k: 'boot', root, agents: ctx.agents.filter(a => !a.isHidden).length, tasks: ctx.tasks.size, pending: ctx.pending.size, twoD: settings.twoD })
  // The 2D Order only when it is on: off loads no art and schedules nothing.
  await $.state.set(STAGE, null)
  if (settings.twoD) await publishMuster($)
}

/** How long a request may wait while legion-mod-runner has never answered in this session, before Legion says so. */
const RUNNER_SILENT_MS = 30_000
export const RUNNER_MISSING = 'legion-mod-runner is not running, so agents cannot start. Install it: claude plugin install legion-mod-runner@legion'

async function failIfRunnerMissing($: EngineInterface): Promise<void> {
  if (ctx.pending.size === 0) return
  const runner = await $.state.get({ plugin: 'legion-mod-runner', key: 'results' } as any)
  if (runner.version > 0) return
  const at = await $.clock.now()
  for (const req of [...ctx.pending.values()]) {
    if (at - req.at < RUNNER_SILENT_MS) continue
    await onResult($, { requestId: req.id, kind: req.kind, taskId: req.taskId, ok: false, error: RUNNER_MISSING, at })
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (!stores || !ctx.isReady) return
  await failIfRunnerMissing($)
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

async function redrawTimes($: EngineInterface): Promise<void> {
  try {
    if (!(await $.ui.panes()).some(p => p.id === 'legion' && p.isShown)) return
    $.ui.invalidate('ui.render')
  } catch (err) {
    $.ui.log(`legion-mod: redraw skipped: ${message(err)}`, { to: 'debug' })
  }
}

async function openTask($: EngineInterface, taskId: string): Promise<void> {
  const task = ctx.tasks.get(taskId)
  if (!task) return
  if (!ctx.threads.has(taskId) && stores) {
    ctx.threads.set(taskId, await stores.threads.load(taskId))
    await publishThread($, taskId)
  }
  // Selecting a task also selects its agent: the Chat view shows the selected agent's task only.
  ctx.ui = { ...ctx.ui, view: 'chat', agentId: task.agentId, taskId }
  await $.state.set(UI, ctx.ui)
}

/** Recent pokes per agent: five within ten seconds make it annoyed (the desktop Relic's rule of thumb). */
const pokes = new Map<string, number[]>()

/** What a Legion Button asked for (src/ui/actions.ts grammar). A press never spawns: it queues, or changes the view. */
async function actOn($: EngineInterface, a: DecodedAction): Promise<void> {
  switch (a.kind) {
    case 'view':
      ctx.ui = { ...ctx.ui, view: a.view }
      await $.state.set(UI, ctx.ui)
      await driveStage($)
      return
    case 'agent': {
      const latest = latestTaskOf(ctx, a.agentId)
      ctx.ui = { ...ctx.ui, agentId: a.agentId, taskId: latest?.id ?? null }
      await $.state.set(UI, ctx.ui)
      if (latest && ctx.ui.view === 'chat') await openTask($, latest.id)
      await driveStage($)
      return
    }
    case 'task':
      return openTask($, a.taskId)
    case 'new': {
      const agent = ctx.agents.find(x => x.id === a.agentId)
      if (agent) await $.prompt.fill({ text: `/to ${agent.id} `, mode: 'replace' })
      return
    }
    case 'continue':
    case 'stop': {
      const task = ctx.tasks.get(a.taskId)
      if (!task) return
      const why = a.kind === 'continue' ? await continueTask($, task) : await stopTask($, task)
      if (why) $.ui.toast(why)
      return
    }
    case 'poke': {
      const at = (await $.clock.now())
      const recent = [...(pokes.get(a.agentId) ?? []).filter(t => at - t < 10_000), at]
      pokes.set(a.agentId, recent)
      await setMood($, a.agentId, recent.length >= 5 ? 'annoyed' : 'listening')
      return
    }
    case 'card-allow':
    case 'card-deny':
      // Approvals are answered in Claude Code's own permission dialog (plan §2.1); the pane shows the request, not a second answer.
      $.ui.toast("Answer this in Claude Code's permission dialog.")
      return
    case 'band-dismiss': {
      const id = 'itemId' in a ? a.itemId : bandItemAt(ctx.band, a.index)?.id
      if (!id) return
      ctx.band = ctx.band.filter(item => item.id !== id)
      await $.state.set(BAND, ctx.band)
      return
    }
  }
}

/** The oldest Claude Code that runs mods (plan-legion-mod-release.md D10). */
const MIN_CLAUDE_CODE = [2, 1, 287] as const

const versionAtLeast = (v: string, min: readonly number[]): boolean => {
  const parts = v.split(/[.+-]/).map(n => Number.parseInt(n, 10))
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0
    if (Number.isNaN(a)) return false
    if (a !== min[i]) return a > min[i]!
  }
  return true
}

/** `/legion doctor`: what Legion needs, checked now. Each problem says what to do next. */
async function doctor($: EngineInterface): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = []
  const version = (await $.session.version()).version
  lines.push(versionAtLeast(version, MIN_CLAUDE_CODE)
    ? { ok: true, label: 'Claude Code', detail: version }
    : { ok: false, label: 'Claude Code', detail: `${version}: mods need ${MIN_CLAUDE_CODE.join('.')} or newer. Run claude update.` })
  const runner = await $.state.get({ plugin: 'legion-mod-runner', key: 'results' } as any)
  lines.push(runner.version > 0
    ? { ok: true, label: 'Runner', detail: 'legion-mod-runner is answering' }
    : { ok: false, label: 'Runner', detail: 'legion-mod-runner is not running, so agents cannot start. Install it: claude plugin install legion-mod-runner@legion' })
  try {
    const probe = `${dataRootPath}/doctor-probe.txt`
    const stamp = String(await $.clock.now())
    await $.fs.write(probe, stamp)
    const back = await $.fs.read(probe)
    lines.push(back === stamp ? { ok: true, label: 'Data folder', detail: dataRootPath } : { ok: false, label: 'Data folder', detail: `${dataRootPath} did not read back what was written.` })
  } catch (err) {
    lines.push({ ok: false, label: 'Data folder', detail: `${dataRootPath || 'not set'}: ${message(err)}. Set LEGION_MOD_HOME to a folder you can write.` })
  }
  const skipped = (stores?.tasks.skipped ?? 0) + (stores?.threads.skipped ?? 0) + (stores?.settings.skipped ?? 0) + (stores?.agents.skipped ?? 0)
  lines.push(skipped === 0 ? { ok: true, label: 'Stored data', detail: 'every line read cleanly' } : { ok: false, label: 'Stored data', detail: `${skipped} unreadable line${skipped === 1 ? '' : 's'} skipped; nothing else was lost.` })
  lines.push({ ok: null, label: 'Agents', detail: `${ctx.agents.filter(a => !a.isHidden).length} in the order` })
  lines.push({ ok: null, label: 'Cost estimates', detail: `prices as of ${PRICES_AS_OF}` })
  return lines
}

async function runCommand($: EngineInterface, command: string, args: string): Promise<{ text: string }> {
  await tr($, { k: 'cmd', command, args })
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
  if (views[sub]) { ctx.ui = { ...ctx.ui, view: views[sub] }; await $.state.set(UI, ctx.ui); await driveStage($) }
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
  if (sub === 'trace') {
    if (rest !== 'on' && rest !== 'off') return { text: 'Usage: /legion trace on|off. The trace is for development: every decision, one line each, in the data folder.' }
    trace.isOn = rest === 'on'
    if (trace.isOn) await tr($, { k: 'boot', root: dataRootPath, agents: ctx.agents.filter(a => !a.isHidden).length, tasks: ctx.tasks.size, pending: ctx.pending.size, twoD: ctx.settings.twoD, via: 'command' })
    return { text: trace.isOn ? `Trace on: ${dataRootPath}/${traceFile(ctx.sessionId)}. Read it with node scripts/mod-trace.mjs.` : 'Trace off.' }
  }
  if (sub === 'doctor') {
    const lines = await doctor($)
    await $.state.set(DOCTOR, lines)
    const bad = lines.filter(l => l.ok === false).length
    return { text: lines.map(l => `${l.ok === true ? '✓' : l.ok === false ? '✕' : '·'} ${l.label}: ${l.detail}`).join('\n') + (bad ? '' : '\nAll clear.') }
  }
  if (sub === 'motion' || sub === '2d') {
    const on = rest === 'on'
    if (rest !== 'on' && rest !== 'off') return { text: `Usage: /legion ${sub} on|off` }
    const patch: Partial<ModSettings> = sub === 'motion' ? { motion: on } : { twoD: on }
    if (stores) ctx.settings = await stores.settings.patch(patch)
    await $.state.set(SETTINGS, ctx.settings)
    await publishMuster($)
    await driveStage($)
    return { text: sub === 'motion' ? `Motion ${on ? 'on' : 'off'}.` : `2D Order ${on ? 'on' : 'off'}.` }
  }
  await $.ui.open({ id: 'legion', title: 'Legion' })
  await driveStage($)
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
    // Relative times ("5m") are drawn from the clock: redraw the open pane twice a minute so they stay true. Nothing runs when it is closed.
    $.clock.every(30_000, () => void redrawTimes($))
    return started
  })

  // One registration per command, with literal matchers, so validate lists each.
  on('command.run', { command: 'legion' }, ($, e) => commandHook($, 'legion', e.args))
  on('command.run', { command: 'to' }, ($, e) => commandHook($, 'to', e.args))
  on('command.run', { command: 'say' }, ($, e) => commandHook($, 'say', e.args))
  on('command.run', { command: 'continue' }, ($, e) => commandHook($, 'continue', e.args))
  on('command.run', { command: 'stop' }, ($, e) => commandHook($, 'stop', e.args))

  // The trace's last lines: flushed at session end (Claude Code bounds session.end to about 1.5 s; one write fits).
  on('session.end', async ($, e, next) => {
    if (trace.isOn && trace.isDirty) await flushTrace($)
    return next(e)
  })

  // Every Legion Button: decode its key and act. The Button's own onPress is a no-op; this hook answers the press.
  on('ui.press', { requestId: 'legion' }, async ($, e, next) => {
    const action = decodeAction(e.element)
    if (!action || e.plugin !== 'legion-mod') return next(e)
    try {
      await actOn($, action)
    } catch (err) {
      $.ui.toast(`Legion: ${message(err)}`)
    }
    return next(e)
  })

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
      // A Legion agent delegates inside the Order only: a built-in type (general-purpose, Explore) would run outside Legion,
      // untracked and unguarded. A live run on 2026-10-05 showed Zealot reaching for general-purpose.
      if (!target) {
        const reason = orderOnlyMessage(input.subagent_type, ctx.agents)
        await tr($, { k: 'deny', task: task.id, agent: task.agentId, run: runId, tool: e.tool, subagentType: input.subagent_type, reason })
        return { deny: reason }
      }
      const check = checkAsk({ callerRunId: runId, target, isBlocking: input.run_in_background === false, message: input.prompt ?? '', agents: ctx.agents, tasks: taskList(ctx), waiting: ctx.waiting, rateLog: ctx.rateLog, now: (await $.clock.now()) })
      ctx.rateLog = check.rateLog
      if (!check.ok) {
        await tr($, { k: 'deny', task: task.id, agent: task.agentId, run: runId, tool: e.tool, subagentType: input.subagent_type, reason: check.reason })
        return { deny: check.reason }
      }
      if (input.run_in_background === false) ctx.waiting.add(task.id)
    }
    if (taintsRun(e.tool) && !task.isTainted) {
      const tainted = { ...task, isTainted: true, updatedAt: (await $.clock.now()) }
      ctx.tasks.set(task.id, tainted)
      await stores?.tasks.put(tainted)
      await publishTasks($)
    }
    const summary = toolLine(e.tool, toolInput(e as unknown as Record<string, unknown>), ctx.agents, summarizeToolInput)
    const agentCall = e.tool === 'Agent' ? (e as unknown as { subagent_type?: string; run_in_background?: boolean }) : undefined
    await tr($, { k: 'tool', task: task.id, agent: task.agentId, run: runId, tool: e.tool, id: e.tool_use_id, summary, subagentType: agentCall?.subagent_type, background: agentCall?.run_in_background })
    await apply($, task.id, { type: 'tool', runId, toolUseId: e.tool_use_id, tool: e.tool, summary })
    const ran = await next(e)
    ctx.waiting.delete(task.id)
    const failed = ran.deny !== undefined || ran.isError === true
    await tr($, { k: 'toolDone', task: task.id, run: runId, tool: e.tool, id: e.tool_use_id, isError: failed, deny: ran.deny })
    await apply($, task.id, { type: 'toolDone', runId, toolUseId: e.tool_use_id, isError: failed })
    return ran
  })

  // Legion's own tools never ask; a run under a stricter ceiling asks where its agent's mode would not (approvals.ts extraAsk).
  // The person's own Claude Code rules decide first (next). A deny stands, always. Legion then only tightens: an allow or an ask
  // becomes an ask where Legion's mode needs a card the agent's permission mode would not raise; Legion's own tools are let
  // through where the person's rules would only ask (never where they deny).
  on('tool.check', async ($, e, next) => {
    const runId = e.tool_use_id ? ctx.toolRun.get(e.tool_use_id) : undefined
    const task = runId ? ctx.tasks.get(ctx.byRun.get(runId) ?? '') : undefined
    const verdict = await next(e)
    if (!task || verdict.decision === 'deny') return verdict
    // Legion's own tools pass the engine's default ask, never a rule the person wrote (a rule names itself in `rule`).
    if (isLegionModTool(e.tool)) return verdict.decision === 'ask' && !verdict.rule ? { decision: 'allow', reason: 'Legion\'s own tool' } : verdict
    const agent = ctx.agents.find(a => a.id === task.agentId)
    if (!agent) return verdict
    const ceiling = task.origin.kind === 'bridge' || task.origin.kind === 'room' ? 'ask' : agent.approval
    const effective = stricterMode(agent.approval, ceiling)
    if (verdict.decision === 'allow' && needsApproval(effective, e.tool)) {
      await tr($, { k: 'deny', task: task.id, agent: agent.id, run: runId, tool: e.tool, reason: 'asks: stricter ceiling', ceiling: effective })
      return { decision: 'ask', reason: `${agent.glyph} ${agent.name} asks · ${e.tool} · ${task.title}` }
    }
    return verdict
  })

  on('turn.step', async function* ($, e, next) {
    // The first model request is the first sign of a run Legion did not queue: adopt it here, so its turns all count.
    const taskId = e.agentId ? ctx.byRun.get(e.agentId) ?? (await adopt($, e.agentId)) : undefined
    if (!taskId || !e.agentId) return yield* next(e)
    const runId = e.agentId
    await apply($, taskId, { type: 'step', runId }, { persistRows: false })
    await tr($, { k: 'step', task: taskId, run: runId, n: ctx.tasks.get(taskId)?.runTurns, model: e.model })
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
        const at = (await $.clock.now())
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
    await tr($, { k: 'finish', task: taskId, agent: after?.agentId, run: runId, reason: e.reason, status: after?.status, turns: after?.turns, runTurns: task.runTurns, isTurnLimit, cost: after?.costUsd, answer: e.answer })
    if (!after) return done
    const agent = ctx.agents.find(a => a.id === after.agentId)
    const who = agent ? `${agent.glyph} ${agent.name}` : after.agentId
    const kind = after.status === 'paused' ? 'paused' : after.status === 'error' ? 'error' : 'done'
    const line = kind === 'paused' ? `${who} paused at the turn limit · /continue` : kind === 'error' ? `${who} stopped on an error` : `${who} finished · ${after.title}`
    await addBand($, { id: newId('b'), kind, taskId, agentId: after.agentId, text: line, at: (await $.clock.now()) })
    if (ctx.ui.taskId !== taskId) $.ui.toast(line)
    // A tell: the answer goes back to the caller, appended into its running loop, or resuming it when it already stopped.
    if (after.origin.kind === 'bridge') {
      const caller = ctx.tasks.get(after.origin.fromTaskId)
      if (caller && answerTaintsCaller(after) && !caller.isTainted) {
        const tainted = { ...caller, isTainted: true, updatedAt: (await $.clock.now()) }
        ctx.tasks.set(caller.id, tainted)
        await stores?.tasks.put(tainted)
      }
      if (caller?.runId && !ctx.waiting.has(caller.id)) {
        const reply = tellReply(agent?.name ?? after.agentId, after.id, truncateResult(e.answer || after.error || ''))
        if (caller.status === 'running') {
          await $.session.append({ agentId: caller.runId, message: { type: 'user', content: [{ type: 'text', text: reply }] } })
        } else if (caller.sessionId === ctx.sessionId) {
          await enqueue($, resumeRequest({ id: newId('rq'), task: caller, text: reply, now: (await $.clock.now()) }))
        }
      }
    }
    return done
  })

  // Legion's own finished runs do not wake the main conversation; the band and the pane carry them. Channel mode routes prompts.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const runId = notificationRunId(e.text)
      if (runId && ctx.byRun.has(runId)) {
        await tr($, { k: 'drop', run: runId, task: ctx.byRun.get(runId) })
        return { drop: 'Legion task finished; shown in the Legion pane.' }
      }
    }
    if (e.origin?.kind === 'composer' && ctx.ui.channel && ctx.isReady && !e.text.trimStart().startsWith('/')) {
      const agent = ctx.agents.find(a => a.id === ctx.ui.channel)
      if (agent) {
        const task = latestTaskOf(ctx, agent.id)
        const why = task && task.runId && task.status !== 'running' && task.status !== 'queued' ? await continueTask($, task, e.text) : (await startTask($, agent, e.text), '')
        if (why) $.ui.toast(why)
        await tr($, { k: 'channel', agent: agent.id, text: e.text, refused: why || undefined })
        return { drop: `Sent to ${agent.name} (Legion channel).` }
      }
    }
    return next(e)
  })
}
