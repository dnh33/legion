import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bandItemAt, cardAt, decodeAction, encodeAction, KEY_MAX, type UiAction } from '../../../src/ui/actions.ts'
import { card } from './fixtures.ts'

const ALL: UiAction[] = [
  { kind: 'view', view: 'order' },
  { kind: 'agent', agentId: 'builder' },
  { kind: 'task', taskId: 't_0123456789ab' },
  { kind: 'new', agentId: 'zealot' },
  { kind: 'continue', taskId: 't_0123456789ab' },
  { kind: 'stop', taskId: 't_0123456789ab' },
  { kind: 'poke', agentId: 'scout' },
  { kind: 'card-allow', cardId: 'toolu_01ABCdef', index: 0 },
  { kind: 'card-deny', cardId: 'toolu_01ABCdef', index: 0 },
  { kind: 'band-dismiss', itemId: 'b_1', index: 2 },
  { kind: 'keys', open: true },
  { kind: 'keys', open: false },
  { kind: 'steps', taskId: 't_0123456789ab' },
  { kind: 'steps', taskId: null },
]

const withoutIndex = (a: UiAction): unknown => {
  const { index: _i, ...rest } = a as UiAction & { index?: number }
  return rest
}

test('actions: every action round-trips through its key, in the documented grammar', () => {
  assert.deepEqual(ALL.map(encodeAction), [
    'view:order', 'agent:builder', 'task:t_0123456789ab', 'new:zealot', 'continue:t_0123456789ab', 'stop:t_0123456789ab',
    'poke:scout', 'allow:toolu_01ABCdef', 'deny:toolu_01ABCdef', 'dismiss:b_1',
    'keys:open', 'keys:close', 'steps:t_0123456789ab', 'steps:close',
  ])
  assert.equal(decodeAction('keys:maybe'), null)
  for (const a of ALL) assert.deepEqual(decodeAction(encodeAction(a)), withoutIndex(a), a.kind)
})

test('actions: a key past 64 characters is written as the index, and the index finds the item', () => {
  const long = 'toolu_' + 'x'.repeat(80)
  assert.equal(encodeAction({ kind: 'card-allow', cardId: long, index: 3 }), 'allow#3')
  assert.equal(encodeAction({ kind: 'band-dismiss', itemId: long, index: 1 }), 'dismiss#1')
  assert.deepEqual(decodeAction('deny#3'), { kind: 'card-deny', index: 3 })
  for (const a of ALL) assert.ok(encodeAction(a).length <= KEY_MAX)
  const cards = [card('late', 't', 'a', { at: 9 }), card('early', 't', 'a', { at: 1 })]
  assert.equal(cardAt(cards, 0)?.id, 'early')
  const band = [{ id: 'old', kind: 'done' as const, text: '', at: 1 }, { id: 'new', kind: 'done' as const, text: '', at: 5 }, { id: 'c', kind: 'card' as const, text: '', at: 9 }]
  assert.equal(bandItemAt(band, 0)?.id, 'new')
  assert.equal(bandItemAt(band, 2), undefined)
})

test('actions: a repeat suffix is ignored; keys that are not Legion\'s decode to null', () => {
  assert.deepEqual(decodeAction('task:t_0123456789ab~2'), { kind: 'task', taskId: 't_0123456789ab' })
  for (const k of ['', 'go', 'view:nowhere', 'agent:', 'frob:x', 'poke#2', 'allow#x', 'Allow']) assert.equal(decodeAction(k), null, k)
})
