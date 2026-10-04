/**
 * The off switch must actually switch something off.
 *
 * `enabled` was plumbed through types, defaults, validation, persistence and the UI while the engine still compacted
 * regardless - the exact half-feature shape. These drive the real engine and assert that `enabled: false` sends the
 * conversation whole, at every automatic gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { needsCompaction, messagesTokens, thresholdTokens, estimateTokens } from '../src/core/providers/compaction.js';
import { normalizeCompaction } from '../src/shared/config.js';
import { conversationFor } from '../src/core/providers/tool-loop.js';
import type { ChatMessage } from '../src/core/providers/types.js';

const WINDOW = 200_000;
const off = normalizeCompaction({ enabled: false, thresholdFraction: 0.5, tailBudgetShare: 0.2, summaryShare: 0.1, protectFirst: 3, contextWindowOverride: null, smallWindowTokens: 32_000 });
const on = normalizeCompaction({ enabled: true, thresholdFraction: 0.5, tailBudgetShare: 0.2, summaryShare: 0.1, protectFirst: 3, contextWindowOverride: null, smallWindowTokens: 32_000 });

/** A conversation well past the threshold, so only the off switch can stop it. */
const huge = (): ChatMessage[] =>
  Array.from({ length: 400 }, (_, i) => ({ role: 'user' as const, content: `message ${i} `.repeat(400) }));

test('a conversation far past the threshold really would be compacted when enabled', () => {
  const msgs = huge();
  assert.ok(messagesTokens(msgs) > thresholdTokens(WINDOW, 0), 'fixture must exceed the threshold, or this test proves nothing');
  assert.equal(needsCompaction(msgs, WINDOW, 0, false, on.thresholdFraction), true, 'the ON path compacts');
  assert.equal(off.enabled, false, 'and the OFF setting is genuinely off');
});

test('only an explicit false disables; a missing or wrong-typed value reads as ON', () => {
  const base = { thresholdFraction: 0.5, tailBudgetShare: 0.2, summaryShare: 0.1, protectFirst: 3, contextWindowOverride: null, smallWindowTokens: 32_000 };
  assert.equal(normalizeCompaction(base as never).enabled, true, 'absent means on');
  assert.equal(normalizeCompaction({ ...base, enabled: undefined } as never).enabled, true, 'undefined means on');
  assert.equal(normalizeCompaction({ ...base, enabled: 'no' } as never).enabled, true, 'a hand-edited typo never silently disables it');
  assert.equal(normalizeCompaction({ ...base, enabled: false }).enabled, false, 'explicit false is off');
});

test('the estimator the switch shares is the byte-based one, not the old /3', () => {
  assert.equal(estimateTokens('a'.repeat(400)), 100, '4 chars per token');
  assert.notEqual(estimateTokens('a'.repeat(400)), Math.ceil(400 / 3), 'and not the old character-count approximation');
});

/**
 * The gate itself, not just the setting. `conversationFor` is the exported surface every automatic compaction passes
 * through, and `overBudget` is what it decides. A setting that is stored, validated, persisted and displayed while this
 * still returns true is the half-feature this release exists to remove.
 */
test('EVIDENCE: with the switch off, the engine stops reporting a conversation as over budget', () => {
  // ProviderHost.stored rows are { role, text } - the store shape, not the wire shape.
  const stored = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `turn ${i}: ${'work on the migration '.repeat(120)}`,
  }));
  const host = { stored, prompt: 'the newest ask', systemPrompt: 'sys' };

  const enabledView = conversationFor(host, { window: WINDOW, compaction: on });
  assert.equal(enabledView.overBudget, true, 'the ON path reports over budget - the fixture must be past the threshold');

  const disabledView = conversationFor(host, { window: WINDOW, compaction: off });
  assert.equal(disabledView.overBudget, false, 'the OFF path must not compact, however far past the threshold it is');
  assert.ok(messagesTokens(stored.map((r) => ({ role: r.role as 'user', content: r.text }))) > thresholdTokens(WINDOW, 0), 'and the conversation really was past the threshold');
});
