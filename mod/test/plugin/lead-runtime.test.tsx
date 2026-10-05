/**
 * The runtime end to end inside the engine's test kit: boot on an in-memory disk, a /to command, the runner's answer,
 * a run's steps, tool calls and finish, and a Button press. Everything beneath the plugins is the test's: the disk,
 * the session id, the environment and the clock.
 */
import { expect, mock, test } from 'claude-code/testing'

import { ZEALOT_ART_JSON } from './fixtures/art-zealot.ts'

const ROOT = 'C:/Users/test/.legion-mod'

function world(on: any, opts: { env?: Record<string, string>; panes?: unknown[] } = {}) {
  const files = new Map<string, string>()
  const writes: Record<string, any[]> = {}
  const registered: { agents: string[]; commands: string[]; tools: string[] } = { agents: [], commands: [], tools: [] }
  const toasts: string[] = []
  const fills: string[] = []
  const artReads: string[] = []
  const norm = (p: string) => p.replace(/\\/g, '/')
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/test', ...opts.env })
  on('session.id', () => ({ value: 'sess_test_1' }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('fs.exists', (_$: any, e: any) => ({ value: files.has(norm(e.path)) || [...files.keys()].some(k => k.startsWith(norm(e.path) + '/')) }))
  on('fs.read', (_$: any, e: any) => {
    // The plugin's own art (mod/art/*.json): Zealot's real frames, recorded so a test can prove what was read.
    if (norm(e.path).includes('/art/')) {
      artReads.push(norm(e.path))
      if (norm(e.path).endsWith('/art/zealot.json')) return { value: ZEALOT_ART_JSON }
      return { deny: `ENOENT: no such file ${e.path}` }
    }
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
  on('ui.panes', () => ({ value: opts.panes ?? [] }))
  on('prompt.fill', (_$: any, e: any) => { fills.push(e.text); return { value: undefined } })
  on('state.set', { plugin: 'legion-mod' } as any, async (_$: any, e: any, next: any) => { (writes[e.key] ??= []).push(e.value); return next(e) })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  return { files, writes, registered, toasts, fills, clock, artReads, last: (key: string) => writes[key]?.at(-1) }
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
  // The trace is off unless asked for: no debug file.
  await w.clock.advance(2_000)
  expect([...w.files.keys()].some(k => k.includes('/debug/'))).toBe(false)
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

test('/legion doctor: says what is fine and, for each problem, what to do next', async ($, on) => {
  const w = world(on)
  on('session.version', () => ({ value: { version: '2.1.289', base: '2.1.289', builtAt: '2026-10-01' } }))
  await start($)
  const out: any = await ($ as any).command.run({ command: 'legion', args: 'doctor' })
  const text = String(out?.text)
  expect(text).toContain('✓ Claude Code: 2.1.289')
  expect(text).toContain('✕ Runner: legion-mod-runner is not running')
  expect(text).toContain('claude plugin install legion-mod-runner@legion')
  expect(text).toContain('✓ Data folder: C:/Users/test/.legion-mod')
  expect(text).not.toContain('All clear.')
  expect(w.last('doctor')?.length).toBeGreaterThan(4)
})

test('/legion doctor: an old Claude Code is named with the fix', async ($, on) => {
  world(on)
  on('session.version', () => ({ value: { version: '2.1.280', base: '2.1.280', builtAt: '2026-09-01' } }))
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: [], version: 1 } }))
  await start($)
  const out: any = await ($ as any).command.run({ command: 'legion', args: 'doctor' })
  const text = String(out?.text)
  expect(text).toContain('✕ Claude Code: 2.1.280: mods need 2.1.287 or newer. Run claude update.')
  expect(text).toContain('✓ Runner')
})


/** The 2D Order's world: the pane shown, Zealot's real art on disk, and a record of every art read, timer and blit. */
function stageWorld(on: any, opts: { twoD: boolean }) {
  const w = world(on, { panes: [{ id: 'legion', title: 'Legion', isShown: true, isFocused: false, isPlaced: true }] })
  const artReads: string[] = []
  const blits: any[] = []
  on('ui.blit', (_$: any, e: any) => { blits.push(e); return { value: {} } })
  if (opts.twoD) w.files.set(`${ROOT}/settings/seg-seed-0.jsonl`, JSON.stringify({ s: 'seed', q: 1, t: 1, op: { k: 'patch', patch: { twoD: true } } }) + '\n')
  return { ...w, artReads: w.artReads, blits }
}

test('2D Order off (the default): no art is read, no stage, no frame timer, even on the Order view', async ($, on) => {
  const w = stageWorld(on, { twoD: false })
  await start($)
  await ($ as any).command.run({ command: 'legion', args: 'order' })
  await w.clock.advance(5_000)
  expect(w.artReads).toEqual([])
  expect(w.blits).toEqual([])
  expect(w.last('stage')).toBe(null)
})

test("2D Order on: the shown agent's stage gets its first frame, frames blit, and it goes still when nothing happens", async ($, on) => {
  const w = stageWorld(on, { twoD: true })
  await start($)
  await ($ as any).command.run({ command: 'legion', args: 'order' })
  const stage = w.last('stage')
  expect(stage).toMatchObject({ agentId: 'zealot', cols: 32, rows: 18 })
  expect(stage.cells.length).toBeGreaterThan(100)
  await w.clock.advance(3_000)
  expect(w.blits.length).toBeGreaterThan(0)
  expect(w.blits[0]).toMatchObject({ requestId: 'legion', key: 'stage' })
  // Dormant after 60 s without events: the blits stop.
  await w.clock.advance(90_000)
  const settled = w.blits.length
  await w.clock.advance(30_000)
  expect(w.blits.length).toBe(settled)
})

test('/to with a model prefix: the router reads it, the title and thread show the message without it', async ($, on) => {
  const w = world(on)
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'zealot /model haiku Two things: check the engines field' })
  expect(w.last('tasks')[0].title).toBe('Two things: check the engines field')
  expect(w.last('runQueue')[0]).toMatchObject({ model: 'haiku', prompt: 'Two things: check the engines field' })
})

