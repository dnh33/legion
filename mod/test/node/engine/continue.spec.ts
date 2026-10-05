import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTINUE_PROMPT, TURN_LIMIT_PREFIX, inferTurnLimit, turnLimitRow, turnLimitText } from '../../../src/engine/continue.ts'

// Pinned literally: the desktop's copies live on branch fix/long-task-turn-limit (src/shared/continue.ts), not in this worktree.
test('the turn-limit and Continue strings, word for word', () => {
  assert.equal(TURN_LIMIT_PREFIX, 'Paused at the turn limit')
  assert.equal(CONTINUE_PROMPT, 'Continue from where you stopped. Do not start over: check what is already done, then finish the rest.')
  assert.equal(turnLimitText(50), 'Paused at the turn limit (50 turns this run) before finishing. The work so far is kept: continue the task to pick up where it stopped.')
  assert.equal(turnLimitText(1000), 'Paused at the turn limit (1000 turns this run) before finishing. The work so far is kept: continue the task to pick up where it stopped.')
  assert.equal(turnLimitRow(50), 'Paused at the turn limit (50 turns this run).')
  assert.ok(turnLimitText(7).startsWith(TURN_LIMIT_PREFIX))
})

test('inferTurnLimit (an assumption until a spike): only an answered run that used its whole budget and still wanted a tool', () => {
  const cases: Array<[Parameters<typeof inferTurnLimit>[0], boolean]> = [
    [{ reason: 'answer', runTurns: 50, maxTurns: 50, lastStopReason: 'tool_use' }, true],
    [{ reason: 'answer', runTurns: 51, maxTurns: 50 }, true],
    [{ reason: 'answer', runTurns: 50, maxTurns: 50, lastStopReason: 'end_turn' }, false],
    [{ reason: 'answer', runTurns: 49, maxTurns: 50, lastStopReason: 'tool_use' }, false],
    [{ reason: 'error', runTurns: 50, maxTurns: 50, lastStopReason: 'tool_use' }, false],
    [{ reason: 'aborted', runTurns: 80, maxTurns: 50 }, false],
    [{ reason: 'refusal', runTurns: 80, maxTurns: 50 }, false],
  ]
  for (const [input, want] of cases) assert.equal(inferTurnLimit(input), want, JSON.stringify(input))
})
