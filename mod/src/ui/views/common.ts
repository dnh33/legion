/**
 * What every Legion view reads, and the small rules they share: which agents show, which is selected, how an agent
 * and a task are named, the marks and words for each state. Pure.
 */
import type { AgentId, AgentView, ApprovalCard, ApprovalMode, BandItem, DoctorLine, MoodState, ModSettings, TaskStatus, TaskView, ThreadRow, UiState } from '../../../types/index.d.ts'
import { MARK, MOOD_WORDS } from '../../theme.ts'
import type { SpanTone } from '../model.ts'
import { cardsInOrder as orderCards } from '../actions.ts'
import { currentTool, nowVerb, STATE_WORD } from '../words.ts'
import { cellWidth } from '../text.ts'

/** One read of the mod's state, as the render hooks gather it (register-ui.tsx). */
export type Snapshot = {
  agents: readonly AgentView[]
  tasks: readonly TaskView[]
  cards: readonly ApprovalCard[]
  ui: UiState
  moods: Readonly<Record<AgentId, MoodState>>
  band: readonly BandItem[]
  settings?: ModSettings
  /** The selected task's rows (the `threads` family member), or none. */
  thread: readonly ThreadRow[]
  /** The selected task's streaming reply (the `live` family member), or ''. */
  live: string
  /** The clock, for "5m ago". */
  now: number
  /** The last `/legion doctor` run, or none yet. */
  doctor?: readonly DoctorLine[]
  /** This window's session id. A task another session owns is shown read-only; unknown ('') counts every task as ours. */
  sessionId?: string
  /** Rows of the other tasks the pane draws (their current tool gives their verb), keyed by task id. */
  threads?: Readonly<Record<string, readonly ThreadRow[]>>
}

export const DEFAULT_UI: UiState = { view: 'chat', agentId: 'zealot', taskId: null, channel: null }

/** Agents a person may pick: hidden ones (the Assayer needs BSV, the Sculptor Blender; the mod leaves both out) are not offered. */
export const visibleAgents = (s: Pick<Snapshot, 'agents'>): AgentView[] => s.agents.filter(a => !a.isHidden)

/** The agent in view: the one `ui.agentId` names, else the first visible one, else none. */
export const selectedAgent = (s: Pick<Snapshot, 'agents' | 'ui'>): AgentView | undefined => {
  const shown = visibleAgents(s)
  return shown.find(a => a.id === s.ui.agentId) ?? shown[0]
}

/** The agent with this id, visible or not (a hidden agent's old task still names it). */
export const agentById = (s: Pick<Snapshot, 'agents'>, id: AgentId | undefined): AgentView | undefined => s.agents.find(a => a.id === id)

/** `⌘ Builder`, or the bare id with a neutral dot when the agent is gone. */
export const agentLabel = (s: Pick<Snapshot, 'agents'>, id: AgentId | undefined): string => {
  const a = agentById(s, id)
  return a ? `${a.glyph} ${a.name}` : `${MARK.running} ${id ?? 'agent'}`
}

export const glyphOf = (s: Pick<Snapshot, 'agents'>, id: AgentId | undefined): string => agentById(s, id)?.glyph ?? MARK.running

/** The approval mode in the desktop's words (ui/src/components/Thread.tsx, the approval chip). */
export const APPROVAL_WORDS: Record<ApprovalMode, string> = { ask: 'Asks first', 'auto-edits': 'Auto-edits', full: 'Full access' }

export const isActive = (t: Pick<TaskView, 'status'>): boolean => t.status === 'running' || t.status === 'queued'

/** True when another window owns the task's run: this window shows it, and cannot continue, stop or answer for it. */
export const isElsewhere = (s: Pick<Snapshot, 'sessionId'>, t: Pick<TaskView, 'sessionId'> | undefined): boolean =>
  !!t && !!s.sessionId && !!t.sessionId && t.sessionId !== s.sessionId

/** The task a card belongs to. */
export const taskOf = (s: Pick<Snapshot, 'tasks'>, taskId: string): TaskView | undefined => s.tasks.find(t => t.id === taskId)

/** The model as the header says it: `auto` is the router's choice, said so. */
export const modelWords = (model: string): string => (model === 'auto' ? 'auto model' : model)

/** The one-cell mark and its tone for a task's state (theme.ts MARK). */
export const STATUS_MARK: Record<TaskStatus, { mark: string; tone: SpanTone }> = {
  running: { mark: MARK.running, tone: 'accent' },
  // accent marks only what is live (R9); queued waits, so it is quiet
  queued: { mark: MARK.queued, tone: 'muted' },
  paused: { mark: MARK.paused, tone: 'warn' },
  error: { mark: MARK.error, tone: 'danger' },
  cancelled: { mark: MARK.cancelled, tone: 'muted' },
  done: { mark: MARK.done, tone: 'muted' },
}

/** A task's state in the glossary's words (words.ts STATE_WORD), with the paused state's reason, for one-line summaries. */
export const STATUS_WORDS: Record<TaskStatus, string> = { ...STATE_WORD, paused: 'paused at the turn limit' }

/** The title as shown: the router prefix (/opus, /sonnet) dropped, as the desktop's cleanTitle (ui/src/util.ts:63). */
export const cleanTitle = (t: string | undefined): string => (t ?? '').replace(/^\s*\/(opus|sonnet)\b\s*/i, '').trim() || 'Untitled'

