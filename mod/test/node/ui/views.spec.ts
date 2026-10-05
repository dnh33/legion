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
import { base, busy, card, DOCTOR, fleet, long, task, WIDTHS } from './fixtures.ts'

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
    if (w >= 72) assert.ok(l.railWidth > 0 && l.rail.length === 11, String(w)) // 13 agents, the Assayer and the Sculptor hidden
    else {
      assert.equal(l.railWidth, 0, String(w))
      const strip = controls([l.main[0] as Row]).map(b => b.label)
      assert.ok(strip.length >= 10 && !strip.includes('⊜') && !strip.includes('◈'), `${w}: ${strip.join(' ')}`)
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
  assert.deepEqual(keysOf(busy()).sort(), ['5', 'n', 's'])
  assert.deepEqual(keysOf(STATES.paused!()).sort(), ['5', 'c', 'n', 'o'])
  assert.deepEqual(keysOf(withView(busy(), 'order')).sort(), ['1'])
})

test('pane: each control carries its action in its key, and every key decodes to it', () => {
  const l = paneLayout(busy(), 120, 40)
  const keys = controls([...l.title, ...l.rail, ...l.main]).map(b => b.key)
  for (const k of ['view:order', 'agent:scout', 'task:t_000000000002', 'new:builder', 'stop:t_000000000001']) assert.ok(keys.includes(k), k)
  for (const b of controls([...l.title, ...l.rail, ...l.main])) {
    const { index: _i, ...want } = b.action as typeof b.action & { index?: number }
    assert.deepEqual(decodeAction(b.key), want, b.key)
  }
  assert.ok(controls(paneLayout(STATES.paused!(), 120, 40).main).some(b => b.key === 'continue:t_000000000002'))
  assert.ok(!controls(paneLayout(withView(busy(), 'order'), 120, 40).main).some(b => b.action.kind === 'poke'), 'no Poke in the summary')
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

test('pane: a card reads who, what, consequence, where to answer, and holds no buttons', () => {
  const s = busy({ cards: [card('c1', 't_000000000001', 'builder', { origin: 'Asked by ✠ Zealot through the agent bridge, hop 1' })] })
  const l = paneLayout(s, 100, 60)
  const text = l.main.map(rowText).join('\n')
  const at = (needle: string): number => text.indexOf(needle)
  assert.ok(at('⌘ Builder asks to run a command') >= 0, text)
  assert.ok(at('⌘ Builder asks to run a command') < at('      npm test -- replay'))
  assert.ok(at('      npm test -- replay') < at('It runs on your computer, with your access.'))
  assert.ok(at('It runs on your computer') < at('Asked by ✠ Zealot'))
  assert.ok(at('Asked by ✠ Zealot') < at('Answer in the permission dialog.'))
  assert.ok(!controls(l.main).some(b => b.action.kind === 'card-allow' || b.action.kind === 'card-deny'))
})

test("pane: another window's task is read-only: no Stop or Continue, its card points to that window", () => {
  const other = busy({ sessionId: 'me', live: '' })
  const l = paneLayout(other, 100, 60)
  const text = l.main.map(rowText).join('\n')
  assert.match(text, /Running in another window/)
  assert.match(text, /Answer it in the window that runs this task\./)
  assert.ok(!controls(l.main).some(b => b.action.kind === 'stop' || b.action.kind === 'continue'))
  const paused = paneLayout(busy({ sessionId: 'me', ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000002', channel: null }, live: '' }), 100, 60)
  assert.match(paused.main.map(rowText).join('\n'), /Paused in another window/)
  assert.ok(!controls(paused.main).some(b => b.action.kind === 'continue'))
  // our own window keeps its controls; an unknown session id counts every task as ours
  for (const mine of [busy({ sessionId: 's1' }), busy()]) assert.ok(controls(paneLayout(mine, 100, 60).main).some(b => b.key === 'stop:t_000000000001'))
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

test('pane: the first open says what this is and the one thing to do; other empty states one line and a hint', () => {
  for (const w of WIDTHS) {
    const first = paneLayout(base({ ui: { view: 'chat', agentId: 'zealot', taskId: null, channel: null } }), w, 40).main.map(rowText)
    const text = first.join(' ').replace(/ +/g, ' ')
    assert.match(text, /Your Order: 11 agents, ready\./)
    assert.match(text, /Zealot leads: it splits your request into tasks/)
    assert.ok(first.some(r => /^ +\/to zealot <what you want done> *$/.test(r)), `${w}: the command on a line of its own`)
    assert.doesNotMatch(text, /n: New task/, `${w}: no tabs before there is a task`)
  }
  const agentEmpty = paneLayout(base({ tasks: [task('t_000000000077', 'scout', 'done')] }), 80, 40).main.map(rowText).join('\n')
  assert.match(agentEmpty, /New task for Builder/)
  assert.match(agentEmpty, /\/to builder <what to do>/)
  assert.match(paneLayout(base({ agents: [] }), 80, 40).main.map(rowText).join('\n'), /The order has not mustered yet\./)
  assert.match(paneLayout(withView(base(), 'order'), 80, 40).main.map(rowText).join('\n'), /Finished tasks stay here to pick up again\./)
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
  assert.match(paused, /Paused .*at the turn limit/)
  assert.doesNotMatch(paused, /\(50 turns\)/, 'the runtime line that repeats the state is not drawn again')
  assert.match(rowText(paneLayout(busy(), 100, 40).title[0] as Row), /1 running · 1 paused · 1 needs your OK $/)
  assert.match(rowText(paneLayout(long(), 120, 40).title[0] as Row), /99\+ need your OK $/)
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

test('band: letters only, each once; card rows hold no controls and point to the dialog', () => {
  const s = busy({ band: [{ id: 'b1', kind: 'paused', taskId: 't_000000000002', agentId: 'builder', text: 'Paused at the turn limit', at: 1 }] })
  const rows = bandRows(s, 100, 10)
  const keys = controls(rows).flatMap(b => (b.hotkey ? [b.hotkey] : []))
  assert.deepEqual(keys, ['c', 'x'])
  assert.match(rowText(rows[0] as Row), /⌘ Builder asks to run a command +npm test -- replay +answer in the dialog $/)
  const many = controls(bandRows(long(), 100, 10)).flatMap(b => (b.hotkey ? [b.hotkey] : []))
  assert.equal(new Set(many).size, many.length, many.join(','))
  const other = bandRows(busy({ sessionId: 'me', band: [{ id: 'b1', kind: 'paused', taskId: 't_000000000002', agentId: 'builder', text: 'Paused', at: 1 }] }), 100, 10)
  assert.match(rowText(other[0] as Row), /answer in its window $/)
  assert.ok(!controls(other).some(b => b.action.kind === 'continue'))
})

test('band: the open channel leads, in plain words', () => {
  const rows = bandRows(base({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } }), 80, 10)
  assert.match(rowText(rows[0] as Row), /^ Speaking to ✠ Zealot · \/legion talk off/)
})

test('band: controls carry the right actions', () => {
  const s = busy({ band: [{ id: 'b1', kind: 'done', taskId: 't_000000000004', agentId: 'scribe', text: 'Finished', at: 1 }] })
  assert.deepEqual(controls(bandRows(s, 120, 10)).map(b => b.key), ['task:t_000000000004', 'dismiss:b1'])
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
  for (const w of [40, 60]) assert.match(rowText((dispatchRows(busy(), 'task t_000000000002', w) as Row[])[0] as Row), /· \/continue/, `${w}: the next step stays`)
})

test('rail: every roster name whole from 72 columns; the mark says cards, then running', () => {
  for (const w of [72, 80, 100, 120, 200]) {
    const text = paneLayout(busy(), w, 40).rail.map(rowText)
    for (const name of ['Zealot', 'Builder', 'Inquisitor', 'Archivist', 'Forgemaster', 'Preceptor', 'Herald']) assert.ok(text.some(t => t.includes(` ${name} `)), `${w}: ${name}`)
    assert.match(text.find(t => t.includes('Builder')) ?? '', /Builder +!1│$/)
  }
  assert.match(paneLayout(long(), 100, 40).rail.map(rowText).find(t => t.includes('Builder')) ?? '', /!\+│$/)
  assert.match(paneLayout(long(), 100, 40).rail.map(rowText).find(t => t.includes('Forgemaster')) ?? '', / ●│$/)
})

test('order: the doctor slot lists checks, problems first, detail wrapping under itself; empty is one hint', () => {
  const order = (extra: Partial<Snapshot>, w = 80) => paneLayout(withView(busy(extra), 'order'), w, 60).main.map(rowText)
  const empty = order({})
  assert.ok(empty.some(t => t.includes('/legion doctor checks what Legion needs.')))
  for (const w of WIDTHS) {
    const rows = order({ doctor: DOCTOR }, w)
    const at = rows.findIndex(t => t.startsWith(' Doctor'))
    assert.match(rows[at] ?? '', /1 to fix $/)
    assert.match(rows[at + 1] ?? '', /^ ✕ Runner +legion-mod-runner/)
    const detailCol = (rows[at + 1] ?? '').indexOf('legion-mod-runner')
    if (w <= 80) assert.equal((rows[at + 2] ?? '').search(/\S/), detailCol, `${w}: wraps under the detail`)
    assert.ok(rows.some(t => /^ ✓ Claude Code +2\.1\.289/.test(t)))
    assert.ok(rows.some(t => /^ · Cost estimates +prices as of/.test(t)))
  }
})

test("order: another window's running task says so", () => {
  const rows = paneLayout(withView(busy({ sessionId: 'me' }), 'order'), 100, 60).main.map(rowText)
  assert.ok(rows.some(t => /fix the flaky replay( · other window| +other window)/.test(t)), rows.join('\n'))
})

test('journey 2: the request reads as a tree in Order, each piece under the task that handed it out', () => {
  for (const w of WIDTHS) {
    const rows = paneLayout(withView(fleet(), 'order'), w, 60).main.map(rowText)
    const at = (needle: string): number => rows.findIndex(r => r.includes(needle))
    const root = at('Ship the replay fix')
    assert.ok(root >= 0, `${w}`)
    assert.match(rows[root + 1] ?? '', /├ Fix the flaky/, `${w}`)
    assert.match(rows[root + 2] ?? '', /│ └ Review/, `${w}`)
    assert.match(rows[root + 3] ?? '', /├ Find where/, `${w}`)
    assert.match(rows[root + 4] ?? '', /└ Update the/, `${w}`)
    // the titles of one depth start in one column, so names and titles line up
    if (w >= 80) assert.equal((rows[root + 1] ?? '').indexOf('├'), (rows[root + 3] ?? '').indexOf('├'))
    if (w >= 100) {
      assert.match(rows[root + 1] ?? '', /Executing/)
      assert.match(rows[root + 4] ?? '', /queued/)
    }
  }
})

test('journey 2: in Chat, the task shows what it handed out, who has each piece, its state and cost', () => {
  for (const w of WIDTHS) {
    const rows = paneLayout(fleet(), w, 60).main.map(rowText)
    const head = rows.findIndex(r => r.includes('Handed out'))
    assert.match(rows[head] ?? '', /Handed out +3 working · 4 in all/, `${w}`)
    assert.match(rows[head + 1] ?? '', /● ⌘ .*├ Fix the flaky.* +≈\$0\.21/, `${w}`)
    assert.ok(rows.some(r => /▸ Told +Builder/.test(r)), `${w}: the bridge chip says what happened`)
  }
  const pieces = controls(paneLayout(fleet(), 100, 60).main).map(b => b.key)
  for (const id of ['a1', 'a2', 'a3', 'a4']) assert.ok(pieces.includes(`task:t_0000000000${id}`), id)
})

test('journey 4: coming back, a paused task says when and keeps its one-key Continue; a done one says how to follow up', () => {
  const paused = paneLayout(fleet({ ui: { view: 'chat', agentId: 'herald', taskId: 't_0000000000b1', channel: null }, thread: [] }), 80, 40)
  assert.ok(paused.main.some(r => /‖ Paused 1d ago at the turn limit/.test(rowText(r))))
  assert.equal(controls(paused.main).find(b => b.key === 'continue:t_0000000000b1')?.hotkey, 'c')
  const done = paneLayout(fleet({ ui: { view: 'chat', agentId: 'archivist', taskId: 't_0000000000b0', channel: null }, thread: [] }), 80, 40).main.map(rowText).join(' ')
  assert.match(done, /· Done 1d ago · \/say to follow up here/)
  assert.doesNotMatch(done, /No messages yet/)
  const order = paneLayout(withView(fleet(), 'order'), 80, 60).main.map(rowText)
  assert.ok(order.some(r => /▤ Archivist +Tidy the Library inbox +≈\$0\.31 +1d $/.test(r)), order.join(' | '))
})

test('journey 5: on a small pane Running comes first in Order, and idle agents take one line', () => {
  const rows = paneLayout(withView(fleet(), 'order'), 60, 60).main.map(rowText)
  assert.match(rows[0] ?? '', /^ Running/)
  assert.ok(rows.findIndex(r => r.startsWith(' Running')) < rows.findIndex(r => r.startsWith(' Agents')))
  assert.equal(rows.filter(r => r.includes('Standing vigil')).length, 1)
  assert.match(rows.find(r => r.includes('Standing vigil')) ?? '', /Standing vigil +◎ ▤ ◬ ⌶ ☾ ⊥ ⚑ *$/)
})

test('order: the Running heading counts and costs the same set, the work still running or paused', () => {
  const head = (w: number) => paneLayout(withView(fleet(), 'order'), w, 60).main.map(rowText).find(r => r.startsWith(' Running')) ?? ''
  // live: Zealot 0.12, Builder 0.21, Inquisitor 0.08, Scribe 0.00, Herald 1.02 (paused) = 1.43; Scout's done 0.05 is not added
  for (const w of WIDTHS) assert.match(head(w), /^ Running +5 +≈\$1\.43 running $/, `${w}`)
})

test('journey 3: on a short line the paused footer keeps its one-key Continue and drops the reassurance whole', () => {
  for (const w of WIDTHS) {
    const l = paneLayout(fleet({ ui: { view: 'chat', agentId: 'herald', taskId: 't_0000000000b1', channel: null }, thread: [] }), w, 40)
    assert.equal(controls(l.main).find(b => b.key === 'continue:t_0000000000b1')?.hotkey, 'c', `${w}`)
    const footer = l.main.map(rowText).find(r => r.includes('Paused')) ?? ''
    assert.doesNotMatch(footer, /the work is k[^e]|…/, `${w}: ${footer}`)
  }
})
