import test from 'node:test';
import assert from 'node:assert/strict';
import { routeModel, shouldEscalate } from '../src/core/router.js';

test('prefix override forces model and strips prefix', () => {
  let r = routeModel('/opus  fix the thing', 'sonnet');
  assert.equal(r.model, 'opus');
  assert.equal(r.prompt, 'fix the thing');
  r = routeModel('  /SONNET\nhello', 'opus');
  assert.equal(r.model, 'sonnet');
  assert.equal(r.prompt, 'hello');
  r = routeModel('/opusx not a prefix', 'sonnet');
  assert.equal(r.model, 'sonnet');
  assert.equal(r.prompt, '/opusx not a prefix');
});

test('explicit choice wins over heuristics', () => {
  assert.equal(routeModel('refactor and debug the architecture', 'sonnet').model, 'sonnet');
  assert.equal(routeModel('hi', 'opus').model, 'opus');
});

test('auto: simple prompt -> sonnet', () => {
  assert.equal(routeModel('what time is it in Tokyo', 'auto').model, 'sonnet');
  assert.equal(routeModel('please refactor this function', 'auto').model, 'sonnet'); // only 1 keyword
});

test('auto: hard keywords, long prompts and phrases -> opus', () => {
  assert.equal(routeModel('refactor this and debug the failure', 'auto').model, 'opus');
  assert.equal(routeModel('x'.repeat(1801), 'auto').model, 'opus');
  assert.equal(routeModel('x'.repeat(1800), 'auto').model, 'sonnet');
  assert.equal(routeModel('Please ULTRATHINK about this', 'auto').model, 'opus');
  assert.equal(routeModel('do a deep dive', 'auto').model, 'opus');
  assert.equal(routeModel('be thorough', 'auto').model, 'opus');
});

test('auto: priorModel opus sticks', () => {
  assert.equal(routeModel('thanks', 'auto', { priorModel: 'opus' }).model, 'opus');
  assert.equal(routeModel('thanks', 'auto', { priorModel: 'sonnet' }).model, 'sonnet');
  assert.equal(routeModel('thanks', 'sonnet', { priorModel: 'opus' }).model, 'sonnet');
});

test('shouldEscalate', () => {
  // a turn-limit stop pauses for Continue on the same model; it is not a reason to buy a second budget on Opus
  assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'error_max_turns', isError: true }), false);
  assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'error_during_execution', isError: true, errorText: 'boom' }), true);
  assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'success', isError: true, errorText: 'weird' }), true);
  assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'success', isError: false }), false);
  assert.equal(shouldEscalate({ model: 'opus', subtype: 'error_max_turns', isError: true }), false);
  for (const t of ['Invalid API key / please login', 'Credit balance too low', '429 Too Many', 'rate limit', 'rate_limit', 'Overloaded', '401', '403 forbidden', 'billing issue', 'authentication_error']) {
    assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'error_during_execution', isError: true, errorText: t }), false, t);
  }
});

test('non-auto choices pass through verbatim (aliases and full ids)', () => {
  assert.equal(routeModel('refactor and debug the architecture', 'haiku').model, 'haiku');
  const r = routeModel('hi', 'claude-opus-5-5[1m]', { priorModel: 'opus' });
  assert.equal(r.model, 'claude-opus-5-5[1m]');
  assert.equal(r.prompt, 'hi');
});

test('/model <value> prefix forces any model; /model auto routes normally; unknown /commands untouched', () => {
  let r = routeModel('/model claude-sonnet-4-5 do it', 'opus');
  assert.equal(r.model, 'claude-sonnet-4-5');
  assert.equal(r.prompt, 'do it');
  r = routeModel('/MODEL haiku', 'auto');
  assert.equal(r.model, 'haiku');
  assert.equal(r.prompt, '');
  r = routeModel('/model auto refactor and debug this', 'sonnet');
  assert.equal(r.model, 'opus');
  assert.equal(r.prompt, 'refactor and debug this');
  r = routeModel('/cost', 'auto');
  assert.equal(r.prompt, '/cost');
  assert.equal(r.model, 'sonnet');
  r = routeModel('/context show me', 'haiku');
  assert.equal(r.prompt, '/context show me');
  assert.equal(r.model, 'haiku');
});

test('only sonnet escalates', () => {
  assert.equal(shouldEscalate({ model: 'haiku', subtype: 'error_max_turns', isError: true }), false);
  assert.equal(shouldEscalate({ model: 'claude-sonnet-5', subtype: 'error_max_turns', isError: true }), false);
});

test('a run that stopped at the spend limit never escalates to Opus (a fresh cap would spend more than allowed)', () => {
  assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'error_max_budget_usd', isError: true }), false);
  assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'error_max_budget_usd', isError: true, errorText: 'tool crashed' }), false);
  // a real failure on sonnet still escalates
  assert.equal(shouldEscalate({ model: 'sonnet', subtype: 'error_during_execution', isError: true }), true);
});

test('a bridge reply is data: its length, keywords and phrases never pick Opus; it stays on the model the thread already uses', () => {
  const long = '[Reply from Scout · task t1] ' + 'architect a migration plan, think hard, review and debug. '.repeat(80);
  assert.ok(long.length > 1800);
  assert.equal(routeModel(long, 'auto', { reply: true }).model, 'sonnet', 'no prior model: the default');
  assert.equal(routeModel(long, 'auto', { reply: true, priorModel: 'sonnet' }).model, 'sonnet');
  assert.equal(routeModel(long, 'auto', { reply: true, priorModel: 'opus' }).model, 'opus', 'a thread already on Opus stays (switching would drop its cache)');
  assert.match(routeModel(long, 'auto', { reply: true }).reason, /reply/);
  // real requests keep every rule
  assert.equal(routeModel(long, 'auto').model, 'opus');
  assert.equal(routeModel('/opus hi', 'auto', { reply: true }).model, 'opus', 'an explicit prefix still wins');
  assert.equal(routeModel('hi', 'haiku', { reply: true }).model, 'haiku', 'a chosen model still passes through');
});
