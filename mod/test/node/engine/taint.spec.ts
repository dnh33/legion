import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLEAN_BUILTINS, taintsRun } from '../../../src/engine/taint.ts'
import { between, readRepo, stringLiterals } from './_src.ts'

test('CLEAN_BUILTINS equals the desktop allowlist (src/core/engine.ts CLEAN_BUILTINS)', () => {
  const block = between(readRepo('src/core/engine.ts'), 'const CLEAN_BUILTINS = new Set([', ']);')
  const desktop = stringLiterals(block.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'))
  assert.ok(desktop.length > 20)
  assert.deepEqual([...CLEAN_BUILTINS].sort(), desktop.sort())
})

test('taintsRun: clean built-ins and the mod\'s own tools do not taint; everything else does', () => {
  const cases: Array<[string, boolean]> = [
    ['Read', false], ['Edit', false], ['TaskStop', false], ['Monitor', false],
    ['mcp__legion-mod__ask', false], ['mcp__legion-mod__kg_capture', false],
    ['Bash', true], ['WebFetch', true], ['WebSearch', true], ['SendMessage', true],
    ['mcp__github__get_issue', true], ['mcp__legion-mod__x__run', true], ['mcp__legion__ask', true],
    ['ReadMcpResourceTool', true], ['', true],
  ]
  for (const [name, want] of cases) assert.equal(taintsRun(name), want, name)
})
