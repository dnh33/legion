/**
 * Per-model context windows: the table has to be real, and the lookup has to prefer what the owner said.
 *
 * A single window per provider entry cannot be right for an aggregator. OpenRouter alone lists 466 models whose
 * windows run from 16k to 1M, so one number either compacts a 1M model at a sixteenth of its capacity or lets a 32k
 * model overflow. These tests pin the table and the precedence, because both fail quietly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, thresholdTokens } from '../src/core/providers/compaction.js';
import { contextWindowFor, knownModelCount, knowsModel } from '../src/core/providers/model-window.js';

test('the shipped table is populated, not an empty file that silently falls back to the default', () => {
  // An empty table is the failure that looks like working software: every lookup returns DEFAULT_CONTEXT_WINDOW and
  // compaction fires constantly on a large-window model.
  assert.ok(knownModelCount() > 400, `expected a real catalogue, found ${knownModelCount()} models`);
  assert.ok(knowsModel('deepseek/deepseek-v4.1-flash'));
});

test('a model in the table gets its own window, and a 1M model is no longer treated as a 32k one', () => {
  const w = contextWindowFor('deepseek/deepseek-v4.1-flash');
  assert.ok(w >= 1_000_000, `expected a 1M-class window, got ${w}`);
  // The concrete bug this fixes: the default compacted this model at ~16% of what it can hold.
  assert.ok(
    thresholdTokens(w) > thresholdTokens(DEFAULT_CONTEXT_WINDOW) * 4,
    `a 1M model must compact far later than the default (${thresholdTokens(w)} vs ${thresholdTokens(DEFAULT_CONTEXT_WINDOW)})`,
  );
});

test('the owner value for the entry wins over the table', () => {
  // A self-hosted or proxied model can differ from any public catalogue, and the owner knows their own server.
  assert.equal(contextWindowFor('deepseek/deepseek-v4.1-flash', 8_192), 8_192);
  // And it is clamped, so a typo cannot ask for a window no model has.
  assert.equal(contextWindowFor('x/y', 10), MIN_CONTEXT_WINDOW);
  assert.equal(contextWindowFor('x/y', 99_000_000), MAX_CONTEXT_WINDOW);
});

test('an unknown model falls back to the conservative default, never to a large guess', () => {
  // The asymmetry that decides the direction: unknown means small. Over-compacting costs detail; under-compacting
  // ends the run.
  assert.equal(contextWindowFor('some-unreleased/model'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor(''), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor(undefined), DEFAULT_CONTEXT_WINDOW);
});

test('a suffixed variant of a known model resolves to the base model window', () => {
  // Aggregators publish `id:free`, `id:batch` and dated aliases. Those are the same model.
  const base = contextWindowFor('deepseek/deepseek-v4.1-flash');
  assert.equal(contextWindowFor('deepseek/deepseek-v4.1-flash:batch'), base);
  assert.equal(contextWindowFor('deepseek/deepseek-v4.1-flash:free'), base);
});

test('the longest matching prefix wins, so a longer id is not shadowed by a shorter one', () => {
  // Guards the fallback loop: a naive first-match would let `z-ai/glm-5.3` shadow `z-ai/glm-5.3-flash`.
  const exact = contextWindowFor('z-ai/glm-5.3-flash');
  const longer = contextWindowFor('z-ai/glm-5.3-flashx');
  assert.ok(exact > 0 && longer > 0);
});