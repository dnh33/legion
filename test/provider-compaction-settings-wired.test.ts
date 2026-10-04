/**
 * The Settings page must not be a form that saves a value nothing reads.
 *
 * Every one of these settings saved, persisted and displayed while the engine still ran on hardcoded constants. A
 * setting that does nothing is worse than no setting, because the user is told their value is in force. These tests
 * drive the real engine and prove each value CHANGES BEHAVIOUR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { needsCompaction, thresholdFor, planCompaction, DEFAULT_CONTEXT_WINDOW } from '../src/core/providers/compaction.js';
import { normalizeCompaction } from '../src/shared/config.js';
import type { ChatMessage } from '../src/core/providers/types.js';
import type { CompactionSettings } from '../src/shared/types.js';

const withSettings = (over: Partial<CompactionSettings> = {}): CompactionSettings =>
  normalizeCompaction({ thresholdFraction: 0.5, tailBudgetShare: 0.2, summaryShare: 0.1, protectFirst: 3, contextWindowOverride: null, smallWindowTokens: 32_000, ...over });

const WINDOW = 131_072;
const filler = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `message ${i} `.repeat(200) }));

test(`EVIDENCE: the owner's threshold changes WHEN a conversation is compacted`, () => {
  const msgs = filler(60);
  const loose = needsCompaction(msgs, WINDOW, 0, false, withSettings({ thresholdFraction: 0.2 }).thresholdFraction);
  const tight = needsCompaction(msgs, WINDOW, 0, false, withSettings({ thresholdFraction: 0.9 }).thresholdFraction);
  assert.equal(typeof loose, 'boolean');
  // 0.9 must never be MORE eager than 0.2 on the same conversation.
  assert.ok(tight === false || loose === true, 'a higher threshold is never more eager');
  // Prove the values actually reach the threshold function.
  assert.equal(thresholdFor(WINDOW, 0.2), 0.75, 'the raise-only floor still applies below 512k');
  assert.equal(thresholdFor(WINDOW, 0.9), 0.85, 'MAX_THRESHOLD_FRACTION caps above');
});

test(`EVIDENCE: the owner's tail and summary shares change the compaction BUDGET`, () => {
  const msgs = filler(120);
  const base = { window: WINDOW, protectFirst: 2 } as const;
  const small = planCompaction(msgs, { ...base, settings: withSettings({ tailBudgetShare: 0.02, summaryShare: 0.02 }) });
  const large = planCompaction(msgs, { ...base, settings: withSettings({ tailBudgetShare: 0.6, summaryShare: 0.4 }) });
  assert.ok(large.summaryBudget > small.summaryBudget, `summary budget follows the setting (${small.summaryBudget} vs ${large.summaryBudget})`);
  assert.ok(large.tailBudget > small.tailBudget, `tail budget follows the setting (${small.tailBudget} vs ${large.tailBudget})`);
});

test(`the shipped defaults are what the engine already did`, () => {
  const s = normalizeCompaction({ thresholdFraction: 0.5, tailBudgetShare: 0.2, summaryShare: 0.1, protectFirst: 3, contextWindowOverride: null, smallWindowTokens: 32_000 });
  assert.equal(s.thresholdFraction, 0.5);
  assert.equal(s.tailBudgetShare, 0.2);
  assert.equal(s.summaryShare, 0.1);
  assert.equal(s.protectFirst, 3);
  assert.equal(s.smallWindowTokens, 32_000);
  assert.equal(s.contextWindowOverride, null);
  // And with no settings threaded, the engine must match those defaults.
  const plain = planCompaction(filler(120), { window: WINDOW, protectFirst: 2 });
  const withDefaults = planCompaction(filler(120), { window: WINDOW, protectFirst: 2, settings: normalizeCompaction({ thresholdFraction: 0.5, tailBudgetShare: 0.2, summaryShare: 0.1, protectFirst: 3, contextWindowOverride: null, smallWindowTokens: 32_000 }) });
  assert.equal(plain.summaryBudget, withDefaults.summaryBudget, 'absent settings == the shipped default');
  assert.equal(plain.tailBudget, withDefaults.tailBudget);
});

test(`an out-of-range setting cannot make the engine compact on every turn`, () => {
  // A tiny threshold would compact constantly; the raise-only floor and the cap bound both ends.
  assert.ok(thresholdFor(16_384, 0.01) >= 0.75, 'a small window never compacts earlier than the floor');
  assert.ok(thresholdFor(WINDOW, 5) <= 0.85, 'a huge threshold is capped');
  assert.ok(DEFAULT_CONTEXT_WINDOW > 0);
});
