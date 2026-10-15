/** A pending edit proposal for a note is the note's own Inbox item: Lint must not also list it as a duplicate title or an extra untrusted note. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import { mkGraph, note } from './kg-helpers.js';

test('a tainted edit proposal is not a duplicate title and not an extra untrusted note in Lint', () => {
  const { g } = mkGraph();
  const original = note(g, 'QA stale note', { body: 'The sky is green.' });
  const bot = agentActor('archivist', { taint: () => true });
  const r = g.upsertNode(bot, { id: original.id, body: 'The sky is blue.', sources: [{ ref: 'https://example.com/sky', untrusted: true }] });
  assert.equal(r.pending, true, 'the edit became a pending proposal');
  const lint = g.lint(HUMAN);
  assert.deepEqual(lint.duplicateTitles, [], 'no duplicate-title group for the original and its proposal');
  assert.ok(!lint.untrustedWithoutReview.includes(r.node.id), 'the proposal is not listed as an untrusted note');
});

test('a held new note that proposes nothing is still counted as untrusted and as a duplicate', () => {
  const { g } = mkGraph();
  note(g, 'Same title');
  const bot = agentActor('archivist', { taint: () => true });
  const held = g.upsertNode(bot, { title: 'Same title', sources: [{ ref: 'https://example.com/x', untrusted: true }] });
  const lint = g.lint(HUMAN);
  assert.equal(lint.duplicateTitles.length, 1);
  assert.ok(lint.untrustedWithoutReview.includes(held.node.id));
});
