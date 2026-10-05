import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assistantText, makeTask, newCtx, notificationRunId, parseTo, pushBand, resolveAgent, spawnRequest, titleFrom } from '../../../src/wire/core.ts'
import { seedAgents } from '../../../src/engine/roster.ts'
import { DEFAULT_SETTINGS } from '../../../src/store/stores.ts'
import type { BandItem } from '../../../types/index.d.ts'

const agents = seedAgents()
const builder = agents.find(a => a.id === 'builder')!

test('titleFrom: first non-empty line, at most 80 characters, cut on a word', () => {
  assert.equal(titleFrom('\n\n  Fix the replay test  \nmore'), 'Fix the replay test')
  assert.equal(titleFrom(''), 'Untitled task')
  const long = 'Pin the clock in the replay test so that the score never straddles a rounding boundary again on slow machines'
  const t = titleFrom(long)
  assert.ok(t.length <= 80, `length ${t.length}`)
  assert.ok(t.endsWith('…'))
  assert.ok(!t.slice(0, -1).endsWith(' '), 'no trailing space before the ellipsis')
})

test('spawnRequest: a legion-mod agent type, the task name, the model only when given', () => {
  const task = makeTask({ id: 't_aaaaaaaaaaaa', agentId: 'builder', text: 'Fix it', sessionId: 's1', origin: { kind: 'person' }, now: 5 })
  const r = spawnRequest({ id: 'rq_1', task, agent: builder, prompt: 'Fix it', model: 'sonnet', now: 6 })
  assert.equal(r.agentType, 'legion-mod:builder')
  assert.equal(r.name, 'builder-t_aaaaaaaaaaaa')
  assert.equal(r.model, 'sonnet')
  assert.equal(r.description, 'Builder · Fix it')
  assert.equal('model' in spawnRequest({ id: 'rq_2', task, agent: builder, prompt: 'x', now: 6 }), false)
})

test('makeTask: a queued task with zero counters and the run counter', () => {
  const t = makeTask({ id: 't_bbbbbbbbbbbb', agentId: 'scout', text: 'Read the docs', sessionId: 's1', origin: { kind: 'person' }, now: 9 })
  assert.equal(t.status, 'queued')
  assert.equal(t.turns, 0)
  assert.equal(t.runTurns, 0)
  assert.equal(t.costUsd, 0)
  assert.deepEqual(t.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('notificationRunId: reads <task-id>, tolerates spaces, refuses junk', () => {
  assert.equal(notificationRunId('<task-notification>\n<task-id>a5f9ac7d71531baa3</task-id>'), 'a5f9ac7d71531baa3')
  assert.equal(notificationRunId('<task-id> abc12 </task-id>'), 'abc12')
  assert.equal(notificationRunId('no id here'), null)
  assert.equal(notificationRunId('<task-id>a b</task-id>'), null)
})

test('assistantText: text blocks only, joined; strings pass; anything else is empty', () => {
  assert.equal(assistantText([{ type: 'text', text: 'One' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'Two' }]), 'One\nTwo')
  assert.equal(assistantText('  plain  '), 'plain')
  assert.equal(assistantText([{ type: 'tool_use' }]), '')
  assert.equal(assistantText([{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'Shown' }]), 'Shown', 'only text blocks, even when another block has a text field')
  assert.equal(assistantText(null), '')
})

test('resolveAgent and parseTo: id, name or glyph; hidden agents are not addressable; plain errors', () => {
  assert.equal(resolveAgent('BUILDER', agents)?.id, 'builder')
  assert.equal(resolveAgent('@scout', agents)?.id, 'scout')
  assert.equal(resolveAgent('⌘', agents)?.id, 'builder')
  assert.equal(resolveAgent('assayer', agents), undefined, 'the Assayer is hidden (BSV is left out)')
  const ok = parseTo('builder fix the failing test', agents)
  assert.ok('agent' in ok && ok.agent.id === 'builder' && ok.text === 'fix the failing test')
  const noText = parseTo('builder', agents)
  assert.ok('error' in noText && noText.error.includes('What should Builder do?'))
  const unknown = parseTo('nobody hi', agents)
  assert.ok('error' in unknown && unknown.error.startsWith('No agent called "nobody"'))
  assert.ok('error' in parseTo('   ', agents))
})

test('pushBand: one row per task (a newer row replaces it), cards stay, at most 20', () => {
  const row = (id: string, taskId: string, kind: BandItem['kind'] = 'done'): BandItem => ({ id, kind, taskId, text: id, at: 0 })
  let band: BandItem[] = [row('a', 't1'), row('c', 't1', 'card')]
  band = pushBand(band, row('b', 't1'))
  assert.deepEqual(band.map(b => b.id), ['c', 'b'])
  for (let i = 0; i < 30; i++) band = pushBand(band, row(`x${i}`, `t${i + 2}`))
  assert.equal(band.length, 20)
})

test('newCtx: starts on Zealot in Chat with nothing pending', () => {
  const ctx = newCtx({ ...DEFAULT_SETTINGS })
  assert.deepEqual(ctx.ui, { view: 'chat', agentId: 'zealot', taskId: null, channel: null })
  assert.equal(ctx.pending.size, 0)
  assert.equal(ctx.isReady, false)
})
