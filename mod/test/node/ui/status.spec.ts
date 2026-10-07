import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusText, STATUS_MAX } from '../../../src/ui/status.ts'
import { cellWidth } from '../../../src/ui/text.ts'
import { base, busy, card, fleetLive, long, task } from './fixtures.ts'

test('status: the shown agent, what its task is doing now, then the counts with what needs your OK first', () => {
  const s = base({
    ui: { view: 'chat', agentId: 'zealot', taskId: null, channel: null },
    tasks: [task('t_000000000001', 'builder', 'running'), task('t_000000000002', 'scout', 'queued')],
    cards: [card('c1', 't_000000000001', 'builder')],
  })
  assert.equal(statusText(s), '✠ Zealot · 1 needs your OK · 1 working')
  // Builder's own task is editing a file (its thread row says so): a verb, never a mood word (R2)
  const builder = fleetLive({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: null } })
  assert.equal(statusText(builder), '⌘ Builder · editing replay.test.ts · 3 working · 1 paused')
})

test('status: quiet when nothing works; no mood words; "needs your OK" is not said twice', () => {
  assert.equal(statusText(base()), '⌘ Builder')
  assert.equal(statusText(base({ moods: { builder: { mood: 'awaiting', since: 0 } } })), '⌘ Builder')
  // Builder's task waits on the person: the count says it, so the verb is left out
  assert.equal(statusText(busy()), '⌘ Builder · 1 needs your OK · 1 working · 1 paused')
})

test('status: an open channel says so and how to close it', () => {
  assert.equal(statusText(base({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } })), 'Talking to ✠ Zealot · /legion talk off')
})

test('status: at most 80 cells; the counts give way before what needs your OK', () => {
  const s = long()
  assert.ok(cellWidth(statusText(s) ?? '') <= STATUS_MAX)
  assert.equal(statusText(s, 40), '⌘ Builder · thinking · 99+ need your OK')
  assert.equal(statusText(s, 36), '⌘ Builder · 99+ need your OK')
  assert.ok(cellWidth(statusText(s, 12) ?? '') <= 12)
})

test('status: no agents clears the line; a hidden selection falls back to the first visible agent', () => {
  assert.equal(statusText(base({ agents: [] })), undefined)
  assert.equal(statusText(base({ ui: { view: 'chat', agentId: 'assayer', taskId: null, channel: null } })), '✠ Zealot')
})
