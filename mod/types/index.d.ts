/**
 * The Legion mod's contract: every domain type the mod's modules share, and every value it keeps in `$.state`.
 *
 * One home for these shapes. Store, engine and UI modules import types from here (type-only imports, erased at run time), so
 * Node's test runner and the Claude Code engine read the same definitions. Values in `$.state` are plain JSON: no functions,
 * no class instances, no secrets (any plugin can read `$.state`).
 */

/** A Legion agent id: the roster ids (`zealot`, `builder`, ...) or a person's own agents. */
export type AgentId = string

/** Legion's approval modes, as on the desktop (src/shared/types.ts ApprovalMode). */
export type ApprovalMode = 'ask' | 'auto-edits' | 'full'

/** The Relic's moods, worded on the desktop in useRelicState.ts; the mod shows the same words. */
export type Mood = 'idle' | 'listening' | 'thinking' | 'hacking' | 'awaiting' | 'victory' | 'error' | 'sleeping' | 'annoyed'

/** An agent as the mod shows and runs it. Seeded from the desktop roster; a person's edits are kept and never overwritten. */
export type AgentView = {
  id: AgentId
  name: string
  /** One roster glyph (✠ ⌘ ◎ ...), or the agent's own emoji for a person's agent. */
  glyph: string
  description: string
  /** The agent's own prompt (role text), without Legion's preamble, which the engine adds per run. */
  systemPrompt: string
  /** `auto` (Legion's router picks per task), or an alias / model id. */
  model: string
  approval: ApprovalMode
  /** True for the 13 roster agents. */
  isRoster: boolean
  /** Hidden agents (the Assayer needs BSV, which the mod leaves out) are not offered. */
  isHidden: boolean
}

/** Where a task stands. `paused` is the turn limit: the work is kept and Continue picks it up. */
export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'paused'

/** Token counts as the engine reports them per turn (turn.complete usage). */
export type TokenCount = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One Legion task: a thread with one agent, made of one Claude Code subagent run and its resumes. */
export type TaskView = {
  /** Legion's task id (`t_` + 12 hex). Stable across resumes. */
  id: string
  agentId: AgentId
  title: string
  status: TaskStatus
  /** The Claude Code subagent id of the latest run, used to resume, stop and follow it. Absent while queued. */
  runId?: string
  /** The session (terminal window) that owns the run. Other windows show the task read-only. */
  sessionId: string
  /** The model the latest run used, as the engine resolved it. */
  model?: string
  /** True once the router escalated this task from sonnet to opus (once per task, as on the desktop). */
  isEscalated: boolean
  /** True once the run touched a tool that taints (web, shell, other MCP): its Library writes go to the Inbox. */
  isTainted: boolean
  turns: number
  tokens: TokenCount
  /** An estimate from a price table: the engine reports tokens, not dollars, per agent. Always shown with "≈". */
  costUsd: number
  /** The last error, or the turn-limit line for a paused task. */
  error?: string
  /** Who started it: the person, another agent through the bridge, or a room wake. */
  origin: TaskOrigin
  projectId?: string
  createdAt: number
  updatedAt: number
}

export type TaskOrigin =
  | { kind: 'person' }
  | { kind: 'bridge'; fromAgentId: AgentId; fromTaskId: string; hop: number; depth: number }
  | { kind: 'room'; roomId: string; hop: number }

/** One row of a thread as the Chat view draws it. */
export type ThreadRow = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  /** Set on tool rows. */
  tool?: { name: string; summary: string; state: 'running' | 'ok' | 'error' | 'awaiting' | 'denied' }
  /** Set on a user row a bridge or room delivered: who it came from. */
  fromAgentId?: AgentId
  at: number
}

/** An approval waiting for the person. */
export type ApprovalCard = {
  /** The tool_use_id of the call it holds. */
  id: string
  taskId: string
  agentId: AgentId
  tool: string
  /** What the call does, at most 400 characters (the desktop's summarizeToolInput rule). */
  summary: string
  /** Who asked, in words: "Asked by Zealot in #release, hop 2". Absent for a task the person started. */
  origin?: string
  /** True where the A hotkey must not allow it (the desktop's click-only rule): the person moves to the button and presses Enter. */
  isClickOnly: boolean
  at: number
}

export type ViewId = 'chat' | 'rooms' | 'library' | 'board' | 'order'

/** What the pane shows, and the channel the prompt talks to. */
export type UiState = {
  view: ViewId
  agentId: AgentId
  taskId: string | null
  /** While set, every prompt goes to this agent (`/legion talk <agent>`). */
  channel: AgentId | null
}

/** One row of the band above the prompt: something that needs the person. */
export type BandItem = {
  id: string
  kind: 'card' | 'done' | 'paused' | 'error' | 'inbox'
  taskId?: string
  agentId?: AgentId
  text: string
  at: number
}

/** An agent's live mood, with when it started (moods dwell at least 1.8 s, urgent ones switch at once). */
export type MoodState = { mood: Mood; since: number; note?: string }

/** The mod's own settings, kept across sessions. */
export type ModSettings = {
  /** `auto` follows Claude Code's theme setting. */
  theme: 'auto' | 'dark' | 'light'
  /** Ambient motion (pulse, muster, seal). Off freezes everything. */
  motion: boolean
  /** The 2D Order: painted busts drawn in cells. Off by default; off loads no frames and registers no timer. */
  twoD: boolean
  /** Turns per run before a task pauses at the turn limit (desktop: claude.maxTurns, 1-1000). */
  maxTurns: number
  /** What Builder's `full` means here: `acceptEdits` with commands still carded (safe default), or Claude Code's `auto`. */
  fullMode: 'acceptEdits' | 'auto'
}

// ---- Shared with legion-mod-runner: keep identical to mod-runner/types/index.d.ts (a spec checks) ----
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

// ---- end shared ----

declare module 'claude-code' {
  interface PluginState {
    'legion-mod': {
      agents: AgentView[]
      tasks: TaskView[]
      threads: StateFamily<ThreadRow[]>
      /** Streaming text of a running task's current reply, cleared when the reply lands as a row. */
      live: StateFamily<string>
      cards: ApprovalCard[]
      ui: UiState
      moods: Record<AgentId, MoodState>
      band: BandItem[]
      settings: ModSettings
      /** Resolved theme for drawing: `dark` or `light`. */
      theme: 'dark' | 'light'
      /** Lifecycle requests for legion-mod-runner, which acts on them from its own timer (plan §1b). Cleared once answered. */
      runQueue: RunRequest[]
    }
  }
}
