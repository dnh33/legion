import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canEscalate, escalationText, pickModel } from '../../../src/engine/router.ts'

test('pickModel: router, prefixes, prior opus, and the cap on a bot\'s pick', () => {
  const cases: Array<[Parameters<typeof pickModel>[0], string, string]> = [
    [{ agentModel: 'auto', prompt: 'rename this file' }, 'sonnet', 'rename this file'],
    [{ agentModel: 'auto', prompt: 'refactor this and debug the race condition' }, 'opus', 'refactor this and debug the race condition'],
    [{ agentModel: 'auto', prompt: '/opus rename it' }, 'opus', 'rename it'],
    [{ agentModel: 'sonnet', prompt: '/opus rename it' }, 'opus', 'rename it'], // the person may pick above the setting
    [{ agentModel: 'sonnet', prompt: 'refactor and debug' }, 'sonnet', 'refactor and debug'], // a fixed model is not routed
    [{ agentModel: 'auto', prompt: 'small thing', prior: 'claude-opus-5-5' }, 'opus', 'small thing'], // continuing on opus
    [{ agentModel: 'auto', prompt: 'small thing', prior: 'claude-sonnet-5-5' }, 'sonnet', 'small thing'],
    [{ agentModel: 'auto', prompt: '/model claude-haiku-4-5 hi' }, 'claude-haiku-4-5', 'hi'],
    [{ agentModel: 'sonnet', prompt: 'x', override: 'opus' }, 'sonnet', 'x'], // a bot cannot upgrade a peer
    [{ agentModel: 'sonnet', prompt: 'x', override: 'haiku' }, 'haiku', 'x'], // downgrades pass
    [{ agentModel: 'opus', prompt: 'x', override: 'opus' }, 'opus', 'x'],
    [{ agentModel: 'sonnet', prompt: '/opus x', fromBot: true }, 'sonnet', 'x'], // a bot's prefix is capped too
    [{ agentModel: 'auto', prompt: '/opus x', fromBot: true }, 'sonnet', 'x'], // auto counts as sonnet for the cap
  ]
  for (const [input, model, prompt] of cases) {
    const r = pickModel(input)
    assert.equal(r.model, model, JSON.stringify(input))
    assert.equal(r.prompt, prompt, JSON.stringify(input))
    assert.ok(r.reason.length > 0)
  }
  assert.match(pickModel({ agentModel: 'sonnet', prompt: 'x', override: 'opus' }).reason, /capped at sonnet/)
})

test('canEscalate: one Sonnet-to-Opus retry on a real error, never on the turn limit', () => {
  const t = (o: Partial<{ isEscalated: boolean; agentModel: string; hasOverride: boolean }> = {}) => ({ isEscalated: false, agentModel: 'auto', ...o })
  const cases: Array<[ReturnType<typeof t>, string, Parameters<typeof canEscalate>[2], boolean, string]> = [
    [t(), 'sonnet', { reason: 'error', errorText: 'tool loop failed' }, true, 'plain error on sonnet'],
    [t(), 'sonnet', { reason: 'error' }, true, 'error without text'],
    [t(), 'claude-sonnet-5-5', { reason: 'error' }, true, 'resolved id, router-picked'],
    [t({ agentModel: 'sonnet' }), 'claude-sonnet-5-5', { reason: 'error' }, true, 'resolved id, alias agent'],
    [t({ agentModel: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6', { reason: 'error' }, false, 'agent fixed to a sonnet id'],
    [t(), 'sonnet', { reason: 'answer', isTurnLimit: true }, false, 'turn limit (answer)'],
    [t(), 'sonnet', { reason: 'error', isTurnLimit: true }, false, 'turn limit flagged on an error'],
    [t(), 'sonnet', { reason: 'answer' }, false, 'success'],
    [t(), 'sonnet', { reason: 'aborted' }, false, 'stopped'],
    [t(), 'sonnet', { reason: 'refusal' }, false, 'refusal'],
    [t({ isEscalated: true }), 'sonnet', { reason: 'error' }, false, 'already escalated once'],
    [t(), 'opus', { reason: 'error' }, false, 'already opus'],
    [t(), 'haiku', { reason: 'error' }, false, 'haiku'],
    [t(), 'sonnet', { reason: 'error', errorText: 'API Error: 429 rate limit' }, false, 'rate limit'],
    [t(), 'sonnet', { reason: 'error', errorText: 'Invalid login' }, false, 'auth'],
    [t({ agentModel: 'sonnet', hasOverride: true }), 'sonnet', { reason: 'error' }, false, 'bot override under opus'],
    [t({ agentModel: 'opus', hasOverride: true }), 'sonnet', { reason: 'error' }, true, 'bot override, agent allows opus'],
  ]
  for (const [task, model, end, want, label] of cases) assert.equal(canEscalate(task, model, end), want, label)
})

test('escalationText: desktop wording, error cut at 160 characters', () => {
  assert.equal(escalationText(undefined), 'Escalated to Opus: error_during_execution')
  assert.equal(escalationText('x'.repeat(300)), `Escalated to Opus: error_during_execution: ${'x'.repeat(160)}`)
})
