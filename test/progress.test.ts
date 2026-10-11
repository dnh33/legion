import { strictEqual, ok } from 'node:assert'
import { describe, it } from 'node:test'

import { collectProgress, loggingProgress, silentProgress, type ProgressEvent } from '../src/core/updater/progress.js'

describe('progress', () => {
  it('collectProgress records every event in order', () => {
    const { sink, events } = collectProgress()
    const e1: ProgressEvent = { stage: 'preflight', message: 'Backing up', percent: null }
    const e2: ProgressEvent = { stage: 'download', message: 'Fetching', percent: 50 }
    sink(e1)
    sink(e2)
    strictEqual(events.length, 2)
    strictEqual(events[0].stage, 'preflight')
    strictEqual(events[1].percent, 50)
  })

  it('silentProgress accepts any event without throwing', () => {
    silentProgress({ stage: 'error', message: 'x', percent: null })
  })

  it('loggingProgress logs and forwards', () => {
    const logs: string[] = []
    const { sink, events } = collectProgress()
    const wrapped = loggingProgress((m) => void logs.push(m), sink)
    wrapped({ stage: 'swap', message: 'Swapping files', percent: 80 })
    strictEqual(events.length, 1)
    ok(logs[0].includes('swap: Swapping files (80%)'))
  })

  it('loggingProgress omits percent in log when null', () => {
    const logs: string[] = []
    loggingProgress((m) => void logs.push(m))({ stage: 'teardown', message: 'Stopping core', percent: null })
    ok(logs[0].includes('teardown: Stopping core'))
    ok(!logs[0].includes('%'))
  })
})
