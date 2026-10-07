/**
 * Persona snapshot: the system prompt of each of the 13 premade bots is pinned by hash, so a change to a bot's voice is deliberate.
 * To change one on purpose: edit the text, run this test, put the new hash below in the SAME commit and say why in the message.
 * (Stored personas on existing installs never update; facts that must stay true live in src/core/agent-facts.ts instead.)
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/core/store.js';

const PINNED: Record<string, string> = {
  // Soul Codex v1 (maintainer 2026-10-07, claude/plan-fascia.md 6.2): full souls for the three defaults, true to each core
  zealot: '42749e93cf4f6690f380513b30e521b941d9001e0889ce22734eeec91366672d',
  builder: '0e355c26f0a8d4ed903ce31169dfe3ef7754d1f5b800c30bcc62d23f3a85391b',
  scout: 'ec252a6319b482ce0b106881e10b0d62eae17a223a24be0f2c0079b809210e55',
  // Fascia 3a (claude/plan-fascia.md 6.3): the roster's trailing comms lines moved into the teamwork block, said once per run
  inquisitor: 'c11895088e75c41796645b6ff345d13504119caec19c4ed1c24fb64e446ce88b',
  scribe: '198b952e24a5f351c474966d23a2c01fdc77eb8ac1b76794d3a6f1010242808d',
  archivist: 'c69d233ffd5574857623b5ca053f4c94e512dc7a4fc2c25f69d5185e4e49c617',
  sentinel: '59b843e6a47cd19b2fefca06e2b56eb7f29df366c5bdd8b5e7a667da27815881',
  forgemaster: 'd150e31c81cb6a3e1af8c914f66f7659cb755e5b2733aa473bf320d8c62a3e80',
  exorcist: '5630c73c50976f70a854f0d26ed3f6b043c249219b806e035bc3bf3a3c6d16bd',
  preceptor: '941fbfc931e417e23f033125ab299118218b06b91241e9eaa1cb4520a62d09e2',
  herald: 'cc58bb7443e0d4f541fde344e0aa6afe1cb4e552eb9c0229a4b2cecb0cc41711',
  quartermaster: 'd9cb33da244c0d933080402870ca5a80e42293fe186401940828f34812aea75d',
  assayer: '544aa417acb8521f0a59744b1a17afff06f7f858ee81ef4f15133fcf8fc195df',
  sculptor: 'dc7a647c2ab4a3675ccce262e93679bdb0ab855a6d3447d9ededeb5864e83e5f',
};

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

test('persona snapshot: the 13 premade personas match their pinned hashes', () => {
  const d = cleanupTemp('persona-snap-');
  const store = new Store(d);
  store.seedDefaults(join(d, 'ws'));
  const got = Object.fromEntries(store.listAgents().map((a) => [a.id, sha(a.systemPrompt)]));
  assert.deepEqual(Object.keys(got).sort(), Object.keys(PINNED).sort(), 'the set of premade bots changed: pin the new one on purpose');
  for (const [id, h] of Object.entries(PINNED)) assert.equal(got[id], h, `${id}: persona text changed. If that is deliberate, update its hash in this file in the same commit`);
});

test('persona snapshot: the two facts the owner approved changing are in, the stale lines are out', () => {
  const d = cleanupTemp('persona-snap-');
  const store = new Store(d);
  store.seedDefaults(join(d, 'ws'));
  const text = (id: string) => store.getAgent(id)!.systemPrompt;
  assert.match(text('sculptor'), /run on this computer by default when Blender is found, in the cloud VM otherwise/);
  assert.match(text('sculptor'), /In live mode the bridge backs up/);
  assert.doesNotMatch(text('sculptor'), /sandbox VM by default/);
  assert.match(text('assayer'), /you never choose the network: mainnet is hard-off/);
  assert.doesNotMatch(text('assayer'), /mainnet only when the user explicitly asks/);
});