/** An agent's mood word, exactly as MOOD_WORDS has it; no mood recorded reads as idle ("Standing vigil"). */
export const moodWord = (s: Pick<Snapshot, 'moods'>, id: AgentId): string => MOOD_WORDS[s.moods[id]?.mood ?? 'idle']

/** The tone a mood is drawn in: accent while working, warn while it needs you, danger on a fault, muted at rest. */
export const moodTone = (s: Pick<Snapshot, 'moods'>, id: AgentId): SpanTone => {
  const m = s.moods[id]?.mood ?? 'idle'
  if (m === 'awaiting') return 'warn'
  if (m === 'error') return 'danger'
  if (m === 'listening' || m === 'thinking' || m === 'hacking' || m === 'victory') return 'accent'
  return 'muted'
}

/** The tasks of one agent, newest created first (stable: tabs never jump when a task finishes; TaskSwitcher.tsx). */
export const tasksOf = (s: Pick<Snapshot, 'tasks'>, agentId: AgentId): TaskView[] =>
  s.tasks.filter(t => t.agentId === agentId).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))

/** The task in view: `ui.taskId` when it is the selected agent's, else none (a new-task screen). */
export const selectedTask = (s: Pick<Snapshot, 'tasks' | 'ui' | 'agents'>): TaskView | undefined => {
  const agent = selectedAgent(s)
  const t = s.ui.taskId ? s.tasks.find(x => x.id === s.ui.taskId) : undefined
  return t && agent && t.agentId === agent.id ? t : undefined
}

/** Cards in the order they arrived (actions.ts): the first is the one `a` and `d` answer; a card's index here is its `allow#n`. */
export const cardsInOrder = (s: Pick<Snapshot, 'cards'>): ApprovalCard[] => orderCards(s.cards)

/**
 * Who started a task, in words, or nothing for the person's own: "from ✠ Zealot" (bridge), "from a room",
 * "from Claude Code" (Claude Code's own model delegated to a Legion agent).
 */
export const originWords = (s: Pick<Snapshot, 'agents'>, t: Pick<TaskView, 'origin'>): string | undefined => {
  switch (t.origin.kind) {
    case 'person': return undefined
    case 'bridge': return `from ${agentLabel(s, t.origin.fromAgentId)}`
    case 'room': return 'from a room'
    case 'claude-code': return 'from Claude Code'
  }
}

/** A tool's short name, as the desktop's shortTool (ui/src/util.ts:18): `mcp__legion-mod__kg_search` -> `legion-mod·kg_search`. */
export const shortTool = (name: string | undefined): string => (name ?? 'tool').replace(/^mcp__/, '').replace(/__/g, '·')

/**
 * The view flags the pane draws from that the contract does not hold yet: the key-help view and a task whose folded
 * steps are open. Read defensively, so the layout is testable before the lead's `UiState.keysOpen` / `stepsOpen` land.
 */
export const uiFlags = (ui: UiState): { keysOpen: boolean; stepsOpen: string | null } => {
  const extra = ui as UiState & { keysOpen?: unknown; stepsOpen?: unknown }
  return { keysOpen: extra.keysOpen === true, stepsOpen: typeof extra.stepsOpen === 'string' ? extra.stepsOpen : null }
}

/** A task's rows, where the snapshot holds them: the selected task's thread, or a drawn task's from `threads`. */
export const threadOf = (s: Pick<Snapshot, 'thread' | 'threads' | 'ui'>, taskId: string): readonly ThreadRow[] | undefined =>
  s.threads?.[taskId] ?? (s.ui.taskId === taskId ? s.thread : undefined)

/**
 * What a task is doing now, in the glossary's words (R2, R11): a working task's verb from its current tool, else its
 * state word; another window's task says so. A mood word never stands in for it.
 */
export const nowOf = (s: Snapshot, t: TaskView, max = 28): string => {
  if (isElsewhere(s, t)) return 'in another window'
  if (t.status !== 'running') return STATE_WORD[t.status]
  const hasCard = s.cards.some(c => c.taskId === t.id)
  const tool = currentTool(threadOf(s, t.id))
  // between its own steps, a task whose agents still work is waiting on them: say who (glossary: "handed to")
  if (!tool && !hasCard) {
    const open = s.tasks.filter(c => c.origin.kind === 'bridge' && c.origin.fromTaskId === t.id && (c.status === 'running' || c.status === 'queued'))
    if (open.length > 0) {
      const first = s.agents.find(a => a.id === open[0]!.agentId)
      const full = `handed to ${first ? `${first.glyph} ${first.name}` : open[0]!.agentId}${open.length > 1 ? ` +${open.length - 1}` : ''}`
      return cellWidth(full) <= max ? full : `handed to ${open.length}`
    }
  }
  return nowVerb(tool, hasCard, name => agentByName(s, name)?.glyph ?? MARK.running, max)
}

/** The agent with this display name (the wire writes names, not ids, into "Ask Scout: …"). */
export const agentByName = (s: Pick<Snapshot, 'agents'>, name: string): AgentView | undefined =>
  s.agents.find(a => a.name.toLowerCase() === name.trim().toLowerCase() || a.id === name.trim().toLowerCase())
