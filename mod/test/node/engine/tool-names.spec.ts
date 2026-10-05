import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_TYPE_PREFIX, BOARD_TOOLS, BRIDGE_TOOLS, COMMS_TOOLS, DROPPED_DESKTOP_TOOL, HOUSE_TOOLS, KG_TOOLS, MOD_TOOL_NAMES, TOOL_PREFIX,
  isLegionModTool, modTool, toModToolNames,
} from '../../../src/engine/tool-names.ts'
import { between, readRepo } from './_src.ts'

test('isLegionModTool: exact server, plain tool name (desktop isLegionTool rule)', () => {
  const cases: Array<[string, boolean]> = [
    ['mcp__legion-mod__agents', true],
    ['mcp__legion-mod__kg_recall', true],
    ['mcp__legion-mod__board_delete', true],
    ['mcp__legion-mod__x__run', false], // another server's tool whose name starts with legion-mod__x
    ['mcp__legion-mod__', false],
    ['mcp__legion-mod__Ask', false],
    ['mcp__legion-mod__9x', false],
    ['mcp__legion-modx__ask', false],
    ['mcp__legion__ask', false], // the desktop's name is not the mod's
    ['mcp__legion_kg__kg_recall', false],
    ['Bash', false],
    ['xmcp__legion-mod__ask', false],
  ]
  for (const [name, want] of cases) assert.equal(isLegionModTool(name), want, name)
  for (const t of MOD_TOOL_NAMES) assert.equal(isLegionModTool(modTool(t)), true, t)
  assert.equal(TOOL_PREFIX, 'mcp__legion-mod__')
})

test('toModToolNames: maps each desktop server, leaves VM, Blender, ask and tell, is idempotent', () => {
  const cases: Array<[string, string]> = [
    ['use mcp__legion__agents, mcp__legion__ask and mcp__legion__tell.', 'use mcp__legion-mod__agents, mcp__legion__ask and mcp__legion__tell.'], // ask/tell are the Agent tool now
    ['mcp__legion_comms__bot_send', 'mcp__legion-mod__bot_send'],
    ['mcp__legion_kg__kg_upsert_node', 'mcp__legion-mod__kg_upsert_node'],
    ['mcp__legion_house__house_read', 'mcp__legion-mod__house_read'],
    ['mcp__legion_board__list and mcp__legion_board__delete', 'mcp__legion-mod__board_list and mcp__legion-mod__board_delete'],
    ['mcp__legion__vm_exec', 'mcp__legion__vm_exec'],
    ['mcp__legion__vm_* tools', 'mcp__legion__vm_* tools'],
    ['mcp__legion_blender__blender_exec', 'mcp__legion_blender__blender_exec'],
    ['mcp__legion__unknown_thing', 'mcp__legion__unknown_thing'],
    ['no tools here', 'no tools here'],
  ]
  for (const [input, want] of cases) {
    assert.equal(toModToolNames(input), want, input)
    assert.equal(toModToolNames(toModToolNames(input)), want, `idempotent: ${input}`)
  }
})

/** Every desktop Legion tool name written in a source text. */
const desktopNames = (src: string): string[] => [...new Set([...src.matchAll(/mcp__legion(?:_[a-z]+)?__[a-z_]*/g)].map((m) => m[0]))]

test('every desktop tool name in the roster prompts and LEGION_PREAMBLE is mapped to a mod tool or deliberately dropped', () => {
  const roster = readRepo('mod/vendor/legion/src/core/roster.ts')
  const preamble = between(readRepo('src/core/engine.ts'), 'export const LEGION_PREAMBLE = [', '].join')
  const names = [...desktopNames(roster), ...desktopNames(preamble)]
  assert.ok(names.length >= 8, `found ${names.length} names; the sources moved?`)
  for (const n of names) {
    if (DROPPED_DESKTOP_TOOL.test(n)) { assert.match(n, /vm_|blender|^mcp__legion__(ask|tell)$/, n); continue }
    const mapped = toModToolNames(n)
    assert.ok(mapped.startsWith(TOOL_PREFIX), `${n} -> ${mapped}`)
    assert.ok(MOD_TOOL_NAMES.includes(mapped.slice(TOOL_PREFIX.length)), `${n} -> ${mapped} is not a mod tool name`)
  }
})

test('the reserved names match the desktop tool servers', () => {
  const declared = (rel: string) => [...readRepo(rel).matchAll(/^\s+'([a-z_]+)',\s*$/gm)].map((m) => m[1])
  assert.deepEqual([...KG_TOOLS].sort(), declared('src/core/kg/tools.ts').sort())
  assert.deepEqual([...COMMS_TOOLS].sort(), declared('src/core/comms/tools.ts').sort())
  assert.deepEqual([...HOUSE_TOOLS].sort(), declared('src/core/house/tools.ts').sort())
  const board = [...readRepo('src/core/projects/board/tools.ts').matchAll(/= tool\('([a-z]+)'/g)].map((m) => `board_${m[1]}`)
  assert.deepEqual([...BOARD_TOOLS].sort(), board.sort())
  assert.deepEqual([...BRIDGE_TOOLS], ['agents'])
  assert.equal(AGENT_TYPE_PREFIX, 'legion-mod:')
  assert.equal(new Set(MOD_TOOL_NAMES).size, MOD_TOOL_NAMES.length, 'no duplicate names')
})
