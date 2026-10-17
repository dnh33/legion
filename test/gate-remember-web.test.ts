// test/gate-remember-web.test.ts: web reads and shell downloads are never remembered as a tool-wide allow (Task 17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canRemember, canRememberAllow, rememberWhen } from '../src/core/gate-remember.js';

test('canRemember and canRememberAllow: WebFetch, WebSearch, curl, wget, iwr and irm are not rememberable', () => {
  for (const [toolName, input] of [
    ['WebFetch', { url: 'https://a.com/' }], ['WebSearch', { query: 'x' }],
    ['Bash', { command: 'curl https://a.com' }], ['Bash', { command: 'wget https://a.com' }],
    ['PowerShell', { command: 'iwr https://a.com' }], ['PowerShell', { command: 'irm https://a.com' }], ['PowerShell', { command: 'Invoke-WebRequest https://a.com' }],
  ] as const) {
    assert.equal(canRememberAllow({ toolName, input: { ...input } }), false, toolName + ' ' + JSON.stringify(input));
  }
  assert.equal(canRemember({ toolName: 'WebFetch' }), false);
  assert.equal(canRemember({ toolName: 'WebSearch' }), false);
});

test('other tools still remember as before', () => {
  assert.equal(canRememberAllow({ toolName: 'Bash', input: { command: 'git status' } }), true);
  assert.equal(canRemember({ toolName: 'Bash' }), true);
  assert.deepEqual(rememberWhen({ agentId: 'a', toolName: 'Bash', input: { command: 'git status' } }).commands, ['git status', 'git status *']);
});
