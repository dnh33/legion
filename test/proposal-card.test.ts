import test from 'node:test';
import assert from 'node:assert/strict';
import { actionNotice, actionState, descriptionNeedsMore, proposalNote } from '../ui/src/projects/proposalCard.js';

test('actionNotice: success says so; a failure (undefined from the board store) says nothing, its error is already shown', () => {
  assert.equal(actionNotice({ ok: true }, 'Move the deploy rejected.'), 'Move the deploy rejected.');
  assert.equal(actionNotice({ id: 'wi1' }, 'accepted'), 'accepted');
  assert.equal(actionNotice(undefined, 'accepted'), null);
});
test('actionState: busy and archived disable the buttons and say why', () => {
  assert.deepEqual(actionState({ archived: false, busy: false }), { disabled: false });
  assert.deepEqual(actionState({ archived: false, busy: true }), { disabled: true, reason: 'Working on the board. Try again in a moment.' });
  assert.deepEqual(actionState({ archived: true, busy: false }), { disabled: true, reason: 'This project is archived. Unarchive it to decide.' });
  assert.equal(actionState({ archived: true, busy: true }).reason, 'This project is archived. Unarchive it to decide.');
});
test('proposalNote: the same safety text the Inbox shows, with the caveat only for a tainted run', () => {
  assert.equal(proposalNote('Forgemaster', false), 'Suggested by Forgemaster. Not reviewed.');
  assert.equal(proposalNote('Forgemaster', true), 'Suggested by Forgemaster. Not reviewed. Its run had read outside content (web, shell or other tools), so treat the text with extra care.');
});
test('descriptionNeedsMore: a long or many-line description gets a More toggle', () => {
  assert.equal(descriptionNeedsMore(''), false);
  assert.equal(descriptionNeedsMore('Short.'), false);
  assert.equal(descriptionNeedsMore('a\nb\nc\nd'), true);
  assert.equal(descriptionNeedsMore('x'.repeat(300)), true);
});
