/**
 * What a Legion Button asks for, written into the Button's key.
 *
 * The UI never runs an action itself: every actionable Button's `key` is `encodeAction(action)` and its `onPress` is a
 * no-op. A press still raises `ui.press` with `e.element` = that key, and the lead's `ui.press` hook
 * (src/wire/actions.tsx) answers it with `decodeAction(e.element)`. That split exists because `onPress` receives no
 * `$` and the validator lets `$` reach only functions declared in the hook's own file.
 *
 * Key grammar (one per action, at most 64 characters, the ButtonProps.key limit the lead's hook relies on):
 *
 *   view:<chat|order>      agent:<agentId>      task:<taskId>      new:<agentId>
 *   continue:<taskId>      stop:<taskId>        poke:<agentId>
 *   allow:<cardId>         deny:<cardId>        dismiss:<bandItemId>
 *   keys:open | keys:close (the key-help view)     steps:<taskId> (open a task's folded steps) | steps:close
 *
 * An id that would take a key past 64 characters is written as its index instead, `allow#3`: the position in
 * `cardsInOrder(cards)` (cards) or `bandOrder(band)` (band items), the same orders the UI draws in; `cardAt` and
 * `bandItemAt` resolve it. A Button drawn twice in one site with the same action carries `~2`, `~3`... after its key
 * (`task:t_0123456789ab~2`), which `decodeAction` ignores, so every key in a site is unique.
 */
import type { AgentId, ApprovalCard, BandItem, ViewId } from '../../types/index.d.ts'

export type UiAction =
  | { kind: 'view'; view: ViewId }
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'task'; taskId: string }
  | { kind: 'new'; agentId: AgentId }
  | { kind: 'continue'; taskId: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'poke'; agentId: AgentId }
  | { kind: 'card-allow'; cardId: string; index: number }
  | { kind: 'card-deny'; cardId: string; index: number }
  | { kind: 'band-dismiss'; itemId: string; index: number }
  | { kind: 'keys'; open: boolean }
  | { kind: 'steps'; taskId: string | null }

/** What a decoded key names: the action, with an index in place of an id that was too long to write. */
export type DecodedAction =
  | Exclude<UiAction, { kind: 'card-allow' | 'card-deny' | 'band-dismiss' }>
  | { kind: 'card-allow' | 'card-deny'; cardId: string }
  | { kind: 'card-allow' | 'card-deny'; index: number }
  | { kind: 'band-dismiss'; itemId: string }
  | { kind: 'band-dismiss'; index: number }

export const KEY_MAX = 64

const PREFIX = {
  view: 'view', agent: 'agent', task: 'task', new: 'new', continue: 'continue', stop: 'stop', poke: 'poke',
  'card-allow': 'allow', 'card-deny': 'deny', 'band-dismiss': 'dismiss', keys: 'keys', steps: 'steps',
} as const satisfies Record<UiAction['kind'], string>

const KIND_OF: Record<string, UiAction['kind']> = Object.fromEntries(Object.entries(PREFIX).map(([k, p]) => [p, k as UiAction['kind']]))

const idOf = (a: UiAction): string => {
  switch (a.kind) {
    case 'view': return a.view
    case 'agent': case 'new': case 'poke': return a.agentId
    case 'task': case 'continue': case 'stop': return a.taskId
    case 'card-allow': case 'card-deny': return a.cardId
    case 'band-dismiss': return a.itemId
    case 'keys': return a.open ? 'open' : 'close'
    case 'steps': return a.taskId ?? 'close'
  }
}

/** The Button key for an action; an id too long for 64 characters is written as its index (`allow#3`). */
export const encodeAction = (a: UiAction): string => {
  const key = `${PREFIX[a.kind]}:${idOf(a)}`
  if (key.length <= KEY_MAX) return key
  if (a.kind === 'card-allow' || a.kind === 'card-deny' || a.kind === 'band-dismiss') return `${PREFIX[a.kind]}#${a.index}`
  // agent, task and view ids are short by contract (roster ids, `t_` + 12 hex); one that is not is cut, never silently
  // merged with another: the lead's hook finds no such agent or task and says so
  return key.slice(0, KEY_MAX)
}

const VIEWS: ReadonlySet<string> = new Set(['chat', 'rooms', 'library', 'board', 'order'])

/** The action a Button key names, or null for a key that is not one of Legion's (another plugin's, a typo). */
export const decodeAction = (key: string): DecodedAction | null => {
  const bare = key.replace(/~\d+$/, '')
  const m = /^([a-z]+)([:#])(.+)$/.exec(bare)
  if (!m) return null
  const [, prefix, sep, rest] = m as unknown as [string, string, string, string]
  const kind = KIND_OF[prefix]
  if (!kind) return null
  if (sep === '#') {
    if (!/^\d+$/.test(rest)) return null
    const index = Number(rest)
    if (kind === 'card-allow' || kind === 'card-deny') return { kind, index }
    if (kind === 'band-dismiss') return { kind, index }
    return null
  }
  switch (kind) {
    case 'view': return VIEWS.has(rest) ? { kind, view: rest as ViewId } : null
    case 'agent': case 'new': case 'poke': return { kind, agentId: rest }
    case 'task': case 'continue': case 'stop': return { kind, taskId: rest }
    case 'card-allow': case 'card-deny': return { kind, cardId: rest }
    case 'band-dismiss': return { kind, itemId: rest }
    case 'keys': return rest === 'open' || rest === 'close' ? { kind, open: rest === 'open' } : null
    case 'steps': return { kind, taskId: rest === 'close' ? null : rest }
  }
}

/** Cards in the order the UI draws them, oldest first: the first is the one `a` and `d` answer. */
export const cardsInOrder = (cards: readonly ApprovalCard[]): ApprovalCard[] => [...cards].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))

/** Band items in the order the band draws them: newest first, cards left out (they come from `cards`). */
export const bandOrder = (band: readonly BandItem[]): BandItem[] => band.filter(i => i.kind !== 'card').sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))

/** The card an `allow#n` / `deny#n` key names. */
export const cardAt = (cards: readonly ApprovalCard[], index: number): ApprovalCard | undefined => cardsInOrder(cards)[index]

/** The band item a `dismiss#n` key names. */
export const bandItemAt = (band: readonly BandItem[], index: number): BandItem | undefined => bandOrder(band)[index]
