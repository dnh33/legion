/**
 * BSV v1 review fix F11 (UI half): the UI reports what the pack load really did instead of always saying "BSV knowledge pack loaded.".
 * The wording lives in src/shared/bsv-seed.ts so it can be tested here; the stores call it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSeed } from '../src/shared/bsv-seed.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const base = { nodes: 157, from: 0, to: 3, created: 0, updated: 0, edges: 0, skippedEdited: [] as string[], skippedRemoved: [] as string[] };

test('F11: describeSeed says loaded, upgraded, repaired and already-loaded differently, with real counts', () => {
  assert.match(describeSeed({ ...base, status: 'loaded', created: 157, edges: 699 }).text, /loaded.*157 notes.*699 links/i);
  const up = describeSeed({ ...base, status: 'upgraded', from: 2, to: 3, created: 0, updated: 40, edges: 3 });
  assert.match(up.text, /upgraded.*version 2 to 3.*40 notes updated/i);
  assert.equal(up.level, 'info');
  assert.match(describeSeed({ ...base, status: 'repaired', from: 3, created: 2, edges: 5 }).text, /repaired|put back/i);
  const same = describeSeed({ ...base, status: 'already-loaded', from: 3 });
  assert.match(same.text, /already up to date.*version 3/i);
  assert.doesNotMatch(same.text, /loaded\.$/);
});

test('F11: a human edit or deletion that the pack left alone is named, so the user can see why a note still has old text', () => {
  const r = describeSeed({ ...base, status: 'upgraded', from: 2, to: 3, updated: 10, skippedEdited: ['bsv-tx-fees', 'bsv-wallet-choice'], skippedRemoved: ['bsv-sound-events'] });
  assert.match(r.text, /2 notes you edited were left as they are/);
  assert.match(r.text, /bsv-tx-fees/);
  assert.match(r.text, /1 note you deleted stays deleted/);
  assert.match(r.text, /restore/i, 'it says how to get one back');
  assert.equal(describeSeed({ ...base, status: 'already-loaded', from: 3, skippedEdited: ['a'] }).text.includes('left as they are'), false, 'nothing is listed when nothing was considered');
  const many = describeSeed({ ...base, status: 'upgraded', skippedEdited: Array.from({ length: 30 }, (_, i) => `bsv-n${i}`) });
  assert.ok(many.text.length < 400, 'a long list is cut');
  assert.match(many.text, /30 notes you edited/);
});

test('F11: errors and a missing graph come back as errors, with the reason', () => {
  assert.deepEqual(describeSeed({ status: 'error', error: 'The BSV knowledge pack is invalid: x' }), { text: 'The BSV knowledge pack did not load: The BSV knowledge pack is invalid: x', level: 'error' });
  assert.equal(describeSeed({ status: 'no-kg' }).level, 'error');
});

test('F11: both stores use it (no fixed "BSV knowledge pack loaded." toast is left)', () => {
  const graph = readFileSync(join(REPO, 'ui/src/graph/graphStore.ts'), 'utf8');
  const bsv = readFileSync(join(REPO, 'ui/src/bsv/bsvStore.ts'), 'utf8');
  assert.doesNotMatch(graph, /notify\('BSV knowledge pack loaded\.'\)/);
  assert.match(graph, /describeSeed\(/);
  assert.match(bsv, /describeSeed\(/);
});
