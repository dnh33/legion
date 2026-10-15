import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRank, rankModel, overrideAllowed, overrideRefusal } from '../src/core/model-cap.js';
import { Bridge, OVERRIDE_MODELS } from '../src/core/bridge.js';
import { modelParam, VM_MODELS } from '../src/core/agent-tools.js';
import type { Catalog } from '../src/shared/types.js';

// A Bridge without its store or engine: resolveModel only reads `catalog`.
const bridgeWith = (catalog?: Catalog): Bridge =>
  Object.assign(Object.create(Bridge.prototype), catalog ? { catalog: async () => catalog } : {}) as Bridge;

test('Fable ranks above Opus: no Sonnet or Opus agent can be moved onto it, and an unknown id still counts as Sonnet', () => {
  assert.ok(modelRank('fable') > modelRank('opus'));
  assert.ok(modelRank('opus') > modelRank('sonnet'));
  assert.equal(modelRank('claude-fable-5-1'), modelRank('fable'));
  assert.equal(modelRank('claude-some-future-model'), modelRank('sonnet'));
  assert.equal(rankModel(modelRank('fable')), 'fable');
  assert.equal(rankModel(modelRank('opus')), 'opus');
});

test('an override to Fable is refused for Sonnet, Auto and Opus agents, and allowed for a Fable agent', () => {
  assert.equal(overrideAllowed('sonnet', 'fable'), false);
  assert.equal(overrideAllowed('auto', 'fable'), false);
  assert.equal(overrideAllowed('opus', 'fable'), false);
  assert.equal(overrideAllowed('fable', 'fable'), true);
  assert.equal(overrideAllowed('fable', 'opus'), true, 'a downgrade from a Fable agent stays allowed');
  assert.equal(overrideAllowed('claude-fable-5-1', 'haiku'), true);
  assert.match(overrideRefusal('Zealot', 'sonnet', 'fable'), /fable/);
});

test('the override list names fable and the bridge accepts it as an alias', async () => {
  assert.ok((OVERRIDE_MODELS as readonly string[]).includes('fable'));
  assert.equal(await bridgeWith().resolveModel('Fable'), 'fable');
});

test('resolveModel accepts a model the account offers by id or name, and refuses one it does not', async () => {
  const c: Catalog = { commands: [], fetchedAt: '', models: [{ value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' }] };
  assert.equal(await bridgeWith(c).resolveModel('claude-fable-5-1'), 'claude-fable-5-1');
  await assert.rejects(bridgeWith(c).resolveModel('gpt-9'), /not offered/);
});

test('with no readable catalog, only the aliases are accepted', async () => {
  assert.equal(await bridgeWith().resolveModel('opus'), 'opus');
  await assert.rejects(bridgeWith().resolveModel('claude-opus-5-5'), /must be one of/);
});

test('the per-task model parameter accepts fable and a catalog id, and refuses text that is not a model', () => {
  assert.equal(modelParam.safeParse('fable').success, true);
  assert.equal(modelParam.safeParse('claude-fable-5-1').success, true);
  assert.equal(modelParam.safeParse('not a model!').success, false);
});

test('the bot-side vm_claude tool offers sonnet and opus only, until boat.dev is shown to accept the others', () => {
  assert.deepEqual([...VM_MODELS], ['sonnet', 'opus']);
});
