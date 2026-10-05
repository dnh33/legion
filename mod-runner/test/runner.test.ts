/**
 * The runner acts on Legion Mod's queue from its own timer, once per request, and only for Legion's agent types.
 * The test engine answers `agent.spawn` with a model but mints no agent id (there is no core behind it), so these
 * tests check what the runner asks for and records; the real id path is proven by the headless spike (plan §1b).
 */
import { expect, mock, test } from 'claude-code/testing'

const QUEUE_REF = { plugin: 'legion-mod', key: 'runQueue' } as any
const RESULTS_REF = { plugin: 'legion-mod-runner', key: 'results' } as any

function world(on: any, queue: unknown[]) {
  const clock = mock.clock(on, { now: 100_000 })
  const spawned: any[] = []
  const writes: any[][] = []
  on('state.get', QUEUE_REF, () => ({ value: { value: queue, version: 1 } }))
  on('agent.spawn', (_$: any, e: any) => { spawned.push(e); return { model: e.model ?? 'claude-sonnet' } })
  on('state.set', RESULTS_REF, async (_$: any, e: any, next: any) => { writes.push(e.value); return next(e) })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  return { clock, spawned, writes }
}

const start = ($: any) => $.session.start({ cwd: 'D:/work', surface: 'terminal', isInteractive: true })
const req = (over: Record<string, unknown> = {}) => ({ id: 'rq_1', kind: 'spawn', taskId: 't_1', agentType: 'legion-mod:builder', prompt: 'Fix the test.', model: 'sonnet', name: 'builder-t_1', description: 'Builder · Fix the test.', at: 100_000, ...over })

test('spawns a queued request with its prompt, type, model and name', async ($, on) => {
  const w = world(on, [req()])
  await start($)
  await w.clock.advance(1_000)
  expect(w.spawned.length).toBe(1)
  expect(w.spawned[0]).toMatchObject({ prompt: 'Fix the test.', subagent_type: 'legion-mod:builder', model: 'sonnet', name: 'builder-t_1', run_in_background: true })
  expect(w.writes.at(-1)?.[0]).toMatchObject({ requestId: 'rq_1', kind: 'spawn', taskId: 't_1' })
})

test('acts on a request once, however many passes run', async ($, on) => {
  const w = world(on, [req()])
  await start($)
  for (let i = 0; i < 6; i++) await w.clock.advance(1_000)
  expect(w.spawned.length).toBe(1)
})

test('ignores a stale request and a non-Legion agent type', async ($, on) => {
  const w = world(on, [req({ id: 'rq_old', at: 100_000 - 11 * 60_000 }), req({ id: 'rq_foreign', agentType: 'other-plugin:agent' })])
  await start($)
  await w.clock.advance(1_000)
  expect(w.spawned.length).toBe(0)
  expect(w.writes.at(-1)?.map((r: any) => [r.requestId, r.ok])).toEqual([['rq_foreign', false]])
})

test('does nothing while the queue is empty (Legion Mod absent), beyond saying it is here', async ($, on) => {
  const w = world(on, [])
  await start($)
  for (let i = 0; i < 3; i++) await w.clock.advance(1_000)
  expect(w.spawned.length).toBe(0)
  // One write at start: an empty results list, so Legion Mod's doctor can see the runner (version > 0). Nothing after.
  expect(w.writes).toEqual([[]])
})
