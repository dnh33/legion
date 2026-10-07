/**
 * How a "needs your OK" reads, everywhere Legion draws one: who, what kind of thing, the exact call, what saying yes
 * does, then where to answer. claude/tui-information-design.md R11 (one name: "needs your OK") and the brief's card rule
 * (hierarchy who → what → consequence → answer; plain, second person).
 *
 * Legion's own surfaces do not answer it: the run waits on Claude Code's own permission dialog (plan §2.1), so the
 * card points there. One that another window's task raised points to that window.
 */
import type { ApprovalCard } from '../../types/index.d.ts'
import { shortTool } from './views/common.ts'
import { NEEDS_YOU } from './words.ts'

/** What it needs your OK for, after "needs your OK": "to run a command". */
export const forWhat = (tool: string): string => {
  if (tool === 'Bash' || tool === 'PowerShell') return 'to run a command'
  if (tool === 'Edit' || tool === 'MultiEdit') return 'to edit a file'
  if (tool === 'Write') return 'to write a file'
  if (tool === 'NotebookEdit') return 'to edit a notebook'
  if (tool === 'WebFetch') return 'to fetch a web page'
  if (tool === 'WebSearch') return 'to search the web'
  return `to use ${tool.startsWith('mcp__') ? shortTool(tool) : tool}`
}

/** The head after the agent's name: "needs your OK to run a command". */
export const needsHead = (tool: string): string => `${NEEDS_YOU} ${forWhat(tool)}`

/** What saying yes does, in one plain sentence; claims scoped to what Legion's own code does. */
export const consequence = (tool: string): string => {
  if (tool === 'Bash' || tool === 'PowerShell') return 'It runs on your computer, with your access.'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return 'It changes the file on disk.'
  if (tool === 'WebFetch' || tool === 'WebSearch') return "It reaches the internet; Legion's own code marks what comes back as untrusted."
  if (tool.startsWith('mcp__')) return 'It calls a tool another server provides.'
  return `It lets ${tool} run once.`
}

/** Where to answer: this window's permission dialog, or the window that owns the task. `short` for one-line rows. */
export const answerWhere = (isElsewhere: boolean, short = false): string =>
  isElsewhere
    ? (short ? 'in its window' : 'Answer in the window that runs this task.')
    : (short ? 'in the dialog' : 'Answer in the permission dialog.')

export type CardWords = { head: string; what: string; consequence: string; origin?: string }

export const cardWords = (card: ApprovalCard): CardWords => ({
  head: needsHead(card.tool),
  what: card.summary,
  consequence: consequence(card.tool),
  ...(card.origin ? { origin: card.origin } : {}),
})
