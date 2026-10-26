/**
 * A task paused at the turn limit must not make the mascots show a fault: the Paused card says the work is kept, and a bust
 * playing "Fault detected" (or the Relic flashing it) would say the opposite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { latestFinished } from '../ui/src/mascot/finished.js';
import { BUDGET_LIMIT_PREFIX, TOKEN_LIMIT_PREFIX, TURN_LIMIT_PREFIX, budgetCap, budgetLimitFromError, formatUsdLimit, isBudgetPause, isLimitPause, isTokenPause, isTurnLimitPause, statusDot, tokenStopFromError, tokenStopText } from '../src/shared/continue.js';

const paused = { agentId: 'a1', status: 'error', error: `${TURN_LIMIT_PREFIX} (200 turns this run) before finishing.`, updatedAt: '2026-10-05T20:00:02Z' };

test('the bust does not count a turn-limit pause as a failed task', () => {
  assert.equal(latestFinished([paused], 'a1'), '');
  // an older real finish is still what counts, so a pause never turns a recent victory into a fault
  assert.equal(latestFinished([{ agentId: 'a1', status: 'done', updatedAt: '2026-10-05T20:00:00Z' }, paused], 'a1'), 'done|2026-10-05T20:00:00Z');
});

test('a real error still shows as a fault, and other agents\' tasks are ignored', () => {
  const failed = { agentId: 'a1', status: 'error', error: 'Invalid API key', updatedAt: '2026-10-05T20:00:03Z' };
  assert.equal(latestFinished([paused, failed], 'a1'), 'error|2026-10-05T20:00:03Z');
  assert.equal(latestFinished([failed], 'a2'), '');
});

test('the bust does not count a spend-limit pause as a failed task either', () => {
  const budget = { agentId: 'a1', status: 'error', error: `${BUDGET_LIMIT_PREFIX} ($5 this run) before finishing.`, updatedAt: '2026-10-05T20:00:02Z' };
  assert.equal(latestFinished([budget], 'a1'), '');
  assert.equal(latestFinished([{ agentId: 'a1', status: 'done', updatedAt: '2026-10-05T20:00:00Z' }, budget], 'a1'), 'done|2026-10-05T20:00:00Z');
});

test('the pause helpers cover both prefixes, only for a task in error, and the dot is amber for both', () => {
  const turn = { status: 'error', error: `${TURN_LIMIT_PREFIX} (200 turns this run).` };
  const budget = { status: 'error', error: `${BUDGET_LIMIT_PREFIX} ($5 this run).` };
  assert.equal(isTurnLimitPause(turn), true);
  assert.equal(isTurnLimitPause(budget), false);
  assert.equal(isBudgetPause(budget), true);
  assert.equal(isBudgetPause(turn), false);
  assert.equal(isLimitPause(turn) && isLimitPause(budget), true);
  assert.equal(statusDot(turn), 'paused');
  assert.equal(statusDot(budget), 'paused');
  // a real failure, a finished task and a missing task are not pauses
  assert.equal(isLimitPause({ status: 'error', error: 'Invalid API key' }), false);
  assert.equal(isLimitPause({ status: 'done', error: budget.error }), false);
  assert.equal(isLimitPause(undefined), false);
  assert.equal(statusDot({ status: 'error', error: 'Invalid API key' }), 'error');
});

test('the Paused card reads the amount from the error text, and shows no amount when there is none', () => {
  assert.equal(budgetLimitFromError(`${BUDGET_LIMIT_PREFIX} ($0.50 this run) before finishing.`), '$0.50');
  assert.equal(budgetLimitFromError(`${BUDGET_LIMIT_PREFIX} before finishing.`), undefined);
  assert.equal(budgetLimitFromError(undefined), undefined);
  assert.equal(formatUsdLimit(5), '$5');
  assert.equal(formatUsdLimit(0.5), '$0.50');
  assert.equal(budgetCap(0), undefined);
  assert.equal(budgetCap('x'), undefined);
  assert.equal(budgetCap(2), 2);
});

test('the token-limit stop is written and read by one rule: the text the engine writes carries a count the app reads back, separator and all', () => {
  // the engine builds the stop's error text with tokenStopText; the app's Paused card reads the count with tokenStopFromError.
  // Both take the prefix and the number format from the same place, so a change to either cannot leave the card without its count.
  const written = tokenStopText(1_200);
  assert.equal(written, 'Stopped after 1,200 tokens', 'the written stop names the count with a separator');
  assert.equal(tokenStopFromError(written), '1,200', 'the reader finds the same count the writer wrote');
  assert.equal(tokenStopFromError(tokenStopText(999)), '999', 'a count under a thousand has no separator, and is still read');
  assert.equal(tokenStopFromError(tokenStopText(1_234_567)), '1,234,567', 'every group is separated, and read back');
  // a stop that is not this one is not a token stop
  assert.equal(tokenStopFromError(undefined), undefined);
  assert.equal(tokenStopFromError(`Paused at the turn limit (200 turns this run)`), undefined);
  assert.equal(tokenStopFromError('Stopped after 12 model turns without a final answer.'), undefined, 'a turn stop names turns, never tokens');
  assert.equal(tokenStopFromError('Stopped after at the token limit, with no count'), undefined);
});

test('a task stopped at its token limit is a limit pause, and its words never read as the spend limit', () => {
  const token = { status: 'error', error: `${TOKEN_LIMIT_PREFIX} (1,200 tokens this task) before finishing.` };
  assert.equal(isTokenPause(token), true);
  assert.equal(isLimitPause(token), true, 'the work is kept and Continue picks it up');
  assert.equal(statusDot(token), 'paused', 'shown as a pause, not as a failure');
  assert.equal(isBudgetPause(token), false, 'a token stop is never the spend limit');
  // the count the card shows comes from the same text, so the heading and the number cannot disagree
  assert.equal(tokenStopFromError(`Stopped after 1,200 tokens`), '1,200');
});
