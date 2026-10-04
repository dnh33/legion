/**
 * The compaction settings block: its defaults, its normalization, and the mapper the provider seam consumes.
 *
 * The drift guard here is the point: DEFAULT_COMPACTION is a set of literals in shared/config.ts, and the provider
 * path used to hardcode the same numbers in compaction.ts. If the two ever diverge, the "default" the Settings UI
 * shows stops being the behaviour a run actually gets — a setting that lies. This test fails the moment they drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACTION_THRESHOLD, PROTECT_FIRST, SMALL_WINDOW_TOKENS, SUMMARY_WINDOW_FRACTION, TAIL_MAX_WINDOW_FRACTION,
} from '../src/core/providers/compaction.js';
import { COMPACTION_LIMITS, DEFAULT_COMPACTION, compactionFor, defaultConfig, normalizeCompaction } from '../src/shared/config.js';

test('compaction defaults equal the provider constants they replace (drift guard)', () => {
  assert.equal(DEFAULT_COMPACTION.thresholdFraction, COMPACTION_THRESHOLD);
  assert.equal(DEFAULT_COMPACTION.tailBudgetShare, TAIL_MAX_WINDOW_FRACTION);
  assert.equal(DEFAULT_COMPACTION.summaryShare, SUMMARY_WINDOW_FRACTION);
  assert.equal(DEFAULT_COMPACTION.protectFirst, PROTECT_FIRST);
  assert.equal(DEFAULT_COMPACTION.smallWindowTokens, SMALL_WINDOW_TOKENS);
  assert.equal(DEFAULT_COMPACTION.contextWindowOverride, null);
});

test('normalizeCompaction: absent, wrong-typed and out-of-range all fall back to defaults; valid values pass through', () => {
  assert.deepEqual(normalizeCompaction(undefined), DEFAULT_COMPACTION);
  assert.deepEqual(normalizeCompaction({}), DEFAULT_COMPACTION);
  assert.deepEqual(
    normalizeCompaction({ thresholdFraction: 0.05, protectFirst: 2.5, smallWindowTokens: 'big', contextWindowOverride: 12 }),
    DEFAULT_COMPACTION,
    'out-of-range and wrong-typed values are dropped to defaults, never clamped',
  );
  assert.deepEqual(
    normalizeCompaction({ thresholdFraction: 0.9, tailBudgetShare: 0.5, summaryShare: 0.3, protectFirst: 20, contextWindowOverride: 1_000_000, smallWindowTokens: 4_096 }),
    // enabled is part of the shape now, and normalise always emits it: an absent value means ON.
    { enabled: true, thresholdFraction: 0.9, tailBudgetShare: 0.5, summaryShare: 0.3, protectFirst: 20, contextWindowOverride: 1_000_000, smallWindowTokens: 4_096 },
  );
  assert.deepEqual(normalizeCompaction({ protectFirst: 5 }), { ...DEFAULT_COMPACTION, protectFirst: 5 }, 'a partial block fills the rest from defaults');
  assert.equal(normalizeCompaction({ contextWindowOverride: null }).contextWindowOverride, null, 'an explicit null override is kept');
});

test('compactionFor: the mapper the provider seam calls always returns a complete, valid object', () => {
  assert.deepEqual(compactionFor(defaultConfig()), DEFAULT_COMPACTION);
  assert.deepEqual(compactionFor({ compaction: { thresholdFraction: 0.3 } as never }), { ...DEFAULT_COMPACTION, thresholdFraction: 0.3 });
});

test('COMPACTION_LIMITS covers every field and matches the documented ranges', () => {
  assert.deepEqual(COMPACTION_LIMITS, {
    thresholdFraction: { min: 0.1, max: 0.95 },
    tailBudgetShare: { min: 0.02, max: 0.6 },
    summaryShare: { min: 0.02, max: 0.4 },
    protectFirst: { min: 1, max: 20 },
    contextWindowOverride: { min: 4_096, max: 4_000_000 },
    smallWindowTokens: { min: 4_096, max: 4_000_000 },
  });
});
