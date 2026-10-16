import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMode } from '../src/core/permission-mode.js';
import type { ModeInputs } from '../src/core/permission-mode.js';
import type { ApprovalMode } from '../src/shared/types.js';

const MODES: ApprovalMode[] = ['ask', 'auto-edits', 'full'];
const own = (m: ApprovalMode, extra: Partial<ModeInputs> = {}): ModeInputs => ({ agentMode: m, source: 'own', appPreset: 'ask', ...extra });

test('no preset on the project (Per agent): the agent own mode, exactly 0.3.0', () => {
  for (const m of MODES) {
    assert.equal(effectiveMode(own(m)), m);
    assert.equal(effectiveMode(own(m, { project: { limit: true } })), m, 'limit without a preset caps nothing');
  }
});

test('a full agent with its own mode in an Ask project: limit on gives ask, limit off gives full', () => {
  assert.equal(effectiveMode(own('full', { project: { preset: 'ask', limit: true } })), 'ask');
  assert.equal(effectiveMode(own('full', { project: { preset: 'ask', limit: false } })), 'full');
});

test('an agent that follows its project takes the preset; without a project it takes the app preset', () => {
  const follow = (extra: Partial<ModeInputs>): ModeInputs => ({ agentMode: 'ask', source: 'project', appPreset: 'ask', ...extra });
  assert.equal(effectiveMode(follow({ project: { preset: 'bypass', limit: true } })), 'full');
  assert.equal(effectiveMode(follow({ project: { preset: 'smart', limit: true } })), 'smart');
  assert.equal(effectiveMode(follow({ project: { preset: 'accept-edits', limit: false } })), 'auto-edits');
  assert.equal(effectiveMode(follow({ appPreset: 'bypass' })), 'full', 'no project: the app preset');
  assert.equal(effectiveMode(follow({ project: { limit: true } })), 'ask', 'a follow agent in a Per agent project takes the app preset');
});

test('an agent explicitly set to Ask stays Ask in a Bypass project', () => {
  assert.equal(effectiveMode(own('ask', { project: { preset: 'bypass', limit: true } })), 'ask');
});

test('a goal: its autonomy replaces the base; the cap still applies unless a lease replaces it', () => {
  const capped = { project: { preset: 'ask' as const, limit: true } };
  assert.equal(effectiveMode(own('ask', { ...capped, goal: { autonomy: 'full' } })), 'ask', 'capped by the project');
  assert.equal(effectiveMode(own('ask', { ...capped, goal: { autonomy: 'full', lease: 'bypass' } })), 'full', 'the lease lifts the cap for this goal');
  assert.equal(effectiveMode(own('ask', { goal: { autonomy: 'full' } })), 'full', 'no cap: Full autonomy gives full');
  assert.equal(effectiveMode(own('full', { goal: { autonomy: 'check-once' } })), 'full', 'other autonomy levels keep the agent mode as the base');
});

test('the origin ceiling beats everything, lease included', () => {
  for (const m of MODES) {
    assert.equal(effectiveMode(own(m, { ceiling: 'ask', project: { preset: 'bypass', limit: false }, goal: { autonomy: 'full', lease: 'bypass' } })), 'ask');
  }
});

test('a lease only replaces an existing project cap; with no cap it adds nothing', () => {
  assert.equal(effectiveMode({ agentMode: 'full', source: 'own', appPreset: 'ask', goal: { autonomy: 'check-once', lease: 'ask' } }), 'full', 'no project: no cap to replace');
  assert.equal(effectiveMode({ agentMode: 'full', source: 'own', appPreset: 'ask', project: { preset: 'bypass', limit: false }, goal: { autonomy: 'check-once', lease: 'ask' } }), 'full', 'limit off: no cap to replace');
});

test('a cap from the project holds on its own, and a lease under a limited Bypass project can tighten it', () => {
  assert.equal(effectiveMode(own('full', { project: { preset: 'smart', limit: true } })), 'smart', 'smart cap on a full own agent');
  assert.equal(effectiveMode(own('full', { project: { preset: 'bypass', limit: true }, goal: { autonomy: 'check-once', lease: 'ask' } })), 'ask', 'lease ask replaces the bypass cap');
});

test('a project cap and the origin ceiling together: the stricter wins', () => {
  assert.equal(effectiveMode(own('full', { project: { preset: 'accept-edits', limit: true }, ceiling: 'ask' })), 'ask');
});

test('values outside the unions fail closed to ask', () => {
  assert.equal(effectiveMode(own('yolo' as never)), 'ask', 'bad agent mode');
  assert.equal(effectiveMode(own('full', { ceiling: 'yolo' as never })), 'ask', 'bad ceiling');
  assert.equal(effectiveMode(own('full', { project: { preset: 'yolo' as never, limit: true } })), 'ask', 'bad project preset under a limit');
});