test('a Legion agent delegates inside the Order only: general-purpose is refused with how to do it right', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  on('tool.call', { tool: 'Agent' } as any, () => ({ result: 'started' }))
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'zealot two things' })
  const req = w.last('runQueue')[0]
  results.push({ requestId: req.id, kind: 'spawn', taskId: w.last('tasks')[0].id, ok: true, runId: 'run_z', model: 'm', at: 1 })
  await start($)
  const refused: any = await ($ as any).tool.call({ tool: 'Agent', subagent_type: 'general-purpose', description: 'x', prompt: 'count files', tool_use_id: 'tu_1', agentId: 'run_z' })
  expect(String(refused?.deny ?? refused?.text ?? JSON.stringify(refused))).toContain('Delegate inside the Order: set subagent_type to legion-mod:<agent id>; you used general-purpose')
  const allowed: any = await ($ as any).tool.call({ tool: 'Agent', subagent_type: 'legion-mod:scout', description: 'x', prompt: 'count files', run_in_background: true, tool_use_id: 'tu_2', agentId: 'run_z' })
  expect(allowed?.deny).toBeUndefined()
})

test('LEGION_MOD_TRACE=1: decisions land in the session\'s trace file within a second; off writes no trace', async ($, on) => {
  const w = world(on, { env: { LEGION_MOD_TRACE: '1' } })
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'scout read the readme' })
  await w.clock.advance(1_100)
  const traceKey = [...w.files.keys()].find(k => k.startsWith(`${ROOT}/debug/trace-sess_test_1`))
  expect(traceKey).toBeDefined()
  const kinds = w.files.get(traceKey!)!.trim().split('\n').map(l => JSON.parse(l).k)
  expect(kinds).toContain('boot')
  expect(kinds).toContain('cmd')
  expect(kinds).toContain('queue')
})

// ---- G3 review findings (claude/review-mod-core.md), each pinned by a test ----------------------------------------------

