import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESKTOP_DEFAULTS, seedAgents } from '../../../src/engine/roster.ts'
import { ROSTER } from '../../../vendor/legion/src/core/roster.ts'
import { toModToolNames } from '../../../src/engine/tool-names.ts'
import { between, literal, readRepo } from './_src.ts'

/** One field's value from a desktop seed object's source text: `field: '...'`. */
const field = (block: string, name: string): string => {
  const m = new RegExp(`\\b${name}: ('(?:[^'\\\\]|\\\\.)*')`).exec(block)
  if (!m) throw new Error(`no ${name} in block`)
  return literal(m[1]!)
}

test('the three defaults are copied from desktop src/core/store.ts seedDefaults, character for character', () => {
  const src = between(readRepo('src/core/store.ts'), 'seedDefaults(workspaceDir: string): void {', '// Muster roster')
  const blocks = src.split(/\n\s*\{\n/).slice(1)
  assert.equal(blocks.length, 3, 'three default agents in the desktop source')
  assert.equal(DESKTOP_DEFAULTS.length, 3)
  for (const [i, block] of blocks.entries()) {
    const mine = DESKTOP_DEFAULTS[i]!
    for (const f of ['id', 'name', 'emoji', 'model', 'approval', 'description', 'systemPrompt'] as const) {
      assert.equal(mine[f], field(block, f), `${mine.id}.${f}`)
    }
  }
})

test('seedAgents: thirteen agents in the desktop order, glyphs, flags, the Assayer and the Sculptor hidden', () => {
  const agents = seedAgents()
  assert.deepEqual(agents.map((a) => a.id), [
    'zealot', 'builder', 'scout', 'inquisitor', 'scribe', 'archivist', 'sentinel', 'forgemaster', 'exorcist', 'preceptor', 'herald', 'assayer', 'sculptor',
  ])
  assert.deepEqual(agents.map((a) => a.glyph).join(' '), '✠ ⌘ ◎ ⌕ ✎ ▤ ◬ ⌶ ☾ ⊥ ⚑ ⊜ ◈')
  assert.deepEqual(agents.filter((a) => a.isHidden).map((a) => a.id), ['assayer', 'sculptor'])
  assert.ok(agents.every((a) => a.isRoster))
  for (const a of agents) {
    const src = [...DESKTOP_DEFAULTS, ...ROSTER].find((s) => s.id === a.id)!
    assert.equal(a.name, src.name)
    assert.equal(a.description, src.description)
    assert.equal(a.model, src.model)
    assert.equal(a.approval, src.approval)
    assert.equal(a.systemPrompt, toModToolNames(src.systemPrompt))
    // no desktop server name survives except the deliberately dropped VM / Blender ones
    assert.doesNotMatch(a.systemPrompt, /mcp__legion_(comms|kg|board|house)__|mcp__legion__(agents|ask|tell)\b/, a.id)
  }
  assert.match(agents.find((a) => a.id === 'scribe')!.systemPrompt, /mcp__legion-mod__bot_send/)
  assert.match(agents.find((a) => a.id === 'archivist')!.systemPrompt, /mcp__legion-mod__kg_recall/)
})

test('seedAgents returns fresh objects: editing one call\'s result leaves the next untouched', () => {
  const a = seedAgents()
  a[0]!.name = 'Changed'
  a.pop()
  const b = seedAgents()
  assert.equal(b[0]!.name, 'Zealot')
  assert.equal(b.length, 13)
})
