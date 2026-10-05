import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalMode } from '../../../types/index.d.ts'
import { DISALLOWED_TOOLS, MOD_PREAMBLE, agentTypeName, buildAgentSpec, preamble } from '../../../src/engine/prompt.ts'
import { seedAgents } from '../../../src/engine/roster.ts'
import { toModToolNames } from '../../../src/engine/tool-names.ts'
import { between, readRepo, stringLiterals } from './_src.ts'

test('MOD_PREAMBLE keeps the desktop LEGION_PREAMBLE lines that still hold, ask and tell as the Agent tool, and drops the VM lines', () => {
  const desktop = stringLiterals(between(readRepo('src/core/engine.ts'), 'export const LEGION_PREAMBLE = [', '].join'))
  assert.equal(desktop.length, 11, 'the desktop preamble changed: re-check what the mod keeps')
  const mine = MOD_PREAMBLE.split('\n')
  // word for word: lines 1, 2 and 6
  for (const i of [0, 1, 5]) assert.equal(mine[i], toModToolNames(desktop[i]!), `line ${i + 1}`)
  // lines 3-5: the desktop's sentences, with ask and tell as the Agent tool
  assert.equal(mine[2], desktop[2]!.replace('mcp__legion__agents (list them), mcp__legion__ask and mcp__legion__tell', 'mcp__legion-mod__agents (list them) and the Agent tool with subagent_type legion-mod:<agent id>'))
  assert.equal(mine[3], desktop[3]!.replace('Use ask when', 'Use ask, the Agent tool with run_in_background false, when'))
  assert.equal(mine[4], desktop[4]!.replace('Use tell for', 'Use tell, the Agent tool with run_in_background true, for'))
  assert.doesNotMatch(MOD_PREAMBLE, /vm_|mcp__legion__|mcp__legion_[a-z]|mcp__legion-mod__(ask|tell)/)
  assert.match(MOD_PREAMBLE, /project folder/)
  assert.match(MOD_PREAMBLE, /mcp__legion-mod__agents/)
})

test('preamble puts the name in literally, even with replacement patterns in it', () => {
  assert.ok(preamble({ name: 'Zealot' }).startsWith('You are Zealot, an agent inside Legion'))
  assert.ok(preamble({ name: 'A$&B' }).startsWith('You are A$&B, an agent'))
})

test('the withheld built-ins exist in this build of Claude Code', () => {
  const dts = readRepo('mod/.claude/types/claude-code.d.ts')
  for (const t of DISALLOWED_TOOLS) assert.match(dts, new RegExp(`^\\s+${t}: \\{`, 'm'), t)
  assert.deepEqual([...DISALLOWED_TOOLS], ['SendMessage', 'ListAgents'])
  assert.ok(!(DISALLOWED_TOOLS as readonly string[]).includes('Agent'), 'Agent is how agents ask and tell')
})

test('the Agent tool fields the preamble names exist in this build of Claude Code', () => {
  const dts = readRepo('mod/.claude/types/claude-code.d.ts')
  const agentInput = between(dts, '\n    Agent: {\n', '\n    }')
  const named = [...MOD_PREAMBLE.matchAll(/\b(subagent_type|run_in_background)\b/g)].map((m) => m[1]!)
  assert.deepEqual([...new Set(named)].sort(), ['run_in_background', 'subagent_type'])
  for (const f of new Set(named)) assert.match(agentInput, new RegExp(`^\\s+${f}\\?: `, 'm'), f)
  assert.match(agentInput, /run_in_background\?: boolean/)
})

test('buildAgentSpec: every seed agent, every mode and fullMode; never bypassPermissions', () => {
  const MODES: Array<ApprovalMode | undefined> = [undefined, 'ask', 'auto-edits', 'full']
  for (const agent of seedAgents()) for (const fullMode of ['acceptEdits', 'auto'] as const) for (const mode of MODES) {
    const spec = buildAgentSpec(agent, { maxTurns: 77, fullMode }, mode ? { mode } : {})
    const label = `${agent.id} ${fullMode} ${mode}`
    assert.notEqual(spec.permissionMode, 'bypassPermissions', label)
    assert.ok(['default', 'acceptEdits', 'auto'].includes(spec.permissionMode!), label)
    assert.ok(!JSON.stringify(spec).includes('bypassPermissions'), label)
    assert.equal(spec.name, agent.id)
    assert.equal(spec.description, agent.description)
    assert.equal(spec.prompt, preamble({ name: agent.name }) + '\n\n' + agent.systemPrompt)
    assert.equal(spec.maxTurns, 77)
    assert.deepEqual(spec.disallowedTools, ['SendMessage', 'ListAgents'])
    if (agent.model === 'auto') assert.equal('model' in spec, false, label)
    else assert.equal(spec.model, agent.model, label)
    const m = mode ?? agent.approval
    assert.equal(spec.permissionMode, m === 'ask' ? 'default' : m === 'auto-edits' ? 'acceptEdits' : fullMode)
  }
  const builder = seedAgents().find((a) => a.id === 'builder')!
  assert.equal(buildAgentSpec(builder, { maxTurns: 50, fullMode: 'acceptEdits' }).permissionMode, 'acceptEdits')
  assert.equal(buildAgentSpec({ ...builder, model: ' AUTO ' }, { maxTurns: 50, fullMode: 'acceptEdits' }).model, undefined)
})

test('agentTypeName: roster ids pass, odd ids are made safe', () => {
  for (const a of seedAgents()) assert.equal(agentTypeName(a.id), a.id)
  assert.equal(agentTypeName('my agent/2'), 'my-agent-2')
  assert.equal(agentTypeName('x'.repeat(80)).length, 64)
  assert.equal(agentTypeName(''), 'agent')
})
