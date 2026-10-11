import { strictEqual, deepStrictEqual, ok } from 'node:assert'
import { describe, it } from 'node:test'

import { recordAttempt, readHistory, summarizeHistory, type MetricsDeps, type UpdateAttempt } from '../src/core/updater/metrics.js'

function fakeDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps & { lines: string[]; logs: string[] } {
  const lines: string[] = []
  const logs: string[] = []
  return {
    historyPath: '/fake/.update/history.jsonl',
    now: () => 1000,
    appendLine: (_path, line) => void lines.push(line),
    readLines: () => [...lines],
    log: (msg) => void logs.push(msg),
    ...overrides,
    lines,
    logs
  }
}

const attempt = (over: Partial<UpdateAttempt> = {}): UpdateAttempt => ({
  at: 1000,
  from: '0.2.5-o',
  to: '0.2.5-r',
  result: 'ok',
  durationMs: 500,
  ...over
})

describe('metrics', () => {
  it('records an attempt as one JSONL line', () => {
    const deps = fakeDeps()
    recordAttempt(deps, attempt())
    strictEqual(deps.lines.length, 1)
    const parsed = JSON.parse(deps.lines[0])
    strictEqual(parsed.from, '0.2.5-o')
    strictEqual(parsed.result, 'ok')
  })

  it('a metrics write failure is non-fatal and logs', () => {
    const deps = fakeDeps({ appendLine: () => { throw new Error('disk full') } })
    recordAttempt(deps, attempt()) // must not throw
    ok(deps.logs.some((l) => l.includes('non-fatal')))
  })

  it('reads history, skipping torn/malformed lines', () => {
    const deps = fakeDeps()
    recordAttempt(deps, attempt({ result: 'ok' }))
    deps.lines.push('{not valid json')
    recordAttempt(deps, attempt({ result: 'failed', reason: 'boom' }))
    const history = readHistory(deps)
    strictEqual(history.length, 2)
    strictEqual(history[1].result, 'failed')
  })

  it('summarizes success rate, counts and average duration', () => {
    const attempts = [
      attempt({ result: 'ok', durationMs: 100 }),
      attempt({ result: 'ok', durationMs: 300 }),
      attempt({ result: 'failed', durationMs: 200, reason: 'network' })
    ]
    const s = summarizeHistory(attempts)
    strictEqual(s.total, 3)
    strictEqual(s.ok, 2)
    strictEqual(s.failed, 1)
    ok(Math.abs((s.successRate ?? 0) - 2 / 3) < 1e-9)
    strictEqual(s.averageDurationMs, 200)
    strictEqual(s.lastFailure, 'network')
  })

  it('empty history yields null rates and no crash', () => {
    const s = summarizeHistory([])
    strictEqual(s.total, 0)
    strictEqual(s.successRate, null)
    strictEqual(s.averageDurationMs, null)
    deepStrictEqual(s.lastFailure, undefined)
  })
})
