/**
 * The band above the prompt: only what needs the person, one row each, at most three, then `+N more · /legion to open`.
 * Plan §4 "Band". It yields to a survey and is gone when nothing waits (the render hook passes then).
 *
 * Rows, in order: the open channel (`Talking to ✠ Zealot`), what needs your OK (oldest first), then the items the runtime
 * posted (done, paused, failed tasks, Library notes), newest first. Each row's words are built here from its kind and
 * its task, so the agent is named once and the state once (review bug 1).
 *
 * Keys come from the one key map (claude/tui-information-design.md "Keys"): the first paused task takes `c` (not one
 * another window owns); open and dismiss are reached with Tab. No digits: a bare digit typed into an empty prompt
 * presses a band Button (ButtonProps.hotkey). A "needs your OK" row carries no control: it is answered in Claude Code's
 * own permission dialog (plan §2.1). It comes from the `cards` state; a band item of kind `card` is not drawn twice.
 */
import type { ApprovalCard, BandItem } from '../../types/index.d.ts'
import { MARK } from '../theme.ts'
import { count } from './format.ts'
import { bandOrder } from './actions.ts'
import { btn, line, partsWidth, span, uniqueKeys, type Part, type Row, type SpanTone } from './model.ts'
import { oneLine } from './text.ts'
import { answerWhere, needsHead } from './cards.ts'
import { agentById, agentLabel, cardsInOrder, cleanTitle, isElsewhere, taskOf, type Snapshot } from './views/common.ts'
import { NEEDS_YOU, STATE_WORD } from './words.ts'

export const BAND_MAX = 3

/** The fewest cells a band row's title keeps before the dismiss control may take room from it. */
const TITLE_MIN = 12

type Entry =
  | { kind: 'channel'; agentId: string }
  | { kind: 'card'; card: ApprovalCard; index: number }
  | { kind: 'item'; item: BandItem; index: number }

const ITEM_MARK: Record<BandItem['kind'], { mark: string; tone: SpanTone }> = {
  card: { mark: MARK.card, tone: 'warn' },
  done: { mark: MARK.done, tone: 'muted' },
  paused: { mark: MARK.paused, tone: 'warn' },
  error: { mark: MARK.error, tone: 'danger' },
  inbox: { mark: MARK.done, tone: 'muted' },
}

/** Everything that waits, in band order. */
export const bandEntries = (s: Snapshot): Entry[] => [
  ...(s.ui.channel ? [{ kind: 'channel', agentId: s.ui.channel } as const] : []),
  ...cardsInOrder(s).map((card, index) => ({ kind: 'card', card, index }) as const),
  ...bandOrder(s.band).map((item, index) => ({ kind: 'item', item, index }) as const),
]

/** The words a band item says after the agent: built from its kind and its task, never from the runtime's text (bug 1). */
const itemWords = (s: Snapshot, it: BandItem): { title: string; state: string } => {
  const task = it.taskId ? taskOf(s, it.taskId) : undefined
  // the runtime writes "<title> · <state>"; without the task, its title part is the best we have
  const title = task ? cleanTitle(task.title) : oneLine(it.text).split(' · ')[0] ?? ''
  if (it.kind === 'paused') return { title, state: STATE_WORD.paused }
  if (it.kind === 'done') return { title, state: STATE_WORD.done }
  if (it.kind === 'error') return { title, state: `${STATE_WORD.error}${task?.error ? `: ${oneLine(task.error)}` : ''}` }
  return { title: oneLine(it.text), state: '' }
}

/** The band's rows at `width` cells and at most `maxRows` rows; none when nothing waits. */
export const bandRows = (s: Snapshot, width: number, maxRows: number): Row[] => {
  const all = bandEntries(s)
  const cap = Math.max(0, Math.min(BAND_MAX, Math.floor(maxRows)))
  if (all.length === 0 || cap === 0) return []
  const shown = all.length <= cap ? all : all.slice(0, cap - 1)
  const taken = new Set<string>()
  /** The hotkey once per band: the first row that asks for it gets it. */
  const key = (k: string): string | undefined => (taken.has(k) ? undefined : (taken.add(k), k))
  const rows = shown.map((e): Row => {
    if (e.kind === 'channel') {
      // C2: every message goes to the agent while this shows
      return line([span(' '), span('Talking to ', 'accent', { fixed: true }), span(agentLabel(s, e.agentId), 'accent', { bold: true, fixed: true }), span(' · /legion talk off', 'muted', { fixed: true })], [], width)
    }
    if (e.kind === 'card') {
      // who, needs your OK, what for when it fits whole, the exact call, then where to answer (polish 8: no cut verb)
      const c = e.card
      const where: Part[] = [span(answerWhere(isElsewhere(s, taskOf(s, c.taskId)), true), 'muted', { fixed: true }), span(' ')]
      const head = (full: boolean): Part[] => [span(' '), span(`${MARK.card} `, 'warn', { fixed: true }), span(agentLabel(s, c.agentId), 'text', { bold: true, fixed: true }), span(` ${full ? needsHead(c.tool) : NEEDS_YOU}`, 'warn', { fixed: true }), span(' · ', 'muted', { fixed: true })]
      const full = partsWidth([...head(true), ...where]) + 20 + 2 <= width
      return line([...head(full), span(oneLine(c.summary))], where, width, 2)
    }
    const it = e.item
    const m = ITEM_MARK[it.kind]
    const w = itemWords(s, it)
    const left: Part[] = [span(' '), span(`${m.mark} `, m.tone, { fixed: true })]
    // below 56 cells the agent is its glyph, so the state and its key keep their room
    if (it.agentId) left.push(span(width >= 56 ? agentLabel(s, it.agentId) : agentById(s, it.agentId)?.glyph ?? '', 'text', { bold: true, fixed: true }), span(' · ', 'muted', { fixed: true }))
    left.push(span(w.title))
    // the state word is fixed; a failure's reason is what gives way
    const [state, ...reason] = w.state.split(': ')
    if (state) left.push(span(` · ${state}`, it.kind === 'error' ? 'danger' : it.kind === 'paused' ? 'warn' : 'muted', { fixed: true }))
    if (reason.length > 0) left.push(span(`: ${reason.join(': ')}`, 'danger'))
    const right: Part[] = []
    if (it.kind === 'paused' && it.taskId && !isElsewhere(s, taskOf(s, it.taskId))) {
      right.push(btn({ kind: 'continue', taskId: it.taskId }, 'continue', { hotkey: key('c') }), span('  '))
    } else if ((it.kind === 'done' || it.kind === 'error') && it.taskId) {
      right.push(btn({ kind: 'task', taskId: it.taskId }, 'open'), span('  '))
    }
    // dismiss leaves first when the row is short: the row's own action stays
    const dismiss: Part[] = [btn({ kind: 'band-dismiss', itemId: it.id, index: e.index }, 'dismiss', { dim: true }), span(' ')]
    const minLeft = partsWidth(left.filter(p => p.t === 'button' || (p.t === 'text' && p.fixed)))
    // the title keeps at least TITLE_MIN cells before dismiss may take room
    if (minLeft + TITLE_MIN + partsWidth([...right, ...dismiss]) + 2 <= width) right.push(...dismiss)
    else if (right.length > 0) right.splice(right.length - 1, 1, span(' '))
    return line(left, right, width, 2)
  })
  if (shown.length < all.length) {
    const more = all.length - shown.length
    rows.push(line([span(' '), span(`${count(more)} more · /legion to open`, 'muted')], [], width))
  }
  return uniqueKeys(rows)
}
