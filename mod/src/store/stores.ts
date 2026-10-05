/**
 * The mod's typed stores, each a thin fold over segment logs (plan §3). Last writer wins by (t, s, q).
 *
 * Every store compacts its own session's records by itself once they grow (see `shouldCompact`), with folds that keep
 * the original record stamps (segment-log.ts explains why) and keep a delete only while another window still holds an
 * older put it must hide.
 */
import type { AgentView, ModSettings, TaskStatus, TaskView, ThreadRow } from '../../types/index.d.ts'
import type { StoragePort } from './port.ts'
import { compareRecords, createSegmentLog, type Fold, type LogRecord, type SegmentLog } from './segment-log.ts'

export type StoreOptions = {
  rollBytes?: number
  now?: () => number
  /** Own bytes at which a store first compacts its own records (default 512 KiB); later at twice the size it last left. */
  compactAt?: number
}

const DEFAULT_COMPACT_AT = 512 * 1024

/** The newest record per key, from records ordered by (t, s, q). */
function winners<Op>(recs: readonly LogRecord<Op>[], keyOf: (op: Op) => string | undefined): Map<string, LogRecord<Op>> {
  const out = new Map<string, LogRecord<Op>>()
  for (const r of recs) {
    const k = keyOf(r.op)
    if (k !== undefined) out.set(k, r)
  }
  return out
}

/**
 * Last-writer-wins compaction: keep an own record only when it is the newest for its key across every window; keep an own
 * delete only while another window still has a record for that key (an older put it must keep hiding).
 */
function lwwFold<Op>(keyOf: (op: Op) => string | undefined, isDel: (op: Op) => boolean, keepPut: (all: LogRecord<Op>[]) => (key: string) => boolean = () => () => true): Fold<Op> {
  return (mine, others) => {
    const all = [...mine, ...others].sort(compareRecords)
    const win = winners(all, keyOf)
    const otherKeys = new Set<string>()
    for (const r of others) {
      const k = keyOf(r.op)
      if (k !== undefined) otherKeys.add(k)
    }
    const isKeptPut = keepPut(all)
    return mine.filter(r => {
      const k = keyOf(r.op)
      if (k === undefined || win.get(k) !== r) return false
      return isDel(r.op) ? otherKeys.has(k) : isKeptPut(k)
    })
  }
}

/** Compacts when own bytes pass max(compactAt, 2 × what the last compaction left), so compaction cost stays amortized. */
function autoCompactor<Op>(log: SegmentLog<Op>, fold: () => Fold<Op>, compactAt: number): () => Promise<void> {
  let leftBytes = 0
  return async () => {
    if (log.ownBytes() <= Math.max(compactAt, 2 * leftBytes)) return
    await log.compactOwn(fold())
    leftBytes = log.ownBytes()
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

function checkId(kind: string, id: unknown): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`${kind}: bad id ${JSON.stringify(id)} (1-64 letters, digits, '_' or '-')`)
  return id
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------------------------------------------------------- tasks

export type TaskOp = { k: 'put'; task: TaskView } | { k: 'del'; id: string }

/** The fold keeps at most this many tasks; the oldest finished ones go first. */
export const MAX_TASKS = 500
const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'error', 'cancelled'])
const TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>(['queued', 'running', 'done', 'error', 'cancelled', 'paused'])

function isTaskView(v: unknown): v is TaskView {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    SAFE_ID.test(v.id) &&
    typeof v.agentId === 'string' &&
    typeof v.title === 'string' &&
    typeof v.status === 'string' &&
    TASK_STATUSES.has(v.status) &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number'
  )
}

const taskKey = (op: TaskOp): string | undefined => (op.k === 'put' ? (isTaskView(op.task) ? op.task.id : undefined) : typeof op.id === 'string' ? op.id : undefined)

/** Newest first by creation (a running task does not jump around the list), id as the tie-break. */
function byNewest(a: TaskView, b: TaskView): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Drops the oldest finished tasks (by last change) until at most `max` remain. Queued, running and paused ones stay. */
export function capTasks(tasks: TaskView[], max = MAX_TASKS): TaskView[] {
  if (tasks.length <= max) return tasks
  const finished = tasks.filter(t => FINISHED.has(t.status)).sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))
  const drop = new Set(finished.slice(0, tasks.length - max).map(t => t.id))
  return tasks.filter(t => !drop.has(t.id))
}

export function foldTasks(recs: readonly LogRecord<TaskOp>[]): TaskView[] {
  const out: TaskView[] = []
  for (const r of winners(recs, taskKey).values()) if (r.op.k === 'put') out.push(r.op.task)
  return capTasks(out).sort(byNewest)
}

