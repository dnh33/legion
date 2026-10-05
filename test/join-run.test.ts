import test from 'node:test';
import assert from 'node:assert/strict';
import { canJoinRun, isProviderModel } from '../ui/src/chat/busy.js';

const running = { status: 'running' as const, provider: undefined, model: 'opus' as const };

test('a plain message to the thread\'s own running Claude run joins it', () => {
  assert.equal(canJoinRun('run', running, 0, 'and make it blue'), true);
});

test('everything else waits in the queue: queued items first, a queued task, a provider run, a slash command, a busy agent', () => {
  assert.equal(canJoinRun('run', running, 1, 'x'), false, 'never jumps ahead of messages already queued');
  assert.equal(canJoinRun('run', { ...running, status: 'queued' }, 0, 'x'), false, 'a task that has not started has no run to join');
  assert.equal(canJoinRun('run', { ...running, provider: 'openai' }, 0, 'x'), false);
  assert.equal(canJoinRun('run', { ...running, model: 'openai:gpt-4o' }, 0, 'x'), false);
  assert.equal(canJoinRun('run', running, 0, '  /compact'), false);
  assert.equal(canJoinRun('approval', running, 0, 'x'), false);
  assert.equal(canJoinRun('other', running, 0, 'x'), false);
  assert.equal(canJoinRun(null, running, 0, 'x'), false);
});

test('provider ids follow the core\'s rule: "name:model" is a provider, an AWS arn or a plain Claude alias is not', () => {
  assert.equal(isProviderModel('openai:gpt-4o'), true);
  assert.equal(isProviderModel('arn:aws:bedrock:eu:1:inference-profile/x'), false);
  assert.equal(isProviderModel('claude-opus-5-5[1m]'), false);
  assert.equal(isProviderModel(undefined), false);
});
