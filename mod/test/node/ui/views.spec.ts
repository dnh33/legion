import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bandRows } from '../../../src/ui/band.ts'
import { dispatchRows } from '../../../src/ui/dispatch.ts'
import { controls, rowText, rowWidth, type Row } from '../../../src/ui/model.ts'
import { cellWidth } from '../../../src/ui/text.ts'
import { paneLayout, type PaneLayout } from '../../../src/ui/views/pane.ts'
import { THREAD_MAX } from '../../../src/ui/views/chat.ts'
import type { Snapshot } from '../../../src/ui/views/common.ts'
import { decodeAction } from '../../../src/ui/actions.ts'
import { base, busy, card, long, task, WIDTHS } from './fixtures.ts'

const STATES: Record<string, () => Snapshot> = {
  empty: () => base({ tasks: [] }),
  'no agents': () => base({ agents: [] }),
  busy: () => busy(),
  long: () => long(),
  error: () => busy({ ui: { view: 'chat', agentId: 'scout', taskId: 't_000000000003', channel: null }, thread: [], live: '' }),
  paused: () => busy({ ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000002', channel: null }, live: '' }),
  'channel open': () => busy({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } }),
}

const VIEWS = ['chat', 'order'] as const
const withView = (s: Snapshot, view: 'chat' | 'order'): Snapshot => ({ ...s, ui: { ...s.ui, view } })

/** Every line row of a pane with the width it must have. */
const sized = (l: PaneLayout, width: number): Array<[Row, number, string]> => [
  ...l.title.map((r): [Row, number, string] => [r, width, 'title']),
  ...l.rail.map((r): [Row, number, string] => [r, l.railWidth, 'rail']),
  ...l.main.map((r): [Row, number, string] => [r, width - l.railWidth, 'main']),
]

test('pane: every line row is exactly its column wide (the thread at most THREAD_MAX), at every width, state and view', () => {
  for (const [name, make] of Object.entries(STATES)) {
    for (const view of VIEWS) {
      for (const w of WIDTHS) {
        const l = paneLayout(withView(make(), view), w, 40)
        for (const [r, want, where] of sized(l, w)) {
          if (r.t !== 'line') continue
          // the thread draws at most THREAD_MAX cells wide; every other row spans its column
          const ok = rowWidth(r) === want || (where === 'main' && view === 'chat' && rowWidth(r) === Math.min(want, THREAD_MAX))
          assert.ok(ok, `${name}/${view}/${w}/${where}: ${rowWidth(r)} of ${want}: "${rowText(r)}"`)
        }
      }
    }
  }
})

test('pane: the rail shows from 72 columns (theme.ts railColumns); below it, a strip of glyphs', () => {
  for (const w of WIDTHS) {
    const l = paneLayout(busy(), w, 40)
    if (w >= 72) assert.ok(l.railWidth > 0 && l.rail.length === 12, String(w)) // 13 agents, the Assayer hidden
    else {
      assert.equal(l.railWidth, 0, String(w))
      const strip = controls([l.main[0] as Row]).map(b => b.label)
      assert.ok(strip.length >= 10 && !strip.includes('⊜'), `${w}: ${strip.join(' ')}`)
    }
  }
})

test('pane: hotkeys are unique per view, and the right ones exist for the state', () => {
  const keysOf = (s: Snapshot, w = 100): string[] => {
    const l = paneLayout(s, w, 40)
    return controls([...l.title, ...l.rail, ...l.main]).flatMap(b => (b.hotkey ? [b.hotkey] : []))
  }
  for (const [name, make] of Object.entries(STATES)) {
    for (const view of VIEWS) {
      const keys = keysOf(withView(make(), view))
      assert.equal(new Set(keys).size, keys.length, `${name}/${view}: ${keys.join(',')}`)
    }
  }
  assert.deepEqual(keysOf(busy()).sort(), ['5', 'a', 'd', 'n', 's'])
  assert.deepEqual(keysOf(STATES.paused!()).sort(), ['5', 'c', 'n', 'o'])
  assert.deepEqual(keysOf(withView(busy(), 'order')).sort(), ['1', 'p'])
})

test('pane: each control carries its action in its key, and every key decodes to it', () => {
  const l = paneLayout(busy(), 120, 40)
  const keys = controls([...l.title, ...l.rail, ...l.main]).map(b => b.key)
  for (const k of ['view:order', 'agent:scout', 'task:t_000000000002', 'new:builder', 'allow:c1', 'deny:c1', 'stop:t_000000000001']) assert.ok(keys.includes(k), k)
  for (const b of controls([...l.title, ...l.rail, ...l.main])) {
    const { index: _i, ...want } = b.action as typeof b.action & { index?: number }
    assert.deepEqual(decodeAction(b.key), want, b.key)
  }
  assert.ok(controls(paneLayout(STATES.paused!(), 120, 40).main).some(b => b.key === 'continue:t_000000000002'))
  assert.ok(controls(paneLayout(withView(busy(), 'order'), 120, 40).main).some(b => b.key === 'poke:builder'))
})

test('pane: keys are unique in the site, even when one action is drawn twice', () => {
  // the paused task's tab and the notice of its card in another task both open it
  const s = busy({ cards: [card('c9', 't_000000000002', 'builder')], ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000001', channel: null } })
  const l = paneLayout(s, 120, 40)
  const keys = controls([...l.title, ...l.rail, ...l.main]).map(b => b.key)
  assert.equal(new Set(keys).size, keys.length, keys.join(' '))
  assert.ok(keys.includes('task:t_000000000002') && keys.includes('task:t_000000000002~2'), keys.join(' '))
  for (const [name, make] of Object.entries(STATES)) {
    for (const view of VIEWS) {
      const p = paneLayout(withView(make(), view), 100, 40)
      const k = controls([...p.title, ...p.rail, ...p.main]).map(b => b.key)
      assert.equal(new Set(k).size, k.length, `${name}/${view}`)
      assert.ok(k.every(x => x.length <= 64 && decodeAction(x) !== null), `${name}/${view}`)
    }
  }
})

test('pane: a click-only card never takes `a`, and says how to allow it', () => {
  const s = busy({ cards: [card('c1', 't_000000000001', 'builder', { isClickOnly: true })] })
  const l = paneLayout(s, 120, 40)
  const allow = controls(l.main).find(b => b.key === 'allow:c1')
  assert.ok(allow && allow.hotkey === undefined)
  assert.equal(controls(l.main).find(b => b.key === 'deny:c1')?.hotkey, 'd')
  assert.ok(l.main.some(r => rowText(r).includes('No one-key allow here')))
})

test('pane: numbers sit in fixed columns, so ≈$0.21 and ≈$1,234.56 end at the same cell', () => {
  const at = (cost: number): number => {
    const s = busy({ tasks: [task('t_000000000001', 'builder', 'running', { costUsd: cost })] })
    const header = paneLayout(s, 120, 40).main.find(r => rowText(r).includes('turns')) as Row
    const text = rowText(header)
    return cellWidth(text.slice(0, text.indexOf(' · 9 turns')))
  }
  assert.equal(at(0.21), at(1234.56))
})

test('pane: empty states say one plain thing and one hint', () => {
  const empty = paneLayout(base(), 80, 40).main.map(rowText).join('\n')
  assert.match(empty, /New task for Builder/)
  assert.match(empty, /\/to builder <what to do>/)
  assert.match(paneLayout(base({ agents: [] }), 80, 40).main.map(rowText).join('\n'), /The order has not mustered yet\./)
  assert.match(paneLayout(withView(base(), 'order'), 80, 40).main.map(rowText).join('\n'), /Tasks show up here as agents work\./)
})

test('pane: a long thread keeps its newest rows and says how many earlier ones it left out', () => {
  const thread = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, role: 'user' as const, text: `message ${i}`, at: i }))
  const l = paneLayout(busy({ thread, live: '', cards: [] }), 100, 30)
  const text = l.main.map(rowText).join('\n')
  assert.match(text, /↑ \d+ earlier rows/)
  assert.match(text, /message 79/)
  assert.doesNotMatch(text, /message 0\b/)
  assert.ok(l.main.length + l.title.length <= 30, String(l.main.length))
})

