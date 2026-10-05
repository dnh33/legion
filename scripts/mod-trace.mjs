#!/usr/bin/env node
/**
 * Reads a Legion Mod development trace and answers the usual questions at once: which tasks ran, who delegated to whom, what was
 * refused and why, what each run cost, and (with --timeline) every decision in order.
 *
 *   node scripts/mod-trace.mjs                 newest trace under LEGION_MOD_HOME or ~/.legion-mod
 *   node scripts/mod-trace.mjs <file|folder>   a given trace file, or the newest in a data folder
 *   node scripts/mod-trace.mjs --timeline      also print every line, in order
 *
 * Turn the trace on with LEGION_MOD_TRACE=1, or /legion trace on in a session. See mod/src/wire/trace.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const timeline = args.includes('--timeline')
const target = args.find(a => !a.startsWith('--'))

function newestTrace(dir) {
  const debug = join(dir, 'debug')
  if (!existsSync(debug)) return undefined
  const files = readdirSync(debug).filter(f => /^trace-.*\.jsonl$/.test(f)).map(f => join(debug, f))
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

const file = target
  ? (statSync(target).isDirectory() ? newestTrace(target) : target)
  : newestTrace(process.env.LEGION_MOD_HOME || join(homedir(), '.legion-mod'))
if (!file || !existsSync(file)) {
  console.error('No trace found. Turn it on with LEGION_MOD_TRACE=1 or /legion trace on, run something, then try again.')
  process.exit(1)
}

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
const t0 = lines[0]?.t ?? 0
const at = t => `+${((t - t0) / 1000).toFixed(1)}s`.padStart(8)
const money = n => (typeof n === 'number' ? `≈$${n.toFixed(3)}` : '')

// Tasks: what each run did, and who started it.
const tasks = new Map()
const task = id => {
  if (!tasks.has(id)) tasks.set(id, { id, agent: '', parent: undefined, title: '', status: 'queued', turns: 0, cost: undefined, tools: {}, delegations: [], denials: [], runs: new Set() })
  return tasks.get(id)
}
const byRun = new Map()
for (const l of lines) {
  if (l.task) {
    const t = task(l.task)
    if (l.agent && !t.agent) t.agent = l.agent
    if (l.run) { t.runs.add(l.run); byRun.set(l.run, l.task) }
  }
  switch (l.k) {
    case 'queue': if (l.kind === 'spawn') { const t = task(l.task); t.agent ||= String(l.agentType ?? '').replace('legion-mod:', ''); t.title ||= l.prompt ?? '' } break
    case 'adopt': { const t = task(l.task); t.parent = l.parentTask; t.title ||= l.title ?? ''; t.origin = l.origin; break }
    case 'tool': {
      const t = task(l.task)
      t.tools[l.tool] = (t.tools[l.tool] ?? 0) + 1
      if (l.tool === 'Agent') t.delegations.push(`${l.subagentType ?? '?'}${l.background === false ? ' (ask)' : l.background === true ? ' (tell)' : ''}`)
      break
    }
    case 'deny': task(l.task).denials.push(`${l.tool}${l.subagentType ? ` → ${l.subagentType}` : ''}: ${l.reason}`); break
    case 'finish': { const t = task(l.task); t.status = l.status ?? l.reason; t.turns = l.turns ?? t.turns; t.cost = l.cost; t.isTurnLimit = l.isTurnLimit; t.answer = l.answer; break }
    case 'result': if (!l.ok) task(l.task).denials.push(`runner ${l.kind}: ${l.error}`); break
  }
}

console.log(`Trace ${file}`)
console.log(`${lines.length} lines over ${((lines.at(-1)?.t - t0) / 1000 || 0).toFixed(1)} s\n`)

const roots = [...tasks.values()].filter(t => !t.parent || !tasks.has(t.parent))
const children = parent => [...tasks.values()].filter(t => t.parent === parent)
function show(t, depth) {
  const pad = '  '.repeat(depth)
  const tools = Object.entries(t.tools).map(([k, v]) => `${k}×${v}`).join(' ')
  console.log(`${pad}${depth ? '└ ' : ''}${t.agent || '?'}  ${t.status}${t.isTurnLimit ? ' (turn limit)' : ''}  ${t.turns} turns  ${money(t.cost)}  ${t.id}`)
  if (t.title) console.log(`${pad}   "${t.title}"`)
  if (tools) console.log(`${pad}   tools: ${tools}`)
  for (const d of t.delegations) console.log(`${pad}   delegated → ${d}`)
  for (const d of t.denials) console.log(`${pad}   REFUSED ${d}`)
  if (t.answer) console.log(`${pad}   answer: ${t.answer}`)
  for (const c of children(t.id)) show(c, depth + 1)
}
console.log('Tasks')
if (!roots.length) console.log('  none')
for (const r of roots) show(r, 0)

const denials = lines.filter(l => l.k === 'deny')
console.log(`\nRefusals: ${denials.length}`)
for (const d of denials) console.log(`  ${at(d.t)}  ${d.agent ?? '?'} ${d.tool}${d.subagentType ? ` → ${d.subagentType}` : ''}: ${d.reason}`)

const total = [...tasks.values()].reduce((n, t) => n + (t.cost ?? 0), 0)
console.log(`\nCost: ${money(total)} (estimate, prices in mod/src/engine/cost.ts)`)

if (timeline) {
  console.log('\nTimeline')
  for (const l of lines) {
    const { t, k, ...rest } = l
    console.log(`  ${at(t)}  ${k.padEnd(8)} ${Object.entries(rest).map(([key, v]) => `${key}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ')}`)
  }
}
