/**
 * First-run welcome (plan claude/plan-fascia.md 6.2): the first screen points at Zealot. A new user needs only a Claude
 * sign-in to get multi-agent work, so the welcome asks for that and offers one real first task for Zealot; VMs (boat.dev)
 * and the Claude Code connection are optional and move under "Later".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WELCOME_STEPS, WELCOME_LATER, WELCOME_TRY } from '../ui/src/components/welcomeLogic.js';

test('welcome: the steps a new user must do are the sign-in check and a first task for Zealot, in that order', () => {
  assert.deepEqual(WELCOME_STEPS.map((s) => s.id), ['signin', 'try']);
});

test('welcome: VMs and the Claude Code connection are optional, under Later', () => {
  assert.deepEqual(WELCOME_LATER.map((s) => s.id), ['boat', 'mcp']);
  for (const s of WELCOME_LATER) assert.doesNotMatch(s.title, /must|required/i);
  assert.ok(!WELCOME_STEPS.some((s) => s.id === 'boat' || s.id === 'mcp'), 'neither is a must-do step');
});

test('welcome: the first task goes to Zealot and shows a hand-off, and the screen says it uses Claude usage', () => {
  assert.equal(WELCOME_TRY.agentId, 'zealot');
  assert.match(WELCOME_TRY.prompt, /\bScout\b/, 'the example makes Zealot hand work to another agent');
  assert.ok(WELCOME_TRY.prompt.length <= 200, 'short enough to read before sending');
  const tryStep = WELCOME_STEPS.find((s) => s.id === 'try')!;
  assert.match(tryStep.body, /Claude usage/, 'it says the click spends usage before it is clicked');
});
