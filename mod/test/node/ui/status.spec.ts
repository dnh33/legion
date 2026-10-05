import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusText, STATUS_MAX } from '../../../src/ui/status.ts'
import { cellWidth } from '../../../src/ui/text.ts'
import { base, busy, card, long, task } from './fixtures.ts'

test('status: the plan line, in its order', () => {
  const s = base({
    ui: { view: 'chat', agentId: 'zealot', taskId: null, channel: null },
    tasks: [task('t_000000000001', 'builder', 'running'), task('t_000000000002', 'scout', 'queued')],
    cards: [card('c1', 't_000000000001', 'builder')],
  })
  assert.equal(statusText(s), '✠ Zealot · Standing vigil · 2 running · 1 awaiting your word')
})

test('status: quiet when nothing runs; mood words exactly as MOOD_WORDS', () => {
  assert.equal(statusText(base()), '⌘ Builder · Standing vigil')
  assert.equal(statusText(base({ moods: { builder: { mood: 'awaiting', since: 0 } } })), '⌘ Builder · Awaiting your word')
  assert.equal(statusText(busy()), '⌘ Builder · Executing · 1 running · 1 paused · 1 awaiting your word')
})

test('status: an open channel says so and how to close it', () => {
  assert.equal(statusText(base({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } })), 'Speaking to ✠ Zealot · /legion talk off')
})

test('status: at most 80 cells; running gives way before what awaits the person', () => {
  const s = long()
  const text = statusText(s) ?? ''
  assert.ok(cellWidth(text) <= STATUS_MAX)
  assert.equal(statusText(s, 40), '⌘ Builder · 99+ awaiting your word')
  assert.ok(cellWidth(statusText(s, 12) ?? '') <= 12)
})

test('status: no agents clears the line; a hidden selection falls back to the first visible agent', () => {
  assert.equal(statusText(base({ agents: [] })), undefined)
  assert.equal(statusText(base({ ui: { view: 'chat', agentId: 'assayer', taskId: null, channel: null } })), '✠ Zealot · Standing vigil')
})
