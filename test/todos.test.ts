import test from 'node:test';
import assert from 'node:assert/strict';
import { todoSummary, todoText, todoChipLabel, parseTodoInput, visibleTodos } from '../ui/src/chat/todos.js';
import { workingLabel } from '../ui/src/chat/working.js';

const mk = (n: number, done: number) => Array.from({ length: n }, (_, i) => ({ content: `step ${i + 1}`, status: (i < done ? 'completed' : 'pending') as 'completed' | 'pending' }));

test('the checklist counts finished items plainly', () => {
  assert.equal(todoSummary(mk(7, 3)), '3 of 7 done');
  assert.equal(todoSummary(mk(2, 0)), '0 of 2 done');
  assert.equal(todoSummary([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'completed' }]), '1 of 2 done');
});

test('an item in progress reads in its present-tense form; the others keep their task text', () => {
  assert.equal(todoText({ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' }), 'Running tests');
  assert.equal(todoText({ content: 'Run tests', status: 'in_progress' }), 'Run tests');
  assert.equal(todoText({ content: 'Run tests', status: 'pending', activeForm: 'Running tests' }), 'Run tests');
  assert.equal(todoText({ content: 'Run tests', status: 'completed', activeForm: 'Running tests' }), 'Run tests');
});

test('the TodoWrite chip says what changed; input it cannot read keeps the raw text', () => {
  const input = JSON.stringify({ todos: [{ content: 'a', status: 'completed', activeForm: 'A' }, { content: 'b', status: 'pending', activeForm: 'B' }, { content: 'c', status: 'in_progress', activeForm: 'C' }] });
  assert.equal(todoChipLabel(input), 'Updated the task list (1 of 3 done)');
  assert.equal(todoChipLabel(input.slice(0, 60) + '…'), null);   // clipped by the core: not JSON
  assert.equal(todoChipLabel('{"command":"ls"}'), null);             // another tool's shape
  assert.equal(parseTodoInput('{"todos":[{"status":"completed"}]}')?.length, 0);   // an item without text is not a task
});

test('a long list folds to a window that holds the current work; a short one never folds', () => {
  assert.deepEqual(visibleTodos(mk(6, 2), false), { items: mk(6, 2), hidden: 0 });
  const long = mk(10, 4);
  const v = visibleTodos(long, false);
  assert.equal(v.items.length, 6);
  assert.equal(v.hidden, 4);
  assert.equal(v.items[0]!.content, 'step 5');   // the first unfinished item leads the window
  assert.equal(visibleTodos(long, true).hidden, 0);
  assert.equal(visibleTodos(long, true).items.length, 10);
  // everything done: the window shows the end of the list
  assert.equal(visibleTodos(mk(10, 10), false).items[5]!.content, 'step 10');
  // the first unfinished item is near the end: the window still holds 6 lines
  assert.equal(visibleTodos(mk(10, 9), false).items.length, 6);
});

test('the working row reads Thinking only when the run is thinking and nothing outranks it', () => {
  assert.equal(workingLabel({ queued: false, waiting: false }), 'Working');
  assert.equal(workingLabel({ queued: false, waiting: false, thinking: false }), 'Working');
  assert.equal(workingLabel({ queued: false, waiting: false, thinking: true }), 'Thinking');
  assert.equal(workingLabel({ queued: false, waiting: true, thinking: true }), 'Waiting for your OK');
  assert.equal(workingLabel({ queued: true, waiting: false, thinking: true }), 'Queued');
});
