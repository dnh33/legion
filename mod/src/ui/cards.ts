/**
 * How an approval reads, in every place Legion draws one: who asks, what exactly, what it does, then where to answer.
 * The brief's card rule (claude/mod-build-brief.md, A-gate "Card design"): hierarchy who → what → consequence →
 * answer; plain, second person; no badge soup.
 *
 * Legion's own surfaces do not answer cards: the run waits on Claude Code's own permission dialog (plan §2.1), so a
 * card here points there. A card of a run another window owns points to that window.
 */
import type { ApprovalCard } from '../../types/index.d.ts'
import { shortTool } from './views/common.ts'

/** What the agent asks to do, after its name: "asks to run a command". */
export const askVerb = (tool: string): string => {
  if (tool === 'Bash' || tool === 'PowerShell') return 'asks to run a command'
  if (tool === 'Edit' || tool === 'MultiEdit') return 'asks to edit a file'
  if (tool === 'Write') return 'asks to write a file'
  if (tool === 'NotebookEdit') return 'asks to edit a notebook'
  if (tool === 'WebFetch') return 'asks to fetch a web page'
  if (tool === 'WebSearch') return 'asks to search the web'
  if (tool.startsWith('mcp__')) return `asks to use ${shortTool(tool)}`
  return `asks to use ${tool}`
}

/** What saying yes does, in one plain sentence. */
export const consequence = (tool: string): string => {
  if (tool === 'Bash' || tool === 'PowerShell') return 'It runs on your computer, with your access.'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return 'It changes the file on disk.'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'It reaches the internet; what comes back is treated as untrusted.'
  if (tool.startsWith('mcp__')) return 'It calls a tool another server provides.'
  return `It lets ${tool} run once.`
}

/** Where to answer: this window's permission dialog, or the window that owns the run. */
export const answerWhere = (isElsewhere: boolean, short = false): string =>
  isElsewhere
    ? (short ? 'answer in its window' : 'Answer it in the window that runs this task.')
    : (short ? 'answer in the dialog' : 'Answer in the permission dialog.')

export type CardWords = { verb: string; what: string; consequence: string; origin?: string }

export const cardWords = (card: ApprovalCard): CardWords => ({
  verb: askVerb(card.tool),
  what: card.summary,
  consequence: consequence(card.tool),
  ...(card.origin ? { origin: card.origin } : {}),
})
