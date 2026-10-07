/**
 * The views as rows, against claude/tui-information-design.md (R1–R11, the key map, journeys C1–C6) and the review's
 * bugs (claude/review-tui-agate.md). Every spec here has a recorded negative (a scratch mutation that makes it fail).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bandRows } from '../../../src/ui/band.ts'
import { dispatchRows } from '../../../src/ui/dispatch.ts'
import { controls, rowText, rowWidth, type Row } from '../../../src/ui/model.ts'
import { cellWidth } from '../../../src/ui/text.ts'
import { paneLayout, type PaneLayout } from '../../../src/ui/views/pane.ts'
import { THREAD_MAX } from '../../../src/ui/views/chat.ts'
import { agentWord, drawnCost } from '../../../src/ui/views/order.ts'
import type { Snapshot } from '../../../src/ui/views/common.ts'
import { decodeAction } from '../../../src/ui/actions.ts'
import { counts, NEVER } from '../../../src/ui/words.ts'
import { base, busy, card, DOCTOR, fleet, fleetLive, long, sentTo, task, wireBand, WIDTHS } from './fixtures.ts'

const NL = '\n'
const chatAt = (agentId: string, taskId: string | null, more: Partial<Snapshot> = {}): Partial<Snapshot> => ({ ui: { view: 'chat', agentId, taskId, channel: null }, ...more })

/** Every state each view must hold (design doc "How to check it"; plan §6 "Real conditions"). */
const STATES: Record<string, () => Snapshot> = {
  'first open': () => base(),
  'agent with no task': () => base({ tasks: [task('t_000000000077', 'scout', 'done')] }),
  'no agents': () => base({ agents: [] }),
  'needs your OK': () => busy({ live: '' }),
  'watching a request': () => fleetLive(),
  long: () => long(),
  failed: () => busy(chatAt('scout', 't_000000000003', { thread: [], live: '' })),
  paused: () => fleet(chatAt('herald', 't_0000000000b1', { thread: [] })),
  done: () => fleet(chatAt('archivist', 't_0000000000b0', { thread: [] })),
  'other window': () => busy({ sessionId: 'me', live: '' }),
  'channel open': () => busy({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } }),
  'steps open': () => busy({ live: '', ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000001', channel: null, stepsOpen: 't_000000000001' } as Snapshot['ui'] }),
}

const VIEWS = ['chat', 'order', 'keys'] as const
const withView = (s: Snapshot, view: (typeof VIEWS)[number]): Snapshot =>
  view === 'keys' ? { ...s, ui: { ...s.ui, keysOpen: true } as Snapshot['ui'] } : { ...s, ui: { ...s.ui, view } }

const allRows = (l: PaneLayout): Row[] => [...l.title, ...l.rail, ...l.main]
const texts = (rows: readonly Row[]): string[] => rows.map(rowText)
const keysOf = (rows: readonly Row[]): string[] => controls(rows).flatMap(b => (b.hotkey ? [b.hotkey] : [])).sort()

test('pane: every line row is exactly its column wide, at every width, in every state and view', () => {
  for (const [name, make] of Object.entries(STATES)) {
    for (const view of VIEWS) {
      for (const w of WIDTHS) {
        const l = paneLayout(withView(make(), view), w, 40)
        const main = Math.min(w - l.railWidth, view === 'chat' ? THREAD_MAX : Infinity)
        for (const r of l.title) if (r.t === 'line') assert.equal(rowWidth(r), w, `${name}/${view}/${w}/title: "${rowText(r)}"`)
        for (const r of l.rail) if (r.t === 'line') assert.equal(rowWidth(r), l.railWidth, `${name}/${view}/${w}/rail: "${rowText(r)}"`)
        for (const r of l.main) if (r.t === 'line') assert.equal(rowWidth(r), main, `${name}/${view}/${w}/main: "${rowText(r)}"`)
      }
    }
  }
})

test('R7: no rail and no glyph strip below 72 (the header names the agent); glyph and name only at 72-99; marks from 100', () => {
  for (const w of WIDTHS) {
    const l = paneLayout(busy(), w, 40)
    if (w < 72) {
      assert.equal(l.railWidth, 0, String(w))
      assert.match(rowText(l.main[0] as Row), /^ ⌘ Builder +$/, `${w}: the header names the shown agent`)
      assert.ok(!texts(l.main).some(t => /◎ ⌕ ✎/.test(t)), `${w}: no strip of glyphs`)
    } else {
      const rail = texts(l.rail)
      assert.ok(rail.some(t => /⌘ Builder /.test(t)), String(w))
      if (w < 100) assert.ok(rail.every(t => !/!1|●/.test(t)), `${w}: no marks at 72-99`)
      else assert.match(rail.find(t => t.includes('Builder')) ?? '', /Builder +!1│$/, `${w}: the mark from 100`)
    }
  }
})

test('R4: agents with nothing in play share one dim line of glyphs in the rail; every name in play is whole from 72', () => {
  for (const w of [72, 80, 100, 120, 200]) {
    const rail = texts(paneLayout(fleetLive(), w, 40).rail)
    for (const name of ['Zealot', 'Builder', 'Inquisitor', 'Scribe', 'Herald']) assert.ok(rail.some(t => t.includes(` ${name} `)), `${w}: ${name}`)
    assert.ok(!rail.some(t => /Archivist|Forgemaster|Preceptor/.test(t)), `${w}: resting agents have no row of their own`)
    assert.ok(rail.some(t => /^ ◎ ▤ ◬ ⌶ ☾ ⊥ +│$/.test(t)), `${w}: ${rail.join(' | ')}`)
  }
})

test('R6 and bug 3: the tabs read 1 Chat 2 Order and never run together; the needs-you count leaves last, as !1 below 64', () => {
  for (const w of WIDTHS) {
    for (const make of [busy, fleetLive, long]) {
      const t = rowText(paneLayout(make(), w, 40).title[0] as Row)
      assert.match(t, /^ ✠ LEGION   1: Chat  2: Order /, `${w}: "${t}"`)
    }
    const t = rowText(paneLayout(busy(), w, 40).title[0] as Row)
    // the words while they fit (56 cells and up here), else !1; never gone
    if (w >= 56) assert.match(t, /1 needs your OK( ·| $)/, `${w}: "${t}"`)
    else assert.match(t, /!1 $/, `${w}: "${t}"`)
  }
  const wide = rowText(paneLayout(fleetLive(), 120, 40).title[0] as Row)
  assert.match(wide, /3 working · 1 paused · 1 queued $/)
})

test('R1: the title row\'s counts are the one count function\'s, and Order adds none of its own', () => {
  for (const make of [busy, fleetLive, long]) {
    const s = make()
    const c = counts(s.tasks, s.cards)
    const t = rowText(paneLayout(s, 200, 40).title[0] as Row)
    if (c.working) assert.match(t, new RegExp(`\\b${c.working} working`))
    if (c.paused) assert.match(t, new RegExp(`\\b${c.paused} paused`))
    const order = texts(paneLayout(withView(s, 'order'), 200, 60).main).join(NL)
    assert.doesNotMatch(order, /\d+ (working|paused|queued)\b/, 'Order repeats no count')
  }
})

test('R5: keys are unique per site, come from the key map, and are the likely ones for the state', () => {
  for (const [name, make] of Object.entries(STATES)) {
    for (const view of VIEWS) {
      const keys = keysOf(allRows(paneLayout(withView(make(), view), 100, 40)))
      assert.equal(new Set(keys).size, keys.length, `${name}/${view}: ${keys.join(',')}`)
      assert.ok(keys.every(k => ['1', '2', 'c', 's', 'n', 'k'].includes(k)), `${name}/${view}: ${keys.join(',')}`)
    }
  }
  assert.deepEqual(keysOf(allRows(paneLayout(busy(), 100, 40))), ['2', 'k', 's'])
  assert.deepEqual(keysOf(allRows(paneLayout(STATES.paused!(), 100, 40))), ['2', 'c', 'k'])
  assert.deepEqual(keysOf(allRows(paneLayout(STATES.done!(), 100, 40))), ['2', 'k', 'n'])
  assert.deepEqual(keysOf(allRows(paneLayout(STATES['first open']!(), 100, 40))), ['2', 'k'])
  assert.deepEqual(keysOf(allRows(paneLayout(withView(busy(), 'order'), 100, 40))), ['1'])
  assert.deepEqual(keysOf(allRows(paneLayout(withView(busy(), 'keys'), 100, 40))), ['2', 'k'])
})

test('R5: the footer holds at most three keys and k, on one line, last', () => {
  for (const [name, make] of Object.entries(STATES)) {
    const main = paneLayout(make(), 80, 40).main
    const footer = main.filter(r => controls([r]).some(b => b.hotkey === 'k'))
    if (footer.length === 0) continue
    assert.equal(footer.length, 1, name)
    assert.ok(keysOf(footer).length <= 4, name)
    assert.equal(main.lastIndexOf(footer[0] as Row), main.length - 1, `${name}: the footer is the last line`)
  }
})

test('actions: every control carries its action in its key, and every key decodes to it', () => {
  for (const [name, make] of Object.entries(STATES)) {
    for (const view of VIEWS) {
      for (const b of controls(allRows(paneLayout(withView(make(), view), 100, 40)))) {
        const { index: _i, ...want } = b.action as typeof b.action & { index?: number }
        assert.deepEqual(decodeAction(b.key), want, `${name}/${view}: ${b.key}`)
        assert.ok(b.key.length <= 64)
      }
    }
  }
})

test('R1: one place per fact: a task title, a count and a call that needs your OK each appear once per view', () => {
  const facts = (s: Snapshot): string[] => [
    ...s.tasks.map(t => t.title.slice(0, 12)).filter(t => t.length >= 12),
    ...s.cards.map(c => c.summary.slice(0, 18)),
    ...['working', 'paused', 'queued', 'needs your OK', 'need your OK'].map(w => ` ${w}`),
  ]
  for (const [name, make] of Object.entries(STATES)) {
    if (name === 'long') continue // its 30 tasks share a 40-character title on purpose
    for (const view of ['chat', 'order'] as const) {
      for (const w of [60, 80, 120]) {
        const s = withView(make(), view)
        const text = texts(allRows(paneLayout(s, w, 60))).join(NL)
        for (const f of new Set(facts(s))) {
          const n = text.split(f).length - 1
          if (f.startsWith(' ')) assert.ok(text.split(NL).filter(l => new RegExp(`\\d+${f}\\b`).test(l)).length <= 1, `${name}/${view}/${w}: count "${f}" twice`)
          else assert.ok(n <= 1, `${name}/${view}/${w}: "${f}" appears ${n} times`)
        }
      }
    }
  }
})

test('R11: no word from the glossary\'s "Never" column in any drawn text (mood words only in Order\'s agent list)', () => {
  const drawn = (rows: readonly Row[], view: string): string[] => {
    const lines = texts(rows)
    if (view !== 'order') return lines
    // Order's agent list: from "Agents" to the next blank line; character (mood words) belongs there (R2)
    const at = lines.findIndex(l => l.startsWith(' Agents'))
    const end = lines.findIndex((l, i) => i > at && l.trim() === '')
    return lines.filter((_, i) => at < 0 || i <= at || i >= end)
  }
  const surfaces: Array<[string, string[]]> = []
  for (const [name, make] of Object.entries(STATES)) {
    for (const view of VIEWS) for (const w of [56, 80, 120]) surfaces.push([`${name}/${view}/${w}`, drawn(allRows(paneLayout(withView(make(), view), w, 60)), view)])
    surfaces.push([`${name}/band`, texts(bandRows(make(), 100, 10))])
  }
  for (const id of ['t_000000000001', 't_000000000002', 't_000000000003', 't_000000000004']) surfaces.push([`dispatch ${id}`, texts(dispatchRows(busy(), sentTo('⌘ Builder', id), 100) ?? [])])
  surfaces.push(['band wire', texts(bandRows(busy({ band: [wireBand('paused', 't_000000000002', 'builder', 'tests'), wireBand('error', 't_000000000003', 'scout', 'find the leak')] }), 100, 10))])
  for (const [where, lines] of surfaces) {
    for (const l of lines) for (const n of NEVER) assert.ok(!n.re.test(l), `${where}: "${n.word}" in "${l.trim()}"`)
  }
})

test('cards: directly under the title, read who → what → consequence → where, no buttons, the waiting tool line not repeated', () => {
  const s = busy({ live: '', cards: [card('c1', 't_000000000001', 'builder', { origin: 'Asked by ✠ Zealot through the agent bridge, hop 1' })] })
  for (const w of [80, 100, 120]) {
    const main = texts(paneLayout(s, w, 60).main)
    const title = main.findIndex(t => t.includes('Pin the clock in the replay test.'))
    assert.match(main[title + 1] ?? '', /^ !   ⌘ Builder needs your OK to run a command/, `${w}`)
    assert.match(main[title + 2] ?? '', /^ {7}npm test -- replay/)
    assert.match(main[title + 3] ?? '', /It runs on your computer, with your access\./)
    assert.match(main[title + 4] ?? '', /Asked by ✠ Zealot/)
    assert.match(main[title + 5] ?? '', /^ {7}Answer in the permission dialog\./)
    assert.equal(main.join(NL).split('npm test -- replay').length - 1, 1, `${w}: the call is said once`)
    assert.ok(!controls(paneLayout(s, w, 60).main).some(b => b.action.kind === 'card-allow' || b.action.kind === 'card-deny'))
  }
  // narrow: the head is said whole or short, never cut mid-word (polish 8)
  assert.match(texts(paneLayout(s, 40, 60).main).join(NL), / !   ⌘ Builder needs your OK +\n/)
})

test('cards: a flood shows the first in full and counts the rest (polish 15)', () => {
  const main = texts(paneLayout(long(), 100, 60).main)
  assert.equal(main.filter(t => /needs your OK to run a command/.test(t)).length, 1)
  assert.ok(main.some(t => /! 99\+ more need your OK · 2: Order/.test(t)))
})

test('C5: another window\'s task is read-only: no stop or continue, and its card points to that window', () => {
  const other = paneLayout(busy({ sessionId: 'me', live: '' }), 100, 60)
  const text = texts(other.main).join(NL)
  assert.match(text, /in another window · continue or stop it there/)
  assert.match(text, /Answer in the window that runs this task\./)
  assert.ok(!controls(other.main).some(b => b.action.kind === 'stop' || b.action.kind === 'continue'))
  const paused = paneLayout(busy({ sessionId: 'me', ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000002', channel: null }, live: '' }), 100, 60)
  assert.ok(!controls(paused.main).some(b => b.action.kind === 'continue'))
  for (const mine of [busy({ sessionId: 's1' }), busy()]) assert.ok(controls(paneLayout(mine, 100, 60).main).some(b => b.key === 'stop:t_000000000001'))
})

test('first open: two sentences and one command, on a line of its own; no tabs before there is a task', () => {
  for (const w of WIDTHS) {
    const main = texts(paneLayout(STATES['first open']!(), w, 40).main)
    const text = main.join(' ').replace(/ +/g, ' ')
    assert.match(text, /Your Order is ready: 11 agents\./)
    assert.match(text, /Tell Zealot what you want\. It splits the work and hands it out\./)
    assert.ok(main.some(r => /^ +\/to zealot <what you want done> *$/.test(r)), `${w}`)
    assert.ok(main.some(r => /k: keys $/.test(r)), `${w}: the key to everything else`)
  }
  assert.match(texts(paneLayout(base({ agents: [] }), 80, 40).main).join(NL), /The Order has not mustered yet\./)
})

test('R8: finished tool lines fold into "N steps" (enter opens them); hand-offs are the tree\'s, never the thread\'s', () => {
  const closed = paneLayout(busy({ live: '' }), 100, 60)
  const steps = controls(closed.main).find(b => b.action.kind === 'steps')
  assert.equal(steps?.label, '2 steps')
  assert.equal(steps?.key, 'steps:t_000000000001')
  assert.ok(!texts(closed.main).some(t => /▸ (Read|Edit)/.test(t)))
  const open = paneLayout(STATES['steps open']!(), 100, 60)
  assert.equal(controls(open.main).find(b => b.action.kind === 'steps')?.key, 'steps:close')
  assert.ok(texts(open.main).some(t => /▸ Edit  test\/replay\.test\.ts/.test(t)))
  const zealot = texts(paneLayout(fleetLive(), 100, 60).main).join(NL)
  assert.doesNotMatch(zealot, /Tell Builder|Told/)
  assert.match(zealot, /2 steps/)
})

test('tabs: only when the agent has more than one task, the shown one first in room', () => {
  assert.ok(!texts(paneLayout(fleet(chatAt('zealot', 't_0000000000a0')), 100, 40).main).some(t => /Ship the replay fix  /.test(t) && /●/.test(t)))
  const two = texts(paneLayout(busy(), 100, 40).main)
  assert.match(two[0] ?? '', /● fix the flaky replay {2}‖ tests/)
})

test('a long thread keeps its newest lines and says how many earlier ones it left out', () => {
  const thread = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, role: 'user' as const, text: `message ${i}`, at: i }))
  const l = paneLayout(busy({ thread, live: '', cards: [] }), 100, 30)
  const text = texts(l.main).join(NL)
  assert.match(text, /↑ \d+ earlier lines/)
  assert.match(text, /message 79/)
  assert.doesNotMatch(text, /message 1\b/)
  assert.ok(l.main.length + l.title.length <= 30, String(l.main.length))
})

test('footers: paused keeps its one-key continue at every width; failed says why and what next; done says when', () => {
  for (const w of WIDTHS) {
    const l = paneLayout(STATES.paused!(), w, 40)
    assert.equal(controls(l.main).find(b => b.key === 'continue:t_0000000000b1')?.hotkey, 'c', `${w}`)
    assert.match(texts(l.main).join(NL), /‖ Paused( 1d ago)?( at the turn limit)?/)
  }
  const failed = texts(paneLayout(STATES.failed!(), 80, 40).main).join(NL)
  assert.match(failed, /✕ Failed: The model declined to answer\./)
  assert.match(failed, /\/say to try again/)
  assert.doesNotMatch(texts(paneLayout(STATES.paused!(), 80, 40).main).join(NL), /\(50 turns\)/)
  assert.match(texts(paneLayout(STATES.done!(), 80, 40).main).join(NL), /· done 1d ago · \/say to follow up/)
})

test('band bug 1: words from the item\'s kind and its task, the agent named once, never the runtime\'s text', () => {
  const s = busy({ cards: [], band: [wireBand('paused', 't_000000000002', 'builder', 'tests', 3), wireBand('error', 't_000000000003', 'scout', 'find the leak', 2), wireBand('done', 't_000000000004', 'scribe', 'docs', 1)] })
  for (const w of WIDTHS) {
    const rows = bandRows(s, w, 10)
    for (const t of texts(rows)) {
      assert.ok((t.match(/⌘|◎|✎/g) ?? []).length <= 1, `${w}: "${t}"`)
      assert.doesNotMatch(t, /paused at the turn limit · paused|· done · done/)
    }
    assert.equal(controls(rows).find(b => b.key === 'continue:t_000000000002')?.hotkey, 'c', `${w}: the continue key stays`)
  }
  const wide = texts(bandRows(s, 100, 10))
  assert.match(wide[0] ?? '', /^ ‖ ⌘ Builder · tests · paused +c: continue  dismiss $/)
  assert.match(wide[1] ?? '', /^ ✕ ◎ Scout · find the leak · failed: The model declined to answer\. +open  dismiss $/)
  assert.match(wide[2] ?? '', /^ · ✎ Scribe · docs · done +open  dismiss $/)
})

test('band: needs your OK reads whole, three rows at most, the channel says Talking to', () => {
  assert.deepEqual(bandRows(base(), 80, 10), [])
  for (const w of WIDTHS) {
    const rows = bandRows(long(), w, 10)
    assert.equal(rows.length, 3, String(w))
    assert.match(rowText(rows[2] as Row), /99\+ more · \/legion to open/)
    for (const r of rows) assert.equal(rowWidth(r), w, `${w}: "${rowText(r)}"`)
    for (const t of texts(rows)) assert.doesNotMatch(t, /needs your OK to [a-z ]*…/, `${w}: a cut head "${t}"`)
    // the call itself always shows: a long head never pushes it off the row
    for (const t of texts(rows).slice(0, 2)) assert.match(t, /needs your OK.* · F/, `${w}: the call is on the row "${t}"`)
  }
  assert.match(rowText(bandRows(busy(), 120, 10)[0] as Row), /⌘ Builder needs your OK to run a command · npm test -- replay +in the dialog $/)
  assert.match(rowText(bandRows(base({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } }), 80, 10)[0] as Row), /^ Talking to ✠ Zealot · \/legion talk off/)
})

