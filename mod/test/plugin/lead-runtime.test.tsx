/**
 * The runtime end to end inside the engine's test kit: boot on an in-memory disk, a /to command, the runner's answer,
 * a run's steps, tool calls and finish, and a Button press. Everything beneath the plugins is the test's: the disk,
 * the session id, the environment and the clock.
 */
import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/Users/test/.legion-mod'

function world(on: any) {
  const files = new Map<string, string>()
  const writes: Record<string, any[]> = {}
  const registered: { agents: string[]; commands: string[]; tools: string[] } = { agents: [], commands: [], tools: [] }
  const toasts: string[] = []
  const fills: string[] = []
  const norm = (p: string) => p.replace(/\\/g, '/')
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/test' })
  on('session.id', () => ({ value: 'sess_test_1' }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('fs.exists', (_$: any, e: any) => ({ value: files.has(norm(e.path)) || [...files.keys()].some(k => k.startsWith(norm(e.path) + '/')) }))
  on('fs.read', (_$: any, e: any) => {
    const t = files.get(norm(e.path))
    if (t === undefined) return { deny: `ENOENT: no such file ${e.path}` }
    return { value: t }
  })
  on('fs.write', (_$: any, e: any) => { files.set(norm(e.path), e.text); return { value: undefined } })
  on('fs.stat', (_$: any, e: any) => {
    const t = files.get(norm(e.path))
    if (t !== undefined) return { value: { kind: 'file', size: new TextEncoder().encode(t).length, mtimeMs: clock.now(), isLink: false } }
    if ([...files.keys()].some(k => k.startsWith(norm(e.path) + '/'))) return { value: { kind: 'dir', size: 0, mtimeMs: clock.now(), isLink: false } }
    return { deny: `ENOENT: no such file ${e.path}` }
  })
  on('fs.list', (_$: any, e: any) => {
    const dir = norm(e.path ?? '') + '/'
    const names = new Map<string, any>()
    for (const [k, t] of files) {
      if (!k.startsWith(dir)) continue
      const rest = k.slice(dir.length)
      const [first, ...more] = rest.split('/')
      names.set(first!, more.length ? { name: first, kind: 'dir', size: 0, mtimeMs: clock.now(), isLink: false } : { name: first, kind: 'file', size: t.length, mtimeMs: clock.now(), isLink: false })
    }
    if (names.size === 0) return { deny: `ENOENT: no such folder ${e.path}` }
    return { value: [...names.values()] }
  })
  on('agent.register', (_$: any, e: any) => { registered.agents.push(e.name); return { value: undefined } })
  on('command.register', (_$: any, e: any) => { registered.commands.push(e.name); return { value: undefined } })
  on('tool.register', (_$: any, e: any) => { registered.tools.push(e.name); return { value: undefined } })
  on('ui.toast', (_$: any, e: any) => { toasts.push(String(e.text ?? e)); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.fill', (_$: any, e: any) => { fills.push(e.text); return { value: undefined } })
  on('state.set', { plugin: 'legion-mod' } as any, async (_$: any, e: any, next: any) => { (writes[e.key] ??= []).push(e.value); return next(e) })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  return { files, writes, registered, toasts, fills, clock, last: (key: string) => writes[key]?.at(-1) }
}

const start = ($: any) => $.session.start({ cwd: 'D:/work', surface: 'terminal', isInteractive: true })

test('boot: registers the order (hidden agents excepted), the commands and the agents tool', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered.agents).toContain('builder')
  expect(w.registered.agents).toContain('zealot')
  expect(w.registered.agents).not.toContain('assayer')
  expect(w.registered.agents).not.toContain('sculptor')
  expect(w.registered.commands).toEqual(['legion', 'to', 'say', 'continue', 'stop'])
  expect(w.registered.tools).toEqual(['agents'])
  expect(w.last('theme')).toBe('dark')
  expect(w.last('agents')?.length).toBe(13)
})

test('/to queues a spawn for the runner, and the transcript line names the task', async ($, on) => {
  const w = world(on)
  await start($)
  const out: any = await ($ as any).command.run({ command: 'to', args: 'builder fix the failing test' })
  expect(String(out?.text)).toMatch(/^Sent to Builder as task t_[0-9a-f]{12}\.$/)
  const queue = w.last('runQueue')
  expect(queue?.length).toBe(1)
  expect(queue[0]).toMatchObject({ kind: 'spawn', agentType: 'legion-mod:builder', prompt: 'fix the failing test' })
  const tasks = w.last('tasks')
  expect(tasks[0]).toMatchObject({ agentId: 'builder', status: 'queued', title: 'fix the failing test' })
  expect([...w.files.keys()].some(k => k.startsWith(`${ROOT}/tasks/seg-`))).toBe(true)
})

test('/to with no agent or no message says what is missing, and queues nothing', async ($, on) => {
  const w = world(on)
  await start($)
  const a: any = await ($ as any).command.run({ command: 'to', args: 'nobody hello' })
  expect(String(a?.text)).toMatch(/^No agent called "nobody"/)
  const b: any = await ($ as any).command.run({ command: 'to', args: 'scout' })
  expect(String(b?.text)).toMatch(/What should Scout do\?/)
  expect(w.last('runQueue') ?? []).toEqual([])
})

test('a run: the runner starts it, tool calls and replies fill the thread, the finish lands in the band', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  on('tool.call', { tool: 'Bash' } as any, () => ({ result: 'ok' }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'builder fix the failing test' })
  const req = w.last('runQueue')[0]
  const taskId = w.last('tasks')[0].id
  // The runner answered; a reload (session.start again) picks results up the same way a live state.set does.
  results.push({ requestId: req.id, kind: 'spawn', taskId, ok: true, runId: 'agent_run_1', model: 'claude-sonnet-5-5', at: 1_000_100 })
  await start($)
  expect(w.last('tasks')[0]).toMatchObject({ id: taskId, status: 'running', runId: 'agent_run_1' })
  expect(w.last('runQueue')).toEqual([])

  // A tool call of that run: a thread row while it runs, ok after.
  await ($ as any).tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1', agentId: 'agent_run_1' })
  const rows = w.writes['threads']?.at(-1) ?? []
  expect(rows.some((r: any) => r.tool?.name === 'Bash' && r.tool?.state === 'ok')).toBe(true)

  // The finish: done, a band row, and a victory mood for Builder.
  await ($ as any).turn.complete({ agentId: 'agent_run_1', reason: 'answer', answer: 'Fixed it.', durationMs: 900, isAborted: false, turnId: 'turn_1', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' } })
  const done = w.last('tasks').find((t: any) => t.id === taskId)
  expect(done).toMatchObject({ status: 'done' })
  expect(done.costUsd).toBeGreaterThan(0)
  expect(w.last('band').at(-1)).toMatchObject({ kind: 'done', taskId })
  // Moods dwell at least 1.8 s (theme.ts MOOD_DWELL_MS): Victory shows once the previous mood has had its time.
  await w.clock.advance(2_000)
  expect(w.last('moods').builder.mood).toBe('victory')
})