export type TaskChanges = { tasks: TaskView[]; changed: TaskView[]; removed: string[] }

export type TaskStore = {
  load(): Promise<TaskView[]>
  /** The current list, newest first. */
  list(): TaskView[]
  put(task: TaskView): Promise<void>
  remove(id: string): Promise<void>
  /** Picks up other windows' changes: the full list, plus which tasks changed or went. */
  refresh(): Promise<TaskChanges>
  compact(): Promise<void>
  /** Marks this window alive in the store's folder (call it from the refresh tick; it writes at most once a minute). */
  heartbeat(): Promise<void>
  /** Unreadable lines, for `/legion doctor`. */
  readonly skipped: number
}

export function createTaskStore(port: StoragePort, sessionId: string, opts: StoreOptions = {}): TaskStore {
  const log = createSegmentLog<TaskOp>(port, 'tasks', sessionId, opts)
  const fold = (): Fold<TaskOp> =>
    lwwFold(taskKey, op => op.k === 'del', all => {
      const keep = new Set(foldTasks(all).map(t => t.id))
      return k => keep.has(k)
    })
  const maybeCompact = autoCompactor(log, fold, opts.compactAt ?? DEFAULT_COMPACT_AT)
  let tasks: TaskView[] = []
  const refold = (): void => {
    tasks = foldTasks(log.all())
  }

  return {
    async load() {
      await log.load()
      refold()
      return tasks
    },
    list: () => tasks,
    async put(task) {
      if (!isTaskView(task)) throw new Error(`tasks: not a task (needs a safe id, agentId, title, a known status, createdAt and updatedAt): ${JSON.stringify(task)?.slice(0, 200)}`)
      await log.append([{ k: 'put', task: structuredClone(task) }])
      refold()
      await maybeCompact()
    },
    async remove(id) {
      checkId('tasks', id)
      await log.append([{ k: 'del', id }])
      refold()
      await maybeCompact()
    },
    async refresh() {
      const fresh = await log.refresh()
      if (fresh.length === 0) return { tasks, changed: [], removed: [] }
      const before = new Map(tasks.map(t => [t.id, t]))
      refold()
      const changed = tasks.filter(t => !sameJson(before.get(t.id), t))
      const now = new Set(tasks.map(t => t.id))
      const removed = [...before.keys()].filter(id => !now.has(id))
      return { tasks, changed, removed }
    },
    async compact() {
      await log.compactOwn(fold())
      refold()
    },
    heartbeat: () => log.heartbeat(),
    get skipped() {
      return log.skipped
    },
  }
}

// -------------------------------------------------------------------------------------------------------------- threads

export type ThreadOp = { k: 'row'; row: ThreadRow }

/** A row's text is cut to this many characters, the marker included. */
export const MAX_ROW_TEXT = 8000
export const CUT_MARKER = '… (cut)'
export const DEFAULT_THREAD_LIMIT = 200

/** Cuts text to MAX_ROW_TEXT characters including a visible marker, never splitting a surrogate pair. */
export function capText(text: string, max = MAX_ROW_TEXT): string {
  if (text.length <= max) return text
  let end = max - CUT_MARKER.length
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1 // the cut would leave a lone high surrogate
  return text.slice(0, end) + CUT_MARKER
}

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool', 'system'])

function isThreadRow(v: unknown): v is ThreadRow {
  return isObj(v) && typeof v.id === 'string' && v.id !== '' && typeof v.role === 'string' && ROLES.has(v.role) && typeof v.text === 'string' && typeof v.at === 'number'
}

/**
 * Rows in thread order: a later record for the same row id (a tool row going running → ok) replaces the row in place.
 * Order is the row's own `at`, then first appearance, so a compaction (which keeps only the newest record per row) never
 * moves a row.
 */
export function foldThread(recs: readonly LogRecord<ThreadOp>[], limit = DEFAULT_THREAD_LIMIT): ThreadRow[] {
  const rows = new Map<string, { row: ThreadRow; first: number }>()
  recs.forEach((r, i) => {
    if (!isThreadRow(r.op?.row)) return
    const row = r.op.row.text.length > MAX_ROW_TEXT ? { ...r.op.row, text: capText(r.op.row.text) } : r.op.row
    const had = rows.get(row.id)
    rows.set(row.id, { row, first: had ? had.first : i })
  })
  const out = [...rows.values()].sort((a, b) => a.row.at - b.row.at || a.first - b.first).map(x => x.row)
  return out.slice(Math.max(0, out.length - limit))
}

