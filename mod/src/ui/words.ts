/**
 * Legion's words, one name per thing (claude/tui-information-design.md R11), and the two facts every surface shares:
 * what a task is doing now (R2) and how many tasks stand where (R1: one count function feeds the title row, the status
 * line and the band, so they never disagree). Pure.
 */
import type { ApprovalCard, TaskView, ThreadRow } from '../../types/index.d.ts'
import { cellWidth, cutCells, oneLine } from './text.ts'

/** The glossary's words for a task's state (R11 "Words"). */
export const STATE_WORD = {
  running: 'working',
  queued: 'queued',
  paused: 'paused',
  cancelled: 'stopped',
  done: 'done',
  error: 'failed',
} as const satisfies Record<TaskView['status'], string>

/** The one name for a tool call that waits on the person. */
export const NEEDS_YOU = 'needs your OK'

/**
 * The glossary's "Never" column: words the drawn UI must not use (R11). Each is a pattern over drawn text; the
 * exemptions are named where they are allowed:
 * - "running `cmd`" is R2's own verb for a shell command (a backtick follows), not the state word;
 * - mood words such as "Executing" and "Awaiting your word" belong to Order's agent list, where character is the point;
 * - "runs" the verb ("It runs on your computer") is not "run" the noun.
 */
export const NEVER: ReadonlyArray<{ word: string; re: RegExp }> = [
  { word: 'job', re: /\bjobs?\b/i },
  { word: 'run (noun)', re: /\b(a|the|this|that|its) run\b|\brun failed\b/i },
  { word: 'request', re: /\brequests?\b/i },
  { word: 'prompt', re: /\bprompts?\b/i },
  { word: 'running (state)', re: /\brunning\b(?! `)/i },
  { word: 'busy', re: /\bbusy\b/i },
  { word: 'active', re: /\bactive\b/i },
  { word: 'executing', re: /\bexecuting\b/i },
  { word: 'pending', re: /\bpending\b/i },
  { word: 'waiting', re: /\bwaiting\b/i },
  { word: 'halted', re: /\bhalted\b/i },
  { word: 'interrupted', re: /\binterrupted\b/i },
  { word: 'cancelled', re: /\bcancell?ed\b/i },
  { word: 'aborted', re: /\baborted\b/i },
  { word: 'killed', re: /\bkilled\b/i },
  { word: 'complete', re: /\bcomplete(d)?\b/i },
  { word: 'finished', re: /\bfinished\b/i },
  { word: 'succeeded', re: /\bsucceeded\b/i },
  { word: 'crashed', re: /\bcrashed\b/i },
  { word: 'error (alone)', re: /\berror\b/i },
  { word: 'approval', re: /\bapprovals?\b/i },
  { word: 'card', re: /\bcards?\b/i },
  { word: 'awaiting your word', re: /\bawaiting your word\b/i },
  { word: 'permission request', re: /\bpermission request\b/i },
  { word: 'delegated', re: /\bdelegated\b/i },
  { word: 'told', re: /\btold\b/i },
  { word: 'bridged', re: /\bbridged?\b/i },
  { word: 'the team', re: /\bthe team\b/i },
  { word: 'the agents', re: /\bthe agents\b/i },
  { word: 'the fleet', re: /\bthe fleet\b/i },
  { word: 'cost:', re: /\bcost:/i },
  { word: '$ without ≈', re: /(?<![≈<])\$\d/ },
]

/** A path's last part: `src/ui/text.ts` → `text.ts`. */
const base = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || p

/** The file or pattern a tool summary names: the wire writes compact JSON for most tools, the path itself for Edit/Write. */
const target = (summary: string): string => {
  try {
    const o = JSON.parse(summary) as Record<string, unknown>
    for (const k of ['file_path', 'path', 'notebook_path', 'pattern', 'url', 'query']) if (typeof o[k] === 'string') return o[k] as string
  } catch { /* the summary is the target itself */ }
  return summary
}

/**
 * What a task is doing now, as a verb from its latest tool (R2): reading, editing, running `npm test`, asking ⌘ Scout,
 * handing to ⌘ Builder; `needs your OK` while a call waits on the person; `thinking` between tools. Not for a task
 * that is not working (its state word says it).
 */
export const nowVerb = (tool: { name: string; summary: string } | undefined, hasCard: boolean, glyphOf: (name: string) => string, max = 28): string => {
  if (hasCard) return NEEDS_YOU
  if (!tool) return 'thinking'
  const { name, summary } = tool
  // the verb and its object, whole; when the object does not fit, the bare verb (never "editing repl…")
  const say = (verb: string, object: string): string => {
    const full = `${verb} ${oneLine(object)}`
    return cellWidth(full) <= max ? full : verb
  }
  if (name === 'Read' || name === 'Glob' || name === 'Grep' || name === 'LS' || name === 'NotebookRead') return say('reading', base(target(summary)))
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return say('editing', base(target(summary)))
  // a command is cut inside its quotes, from 16 cells; below that the bare verb
  if (name === 'Bash' || name === 'PowerShell') return max >= 16 ? `running \`${cutCells(oneLine(summary), max - 10)}\`` : 'running'
  if (name === 'WebFetch' || name === 'WebSearch') return 'reading the web'
  const handed = /^(Ask|Tell) ([^:]+):/.exec(summary)
  if (name === 'Agent' && handed) return say(handed[1] === 'Ask' ? 'asking' : 'handing to', `${glyphOf(handed[2] as string)} ${handed[2]}`)
  return say('using', name.replace(/^mcp__/, '').replace(/__/g, '·'))
}

/** The tool a task is in now: its newest tool row still running or waiting, from its thread. */
export const currentTool = (thread: readonly ThreadRow[] | undefined): { name: string; summary: string } | undefined => {
  if (!thread) return undefined
  for (let i = thread.length - 1; i >= 0; i--) {
    const r = thread[i] as ThreadRow
    if (r.role === 'tool' && r.tool) return r.tool.state === 'running' || r.tool.state === 'awaiting' ? { name: r.tool.name, summary: r.tool.summary } : undefined
    if (r.role === 'assistant') return undefined
  }
  return undefined
}

/** How many tasks stand where: the one count every surface draws from. */
export type Counts = { working: number; queued: number; paused: number; needsYou: number }

export const counts = (tasks: readonly TaskView[], cards: readonly ApprovalCard[]): Counts => ({
  working: tasks.filter(t => t.status === 'running').length,
  queued: tasks.filter(t => t.status === 'queued').length,
  paused: tasks.filter(t => t.status === 'paused').length,
  needsYou: cards.length,
})