test('pane: failure and pause say what happened and the next step', () => {
  const err = paneLayout(STATES.error!(), 100, 40).main.map(rowText).join('\n')
  assert.match(err, /Run failed/)
  assert.match(err, /The model refused the request\./)
  assert.match(err, /\/say/)
  const paused = paneLayout(STATES.paused!(), 100, 40).main.map(rowText).join('\n')
  assert.match(paused, /Paused at the turn limit/)
  assert.match(paused, /c: Continue/)
})

test('band: nothing when nothing waits; at most 3 rows then "+N more"; exact widths', () => {
  assert.deepEqual(bandRows(base(), 80, 10), [])
  for (const w of WIDTHS) {
    const rows = bandRows(long(), w, 10)
    assert.equal(rows.length, 3, String(w))
    assert.match(rowText(rows[2] as Row), /\+124 more · \/legion to open/) // 120 cards + 6 items, 2 shown
    for (const r of rows) assert.equal(rowWidth(r), w, `${w}: "${rowText(r)}"`)
  }
  assert.equal(bandRows(long(), 80, 2).length, 2)
  assert.equal(bandRows(long(), 80, 0).length, 0)
})

test('band: letters only, each once; a click-only first card takes no `a`', () => {
  const s = busy({ band: [{ id: 'b1', kind: 'paused', taskId: 't_000000000002', agentId: 'builder', text: 'Paused at the turn limit', at: 1 }] })
  const keys = controls(bandRows(s, 100, 10)).flatMap(b => (b.hotkey ? [b.hotkey] : []))
  assert.deepEqual(keys, ['a', 'd', 'c', 'x'])
  assert.ok(keys.every(k => /^[a-z]$/.test(k)))
  const many = controls(bandRows(long(), 100, 10)).flatMap(b => (b.hotkey ? [b.hotkey] : []))
  assert.equal(new Set(many).size, many.length, many.join(','))
  const click = busy({ cards: [card('c1', 't_000000000001', 'builder', { isClickOnly: true })] })
  const allow = controls(bandRows(click, 100, 10)).find(b => b.key === 'allow:c1')
  assert.ok(allow && allow.hotkey === undefined)
})

