/** Text from outside (the agent's own purpose and recipient, 60+ disguised instructions) moves nothing in the spend path. The scenario is in bsv-spend-scenarios.ts. */
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORPUS, loadMods, SCENARIOS } from './bsv-spend-scenarios.js';
import assert from 'node:assert/strict';

test('injection: a corpus of at least 50 strings through purpose and recipient moves nothing and appears only as the card purpose', async () => {
  assert.ok(CORPUS.length >= 50);
  await SCENARIOS['injection-corpus-moves-nothing']!(await loadMods(fileURLToPath(new URL('../', import.meta.url))));
});
