// test/gates-keep-logic.test.ts: the "Variables commands may keep" editor (Settings, Gates). The pure part: what a typed name is
// checked against, the plain words an error uses, and the exact change an Add or a Remove sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV_KEEP_LABEL, ENV_KEEP_MAX, ENV_KEEP_NAME_MAX, ENV_KEEP_RE } from '../src/shared/gates-registry.js';
import { checkKeepName, keepAddChange, keepRemoveChange, KEEP_EMPTY_LINE, KEEP_NOTE } from '../ui/src/gates/keepLogic.js';

const err = (input: string, kept: string[] = []): string => {
  const r = checkKeepName(input, kept);
  assert.equal(r.kind, 'error', `"${input}" should be refused`);
  return r.kind === 'error' ? r.message : '';
};

test('the label and the limits come from one place the core and the window both read', () => {
  assert.equal(ENV_KEEP_LABEL, 'Variables commands may keep');
  assert.equal(ENV_KEEP_MAX, 50);
  assert.equal(ENV_KEEP_NAME_MAX, 100);
  assert.equal(ENV_KEEP_RE.test('NPM_TOKEN'), true);
  assert.equal(ENV_KEEP_RE.test('MYAPP_*'), true);
  assert.equal(ENV_KEEP_RE.test('AB*'), false);
});

test('nothing typed is not an error: Add is just off', () => {
  assert.deepEqual(checkKeepName('', []), { kind: 'empty' });
  assert.deepEqual(checkKeepName('   ', []), { kind: 'empty' });
});

test('a good name is trimmed and passes as typed; a prefix with a star at the end passes', () => {
  assert.deepEqual(checkKeepName('  NPM_TOKEN ', []), { kind: 'ok', name: 'NPM_TOKEN' });
  assert.deepEqual(checkKeepName('gh_token', []), { kind: 'ok', name: 'gh_token' });
  assert.deepEqual(checkKeepName('_PRIVATE', []), { kind: 'ok', name: '_PRIVATE' });
  assert.deepEqual(checkKeepName('MYAPP_*', []), { kind: 'ok', name: 'MYAPP_*' });
  assert.deepEqual(checkKeepName('AWS*', []), { kind: 'ok', name: 'AWS*' }, 'three characters before the star is enough');
});

test('a bad name gets a plain sentence that says what to change', () => {
  assert.match(err('NPM TOKEN'), /letters, digits and _/i);
  assert.match(err('NPM-TOKEN'), /letters, digits and _/i);
  assert.match(err('9LIVES'), /start with a letter or _/i);
  assert.match(err('MY*APP'), /\* only at the end/i);
  assert.match(err('A*'), /at least 3 characters before the \*/i);
  assert.match(err('AW*'), /at least 3 characters before the \*/i);
  assert.match(err('*'), /at least 3 characters before the \*/i);
  assert.match(err('A'.repeat(101)), /up to 100 characters/);
});

test('a pasted NAME=value is refused with a sentence that never repeats what was typed', () => {
  const secret = 'ghp_ZZ-SECRET-VALUE-9f3a';
  const m = err(`GH_TOKEN=${secret}`);
  assert.match(m, /only the name/i);
  assert.equal(m.includes(secret), false);
  assert.equal(m.includes('GH_TOKEN'), false);
  for (const bad of ['has space', 'bad-name!', `${secret}`, '9' + secret]) assert.equal(err(bad).includes(secret), false, bad);
});

test('a name already on the list, or covered by a prefix on it, is said so; case does not matter', () => {
  assert.match(err('NPM_TOKEN', ['NPM_TOKEN']), /NPM_TOKEN is already on the list/);
  assert.match(err('npm_token', ['NPM_TOKEN']), /already on the list/);
  assert.match(err('AWS_PROFILE', ['AWS_*']), /AWS_PROFILE is already covered by AWS_\*/);
  assert.equal(checkKeepName('AWS_*', ['AWS_PROFILE']).kind, 'ok', 'a wider prefix is allowed after a single name');
});

test('the list holds 50 names: the 51st is refused in words, the 50th passes', () => {
  const kept49 = Array.from({ length: 49 }, (_, i) => `VAR_${i}`);
  assert.equal(checkKeepName('LAST_ONE', kept49).kind, 'ok');
  assert.match(err('ONE_MORE', [...kept49, 'LAST_ONE']), /holds 50 names.*Remove one first/);
});

test("Legion's own keys and LEGION_ variables are never passed, so keeping them is refused", () => {
  for (const n of ['ANTHROPIC_API_KEY', 'anthropic_auth_token', 'BOAT_API_KEY', 'LEGION_HOME', 'legion_port']) assert.match(err(n), /Legion never passes its own/, n);
  assert.match(err('LEGION_*'), /Legion never passes its own/);
  assert.equal(checkKeepName('ANTHROPIC_BASE_URL', []).kind, 'ok', 'a name that is not one of the keys is fine');
});

test('Add sends the whole list with the name at the end, as an app change; Remove sends the list without it', () => {
  assert.deepEqual(keepAddChange(['NPM_TOKEN'], 'GH_TOKEN'), { kind: 'app', patch: { envKeep: ['NPM_TOKEN', 'GH_TOKEN'] } });
  assert.deepEqual(keepAddChange([], 'GH_TOKEN'), { kind: 'app', patch: { envKeep: ['GH_TOKEN'] } });
  assert.deepEqual(keepRemoveChange(['NPM_TOKEN', 'GH_TOKEN'], 'NPM_TOKEN'), { kind: 'app', patch: { envKeep: ['GH_TOKEN'] } });
  assert.deepEqual(keepRemoveChange(['GH_TOKEN'], 'GH_TOKEN'), { kind: 'app', patch: { envKeep: [] } }, 'removing the last name sends an empty list');
});

test('the empty line and the note are plain, scoped, and say values are never shown; no em dash', () => {
  assert.match(KEEP_EMPTY_LINE, /None are kept/);
  assert.match(KEEP_EMPTY_LINE, /held back from every command/);
  assert.match(KEEP_NOTE, /every project and outside projects/);
  assert.match(KEEP_NOTE, /values are never shown/i);
  for (const t of [KEEP_EMPTY_LINE, KEEP_NOTE, ENV_KEEP_LABEL]) assert.equal(t.includes('—'), false);
});
