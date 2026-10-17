import test from 'node:test';
import assert from 'node:assert/strict';
import { explainClaudeError } from '../src/shared/claude-errors.js';

test('explainClaudeError: empty credit balance, Claude login', () => {
  const t = explainClaudeError('Credit balance is too low', 'claude-login')!;
  assert.match(t, /^Claude Code is billing this run to Anthropic API credits, and the balance is empty\./);
  assert.match(t, /type \/logout, then \/login/);
  assert.match(t, /Help -> Doctor/);
  assert.doesNotMatch(t, /\u2014/);
});

test('explainClaudeError: empty credit balance, API key', () => {
  assert.equal(
    explainClaudeError('API Error: credit balance is too low to access the API', 'api-key'),
    'The API key in Settings -> Claude has no credits left. Add credits in the Claude Console, or switch Settings -> Claude to Claude login to use your Claude plan.',
  );
});

test('explainClaudeError: anything else is left alone', () => {
  assert.equal(explainClaudeError('Invalid API key', 'claude-login'), undefined);
  assert.equal(explainClaudeError(undefined, 'api-key'), undefined);
  assert.equal(explainClaudeError('', 'api-key'), undefined);
});
