import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskOrigin, TaskView } from '../../../types/index.d.ts'
import {
  MAX_DEPTH, MAX_HOP, RATE_LIMIT, RATE_WINDOW_MS, RESULT_MAX_CHARS, TIMEOUT_DEFAULT_S, agentsList, answerTaintsCaller, bridgeHeader,
  checkAsk, clampTimeout, parseLegionAgentType, tellBody, tellReply, truncateResult,
} from '../../../src/engine/bridge.ts'
import { seedAgents } from '../../../src/engine/roster.ts'
import { readRepo } from './_src.ts'

const desktop = readRepo('src/core/bridge.ts')

test('constants equal desktop src/core/bridge.ts:9-16', () => {
  const num = (name: string) => Number(new RegExp(`export const ${name} = ([0-9 *]+);`).exec(desktop)![1]!.split('*').reduce((a, b) => a * Number(b), 1))
  assert.equal(MAX_DEPTH, num('MAX_DEPTH'))
  assert.equal(MAX_HOP, num('MAX_HOP'))
  assert.equal(RESULT_MAX_CHARS, num('RESULT_MAX_CHARS'))
  assert.equal(RATE_LIMIT, num('RATE_LIMIT'))
  assert.equal(RATE_WINDOW_MS, num('RATE_WINDOW_MS'))
  assert.match(desktop, /Math\.min\(3600, Math\.max\(1, v\)\) : def\)/)
  assert.match(desktop, /clampTimeout = \(v: unknown, def = 600\)/)
  assert.equal(TIMEOUT_DEFAULT_S, 600)
  assert.deepEqual([clampTimeout(undefined), clampTimeout(0), clampTimeout(5000), clampTimeout(30), clampTimeout(Number.NaN), clampTimeout('9')], [600, 1, 3600, 30, 600, 600])
})

