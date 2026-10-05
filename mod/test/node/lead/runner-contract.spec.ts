/** legion-mod and legion-mod-runner read each other's state, so RunRequest and RunResult must be declared identically in both contracts. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const shared = (text: string): string => {
  const a = text.indexOf('/** A lifecycle request')
  const b = text.indexOf('/** What the runner did with one request')
  const end = text.indexOf('\n}\n', b)
  assert.ok(a >= 0 && b > a && end > b, 'shared block markers not found')
  return text.slice(a, end + 2)
}

test('RunRequest and RunResult are identical in both plugin contracts', () => {
  assert.equal(shared(read('../../../types/index.d.ts')), shared(read('../../../../mod-runner/types/index.d.ts')))
})