export type ThreadStore = {
  append(taskId: string, rows: ThreadRow[]): Promise<void>
  /** The last `limit` rows of a task's thread (default 200). */
  load(taskId: string, limit?: number): Promise<ThreadRow[]>
  /** Other windows' new rows for a task: its last `limit` rows, or undefined when nothing changed. */
  refresh(taskId: string, limit?: number): Promise<ThreadRow[] | undefined>
  compact(taskId: string): Promise<void>
  /** Forgets a task's cached log (its files stay). */
  close(taskId: string): void
  /** Marks this window alive in every thread folder it has open. */
  heartbeat(): Promise<void>
  readonly skipped: number
}

export function createThreadStore(port: StoragePort, sessionId: string, opts: StoreOptions = {}): ThreadStore {
  type Open = { log: SegmentLog<ThreadOp>; isLoaded: boolean; maybeCompact: () => Promise<void> }
  const open = new Map<string, Open>()
  const fold = (): Fold<ThreadOp> => lwwFold(op => (isThreadRow(op?.row) ? op.row.id : undefined), () => false)

  function logOf(taskId: string): Open {
    checkId('threads', taskId)
    let o = open.get(taskId)
    if (!o) {
      const log = createSegmentLog<ThreadOp>(port, `threads/${taskId}`, sessionId, opts)
      o = { log, isLoaded: false, maybeCompact: autoCompactor(log, fold, opts.compactAt ?? DEFAULT_COMPACT_AT) }
      open.set(taskId, o)
    }
    return o
  }

  function checkLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`threads: limit must be a positive integer, got ${limit}`)
    return limit
  }

  return {
    async append(taskId, rows) {
      const o = logOf(taskId)
      const ops: ThreadOp[] = rows.map(row => {
        if (!isThreadRow(row)) throw new Error(`threads: not a thread row (needs id, a known role, text and at): ${JSON.stringify(row)?.slice(0, 200)}`)
        const copy = structuredClone(row)
        copy.text = capText(copy.text)
        return { k: 'row', row: copy }
      })
      await o.log.append(ops)
      await o.maybeCompact()
    },
    async load(taskId, limit = DEFAULT_THREAD_LIMIT) {
      checkLimit(limit)
      const o = logOf(taskId)
      if (o.isLoaded) await o.log.refresh()
      else {
        await o.log.load()
        o.isLoaded = true
      }
      return foldThread(o.log.all(), limit)
    },
    async refresh(taskId, limit = DEFAULT_THREAD_LIMIT) {
      checkLimit(limit)
      const o = logOf(taskId)
      if (!o.isLoaded) {
        await o.log.load()
        o.isLoaded = true
        return foldThread(o.log.all(), limit)
      }
      const fresh = await o.log.refresh()
      return fresh.length === 0 ? undefined : foldThread(o.log.all(), limit)
    },
    async compact(taskId) {
      await logOf(taskId).log.compactOwn(fold())
    },
    close(taskId) {
      open.delete(taskId)
    },
    async heartbeat() {
      for (const o of open.values()) await o.log.heartbeat()
    },
    get skipped() {
      let n = 0
      for (const o of open.values()) n += o.log.skipped
      return n
    },
  }
}

// ------------------------------------------------------------------------------------------------------------- settings

export type SettingsOp = { k: 'patch'; patch: Partial<ModSettings> }

/**
 * maxTurns 40 is the desktop's default (src/shared/config.ts:171 `maxTurns: 40`); its 1-1000 integer rule is
 * src/core/settings.ts:115.
 */
export const DEFAULT_SETTINGS: Readonly<ModSettings> = Object.freeze({ theme: 'auto', motion: true, twoD: false, maxTurns: 40, fullMode: 'acceptEdits' })

type FieldCheck = (v: unknown) => string | undefined
const SETTING_CHECKS: { [K in keyof ModSettings]: FieldCheck } = {
  theme: v => (v === 'auto' || v === 'dark' || v === 'light' ? undefined : 'theme must be "auto", "dark" or "light"'),
  motion: v => (typeof v === 'boolean' ? undefined : 'motion must be true or false'),
  twoD: v => (typeof v === 'boolean' ? undefined : 'twoD must be true or false'),
  maxTurns: v => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000 ? undefined : 'maxTurns must be an integer 1-1000'),
  fullMode: v => (v === 'acceptEdits' || v === 'auto' ? undefined : 'fullMode must be "acceptEdits" or "auto"'),
}
const SETTING_KEYS = Object.keys(SETTING_CHECKS) as Array<keyof ModSettings>

