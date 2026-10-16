/**
 * `estimateTokens` counts with the o200k_base vocabulary, not bytes / 4.
 *
 * The compaction trigger, the turn budget and the tool-definition cost all lean on this number. Bytes / 4 said a
 * 400-letter run of "a" was 100 tokens (a real tokenizer says about 50) and called a plain English sentence 11 tokens
 * when it is 9. The facts pinned here are the published o200k_base counts for well-known strings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { estimateTokens, messageTokens, messagesTokens } from '../src/core/providers/compaction.js';
import type { ChatMessage } from '../src/core/providers/types.js';

test('ASCII: short English text is counted by the real vocabulary', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('hello world'), 2, 'two words, two tokens (bytes / 4 said 3)');
  assert.equal(estimateTokens('The quick brown fox jumps over the lazy dog'), 9, 'bytes / 4 said 11');
});

test('ASCII: a long run of one letter is cheaper than bytes / 4 says', () => {
  assert.ok(estimateTokens('a'.repeat(400)) < 80, `400 "a" estimated at ${estimateTokens('a'.repeat(400))}; bytes / 4 gave 100`);
  assert.ok(estimateTokens('a'.repeat(400)) > 0);
});

test('CJK: ideographs and kana are counted by the vocabulary and never rounded down to nothing', () => {
  const jp = '今日は天気がいいので、散歩に行きましょう。';
  assert.equal(estimateTokens(jp), countTokens(jp));
  assert.ok(estimateTokens(jp) >= jp.length / 3, 'at worst a few characters share a token');
  const zh = '数据库连接失败，请检查网络设置后重试。'.repeat(20);
  assert.ok(estimateTokens(zh) >= zh.length / 3 && estimateTokens(zh) <= zh.length * 2, `${zh.length} CJK characters estimated at ${estimateTokens(zh)}`);
});

test('code: source text is counted by the vocabulary (punctuation and indentation included)', () => {
  const code = [
    'export function clamp(v: number, lo: number, hi: number): number {',
    '  if (v < lo) return lo;',
    '  return v > hi ? hi : v;',
    '}',
  ].join('\n');
  assert.equal(estimateTokens(code), countTokens(code));
  assert.ok(estimateTokens(code) < Math.ceil(Buffer.byteLength(code) / 3), 'and it is not the old byte count');
});

test('a message still costs its text plus the role overhead, and the sum is the sum of the messages', () => {
  const m: ChatMessage = { role: 'user', content: 'hello world' };
  assert.equal(messagesTokens([m, m]), 2 * (4 + 2));
});

test('a very long single block finishes quickly and still gets a sane figure', () => {
  const big = 'x'.repeat(2_000_000);
  const t0 = performance.now();
  const n = estimateTokens(big);
  const ms = performance.now() - t0;
  assert.ok(n > 10_000 && n <= 2_000_000, `estimated ${n}`);
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test('a long unbroken run under the exact limit is not quadratic', () => {
  const run = '='.repeat(30_000);
  const t0 = performance.now();
  const n = estimateTokens(run);
  const ms = performance.now() - t0;
  assert.ok(n > 100, `estimated ${n}`);
  assert.ok(ms < 500, `took ${Math.round(ms)} ms (one piece of 30,000 took over a second)`);
});

test('a block over the exact limit is scaled from its head and tail, close to the full count', () => {
  const para = 'Compaction summarises older turns so the conversation fits the window.\n';
  const text = para.repeat(2_000);
  const exact = countTokens(text);
  const est = estimateTokens(text);
  assert.ok(Math.abs(est - exact) / exact < 0.05, `estimated ${est}, full count ${exact}`);
});

test('messageTokens follows a message whose text changes', () => {
  const m: ChatMessage = { role: 'user', content: 'hello world' };
  const before = messageTokens(m);
  m.content = 'hello world '.repeat(50);
  assert.ok(messageTokens(m) > before + 50);
});

test('a message with tool calls follows an argument edited in place', () => {
  const m: ChatMessage = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] };
  const before = messageTokens(m);
  m.tool_calls![0]!.function.arguments = JSON.stringify({ path: 'src/core/providers/compaction.ts'.repeat(20) });
  assert.ok(messageTokens(m) > before + 20);
});
