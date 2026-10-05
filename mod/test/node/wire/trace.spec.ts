import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_LINES, TEXT_MAX, cut, newTrace, record, traceFile, traceText } from '../../../src/wire/trace.ts'

test('trace off: nothing is kept, nothing is dirty', () => {
  const t = newTrace(false)
  assert.equal(record(t, { t: 1, k: 'cmd', command: 'to' }), false)
  assert.equal(t.lines.length, 0)
  assert.equal(t.isDirty, false)
  assert.equal(traceText(t), '')
})

test('trace on: text is cut to one line of TEXT_MAX, undefined fields are left out, JSON lines end with a newline', () => {
  const t = newTrace(true)
  record(t, { t: 5, k: 'tool', tool: 'Bash', summary: 'x'.repeat(500) + '\n\nmore', error: undefined })
  const line = t.lines[0]!
  assert.equal((line.summary as string).length, TEXT_MAX)
  assert.ok((line.summary as string).endsWith('…'))
  assert.equal('error' in line, false)
  assert.ok(traceText(t).endsWith('\n'))
  assert.deepEqual(JSON.parse(traceText(t).trim()).k, 'tool')
  assert.equal(cut('a\n  b'), 'a b')
})

test('trace keeps the last MAX_LINES lines only', () => {
  const t = newTrace(true)
  for (let i = 0; i < MAX_LINES + 10; i++) record(t, { t: i, k: 'step', n: i })
  assert.equal(t.lines.length, MAX_LINES)
  assert.equal(t.lines[0]!.n, 10)
})

test('trace file names are safe and per session', () => {
  assert.equal(traceFile('05fc-ba2e'), 'debug/trace-05fc-ba2e.jsonl')
  assert.equal(traceFile('a/b\\c'), 'debug/trace-a_b_c.jsonl')
})