/** Checks a patch: known keys only, each value valid. Throws an Error naming every problem. */
export function validateSettingsPatch(patch: unknown): Partial<ModSettings> {
  if (!isObj(patch)) throw new Error('settings: a patch must be an object')
  const problems: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    const check = (SETTING_CHECKS as Record<string, FieldCheck | undefined>)[k]
    if (!check) problems.push(`unknown setting "${k}"`)
    else {
      const why = check(v)
      if (why) problems.push(why)
    }
  }
  if (problems.length > 0) throw new Error(`settings: ${problems.join('; ')}`)
  return { ...(patch as Partial<ModSettings>) }
}

/** Merges patches in order onto the defaults. A stored field that is unknown or invalid is skipped and counted. */
export function foldSettings(recs: readonly LogRecord<SettingsOp>[]): { settings: ModSettings; invalid: number } {
  const settings: ModSettings = { ...DEFAULT_SETTINGS }
  let invalid = 0
  for (const r of recs) {
    const patch: unknown = r.op?.patch
    if (!isObj(patch)) {
      invalid++
      continue
    }
    for (const [k, v] of Object.entries(patch)) {
      const check = (SETTING_CHECKS as Record<string, FieldCheck | undefined>)[k]
      if (!check || check(v) !== undefined) {
        invalid++
        continue
      }
      ;(settings as Record<string, unknown>)[k] = v
    }
  }
  return { settings, invalid }
}

/** Per field, keep the own record that set it last across every window, its patch cut to the fields it still wins. */
const settingsFold: Fold<SettingsOp> = (mine, others) => {
  const all = [...mine, ...others].sort(compareRecords)
  const winner = new Map<string, LogRecord<SettingsOp>>()
  for (const r of all) if (isObj(r.op?.patch)) for (const k of Object.keys(r.op.patch)) if (SETTING_KEYS.includes(k as keyof ModSettings)) winner.set(k, r)
  const kept: LogRecord<SettingsOp>[] = []
  for (const r of mine) {
    if (!isObj(r.op?.patch)) continue
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r.op.patch)) if (winner.get(k) === r) patch[k] = v
    if (Object.keys(patch).length > 0) kept.push({ ...r, op: { k: 'patch', patch: patch as Partial<ModSettings> } })
  }
  return kept
}

export type SettingsStore = {
  load(): Promise<ModSettings>
  current(): ModSettings
  /** Validates, stores and answers the new settings. Throws on an unknown key or a bad value, storing nothing. */
  patch(p: Partial<ModSettings>): Promise<ModSettings>
  /** Other windows' changes: the new settings, or undefined when nothing changed. */
  refresh(): Promise<ModSettings | undefined>
  compact(): Promise<void>
  heartbeat(): Promise<void>
  /** Stored fields that were skipped as invalid, for `/legion doctor`. */
  readonly invalid: number
  readonly skipped: number
}

export function createSettingsStore(port: StoragePort, sessionId: string, opts: StoreOptions = {}): SettingsStore {
  const log = createSegmentLog<SettingsOp>(port, 'settings', sessionId, opts)
  const maybeCompact = autoCompactor(log, () => settingsFold, opts.compactAt ?? DEFAULT_COMPACT_AT)
  let state = { settings: { ...DEFAULT_SETTINGS } as ModSettings, invalid: 0 }
  const refold = (): void => {
    state = foldSettings(log.all())
  }
  return {
    async load() {
      await log.load()
      refold()
      return state.settings
    },
    current: () => state.settings,
    async patch(p) {
      const patch = validateSettingsPatch(p)
      if (Object.keys(patch).length === 0) return state.settings
      await log.append([{ k: 'patch', patch }])
      refold()
      await maybeCompact()
      return state.settings
    },
    async refresh() {
      const fresh = await log.refresh()
      if (fresh.length === 0) return undefined
      const before = state.settings
      refold()
      return sameJson(before, state.settings) ? undefined : state.settings
    },
    async compact() {
      await log.compactOwn(settingsFold)
      refold()
    },
    heartbeat: () => log.heartbeat(),
    get invalid() {
      return state.invalid
    },
    get skipped() {
      return log.skipped
    },
  }
}

// --------------------------------------------------------------------------------------------------------------- agents

export type AgentOp = { k: 'put'; agent: AgentView } | { k: 'del'; id: string }

const APPROVALS: ReadonlySet<string> = new Set(['ask', 'auto-edits', 'full'])

