/**
 * The compaction trigger's two arithmetic rules, pinned against the reference implementation.
 *
 * Both rules were wrong in the same direction: the engine compacted EARLIER than the reference on almost every model,
 * and the token estimator counted characters instead of UTF-8 bytes, under-counting CJK by ~4.5x. These tests are
 * written as evidence, not smoke: each one names the defect and was observed failing against the unfixed code before
 * the fix landed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateTokens, MAX_THRESHOLD_FRACTION, messagesTokens, needsCompaction,
  SMALL_WINDOW_FLOOR, SMALL_WINDOW_LIMIT, thresholdFor, thresholdTokens, usableWindow,
} from '../src/core/providers/compaction.js';
import type { ChatMessage } from '../src/core/providers/types.js';

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

// ---------------------------------------------------------------- 1. raise-only floor
test('the small-window floor is RAISE-ONLY: a configured threshold can never push compaction below it', () => {
  // The constants match the reference (context_compressor.py _SMALL_CTX_WINDOW_LIMIT / _SMALL_CTX_THRESHOLD_PERCENT).
  assert.equal(SMALL_WINDOW_LIMIT, 512_000, 'the boundary is 512k, not 32k');
  assert.equal(SMALL_WINDOW_FLOOR, 0.75, 'the floor is 75%, matching the reference');
  // A requested threshold BELOW the floor is raised to the floor.
  assert.equal(thresholdFor(100_000, 0.5), 0.75, 'a 0.5 request under 512k still fires at 0.75');
  assert.equal(thresholdFor(100_000, 0.35), 0.75, 'even the old small-window 0.35 cannot lower it');
  assert.equal(thresholdFor(16_384, 0.1), 0.75);
  // A request ABOVE the floor passes through unchanged — raise-only, never lowered.
  assert.equal(thresholdFor(100_000, 0.8), 0.8);
  // At and above the boundary there is no floor at all.
  assert.equal(thresholdFor(512_000, 0.5), 0.5, 'at the boundary the requested value is returned unchanged');
  assert.equal(thresholdFor(1_000_000, 0.5), 0.5);
  assert.equal(thresholdFor(1_000_000, 0.4), 0.4);
  // The cap above the floor still holds, and nothing can exceed it.
  assert.equal(thresholdFor(1_000_000, 0.95), MAX_THRESHOLD_FRACTION);
  assert.equal(thresholdFor(100_000, 0.95), MAX_THRESHOLD_FRACTION);
  assert.ok(thresholdFor(100_000, 5) <= MAX_THRESHOLD_FRACTION, 'nothing ever exceeds the cap');
});

// ---------------------------------------------------------------- 2. table of real model sizes
test('the trigger fraction per real model size, and the absolute trigger scales with the usable window', () => {
  const cases: Array<[number, number]> = [
    [16_384, 0.75],
    [32_768, 0.75],
    [128_000, 0.75],
    [200_000, 0.75],
    [512_000, 0.5],
    [1_000_000, 0.5],
  ];
  for (const [window, expected] of cases) {
    assert.equal(thresholdFor(window, 0.5), expected, `window ${window} should fire at ${expected}`);
    assert.equal(
      thresholdTokens(window, 0),
      Math.max(200, Math.round(Math.max(1, usableWindow(window)) * expected)),
      `thresholdTokens for window ${window}`,
    );
  }
});

// ---------------------------------------------------------------- 3. EVIDENCE: fires later
test('EVIDENCE: with the floor, a conversation that used to compact now rides to 75% instead of 50%', () => {
  const WINDOW = 131_072;
  const usable = usableWindow(WINDOW);
  const oldTrigger = Math.round(usable * 0.5);
  const floorTrigger = Math.round(usable * 0.75);
  const turn = 'work on the migration '.repeat(200);
  const convo = (count: number): ChatMessage[] =>
    Array.from({ length: count }, (_, i) => msg(i % 2 ? 'assistant' : 'user', turn));
  const per = messagesTokens(convo(1));

  // Sized to land between the old 0.5 trigger and the new 0.75 floor.
  const atOldThreshold = convo(Math.ceil((oldTrigger * 1.1) / per));
  const n = messagesTokens(atOldThreshold);
  assert.ok(n > oldTrigger, `sanity: this conversation is over the OLD trigger (${n} > ${oldTrigger})`);
  assert.ok(n < floorTrigger, `sanity: and under the new floor (${n} < ${floorTrigger})`);
  assert.equal(needsCompaction(atOldThreshold, WINDOW), false, 'it no longer compacts where it used to compact');

  // The floor is higher, not infinite: past 75% it still compacts.
  assert.equal(needsCompaction(convo(Math.ceil((floorTrigger * 1.1) / per)), WINDOW), true, 'and it still compacts once it passes the floor');
});

// ---------------------------------------------------------------- 4. estimator: real tokens
test('estimateTokens counts vocabulary tokens, not characters or code units', () => {
  assert.equal(estimateTokens(''), 0);
  // 400 letters in a row pack into about 50 tokens; bytes / 4 said 100, the old code-unit rule ~134.
  assert.ok(estimateTokens('a'.repeat(400)) < 100);

  // CJK: an ideograph is about one token, never a third of one (the old /3 rule).
  const cjk = '中'.repeat(100);
  assert.ok(estimateTokens(cjk) >= 50, `100 ideographs estimated at ${estimateTokens(cjk)}`);
  assert.ok(estimateTokens(cjk) > Math.ceil(cjk.length / 3), 'and it is demonstrably not the old character/3 count');

  // Cyrillic is two bytes a character and costs more than ASCII per character.
  assert.ok(estimateTokens('привет мир '.repeat(20)) > estimateTokens('hello world '.repeat(20)) / 2);

  // A surrogate pair (emoji) is one codepoint and two JS code units; a lone emoji costs at least a token.
  assert.ok(estimateTokens('😀'.repeat(10)) >= 5);
});

// ---------------------------------------------------------------- 5. CJK under-count guard
test('regression guard: the estimate never under-counts CJK by more than 2x', () => {
  // A CJK ideograph is near one real token; the old /3-per-char counted it as one THIRD of a token.
  for (const n of [1, 10, 100, 1_000]) {
    const cjk = '漢'.repeat(n);
    assert.ok(
      estimateTokens(cjk) >= n / 2,
      `CJK of ${n} chars estimated at ${estimateTokens(cjk)} — must stay within 2x of ${n} real tokens`,
    );
  }
  // Mixed text: the ideograph and the ASCII around it are both counted.
  assert.ok(estimateTokens('abc中'.repeat(10)) >= 20);
});
