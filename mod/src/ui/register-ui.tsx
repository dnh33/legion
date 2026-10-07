/**
 * The Legion UI's hooks: the pane, the band above the prompt, the `/to` and `/say` transcript cards, and the status
 * line. `hooks/register.tsx` calls `registerUi(on)` once; everything else in src/ui is pure.
 *
 * Each render hook reads the state it draws from (`$.state`, which subscribes the drawing, so a write redraws it),
 * builds rows in pure code, and turns them into the surface's elements. Nothing here writes state, and no Button acts
 * by itself: each carries its action in its key (actions.ts), which the lead's `ui.press` hook answers.
 */
import { atom, read } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'
import type { ThreadRow } from '../../types/index.d.ts'
import { palette } from '../theme.ts'
import { bandRows } from './band.ts'
import { Pane, Rows } from './components.tsx'
import { dispatchRows, taskIdIn } from './dispatch.ts'
import { statusText } from './status.ts'
import { DEFAULT_UI, selectedTask, type Snapshot } from './views/common.ts'
import { paneLayout } from './views/pane.ts'

const agents = atom({ plugin: 'legion-mod', key: 'agents' } as const, [])
const tasks = atom({ plugin: 'legion-mod', key: 'tasks' } as const, [])
const cards = atom({ plugin: 'legion-mod', key: 'cards' } as const, [])
const ui = atom({ plugin: 'legion-mod', key: 'ui' } as const, DEFAULT_UI)
const moods = atom({ plugin: 'legion-mod', key: 'moods' } as const, {})
const band = atom({ plugin: 'legion-mod', key: 'band' } as const, [])
const theme = atom({ plugin: 'legion-mod', key: 'theme' } as const, 'dark')
const sessionId = atom({ plugin: 'legion-mod', key: 'sessionId' } as const, '')
const doctor = atom({ plugin: 'legion-mod', key: 'doctor' } as const, [])
const THREADS = { plugin: 'legion-mod', key: 'threads' } as const
const LIVE = { plugin: 'legion-mod', key: 'live' } as const

/**
 * Keys whose change can change the status line. `threads` is one write per row (a tool starting or ending), and the
 * line's verb comes from it: without it the verb froze until the mood changed. `live` changes on every streamed chunk
 * and never changes the line.
 */
const STATUS_KEYS: ReadonlySet<string> = new Set(['agents', 'tasks', 'cards', 'ui', 'moods', 'threads'])

/**
 * One read of the state a drawing needs. `thread` and `live` are read for one task: the selected task's for the pane,
 * the dispatched task's for a transcript card, none for the band and the status line.
 */
async function readSnapshot($: EngineInterface, taskFor: 'selected' | 'none' | string): Promise<Snapshot> {
  const s: Snapshot = {
    agents: await read($, agents),
    tasks: await read($, tasks),
    cards: await read($, cards),
    ui: { ...DEFAULT_UI, ...(await read($, ui)) },
    moods: await read($, moods),
    band: await read($, band),
    thread: [],
    live: '',
    now: await $.clock.now(),
    sessionId: await read($, sessionId),
  }
  if (taskFor === 'selected') s.doctor = await read($, doctor)
  const id = taskFor === 'selected' ? selectedTask(s)?.id : taskFor === 'none' ? undefined : taskFor
  if (id) {
    const thread: ThreadRow[] | undefined = await read($, { ...THREADS, id })
    s.thread = thread ?? []
    s.live = (await read($, { ...LIVE, id })) ?? ''
    s.threads = { [id]: s.thread }
  }
  // the working tasks' own rows, for what each is doing now (R2): the pane's tree and Order, or the status line's agent.
  // Capped, newest first; each read subscribes the drawing, so a tool starting redraws its verb.
  const workers = s.tasks.filter(t => t.status === 'running' && t.id !== id)
    .filter(t => taskFor !== 'none' || t.agentId === s.ui.agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, THREADS_READ_MAX)
  if (workers.length > 0) {
    const threads: Record<string, readonly ThreadRow[]> = { ...s.threads }
    for (const t of workers) threads[t.id] = (await read($, { ...THREADS, id: t.id })) ?? []
    s.threads = threads
  }
  return s
}

/** The snapshot with one task's just-written rows laid over it (a `threads` write names its task by the family id). */
const withThread = (s: Snapshot, e: { id?: string; value: unknown }): Snapshot =>
  e.id ? { ...s, threads: { ...s.threads, [e.id]: e.value as readonly ThreadRow[] } } : s

/** At most this many other tasks' rows are read per drawing; past it a task's verb reads "thinking". */
const THREADS_READ_MAX = 12

/** The card a `/to` or `/say` row leaves, or undefined to let the engine draw the row's text. */
async function dispatchTree($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0] & { props: { text: string; isErrored: boolean }; viewport?: { columns: number } }): Promise<RenderElement | undefined> {
  const id = taskIdIn(e.props.text)
  if (!id || e.props.isErrored) return undefined
  const s = await readSnapshot($, id)
  // CommandOutput has no bodyColumns: the transcript's width is the viewport's, else 80
  const columns = e.viewport?.columns && e.viewport.columns > 0 ? Math.floor(e.viewport.columns) : 80
  const rows = dispatchRows(s, e.props.text, columns)
  if (!rows) return undefined
  return Rows($.ui.resolve(e), palette(await read($, theme)), rows)
}

export function registerUi(on: On): void {
  /**
   * The status line follows every write to a key it shows; the first write (the engine seeding the agents at session
   * start) pins it. It changes only when its text does: a module value, reset harmlessly on reload.
   */
  let lastStatus: string | undefined

  on('ui.render', { component: 'Pane', requestId: 'legion' }, async ($, e) => {
    const s = await readSnapshot($, 'selected')
    const pal = palette(await read($, theme))
    return Pane($.ui.resolve(e), pal, paneLayout(s, e.props.bodyColumns, e.props.scroll.bodyRows))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const rows = bandRows(await readSnapshot($, 'none'), e.props.bodyColumns, e.props.maxRows)
    if (rows.length === 0) return next(e)
    return Rows($.ui.resolve(e), palette(await read($, theme)), rows)
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'to' } }, async ($, e, next) => (await dispatchTree($, e)) ?? next(e))

  on('ui.render', { component: 'CommandOutput', props: { command: 'say' } }, async ($, e, next) => (await dispatchTree($, e)) ?? next(e))

  on('state.set', { plugin: 'legion-mod' }, async ($, e, next) => {
    const done = await next(e)
    if (!STATUS_KEYS.has(e.key)) return done
    // every get of one dispatch reads one moment, which may be before this write lands: lay the written value over it
    const s = await readSnapshot($, 'none')
    const landed = done.deny === undefined && done.value.isSet
    const text = statusText(!landed ? s : e.key === 'threads' ? withThread(s, e) : { ...s, [e.key]: e.value })
    if (text !== lastStatus) {
      lastStatus = text
      $.ui.status(text)
    }
    return done
  })
}