/** A Zealot task whose run is live, and a Builder run it started (a bridge child), with the person's rule answering tool.check. */
async function bridged($: any, on: any, rule: 'allow' | 'deny' | 'ask') {
  const w = world(on)
  const results: any[] = []
  const agents: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  on('agent.list', () => ({ value: agents }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'edit it' }] }) as any)
  on('tool.call', () => ({ result: 'ok' }))
  on('tool.check', (_$: any, e: any) => ({ decision: rule, reason: `your settings: ${rule}`, rule: `${e.tool}(*)` }))
  await start($)
  await $.command.run({ command: 'to', args: 'zealot plan it' })
  const req = w.last('runQueue')[0]
  results.push({ requestId: req.id, kind: 'spawn', taskId: w.last('tasks')[0].id, ok: true, runId: 'run_Z', model: 'm', at: 1_000_100 })
  await start($)
  agents.push({ id: 'run_Bu', description: 'builder', type: 'legion-mod:builder', status: 'running', parentId: 'run_Z' })
  return w
}

test('G3-1: a deny rule in the person\'s own settings stays a deny, for a bridged run and for Legion\'s own tool', async ($, on) => {
  await bridged($, on, 'deny')
  await ($ as any).tool.call({ tool: 'Edit', file_path: '.env', tool_use_id: 'toolu_E', agentId: 'run_Bu' })
  expect(((await ($ as any).tool.check({ tool: 'Edit', input: { file_path: '.env' }, tool_use_id: 'toolu_E' })) as any)?.decision).toBe('deny')
  await ($ as any).tool.call({ tool: 'mcp__legion-mod__agents', tool_use_id: 'toolu_L', agentId: 'run_Z' })
  expect(((await ($ as any).tool.check({ tool: 'mcp__legion-mod__agents', input: {}, tool_use_id: 'toolu_L' })) as any)?.decision).toBe('deny')
})

test('G3-8 (plan §2.1): a Builder run started by another agent asks before editing, even where the person\'s rules allow', async ($, on) => {
  await bridged($, on, 'allow')
  await ($ as any).tool.call({ tool: 'Edit', file_path: 'src/a.ts', tool_use_id: 'toolu_E', agentId: 'run_Bu' })
  const v: any = await ($ as any).tool.check({ tool: 'Edit', input: { file_path: 'src/a.ts' }, tool_use_id: 'toolu_E' })
  expect(v?.decision).toBe('ask')
  expect(String(v?.reason)).toContain('Builder asks')
})

test('G3-8: the same Builder started by the person keeps its own mode (no extra ask on an allowed edit)', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'builder edit it' })
  const req = w.last('runQueue')[0]
  results.push({ requestId: req.id, kind: 'spawn', taskId: w.last('tasks')[0].id, ok: true, runId: 'run_B', model: 'm', at: 1_000_100 })
  await start($)
  await ($ as any).tool.call({ tool: 'Edit', file_path: 'src/a.ts', tool_use_id: 'toolu_E', agentId: 'run_B' })
  expect(((await ($ as any).tool.check({ tool: 'Edit', input: {}, tool_use_id: 'toolu_E' })) as any)?.decision).toBe('allow')
})

test('G3-3: a queued run whose first tool call beats the runner\'s answer stays ONE task', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  const agents: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  on('tool.call', { tool: 'Bash' } as any, () => ({ result: 'ok' }))
  on('agent.list', () => ({ value: agents }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'fix the failing test' }] }) as any)
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'builder fix the failing test' })
  const req = w.last('runQueue')[0]
  const taskId = w.last('tasks')[0].id
  agents.push({ id: 'agent_run_1', description: req.description, type: 'legion-mod:builder', status: 'running', name: req.name, spawnedBy: 'legion-mod-runner' })
  await ($ as any).tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1', agentId: 'agent_run_1' })
  results.push({ requestId: req.id, kind: 'spawn', taskId, ok: true, runId: 'agent_run_1', model: 'claude-sonnet-5-5', at: 1_000_100 })
  await start($)
  const builderTasks = w.last('tasks').filter((t: any) => t.agentId === 'builder')
  expect(builderTasks.map((t: any) => `${t.id}:${t.status}:${t.origin.kind}`)).toEqual([`${taskId}:running:person`])
})