test('dispatch: a state mark on every line, cost then turns, the agent once, and a next step that names its task\'s agent', () => {
  const at = (id: string, w = 80): string[] => texts(dispatchRows(busy(), sentTo('⌘ Builder', id), w) ?? [])
  assert.equal(at('t_000000000004')[0]?.trimEnd(), '· ✎ Scribe · done · ≈$0.21 · 9 turns')
  assert.equal(at('t_000000000002', 100)[0]?.trimEnd(), '‖ ⌘ Builder · paused at the turn limit · ≈$0.21 · 9 turns · /legion continue builder')
  // the numbers give way before the reason it paused
  assert.equal(at('t_000000000002')[0]?.trimEnd(), '‖ ⌘ Builder · paused at the turn limit · /legion continue builder')
  assert.equal(at('t_000000000002', 40)[0]?.trimEnd(), '‖ paused · /legion continue builder')
  for (const w of [40, 56]) assert.match(at('t_000000000002', w)[0] ?? '', /\/legion continue builder/, `${w}`)
  const failed = at('t_000000000003')
  assert.match(failed[0] ?? '', /^✕ ◎ Scout · failed · ≈\$0\.21 · 9 turns/)
  assert.match(failed.join(NL), /\/to scout <what to do> to try again/)
  const live = at('t_000000000001')
  assert.match(live[0] ?? '', /^● ⌘ Builder · ≈\$0\.21 · 9 turns/)
  assert.match(live[2] ?? '', /^ {2}! needs your OK · npm test -- replay +in the dialog $/)
  assert.equal(live.join(NL).split('⌘ Builder').length - 1, 1)
  assert.equal(dispatchRows(busy(), 'No agent called that.', 80), undefined)
})

