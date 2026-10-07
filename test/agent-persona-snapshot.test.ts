/**
 * Persona snapshot: the system prompt of each of the 14 premade bots is pinned by hash, so a change to a bot's voice is deliberate.
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
  // 0.2.5-c: the lead of the Order (owner direction); the old seed told Zealot to handle requests itself
  zealot: 'b748fba935e08e475c92c5b00261fa7eece6279a08f1656c51ae5d41b8c3e2ec',
  builder: 'afcc30aa33d6403b4bdea20e9cdf0a2c8187cab555fdd9ea74920b234601d26a',
  scout: 'a17ba5e29b22a1fad5bb641ab9f105eec7ae5fedf7ab61ffc8ec56de80cc36fd',
  inquisitor: 'a472001174c15ab74e79a8eee932b480a72c600f5dd54f84c565627d91c5f7a6',
  scribe: '7fa67b71950516de75ff310e11eac438d9c52b27a6c781b62f22c40cf91a92a3',
  archivist: 'd0424fd7ea070269cf14b25e9b695665e5a0dc29e5a772b9bdee17ee52f38da7',
  sentinel: '145cc7e5c68a2ebb54fdecdc776fb15d68a971bf2f3e1911cc853ffb239daaab',
  forgemaster: '30919367af380f468c59304d1235b68f45beb980571a9e8b5a52550bd6fbd282',
  exorcist: '695bdbc5e6f2639dfaa33620981ee2b09112be7b45f77d18d036b1732ca8ff75',
  preceptor: '47745ff315cb5b825be5f8a62c67ff43ef02c2b1656c4f2b19d226cc91b1adfe',
  herald: 'bbfebf3df421a223eea0b5b9671e3bb4786596698bb129e7d940f2022fa0b55f',
  assayer: '4b5222f41466330a713226d196e2a3d34060872322d6728b136592eac95f6723',
  sculptor: 'c281b633fc9e5906cd4f3629331f95a6fbab4e25490e27a3fb30af1d73147346',
  // added with the Quartermaster (supply watch: reports newer versions, never upgrades)
  quartermaster: 'a35b7d55f683f2fe472bfb1ec7759913d765026f7d2787d35b6ac67d9a083907',
};

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

test('persona snapshot: the 14 premade personas match their pinned hashes', () => {
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
