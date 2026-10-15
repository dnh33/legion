import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core/bridge.js';
import { modelParam, roomModelParam } from '../src/core/agent-tools.js';
import type { Catalog } from '../src/shared/types.js';

const bridgeWith = (catalog?: Catalog): Bridge =>
  Object.assign(Object.create(Bridge.prototype), catalog ? { catalog: async () => catalog } : {}) as Bridge;

const catalog: Catalog = {
  commands: [], fetchedAt: '', models: [
    { value: 'default', displayName: 'Default', description: '' },
    { value: 'opus', displayName: 'Opus 5.5', description: '', resolvedModel: 'claude-opus-5-5' },
    { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
  ],
};

test('a catalog id must match a catalog value or resolved id exactly: a prefix or a part of one is refused', async () => {
  assert.equal(await bridgeWith(catalog).resolveModel('claude-opus-5-5'), 'claude-opus-5-5', 'the resolved id is exact');
  assert.equal(await bridgeWith(catalog).resolveModel('CLAUDE-FABLE-5-1'), 'CLAUDE-FABLE-5-1'.toLowerCase(), 'case does not matter');
  await assert.rejects(bridgeWith(catalog).resolveModel('claude-opus'), /not offered/, 'a prefix is not a match');
  await assert.rejects(bridgeWith(catalog).resolveModel('laude-fable-5-1'), /not offered/, 'a part of an id is not a match');
});

test('a family alias (haiku, fable) is accepted when the catalog offers that family, and refused when it does not', async () => {
  assert.equal(await bridgeWith(catalog).resolveModel('fable'), 'fable');
  await assert.rejects(bridgeWith(catalog).resolveModel('haiku'), /not offered/);
});

test('an id needs at least three characters: one or two characters never pass, whatever the catalog holds', async () => {
  await assert.rejects(bridgeWith(catalog).resolveModel('-'), /must be one of/);
  await assert.rejects(bridgeWith(catalog).resolveModel('a'), /must be one of/);
  await assert.rejects(bridgeWith(catalog).resolveModel('de'), /must be one of/);
});

test('the per-task parameter refuses ids under three characters', () => {
  assert.equal(modelParam.safeParse('a').success, false);
  assert.equal(modelParam.safeParse('ab').success, false);
  assert.equal(modelParam.safeParse('opus').success, true);
});

test('rooms (bot_send, room_post) take the aliases only: a catalog id is refused, Fable is accepted', () => {
  assert.equal(roomModelParam.safeParse('fable').success, true);
  assert.equal(roomModelParam.safeParse('haiku').success, true);
  assert.equal(roomModelParam.safeParse('claude-opus-5-5').success, false);
  assert.match(roomModelParam.description ?? '', /sonnet, opus, haiku, fable or auto/);
});
