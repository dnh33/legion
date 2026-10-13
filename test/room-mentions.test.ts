/**
 * The room composer's @ menu. The defect: a bare "@" listed @everyone first, so Enter (which takes the first row)
 * woke every bot in the room. Members come first now; @everyone is last and is never the default pick.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mentionCandidates } from '../ui/src/rooms/mentionLogic.js';

const room: { members: string[]; kind: 'group' | 'dm'; lead: string } = { members: ['zealot', 'builder', 'scout'], kind: 'group', lead: 'zealot' };
const agents = [
  { id: 'zealot', name: 'Marshal', description: 'Lead' },
  { id: 'builder', name: 'Builder', description: 'Coding' },
  { id: 'scout', name: 'Scout', description: 'Research' },
];

test('a bare @ lists the members first and @everyone last', () => {
  const c = mentionCandidates(room, agents, '');
  assert.deepEqual(c.map((x) => x.key), ['zealot', 'builder', 'scout', 'everyone']);
});

test('typing narrows the list; @everyone is still offered when it matches, but after a matching member', () => {
  assert.deepEqual(mentionCandidates(room, agents, 'bu').map((x) => x.key), ['builder']);
  assert.deepEqual(mentionCandidates(room, agents, 'ev').map((x) => x.key), ['everyone']);
  const e = mentionCandidates({ ...room, members: ['zealot', 'everett'] }, [...agents, { id: 'everett', name: 'Everett', description: '' }], 'ev');
  assert.deepEqual(e.map((x) => x.key), ['everett', 'everyone']);
});

test('@everyone only in a group room with more than one member', () => {
  assert.equal(mentionCandidates({ ...room, members: ['zealot'] }, agents, '').some((x) => x.key === 'everyone'), false);
  assert.equal(mentionCandidates({ ...room, kind: 'dm' as const }, agents, '').some((x) => x.key === 'everyone'), false);
});

test('the lead is labelled, an unknown member falls back to its id', () => {
  const c = mentionCandidates({ ...room, members: ['zealot', 'ghost'] }, agents, '');
  assert.equal(c[0]!.sub, 'Lead');
  assert.equal(c[1]!.label, '@ghost');
});