test('Order bug 5: the Working heading sums exactly the lines drawn, and the lines say what each task does now', () => {
  for (const w of WIDTHS) {
    const s = withView(fleetLive(), 'order')
    const rows = texts(paneLayout(s, w, 60).main)
    const head = rows.find(r => r.startsWith(' Working')) ?? ''
    const drawn = s.tasks.filter(t => rows.slice(1, rows.findIndex(r => r.trim() === '')).some(r => r.includes(t.title.slice(0, 10))))
    assert.match(head, new RegExp(`≈\\$${drawnCost(drawn).toFixed(2)} so far $`), `${w}: "${head}"`)
    if (w >= 80) {
      assert.match(rows.join(NL), /Fix the flaky replay test +editing replay\.test\.ts/)
      assert.match(rows.join(NL), /Review Builder's fix +reading replay\.ts/)
      assert.match(rows.join(NL), /Update the testing docs +queued/)
    }
  }
})

test('Order bug 6: a working agent never reads "Standing vigil"; one whose call needs your OK is "Awaiting your word"', () => {
  const s = busy({ moods: { builder: { mood: 'idle', since: 0 } } })
  assert.equal(agentWord(s, 'builder'), 'Awaiting your word')
  const resting = busy({ cards: [], moods: { builder: { mood: 'sleeping', since: 0 } } })
  assert.notEqual(agentWord(resting, 'builder'), 'Dormant')
  assert.equal(agentWord(fleetLive({ moods: { builder: { mood: 'victory', since: 0 } } }), 'builder'), 'editing replay.test.ts')
  assert.equal(agentWord(fleetLive(), 'builder'), 'Executing')
  assert.equal(agentWord(fleet(), 'scribe'), 'queued')
})

test('Order: the agent list keeps whole names from 56 (polish 13) and the resting agents on one line', () => {
  for (const w of [56, 60, 80]) {
    const rows = texts(paneLayout(withView(long(), 'order'), w, 60).main)
    assert.ok(rows.some(t => / ⌶ Forgemaster /.test(t)), `${w}`)
  }
  const rows = texts(paneLayout(withView(fleetLive(), 'order'), 60, 60).main)
  assert.equal(rows.filter(r => r.includes('Standing vigil')).length, 1)
  assert.match(rows.find(r => r.includes('Standing vigil')) ?? '', /Standing vigil +◎ ▤ ◬ ⌶ ☾ ⊥ *$/)
  assert.match(rows[0] ?? '', /^ Working/)
})

test('Order: the doctor slot lists checks, problems first, detail wrapping under itself; empty is one hint', () => {
  const order = (extra: Partial<Snapshot>, w = 80) => texts(paneLayout(withView(busy(extra), 'order'), w, 60).main)
  assert.ok(order({}).some(t => t.includes('/legion doctor checks what Legion needs.')))
  for (const w of WIDTHS) {
    const rows = order({ doctor: DOCTOR }, w)
    const at = rows.findIndex(t => t.startsWith(' Doctor'))
    assert.match(rows[at] ?? '', /1 to fix $/)
    assert.match(rows[at + 1] ?? '', /^ ✕ Runner +legion-mod-runner/)
    const detailCol = (rows[at + 1] ?? '').indexOf('legion-mod-runner')
    if (w <= 80 && w >= 56) assert.equal((rows[at + 2] ?? '').search(/\S/), detailCol, `${w}: wraps under the detail`)
    assert.ok(rows.some(t => /^ ✓ Claude Code +2\.1\.289/.test(t)))
  }
})

test('journey 2: in Chat, the request is the title with one total, and the pieces hang under it with who, now and cost', () => {
  for (const w of [80, 100, 120]) {
    const main = texts(paneLayout(fleetLive(), w, 60).main)
    const title = main.findIndex(t => t.includes('Ship the replay fix: tests green, docs updated.'))
    assert.match(main[title] ?? '', /≈\$0\.46 $/, `${w}: task and pieces, one total`)
    // the verb whole, with its file where the line has room (R2; never a cut file name)
    assert.match(main[title + 1] ?? '', w >= 100 ? /├ .*Fix the flaky replay test.*editing replay\.test\.ts +≈\$0\.21/ : /├ .*Fix the flaky replay test.*editing +≈\$0\.21/, `${w}`)
    assert.match(main[title + 2] ?? '', /│ └ .*Review Builder's fix.*reading/, `${w}`)
    assert.match(main[title + 4] ?? '', /└ .*Update the testing docs.*queued/, `${w}`)
    assert.doesNotMatch(main.join(NL), /^ you Ship the replay fix/m, 'the opening message is said once')
  }
})

test('journey 2: in Order, the request reads as a tree under the task that started it', () => {
  for (const w of WIDTHS) {
    const rows = texts(paneLayout(withView(fleetLive(), 'order'), w, 60).main)
    const root = rows.findIndex(r => r.includes('Ship the replay fix'))
    assert.match(rows[root + 1] ?? '', /├ .*Fix the/, `${w}`)
    assert.match(rows[root + 2] ?? '', /│ └ .*Review/, `${w}`)
    assert.match(rows[root + 4] ?? '', /└ .*Update the/, `${w}`)
  }
})

test('keys view (k): every key, the commands, one line on what Legion is; k goes back', () => {
  const l = paneLayout(withView(busy(), 'keys'), 80, 40)
  const text = texts(l.main).join(NL)
  for (const k of ['1 2', 'enter', 'c ', 's ', 'n ', 'k ', 'Tab', 'Esc']) assert.ok(text.includes(`   ${k}`), k)
  assert.match(text, /Legion runs your Order of agents inside Claude Code\./)
  assert.match(text, /\/to, \/say, \/legion continue, \/legion stop/)
  assert.equal(controls(l.main).find(b => b.hotkey === 'k')?.key, 'keys:close')
  assert.equal(controls(paneLayout(busy(), 80, 40).main).find(b => b.hotkey === 'k')?.key, 'keys:open')
  assert.ok(cellWidth(text) > 0)
})

test('a working task with no tool of its own, whose agents still work, reads "handed to" them, not "thinking"', async () => {
  const { nowOf } = await import('../../../src/ui/views/common.ts')
  const F = await import('./fixtures.ts')
  const s = F.fleetLive()
  const zealot = s.tasks.find(t => t.id === 't_0000000000a0')!
  // Builder works and Scribe is queued under it; Scout is done
  assert.equal(nowOf(s, zealot, 40), 'handed to ⌘ Builder +1')
  assert.equal(nowOf(s, zealot, 14), 'handed to 2')
  // once its agents stop, it is thinking again
  const quiet = { ...s, tasks: s.tasks.map(t => t.origin.kind === 'bridge' && t.origin.fromTaskId === zealot.id ? { ...t, status: 'done' as const } : t) }
  assert.equal(nowOf(quiet, zealot, 40), 'thinking')
})
