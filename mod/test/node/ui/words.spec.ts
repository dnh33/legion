import { test } from 'node:test'
import assert from 'node:assert/strict'
import { counts, currentTool, NEVER, nowVerb } from '../../../src/ui/words.ts'
import { card, task } from './fixtures.ts'

const glyph = (name: string): string => ({ Scout: '◎', Builder: '⌘' } as Record<string, string>)[name] ?? '●'

test('words R2: what a task does now is a verb from its current tool', () => {
  assert.equal(nowVerb({ name: 'Read', summary: '{"file_path":"src/ui/text.ts"}' }, false, glyph), 'reading text.ts')
  assert.equal(nowVerb({ name: 'Grep', summary: '{"pattern":"clock"}' }, false, glyph), 'reading clock')
  assert.equal(nowVerb({ name: 'Edit', summary: 'test/replay.test.ts' }, false, glyph), 'editing replay.test.ts')
  assert.equal(nowVerb({ name: 'Write', summary: 'C:\\work\\notes.md' }, false, glyph), 'editing notes.md')
  assert.equal(nowVerb({ name: 'Bash', summary: 'npm test -- replay' }, false, glyph), 'running `npm test -- replay`')
  assert.match(nowVerb({ name: 'Bash', summary: 'x'.repeat(200) }, false, glyph, 28), /^running `x+…`$/)
  assert.equal(nowVerb({ name: 'Agent', summary: 'Ask Scout: check the engines field' }, false, glyph), 'asking ◎ Scout')
  assert.equal(nowVerb({ name: 'Agent', summary: 'Tell Builder: fix the test' }, false, glyph), 'handing to ⌘ Builder')
  assert.equal(nowVerb({ name: 'WebFetch', summary: '{"url":"https://example.com"}' }, false, glyph), 'reading the web')
  assert.equal(nowVerb(undefined, false, glyph), 'thinking')
  assert.equal(nowVerb({ name: 'Bash', summary: 'rm -rf build' }, true, glyph), 'needs your OK')
})

test('words R2: the current tool is the newest one still working, not one an answer came after', () => {
  const tool = (state: 'running' | 'ok' | 'awaiting', name = 'Edit') => ({ id: name + state, role: 'tool' as const, text: '', tool: { name, summary: 'a.ts', state }, at: 1 })
  assert.equal(currentTool([tool('ok'), tool('running', 'Read')])?.name, 'Read')
  assert.equal(currentTool([tool('running'), tool('ok', 'Read')]), undefined)
  assert.equal(currentTool([tool('running'), { id: 'a', role: 'assistant', text: 'done', at: 2 }]), undefined)
  assert.equal(currentTool([tool('awaiting', 'Bash')])?.name, 'Bash')
  assert.equal(currentTool(undefined), undefined)
})

test('words R1: one count function; queued and paused are not "working"', () => {
  const c = counts([task('a', 'x', 'running'), task('b', 'x', 'running'), task('c', 'x', 'queued'), task('d', 'x', 'paused'), task('e', 'x', 'done')], [card('c1', 'a', 'x')])
  assert.deepEqual(c, { working: 2, queued: 1, paused: 1, needsYou: 1 })
})

test('words R11: the never-list catches each glossary "Never" word and lets the named exemptions through', () => {
  const hit = (text: string): string[] => NEVER.filter(n => n.re.test(text)).map(n => n.word)
  assert.deepEqual(hit('3 running'), ['running (state)'])
  assert.deepEqual(hit('running `npm test`'), [])
  assert.deepEqual(hit('It runs on your computer'), [])
  assert.deepEqual(hit('Run failed'), ['run (noun)'])
  assert.deepEqual(hit('1 approval waiting').sort(), ['approval', 'waiting'])
  assert.deepEqual(hit('Awaiting your word'), ['awaiting your word'])
  assert.deepEqual(hit('cost: $0.21'), ['cost:', '$ without ≈'])
  assert.deepEqual(hit('≈$0.21 · <≈$0.01'), [])
  assert.deepEqual(hit('Told Builder'), ['told'])
  assert.deepEqual(hit('Finished tasks'), ['finished'])
})