test('G3-6: an ask back up the chain while the asker waits is refused as a deadlock', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  const agents: any[] = []
  let verdict: any = 'not called'
  let innerCalls = 0
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  on('agent.list', () => ({ value: agents }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'look it up' }] }) as any)
  on('tool.call', { tool: 'Agent' } as any, async (_$: any, e: any) => {
    if (e.agentId === 'run_A') {
      verdict = await ($ as any).tool.call({ tool: 'Agent', subagent_type: 'legion-mod:builder', prompt: 'what did you mean?', run_in_background: false, tool_use_id: 'toolu_B', agentId: 'run_B' })
      return { result: 'answer' }
    }
    innerCalls++
    return { result: 'B reached A' }
  })
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'builder build it' })
  const req = w.last('runQueue')[0]
  const taskA = w.last('tasks')[0].id
  results.push({ requestId: req.id, kind: 'spawn', taskId: taskA, ok: true, runId: 'run_A', model: 'm', at: 1_000_100 })
  await start($)
  agents.push({ id: 'run_B', description: 'scout', type: 'legion-mod:scout', status: 'running', parentId: 'run_A' })
  await ($ as any).tool.call({ tool: 'Agent', subagent_type: 'legion-mod:scout', prompt: 'look it up', run_in_background: false, tool_use_id: 'toolu_A', agentId: 'run_A' })
  expect({ innerCalls, deny: String(verdict?.deny ?? '') }).toEqual({ innerCalls: 0, deny: expect.stringContaining('would deadlock') })
})

test('G3-4: a start that fails leaves the task in error with the reason, in the thread and the band', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'scout read it' })
  const req = w.last('runQueue')[0]
  const taskId = w.last('tasks')[0].id
  results.push({ requestId: req.id, kind: 'spawn', taskId, ok: false, error: 'Claude Code refused to start the agent: limit', at: 1_000_100 })
  await start($)
  expect(w.last('tasks')[0]).toMatchObject({ id: taskId, status: 'error', error: 'Claude Code refused to start the agent: limit' })
  expect((w.writes['threads'] ?? []).flat().some((r: any) => r.role === 'system' && r.text.includes('refused to start'))).toBe(true)
  expect(w.last('band').at(-1)).toMatchObject({ kind: 'error', taskId })
})

test('G3-2: a stop that does not land shows the task running again and says so', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'builder long job' })
  const spawn = w.last('runQueue')[0]
  const taskId = w.last('tasks')[0].id
  results.push({ requestId: spawn.id, kind: 'spawn', taskId, ok: true, runId: 'run_L', model: 'm', at: 1_000_100 })
  await start($)
  await ($ as any).command.run({ command: 'stop', args: '' })
  const stop = w.last('runQueue').find((r: any) => r.kind === 'stop')
  expect(stop).toMatchObject({ runId: 'run_L', taskId })
  results.push({ requestId: stop.id, kind: 'stop', taskId, ok: false, runId: 'run_L', error: 'Claude Code refused to stop it: policy', at: 1_000_200 })
  await start($)
  expect(w.last('tasks')[0]).toMatchObject({ id: taskId, status: 'running' })
  expect(String(w.last('band').at(-1)?.text)).toContain('Could not stop')
})

test('G3-2: a stop before the run started withdraws the spawn; a run that starts anyway is stopped on arrival', async ($, on) => {
  const w = world(on)
  const results: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'builder long job' })
  const spawn = w.last('runQueue')[0]
  const taskId = w.last('tasks')[0].id
  await ($ as any).command.run({ command: 'stop', args: '' })
  expect(w.last('runQueue')).toEqual([])
  expect(w.last('tasks')[0]).toMatchObject({ id: taskId, status: 'cancelled' })
  // The runner had already taken the request: its run arrives after the stop.
  const resultsSet = { requestId: spawn.id, kind: 'spawn', taskId, ok: true, runId: 'run_late', model: 'm', at: 1_000_150 }
  results.push(resultsSet)
  await start($)
  const stopLater = (w.writes['runQueue'] ?? []).flat().find((r: any) => r.kind === 'stop' && r.runId === 'run_late')
  expect(stopLater).toBeDefined()
})

