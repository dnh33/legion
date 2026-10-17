/** The chat line under a reply: which reply a finder note belongs to, the line text and the popover rows. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINES, lineText, rowText, skillLinesByMessage, shortSkillName, overflowTurns } from '../src/shared/skill-line.js';
import type { ChatMessage, SkillTurn } from '../src/shared/types.js';

const at = (min: number): string => new Date(Date.UTC(2026, 9, 18, 10, min, 0)).toISOString();
const msg = (id: string, role: ChatMessage['role'], min: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, taskId: 't', role, text: id, at: at(min), ...extra });
const turn = (min: number, suggested: string[], loaded: string[] = [], extra: Partial<SkillTurn> = {}): SkillTurn => ({
  at: at(min), suggested, loaded, why: suggested.map((id, i) => ({ id, score: 12.34 - i, matched: i === 0 ? ['pdf', 'export'] : [] })), ...extra,
});
const thread = [msg('u1', 'user', 0), msg('a1', 'assistant', 2), msg('u2', 'user', 3), msg('tool', 'tool', 4, { toolName: 'Skill' }), msg('a2', 'assistant', 6)];

test('a note belongs under the first assistant message at or after it', () => {
  const m = skillLinesByMessage(thread, [turn(1, ['x:a']), turn(2, ['x:b']), turn(5, ['x:c'])]);
  assert.deepEqual(m.get('a1')!.map((t) => t.suggested[0]), ['x:a', 'x:b'], 'a note made before the reply, and one made at the same moment');
  assert.deepEqual(m.get('a2')!.map((t) => t.suggested[0]), ['x:c']);
  assert.equal(m.has('u1') || m.has('tool'), false, 'only assistant messages get a line');
});

test('a note after the last reply has no line yet, and an empty list gives an empty map', () => {
  assert.equal(skillLinesByMessage(thread, [turn(9, ['x:a'])]).size, 0);
  assert.equal(skillLinesByMessage(thread, []).size, 0);
  assert.equal(skillLinesByMessage(thread, undefined).size, 0);
  assert.equal(skillLinesByMessage([], [turn(1, ['x:a'])]).size, 0);
});

test('a note older than the loaded part of a long thread is left out, not pinned to the first loaded reply', () => {
  const loaded = thread.slice(2);
  const m = skillLinesByMessage(loaded, [turn(1, ['x:old']), turn(5, ['x:new'])]);
  assert.deepEqual([...m.keys()], ['a2']);
  assert.deepEqual(m.get('a2')!.map((t) => t.suggested[0]), ['x:new']);
});

test('a note with nothing suggested has no line', () => {
  assert.equal(skillLinesByMessage(thread, [turn(1, [])]).size, 0);
});

test('a subagent note is kept as its own entry, in time order, beside the main one', () => {
  const m = skillLinesByMessage(thread, [turn(1, ['x:a']), turn(1, ['x:b'], [], { subagent: 'reviewer' })]);
  assert.equal(m.get('a1')!.length, 2);
  assert.equal(m.get('a1')![1]!.subagent, 'reviewer');
});

test('line text: short names, loaded only when something was loaded, and the subagent wording', () => {
  assert.equal(shortSkillName('legion-armory:invoice-pdf-export'), 'invoice-pdf-export');
  assert.equal(shortSkillName('verify'), 'verify');
  assert.equal(lineText(turn(1, ['sp:a', 'legion-armory:b'], ['sp:a'])), 'Suggested: a, b · loaded: a');
  assert.equal(lineText(turn(1, ['sp:a', 'b'])), 'Suggested: a, b');
  assert.equal(lineText(turn(1, ['sp:a'], [], { subagent: 'reviewer' })), 'Suggested to reviewer: a');
  assert.equal(lineText(turn(1, ['sp:a'], ['sp:a'], { subagent: 'reviewer' })), 'Suggested to reviewer: a · loaded: a');
});

test('popover rows: full id, score with one decimal, matched words only when there are some, id alone for outside skills', () => {
  const t = turn(1, ['sp:a', 'b']);
  assert.equal(rowText(t.why[0]!, false), 'sp:a · score 12.3 · matched: pdf, export');
  assert.equal(rowText(t.why[1]!, false), 'b · score 11.3', 'no matched words, no matched part');
  assert.equal(rowText(t.why[0]!, true), 'sp:a');
});

test('at most three lines per reply; the rest are counted for the popover', () => {
  const four = [turn(1, ['a']), turn(1, ['b']), turn(1, ['c']), turn(1, ['d'])];
  assert.equal(MAX_LINES, 3);
  assert.deepEqual(overflowTurns(four).map((t) => t.suggested[0]), ['d']);
  assert.deepEqual(overflowTurns(four.slice(0, 3)), []);
});
