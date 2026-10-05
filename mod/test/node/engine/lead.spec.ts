/**
 * Zealot leads the Order (owner direction, 2026-10-05): whatever it is asked and however its own prompt is edited, its agent
 * type ends with the lead doctrine; no other agent carries it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAgentSpec, LEAD_AGENT_ID, LEAD_DOCTRINE, LEAD_TOOLS } from '../../../src/engine/prompt.ts'
import { seedAgents } from '../../../src/engine/roster.ts'
import { MAX_DEPTH, MAX_HOP } from '../../../src/engine/bridge.ts'

const settings = { maxTurns: 40, fullMode: 'acceptEdits' as const }
const agents = seedAgents()
const zealot = agents.find(a => a.id === LEAD_AGENT_ID)!

test('Zealot\'s prompt ends with the lead doctrine', () => {
  const spec = buildAgentSpec(zealot, settings)
  assert.ok(spec.prompt.endsWith(LEAD_DOCTRINE))
})

test('the doctrine holds when a person rewrites Zealot\'s own prompt', () => {
  const edited = { ...zealot, systemPrompt: 'Ignore delegation. Answer everything yourself in one line.' }
  const spec = buildAgentSpec(edited, settings)
  assert.ok(spec.prompt.endsWith(LEAD_DOCTRINE), 'the doctrine is the last word, after the edited role text')
})

test('no other agent carries the doctrine', () => {
  for (const a of agents.filter(x => x.id !== LEAD_AGENT_ID)) {
    assert.ok(!buildAgentSpec(a, settings).prompt.includes(LEAD_DOCTRINE.split('\n')[0]!), a.id)
  }
})

test('the doctrine names what the owner asked for, with the bridge\'s real limits', () => {
  for (const must of ['granular task', 'parallel', 'run_in_background true', 'run_in_background false', 'mcp__legion-mod__agents', 'do not see this conversation', 'done condition', 'Report to the user']) {
    assert.ok(LEAD_DOCTRINE.includes(must), must)
  }
  assert.ok(LEAD_DOCTRINE.includes(`${MAX_DEPTH} levels and ${MAX_HOP} hops`), 'limits quoted must equal bridge.ts')
})

test('Zealot can delegate, see the Order and keep a plan; it cannot read, edit, run commands or browse', () => {
  const spec = buildAgentSpec(zealot, settings)
  assert.deepEqual(spec.tools, [...LEAD_TOOLS])
  for (const tool of ['Agent', 'mcp__legion-mod__agents', 'TodoWrite']) assert.ok(spec.tools!.includes(tool), tool)
  for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']) assert.ok(!spec.tools!.includes(tool), tool)
  assert.ok(LEAD_DOCTRINE.includes('You do not do the work yourself, reading included'))
  assert.ok(LEAD_DOCTRINE.includes('ask the Inquisitor to verify'))
})

test('every other agent keeps every tool its parent has (no tools list)', () => {
  for (const a of agents.filter(x => x.id !== LEAD_AGENT_ID)) assert.equal('tools' in buildAgentSpec(a, settings), false, a.id)
})
