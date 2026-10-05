import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalMode } from '../../../types/index.d.ts'
import {
  EDIT_TOOLS, READ_ONLY, engineAsks, extraAsk, needsApproval, permissionModeFor, stricterMode, summarizeToolInput,
} from '../../../src/engine/approvals.ts'
import { readRepo, stringLiterals } from './_src.ts'

const MODES: ApprovalMode[] = ['ask', 'auto-edits', 'full']
const FULL_MODES = ['acceptEdits', 'auto'] as const

/** One tool per class the rules tell apart. */
const TOOLS = { read: 'Read', edit: 'Write', bash: 'Bash', mod: 'mcp__legion-mod__ask', otherMcp: 'mcp__github__create_issue', unknown: 'SomethingNew' } as const
type Cls = keyof typeof TOOLS

test('READ_ONLY and EDIT_TOOLS equal the desktop sets (src/core/approvals.ts:8-9)', () => {
  const src = readRepo('src/core/approvals.ts')
  const line = (name: string) => src.split('\n').find((l) => l.startsWith(`const ${name} = new Set(`))!
  assert.deepEqual([...READ_ONLY], stringLiterals(line('READ_ONLY')))
  assert.deepEqual([...EDIT_TOOLS], stringLiterals(line('EDIT_TOOLS')))
})

test('needsApproval: every mode x tool class, as the desktop rule', () => {
  const want: Record<ApprovalMode, Record<Cls, boolean>> = {
    ask: { read: false, edit: true, bash: true, mod: false, otherMcp: true, unknown: true },
    'auto-edits': { read: false, edit: false, bash: true, mod: false, otherMcp: true, unknown: true },
    full: { read: false, edit: false, bash: false, mod: false, otherMcp: false, unknown: false },
  }
  for (const m of MODES) for (const c of Object.keys(TOOLS) as Cls[]) {
    assert.equal(needsApproval(m, TOOLS[c]), want[m][c], `${m} ${c}`)
    assert.equal(needsApproval(m, TOOLS[c], { capped: true }), want[m][c], `${m} ${c} capped (no VM tools in the mod)`)
  }
  for (const t of EDIT_TOOLS) assert.equal(needsApproval('ask', t), true, t)
  for (const t of READ_ONLY) assert.equal(needsApproval('ask', t), false, t)
  // a look-alike of the mod's own server is not trusted
  assert.equal(needsApproval('auto-edits', 'mcp__legion-mod__x__run'), true)
})

test('stricterMode: all nine pairs', () => {
  const rank = { ask: 0, 'auto-edits': 1, full: 2 }
  for (const a of MODES) for (const b of MODES) assert.equal(stricterMode(a, b), rank[a] <= rank[b] ? a : b, `${a} ${b}`)
  assert.equal(stricterMode('full', 'ask'), 'ask')
  assert.equal(stricterMode('auto-edits', 'full'), 'auto-edits')
})

test('summarizeToolInput: command, path, compact JSON, 400-char cap, odd inputs', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'npm test' }), 'npm test')
  assert.equal(summarizeToolInput('Write', { file_path: 'a/b.ts', content: 'x' }), 'a/b.ts')
  assert.equal(summarizeToolInput('Edit', { file_path: 'c.ts' }), 'c.ts')
  assert.equal(summarizeToolInput('Grep', { pattern: 'x' }), '{"pattern":"x"}')
  assert.equal(summarizeToolInput('Bash', { command: 3 }), '{"command":3}')
  assert.equal(summarizeToolInput('Read', undefined), '{}')
  const long = summarizeToolInput('Bash', { command: 'x'.repeat(1000) })
  assert.equal(long.length, 400)
  assert.ok(long.endsWith('…'))
  assert.equal(summarizeToolInput('Bash', { command: 'y'.repeat(400) }), 'y'.repeat(400))
  const big = summarizeToolInput('Other', { v: 'z'.repeat(1000) })
  assert.equal(big.length, 400)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(summarizeToolInput('Other', circular), '[object Object]')
})

test('permissionModeFor: ask/auto-edits/full map as the plan says, never bypassPermissions', () => {
  assert.equal(permissionModeFor('ask', 'acceptEdits'), 'default')
  assert.equal(permissionModeFor('ask', 'auto'), 'default')
  assert.equal(permissionModeFor('auto-edits', 'auto'), 'acceptEdits')
  assert.equal(permissionModeFor('full', 'acceptEdits'), 'acceptEdits')
  assert.equal(permissionModeFor('full', 'auto'), 'auto')
  for (const m of MODES) for (const f of FULL_MODES) assert.notEqual(permissionModeFor(m, f), 'bypassPermissions')
  assert.equal(engineAsks('auto', 'Bash'), false)
  assert.equal(engineAsks('acceptEdits', 'Write'), false)
  assert.equal(engineAsks('acceptEdits', 'Bash'), true)
  assert.equal(engineAsks('default', 'Read'), false)
})

test('extraAsk: agent mode x ceiling x fullMode x tool class, written out by hand', () => {
  // The tool classes that get Legion's extra card. Everything not listed gets none.
  const W = 'edit', ALL4 = ['edit', 'bash', 'otherMcp', 'unknown'], ADD3 = ['bash', 'otherMcp', 'unknown']
  const table: Array<[ApprovalMode, ApprovalMode | 'none', 'acceptEdits' | 'auto', string[]]> = [
    // agent `ask` runs `default`: Claude Code already asks for everything Legion would.
    ...(['none', 'ask', 'auto-edits', 'full'] as const).flatMap((c) => FULL_MODES.map((f) => ['ask', c, f, []] as [ApprovalMode, ApprovalMode | 'none', 'acceptEdits' | 'auto', string[]])),
    // agent `auto-edits` runs `acceptEdits`: only an `ask` ceiling needs a card for file edits.
    ...FULL_MODES.flatMap((f) => [
      ['auto-edits', 'none', f, []], ['auto-edits', 'ask', f, [W]], ['auto-edits', 'auto-edits', f, []], ['auto-edits', 'full', f, []],
    ] as Array<[ApprovalMode, ApprovalMode | 'none', 'acceptEdits' | 'auto', string[]]>),
    // agent `full` on acceptEdits: commands are still asked by Claude Code; an `ask` ceiling adds file edits.
    ['full', 'none', 'acceptEdits', []], ['full', 'ask', 'acceptEdits', [W]], ['full', 'auto-edits', 'acceptEdits', []], ['full', 'full', 'acceptEdits', []],
    // agent `full` on auto (treated as never asking): the ceiling's whole card set is Legion's.
    ['full', 'none', 'auto', []], ['full', 'ask', 'auto', ALL4], ['full', 'auto-edits', 'auto', ADD3], ['full', 'full', 'auto', []],
  ]
  assert.equal(table.length, 24)
  for (const [agent, ceiling, fullMode, extra] of table) {
    const effective = ceiling === 'none' ? agent : stricterMode(agent, ceiling)
    for (const c of Object.keys(TOOLS) as Cls[]) {
      assert.equal(extraAsk(effective, agent, TOOLS[c], fullMode), extra.includes(c), `agent=${agent} ceiling=${ceiling} full=${fullMode} tool=${c}`)
    }
  }
})
