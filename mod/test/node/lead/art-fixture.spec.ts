/** The kit cannot import JSON, so a plugin test carries Zealot's art as a .ts string; it must stay the shipped file, byte for byte. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ZEALOT_ART_JSON } from '../../plugin/fixtures/art-zealot.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

test('the plugin-test fixture is mod/art/zealot.json exactly', () => {
  assert.equal(ZEALOT_ART_JSON, readFileSync(join(HERE, '../../../art/zealot.json'), 'utf8'))
})