// ---- G3 re-review (R1-R3) and the gaps it named ----
async function order($: any, on: any, verdict: (e: any) => any) {
  const w = world(on)
  const results: any[] = []
  const agents: any[] = []
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: results, version: results.length } }))
  on('agent.list', () => ({ value: agents }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'do it' }] }) as any)
  on('tool.call', () => ({ result: 'ok' }))
  on('tool.check', (_$: any, e: any) => verdict(e))
  await start($)
  await $.command.run({ command: 'to', args: 'zealot plan it' })
  const rz = w.last('runQueue')[0]
  const tz = w.last('tasks')[0].id
  await $.command.run({ command: 'to', args: 'builder fix the build' })
  const rb = w.last('runQueue').find((r: any) => r.agentType === 'legion-mod:builder')
  const tb = w.last('tasks').find((t: any) => t.agentId === 'builder').id
  results.push({ requestId: rz.id, kind: 'spawn', taskId: tz, ok: true, runId: 'run_Z', model: 'm', at: 1_000_100 })
  results.push({ requestId: rb.id, kind: 'spawn', taskId: tb, ok: true, runId: 'run_B1', model: 'm', at: 1_000_100 })
  await start($)
  return { w, agents, tz, tb }
}

test('R1 name hijack: a model-started run named <agent>-<existing task id> is not linked to that task', async ($, on) => {
  const { w, agents, tb } = await order($, on, () => ({ decision: 'allow' }))
  // Zealot's run starts a Builder with the Agent tool and (by chance or injection) names it after the person's Builder task.
  agents.push({ id: 'run_X', description: 'x', type: 'legion-mod:builder', status: 'running', parentId: 'run_Z', name: `builder-${tb}` })
  await ($ as any).tool.call({ tool: 'Edit', file_path: 'a.ts', tool_use_id: 'tu_X', agentId: 'run_X' })
  const v: any = await ($ as any).tool.check({ tool: 'Edit', input: { file_path: 'a.ts' }, tool_use_id: 'tu_X' })
  const person = w.last('tasks').find((t: any) => t.id === tb)
  expect({ personRun: person.runId, bridged: w.last('tasks').some((t: any) => t.origin.kind === 'bridge'), decision: v?.decision }).toEqual({ personRun: 'run_B1', bridged: true, decision: 'ask' })
})

test("R2 the person's own ask rule on a Legion tool stays an ask", async ($, on) => {
  await order($, on, (e: any) => ({ decision: 'ask', reason: 'your rule', rule: e.tool }))
  await ($ as any).tool.call({ tool: 'mcp__legion-mod__kg_forget', tool_use_id: 'tu_L', agentId: 'run_Z' })
  const v: any = await ($ as any).tool.check({ tool: 'mcp__legion-mod__kg_forget', input: {}, tool_use_id: 'tu_L' })
  expect(v?.decision).toBe('ask')
})

test('R3 a bridged Builder Bash that the person allows still gets the ceiling card (as Edit does)', async ($, on) => {
  const { agents } = await order($, on, () => ({ decision: 'allow', rule: 'Bash(npm test:*)' }))
  agents.push({ id: 'run_Y', description: 'y', type: 'legion-mod:builder', status: 'running', parentId: 'run_Z' })
  await ($ as any).tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu_Y', agentId: 'run_Y' })
  const v: any = await ($ as any).tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'tu_Y' })
  expect(v?.decision).toBe('ask')
})

test('no runner: a start that waits 30 s with legion-mod-runner never answering fails with how to install it', async ($, on) => {
  const w = world(on)
  on('state.get', { plugin: 'legion-mod-runner', key: 'results' } as any, () => ({ value: { value: undefined, version: 0 } }))
  await start($)
  await ($ as any).command.run({ command: 'to', args: 'scout read it' })
  await w.clock.advance(20_000)
  expect(w.last('tasks')[0].status).toBe('queued')
  await w.clock.advance(15_000)
  expect(w.last('tasks')[0]).toMatchObject({ status: 'error', error: expect.stringContaining('claude plugin install legion-mod-runner@legion') })
  expect(w.last('runQueue')).toEqual([])
})