test('bridgeHeader and tellReply: the desktop wording, word for word', () => {
  const header = /`(\[From \$\{caller\?\.name \?\? item\.fromAgentId\} \(Legion agent\) via the bridge\.[^`]*)`/.exec(desktop)![1]!
  assert.equal(bridgeHeader('Zealot'), header.replace('${caller?.name ?? item.fromAgentId}', 'Zealot'))
  assert.equal(bridgeHeader('Zealot'), '[From Zealot (Legion agent) via the bridge. Reply with just what they need; your final message is returned to them.]')
  assert.match(desktop, /message: `\[Reply from \$\{from\.name\} · task \$\{fromTaskId\}\] \$\{body\}`/)
  assert.equal(tellReply('Scout', 't_abc', 'found it'), '[Reply from Scout · task t_abc] found it')
})

test('truncateResult and tellBody', () => {
  assert.equal(truncateResult('short'), 'short')
  const long = 'x'.repeat(RESULT_MAX_CHARS + 10)
  assert.equal(truncateResult(long), `${'x'.repeat(RESULT_MAX_CHARS)}\n[truncated: 10 more chars]`)
  assert.equal(truncateResult('y'.repeat(RESULT_MAX_CHARS)), 'y'.repeat(RESULT_MAX_CHARS))
  assert.equal(tellBody({ status: 'done' }, 'the answer'), 'the answer')
  assert.equal(tellBody({ status: 'error', error: 'boom' }, undefined), '(error) boom')
  assert.equal(tellBody({ status: 'cancelled' }, undefined), '(cancelled)')
  assert.equal(tellBody(undefined, undefined), '(gone)')
  assert.equal(tellBody(undefined, undefined, 'could not start'), '(failed) could not start')
  assert.equal(answerTaintsCaller({ isTainted: true }), true)
  assert.equal(answerTaintsCaller(undefined), false)
})

const agents = seedAgents()
const task = (id: string, agentId: string, origin: TaskOrigin = { kind: 'person' }, status: TaskView['status'] = 'running'): TaskView => ({
  id, agentId, title: id, status, runId: `run-${id}`, sessionId: 's1', isEscalated: false, isTainted: false, turns: 0, runTurns: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, origin, createdAt: 0, updatedAt: 0,
})
const bridged = (from: TaskView, hop: number, depth: number): TaskOrigin => ({ kind: 'bridge', fromAgentId: from.agentId, fromTaskId: from.id, hop, depth })
const NOW = 1_000_000_000

test('parseLegionAgentType: only legion-mod agent types name a Legion agent', () => {
  const cases: Array<[unknown, string | null]> = [
    ['legion-mod:builder', 'builder'], [' legion-mod:scout ', 'scout'], ['legion-mod:my-agent_2', 'my-agent_2'],
    ['legion-mod:', null], ['legion-mod:a b', null], ['legion-mod:x:y', null], ['Explore', null], ['general-purpose', null],
    ['other-plugin:builder', null], ['legion:builder', null], ['LEGION-MOD:builder', null], [undefined, null], [42, null],
    [`legion-mod:${'x'.repeat(65)}`, null],
  ]
  for (const [input, want] of cases) assert.equal(parseLegionAgentType(input), want, String(input))
})

test('checkAsk: refusals in the desktop order, with the desktop messages', () => {
  const root = task('t0', 'zealot')
  const base = { callerRunId: 'run-t0' as string | undefined, target: 'builder', isBlocking: true, message: 'do it', agents, tasks: [root], waiting: new Set<string>(), rateLog: {}, now: NOW }
  const reason = (o: Partial<typeof base>) => { const r = checkAsk({ ...base, ...o }); return r.ok ? 'ok' : r.reason }

  assert.equal(reason({ callerRunId: 'nope', message: '' }), 'Unknown caller task') // caller first
  assert.equal(reason({ callerRunId: undefined }), 'Unknown caller task') // the main loop is not a bridge caller
  assert.equal(reason({ message: '  ', target: 'nobody' }), 'message is empty') // empty before unknown agent
  assert.match(reason({ target: 'nobody' }), /^Unknown agent "nobody"\. Available: builder, scout, /)
  assert.ok(!reason({ target: 'nobody' }).includes('assayer'), 'hidden agents are not offered')
  assert.ok(!reason({ target: 'nobody' }).includes('zealot,'), 'the caller is not offered')
  assert.match(reason({ target: 'assayer' }), /^Unknown agent "assayer"/) // hidden: cannot be reached
  assert.equal(reason({ target: 'zealot' }), 'You cannot message yourself')
  assert.equal(reason({ target: 'ZEALOT' }), 'You cannot message yourself')
  assert.equal(reason({ target: ' Builder ' }), 'ok') // by name, any case (desktop rule)
  assert.equal(reason({ target: 'BUILDER' }), 'ok')
  const pass = checkAsk(base)
  assert.ok(pass.ok && pass.caller === root && pass.target.id === 'builder')

  // depth: a caller with MAX_DEPTH ancestors cannot delegate; one with MAX_DEPTH - 1 can
  const t1 = task('t1', 'builder', bridged(root, 1, 1))
  const t2 = task('t2', 'scout', bridged(t1, 2, 2))
  const t3 = task('t3', 'scribe', bridged(t2, 3, 3))
  const chainTasks = [root, t1, t2, t3]
  const ok2 = checkAsk({ ...base, callerRunId: 'run-t2', target: 'inquisitor', tasks: chainTasks })
  assert.ok(ok2.ok && ok2.depth === 3 && ok2.hop === 3)
  assert.equal(reason({ callerRunId: 'run-t3', target: 'inquisitor', tasks: chainTasks }), `delegation too deep (max ${MAX_DEPTH})`)

  // deadlock: blocking calls (ask) only; tell passes
  const waiting = new Set(['t1'])
  assert.equal(reason({ callerRunId: 'run-t2', target: 'builder', tasks: chainTasks, waiting }), 'would deadlock: Builder is waiting on this chain. Use tell instead.')
  assert.equal(reason({ isBlocking: false, callerRunId: 'run-t2', target: 'builder', tasks: chainTasks, waiting }), 'ok')
  assert.equal(reason({ callerRunId: 'run-t2', target: 'builder', tasks: chainTasks }), 'ok') // not waiting

  // hop: counted from the caller's origin (a room origin too)
  const roomCaller = task('r1', 'herald', { kind: 'room', roomId: 'x', hop: MAX_HOP })
  assert.equal(reason({ callerRunId: 'run-r1', tasks: [roomCaller] }), `Bridge hop limit reached (${MAX_HOP}). Finish the work yourself or ask the user.`)
  const r5 = checkAsk({ ...base, callerRunId: 'run-r1', tasks: [task('r1', 'herald', { kind: 'room', roomId: 'x', hop: MAX_HOP - 1 })] })
  assert.ok(r5.ok && r5.hop === MAX_HOP && r5.depth === 1)
  const cc = checkAsk({ ...base, callerRunId: 'run-c1', tasks: [task('c1', 'zealot', { kind: 'claude-code' })] })
  assert.ok(cc.ok && cc.hop === 1 && cc.depth === 1, 'a run Claude Code started is hop 0')
})

test('checkAsk: the rate limit counts per pair in a 10-minute window and never mutates its input', () => {
  const root = task('t0', 'zealot')
  const base = { callerRunId: 'run-t0', target: 'builder', isBlocking: false, message: 'go', agents, tasks: [root], waiting: new Set<string>(), now: NOW }
  const key = 'zealot>builder'
  const old = NOW - RATE_WINDOW_MS // exactly at the window edge: no longer counted
  const full = { [key]: [old, ...Array.from({ length: RATE_LIMIT }, (_, i) => NOW - i)], 'zealot>scout': [NOW] }
  const frozen = structuredClone(full)
  const r = checkAsk({ ...base, rateLog: full })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.reason, `Rate limit: more than ${RATE_LIMIT} messages from zealot to builder in 10 minutes. Finish the work yourself or ask the user.`)
  assert.equal(r.rateLog[key]!.length, RATE_LIMIT, 'pruned on refusal')
  assert.deepEqual(r.rateLog['zealot>scout'], [NOW], 'other pairs kept')
  assert.deepEqual(full, frozen, 'input untouched')

  const almost = { [key]: Array.from({ length: RATE_LIMIT - 1 }, (_, i) => NOW - i) }
  const ok = checkAsk({ ...base, rateLog: almost })
  assert.ok(ok.ok)
  assert.equal(ok.rateLog[key]!.length, RATE_LIMIT)
  assert.equal(ok.rateLog[key]!.at(-1), NOW)
  assert.equal(almost[key]!.length, RATE_LIMIT - 1, 'input untouched')
  const other = checkAsk({ ...base, target: 'scout', rateLog: full })
  assert.ok(other.ok, 'a different pair has its own budget')
})

test('agentsList: one line per other visible agent, desktop format', () => {
  const tasks = [task('a', 'builder', { kind: 'person' }, 'running'), task('b', 'scout', bridged(task('t0', 'zealot'), 1, 1), 'done'), task('c', 'scribe', { kind: 'person' }, 'queued')]
  const lines = agentsList('zealot', agents, tasks).split('\n')
  assert.equal(lines.length, 10) // 13 minus the caller and the hidden Assayer and Sculptor
  assert.ok(!lines.some((l) => l.startsWith('sculptor')))
  assert.equal(lines[0], `builder | Builder | ${agents[1]!.description.slice(0, 80)} | working | no-thread`)
  assert.equal(lines[1], `scout | Scout | Research, reading and summarising. | idle | thread`)
  assert.match(lines[2]!, /^inquisitor \| Inquisitor \| .{1,80} \| idle \| no-thread$/)
  assert.match(lines.find((l) => l.startsWith('scribe'))!, /\| queued \| no-thread$/)
  assert.equal(agentsList('zealot', agents.filter((a) => a.id === 'zealot'), []), 'No other agents.')
})