function isAgentView(v: unknown): v is AgentView {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    SAFE_ID.test(v.id) &&
    typeof v.name === 'string' &&
    typeof v.glyph === 'string' &&
    typeof v.description === 'string' &&
    typeof v.systemPrompt === 'string' &&
    typeof v.model === 'string' &&
    typeof v.approval === 'string' &&
    APPROVALS.has(v.approval) &&
    typeof v.isRoster === 'boolean' &&
    typeof v.isHidden === 'boolean'
  )
}

const agentKey = (op: AgentOp): string | undefined => (op.k === 'put' ? (isAgentView(op.agent) ? op.agent.id : undefined) : typeof op.id === 'string' ? op.id : undefined)

/**
 * Seed order first: a stored edit replaces its roster entry (id, isRoster and isHidden stay the seed's; a stored delete of a
 * roster agent is ignored). Then the person's own agents, in the order they were first made.
 */
export function foldAgents(recs: readonly LogRecord<AgentOp>[], seed: readonly AgentView[]): AgentView[] {
  const win = winners(recs, agentKey)
  const seedIds = new Set(seed.map(a => a.id))
  const out = seed.map(a => {
    const r = win.get(a.id)
    return r && r.op.k === 'put' ? { ...r.op.agent, id: a.id, isRoster: true, isHidden: a.isHidden } : a
  })
  const firstSeen = new Map<string, number>()
  recs.forEach((r, i) => {
    const k = agentKey(r.op)
    if (k !== undefined && r.op.k === 'put' && !firstSeen.has(k)) firstSeen.set(k, i)
  })
  const own: AgentView[] = []
  for (const [id, r] of win) if (!seedIds.has(id) && r.op.k === 'put') own.push({ ...r.op.agent, isRoster: false })
  own.sort((a, b) => (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0))
  return [...out, ...own]
}

export type AgentStore = {
  /** The agents: `seed` (the roster) in order with the person's edits applied, then the person's own agents. */
  load(seed: readonly AgentView[]): Promise<AgentView[]>
  list(): AgentView[]
  /** Stores an edit to a roster agent, or a person's own agent. */
  put(agent: AgentView): Promise<void>
  /** Deletes a person's own agent. Roster agents (Zealot above all) can be edited, never deleted: this throws. */
  remove(id: string): Promise<void>
  refresh(): Promise<AgentView[] | undefined>
  compact(): Promise<void>
  heartbeat(): Promise<void>
  readonly skipped: number
}

export function createAgentStore(port: StoragePort, sessionId: string, opts: StoreOptions = {}): AgentStore {
  const log = createSegmentLog<AgentOp>(port, 'agents', sessionId, opts)
  const fold = (): Fold<AgentOp> => lwwFold(agentKey, op => op.k === 'del')
  const maybeCompact = autoCompactor(log, fold, opts.compactAt ?? DEFAULT_COMPACT_AT)
  let seed: readonly AgentView[] | undefined
  let agents: AgentView[] = []
  const refold = (): void => {
    agents = foldAgents(log.all(), seed ?? [])
  }
  const isRosterId = (id: string): boolean => id === 'zealot' || (seed ?? []).some(a => a.id === id)

  return {
    async load(s) {
      seed = s.map(a => structuredClone(a))
      await log.load()
      refold()
      return agents
    },
    list: () => agents,
    async put(agent) {
      if (!seed) throw new Error('agents: load the roster first')
      if (!isAgentView(agent)) throw new Error(`agents: not an agent (needs a safe id, name, glyph, description, systemPrompt, model, a known approval mode and the two flags): ${JSON.stringify(agent)?.slice(0, 200)}`)
      const roster = seed.find(a => a.id === agent.id)
      const stored: AgentView = roster ? { ...structuredClone(agent), isRoster: true, isHidden: roster.isHidden } : { ...structuredClone(agent), isRoster: false }
      await log.append([{ k: 'put', agent: stored }])
      refold()
      await maybeCompact()
    },
    async remove(id) {
      if (!seed) throw new Error('agents: load the roster first')
      checkId('agents', id)
      if (isRosterId(id)) throw new Error(`agents: ${id} is a roster agent; it can be edited, not deleted`)
      await log.append([{ k: 'del', id }])
      refold()
      await maybeCompact()
    },
    async refresh() {
      const fresh = await log.refresh()
      if (fresh.length === 0) return undefined
      const before = agents
      refold()
      return sameJson(before, agents) ? undefined : agents
    },
    async compact() {
      await log.compactOwn(fold())
      refold()
    },
    heartbeat: () => log.heartbeat(),
    get skipped() {
      return log.skipped
    },
  }
}