test('band: the open channel leads, in plain words', () => {
  const rows = bandRows(base({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } }), 80, 10)
  assert.match(rowText(rows[0] as Row), /^ Speaking to ✠ Zealot · \/legion talk off/)
})

test('band: controls carry the right actions', () => {
  const s = busy({ band: [{ id: 'b1', kind: 'done', taskId: 't_000000000004', agentId: 'scribe', text: 'Finished', at: 1 }] })
  assert.deepEqual(controls(bandRows(s, 120, 10)).map(b => b.key), ['allow:c1', 'deny:c1', 'task:t_000000000004', 'dismiss:b1'])
})

test('dispatch: frozen one-line summary when done; live card while running; nothing without a task id', () => {
  const done = busy({ tasks: [task('t_000000000009', 'builder', 'done')] })
  const rows = dispatchRows(done, 'Sent to ⌘ Builder · task t_000000000009', 80) as Row[]
  assert.equal(rows.length, 1)
  assert.equal(rowText(rows[0] as Row).trimEnd(), '⌘ Builder · done · 9 turns · ≈$0.21')
  assert.equal(dispatchRows(done, 'no id here', 80), undefined)
  assert.equal(dispatchRows(done, 'task t_00000000000f', 80), undefined) // not in state
  const live = dispatchRows(busy(), 'task t_000000000001', 80) as Row[]
  assert.ok(live.length >= 3)
  assert.match(rowText(live[0] as Row), /⌘ Builder · Executing · 9 turns · ≈\$0\.21/)
  assert.ok(controls(live).every(b => b.hotkey === undefined))
  for (const w of WIDTHS) for (const r of dispatchRows(long(), 'task t_000000000000', w) ?? []) if (r.t === 'line') assert.equal(rowWidth(r), w)
  const paused = dispatchRows(busy(), 'task t_000000000002', 80) as Row[]
  assert.match(rowText(paused[0] as Row), /paused at the turn limit · 9 turns · ≈\$0\.21 · \/continue/)
})

test('rail: every roster name whole from 100 columns; the mark says cards, then running', () => {
  for (const w of [100, 120, 200]) {
    const text = paneLayout(busy(), w, 40).rail.map(rowText)
    for (const name of ['Zealot', 'Builder', 'Inquisitor', 'Forgemaster', 'Preceptor', 'Sculptor']) assert.ok(text.some(t => t.includes(` ${name} `)), `${w}: ${name}`)
    assert.match(text.find(t => t.includes('Builder')) ?? '', /Builder +!1│$/)
  }
  assert.match(paneLayout(long(), 100, 40).rail.map(rowText).find(t => t.includes('Builder')) ?? '', /!\+│$/)
  assert.match(paneLayout(long(), 100, 40).rail.map(rowText).find(t => t.includes('Forgemaster')) ?? '', / ●│$/)
})
