/**
 * Regression evidence for the per-turn tool-output budget.
 *
 * THE BUG. The budget for one turn's tool output carried an ABSOLUTE floor of `MAX_TOOL_RESULT_CHARS * 2` (24_000
 * chars). On a large window that floor is correct — it keeps a single tool result from being clipped to nothing. On a
 * small-context model it is far larger than the whole compaction threshold, so ONE turn of tool output could add
 * several times the entire trigger and blow straight past it: the overflow the compaction feature exists to prevent,
 * arriving through the back door.
 *
 * The cap (MAX_TURN_TOOL_CHARS) was already correct; the floor was the defect.
 *
 * These tests assert the DISCRIMINATOR, not "a budget exists":
 *   1. On a 16k window the budget (in estimated tokens) must not exceed the compaction threshold by more than a small
 *      safe factor. The buggy floor makes this ~1.86x; the fix brings it below 1x.
 *   2. On a large window the floor must still be at least one whole tool result, so a single result is never clipped
 *      to nothing — the original reason the floor exists at all.
 *
 * Written to FAIL against the unfixed arithmetic and pass after the fix.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TOOL_RESULT_CHARS, MAX_TURN_TOOL_CHARS, turnToolBudget } from '../src/core/providers/tool-loop.js';
import { estimateTokens, MAX_CONTEXT_WINDOW, thresholdTokens } from '../src/core/providers/compaction.js';

/** A small-context model — the window the bug bites hardest on. */
const SMALL_WINDOW = 16_384;
/** A large-context model — the window where the cap must dominate and the floor must still fit one result. */
const LARGE_WINDOW = 1_000_000;

test('DISCRIMINATOR: a 16k window does not let one turn blow past its compaction trigger', () => {
  const budgetChars = turnToolBudget(SMALL_WINDOW);
  const budgetTokens = estimateTokens('x'.repeat(budgetChars));
  const threshold = thresholdTokens(SMALL_WINDOW);
  const factor = budgetTokens / threshold;
  // "by more than a small safe factor" — the budget must not materially exceed the threshold it feeds. One is the
  // strictest honest reading: a turn's own output cannot, by itself, cross the trigger. The buggy floor gives ~1.86x.
  assert.ok(factor <= 1,
    `a 16k window allows ${budgetChars} chars (${budgetTokens} est-tokens) of tool output in one turn against a ` +
    `${threshold}-token compaction threshold (${factor.toFixed(2)}x): one turn can exceed the trigger the loop is meant ` +
    'to honour, so the per-turn floor is not window-proportional');
});

test('DISCRIMINATOR: on a large window the per-result clip is still fully honoured', () => {
  const budget = turnToolBudget(LARGE_WINDOW);
  // The cap still dominates a large window.
  assert.equal(budget, MAX_TURN_TOOL_CHARS, 'the cap must not have changed');
  // The floor must fit one whole tool result, so the first result in a turn is never clipped to nothing.
  assert.ok(budget >= MAX_TOOL_RESULT_CHARS,
    `a large window budgets only ${budget} chars for a turn, below the ${MAX_TOOL_RESULT_CHARS}-char per-result clip: ` +
    'one tool result would be clipped to nothing');
});

test('the budget stays within (one whole result, cap) and grows with the window', () => {
  const windows = [SMALL_WINDOW, 32_768, 65_536, 131_072, 262_144, LARGE_WINDOW, MAX_CONTEXT_WINDOW];
  let previous = 0;
  for (const window of windows) {
    const budget = turnToolBudget(window);
    assert.ok(budget <= MAX_TURN_TOOL_CHARS, `window=${window}: budget ${budget} exceeds the ${MAX_TURN_TOOL_CHARS} cap`);
    assert.ok(budget >= MAX_TOOL_RESULT_CHARS, `window=${window}: budget ${budget} is below one whole tool result`);
    assert.ok(budget >= previous, `window=${window}: budget fell from ${previous} to ${budget} as the window grew`);
    previous = budget;
  }
  // The floor degrades: a small window gets strictly less budget than a large one.
  assert.ok(turnToolBudget(SMALL_WINDOW) < turnToolBudget(LARGE_WINDOW),
    'the floor did not degrade on a small window');

  // Sanity: the extracted function matches the constant at the boundary windows we care about.
  assert.equal(turnToolBudget(SMALL_WINDOW), MAX_TOOL_RESULT_CHARS, 'a 16k window should budget exactly one whole result');
});

test('a missing or nonsensical window never yields a zero budget', () => {
  assert.ok(turnToolBudget(0) >= MAX_TOOL_RESULT_CHARS);
  assert.ok(turnToolBudget(-100) >= MAX_TOOL_RESULT_CHARS);
});
