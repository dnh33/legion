/**
 * The structured question card's UI half. The pure logic (ui/src/chat/questionCard.ts) is imported and run for real;
 * the component and the thread are checked as source, the way test/approval-keys.test.ts checks both approval key paths.
 *
 * The A-key safety rule is the reason this file exists: `questionKey` must return nothing for 'a'/'A', and the thread's
 * A/D shortcut must skip a keypress whose focus is inside a question card (which carries the `.approval` class).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyOther, applyPick, initialAnswers, isAnswered, isReviewStep, orderedOptions, questionKey, reviewRows, stepCount,
} from '../ui/src/chat/questionCard.js';
import type { QuestionSpec } from '../src/shared/types.js';

const base = { step: 0, questionCount: 1, optionCount: 3, focus: 0, otherOpen: false };

test('orderedOptions puts the recommended option first and keeps the rest in order', () => {
  const plain = [{ label: 'A', description: '' }, { label: 'B', description: '' }];
  assert.deepEqual(orderedOptions(plain), plain, 'no recommended: order untouched');
  const rec = orderedOptions([{ label: 'A', description: '' }, { label: 'B', description: '', recommended: true }, { label: 'C', description: '' }]);
  assert.deepEqual(rec.map((o) => o.label), ['B', 'A', 'C']);
});

test('steps: one per question plus a review step', () => {
  assert.equal(stepCount([]), 1);
  assert.equal(stepCount([{} as QuestionSpec, {} as QuestionSpec]), 3);
  assert.equal(isReviewStep(2, 2), true);
  assert.equal(isReviewStep(1, 2), false);
});

test('questionKey: arrows move, Enter picks the focused option, 1-4 pick directly, out-of-range digits do nothing', () => {
  assert.deepEqual(questionKey({ ...base, key: 'ArrowDown' }), { kind: 'move', delta: 1 });
  assert.deepEqual(questionKey({ ...base, key: 'ArrowRight' }), { kind: 'move', delta: 1 });
  assert.deepEqual(questionKey({ ...base, key: 'ArrowUp' }), { kind: 'move', delta: -1 });
  assert.deepEqual(questionKey({ ...base, key: 'ArrowLeft' }), { kind: 'move', delta: -1 });
  assert.deepEqual(questionKey({ ...base, key: 'Enter', focus: 2 }), { kind: 'pick', index: 2 });
  assert.deepEqual(questionKey({ ...base, key: '1' }), { kind: 'pick', index: 0 });
  assert.deepEqual(questionKey({ ...base, key: '3' }), { kind: 'pick', index: 2 });
  assert.deepEqual(questionKey({ ...base, key: '4' }), { kind: 'none' }, 'digit past the option count picks nothing');
  assert.deepEqual(questionKey({ ...base, key: '0' }), { kind: 'none' });
  assert.deepEqual(questionKey({ ...base, key: 'Tab' }), { kind: 'none' });
});

test('questionKey: A never answers a question card', () => {
  for (const key of ['a', 'A']) {
    assert.deepEqual(questionKey({ ...base, key }), { kind: 'none' }, `${key} must not answer`);
  }
  // and it stays a no-op everywhere on the card, including the review step and while Other is open
  assert.deepEqual(questionKey({ ...base, key: 'a', step: 1, questionCount: 1 }), { kind: 'none' });
  assert.deepEqual(questionKey({ ...base, key: 'A', otherOpen: true }), { kind: 'none' });
});

test('questionKey: Esc closes Other (and is the only key handled while Other is open); Enter submits on review', () => {
  assert.deepEqual(questionKey({ ...base, key: 'Escape', otherOpen: true }), { kind: 'closeOther' });
  assert.deepEqual(questionKey({ ...base, key: 'Escape' }), { kind: 'none' }, 'no Other open: nothing to close');
  for (const key of ['1', '2', 'Enter', 'ArrowDown']) {
    assert.deepEqual(questionKey({ ...base, key, otherOpen: true }), { kind: 'none' }, `${key} in the Other field must not act on the card`);
  }
  assert.deepEqual(questionKey({ ...base, key: 'Enter', step: 1, questionCount: 1 }), { kind: 'submit' });
  assert.deepEqual(questionKey({ ...base, key: '1', step: 1, questionCount: 1 }), { kind: 'none' });
});

test('answers: single-select replaces, multi-select toggles, Other is kept and can be cleared', () => {
  let a = initialAnswers(2);
  assert.deepEqual(a, [{ labels: [] }, { labels: [] }]);
  a = applyPick(a, 0, 'A', false);
  assert.deepEqual(a[0]!.labels, ['A']);
  a = applyPick(a, 0, 'B', false);
  assert.deepEqual(a[0]!.labels, ['B'], 'single-select replaces');
  a = applyPick(a, 0, 'C', true);
  assert.deepEqual(a[0]!.labels, ['B', 'C'], 'multi-select adds');
  a = applyPick(a, 0, 'B', true);
  assert.deepEqual(a[0]!.labels, ['C'], 'multi-select toggles off');
  a = applyOther(a, 1, '  my own  ');
  assert.equal(a[1]!.other, 'my own');
  a = applyOther(a, 1, '   ');
  assert.equal(a[1]!.other, undefined, 'blank Other clears it');
  assert.equal(isAnswered([{ labels: [] }], 0), false);
  assert.equal(isAnswered([{ labels: [], other: 'x' }], 0), true);
  assert.equal(isAnswered([{ labels: ['A'] }], 0), true);
});

test('reviewRows lists every question with the picked labels and the Other text; unanswered reads as such', () => {
  const questions: QuestionSpec[] = [
    { question: 'Which?', header: 'Which', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false },
    { question: 'Why?', header: 'Why', options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }], multiSelect: false },
    { question: 'Notes?', header: 'Notes', options: [{ label: 'N', description: '' }, { label: 'M', description: '' }], multiSelect: false },
  ];
  const rows = reviewRows(questions, [{ labels: ['A'] }, { labels: [], other: 'because' }, { labels: [] }]);
  assert.deepEqual(rows.map((r) => r.answer), ['A', 'because', 'Not answered']);
  assert.equal(rows[0]!.header, 'Which');
});

test('the thread renders the question card for the open task and skips a keypress inside one', () => {
  const thread = readFileSync(join(process.cwd(), 'ui/src/components/Thread.tsx'), 'utf8');
  assert.match(thread, /import \{ QuestionCard \} from '\.\/QuestionCard';/);
  assert.match(thread, /const taskQuestions = questions\.filter\(\(q\) => q\.taskId === taskId\);/);
  assert.match(thread, /\{taskQuestions\.map\(\(q\) => <QuestionCard key=\{q\.id\} q=\{q\} \/>\)\}/);
  // the A/D shortcut must not fire while focus is inside a question card
  assert.match(thread, /t\.closest\('\.approval, \.question, \.modal'\)/);
});

test('the card keeps the approval shell, routes the keyboard through questionKey, and never binds A', () => {
  const src = readFileSync(join(process.cwd(), 'ui/src/components/QuestionCard.tsx'), 'utf8');
  assert.match(src, /className="approval question"/, 'the approval shell, so the look and the focus ring are shared');
  assert.match(src, /questionKey\(\{ key: e\.key/);
  assert.match(src, /answerQuestion\(q\.id, answers\)/);
  assert.match(src, />Submit</);
  assert.match(src, /Recommended/);
  assert.doesNotMatch(src, /e\.key === 'a'/, 'no A-key answer on the card');
  assert.doesNotMatch(src, /e\.key === 'A'/);
});
