// test/folder-trust-ui-logic.test.ts: the pure part of folder trust in the window. The window sends a path and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRUST_EMPTY_LINE, TRUST_NOTE, cardLines, trustChange, trustSummary, untrustChange } from '../ui/src/gates/trustLogic.js';

test('Trust and Remove send a path only', () => {
  assert.deepEqual(trustChange('D:/x'), { kind: 'app', patch: { trustFolder: 'D:/x' } });
  assert.deepEqual(untrustChange('D:/x'), { kind: 'app', patch: { untrustFolder: 'D:/x' } });
});

test('the summary counts items and shows the first, cut', () => {
  assert.equal(trustSummary({ summary: [], more: 0 }), 'Nothing in it can run now.');
  assert.equal(trustSummary({ summary: ['Hook Stop (command) in .claude/settings.json runs: x'], more: 0 }), '1 item can run. Hook Stop (command) in .claude/settings.json runs: x');
  assert.match(trustSummary({ summary: ['a'.repeat(300), 'b'], more: 2 }), /^4 items can run\. a+\u2026$/);
});

test('a card shows six lines and counts the rest', () => {
  const lines = Array.from({ length: 9 }, (_, i) => `l${i}`);
  assert.deepEqual(cardLines(lines, 0), { shown: lines.slice(0, 6), hidden: 3 });
  assert.deepEqual(cardLines(lines.slice(0, 2), 5), { shown: ['l0', 'l1'], hidden: 5 });
});

test('the copy uses plain words and no em dash', () => {
  for (const t of [TRUST_NOTE, TRUST_EMPTY_LINE]) assert.ok(!t.includes('\u2014') && !t.includes('\u2013'));
});
